/**
 * The URL reader core.
 *
 * `readUrl()` fetches a URL and returns its content rendered as clean
 * Markdown (or the requested format), mirroring the behavior of mcp-searxng's
 * `web_url_read` tool:
 *
 *   1. Parse + statically validate the URL (SSRF: reject private ranges).
 *   2. Serve from cache when present (unless `noCache`). The cache stores the
 *      *un-paginated* markdown; per-request pagination options are applied on
 *      top of the cached document so slicing never corrupts the cache entry.
 *   3. Follow redirects manually, re-validating every hop, up to a cap.
 *   4. Pre-check content-length with a HEAD request to fail fast on huge pages.
 *   5. Stream the body, enforcing the byte cap and sniffing the first 1 KiB
 *      for NUL bytes (binary masquerading).
 *   6. Classify the content type and convert (HTML->Markdown, JSON fenced,
 *      text fenced, PDF text, or reject binary).
 *   7. Apply pagination options, then cache and return.
 */
import { fetch as undiciFetch, type Dispatcher } from "undici";
import { parse as parseHtml } from "node-html-parser";
import type { AppConfig } from "./config.js";
import type {
  ConverterKind,
  ImageInfo,
  LinkInfo,
  ResolvedOptions,
} from "./types.js";
import { aiShouldAttempt, maybeAiConvert } from "./ai-converter.js";
import { preprocessHtml } from "./preprocess.js";
import { minifyHtml } from "./minify.js";
import {
  createContentError,
  createConversionError,
  createNetworkError,
  createEmptyContentWarning,
  createServerError,
  createTimeoutError,
  createUrlFormatError,
  type EngineError,
} from "./error-handler.js";
import {
  assertUrlAllowed,
  createSecurityPolicyError,
  createUrlReaderAgent,
  isSecurityPolicyError,
} from "./security.js";
import {
  applyPaginationOptions,
  classifyContentType,
  htmlToMarkdown,
  renderFencedMarkdown,
  renderJsonMarkdown,
  type ContentTypeClassification,
} from "./markdown.js";
import { effectivePdfLimit, extractPdfText } from "./pdf-reader.js";
import type { PaginationOptions } from "./markdown.js";
import type { CacheDocument, SimpleCache } from "./cache.js";

/** The fully-processed result of reading a single URL. */
export interface UrlReadResult {
  url: string;
  content: string;
  title?: string;
  images?: ImageInfo[];
  links?: LinkInfo[];
  byteLength: number;
  cached: boolean;
  processingTimeMs: number;
  /** Which renderer produced this markdown (HTML only). */
  converter?: ConverterKind;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const BINARY_SNIFF_PREFIX_BYTES = 1024;

/** Cache key: output format plus URL (so formats do not collide). */
export function cacheKeyFor(url: string, options: ResolvedOptions): string {
  return `${options.respondWith}:${url}`;
}

/**
 * Cache key for an AI-converted document. Namespaced so an AI result and the
 * native result for the same URL never shadow each other.
 *
 * Known staleness trade-off: the key encodes the output format and URL only —
 * not the AI generation parameters (temperature, top-k/p, seed) or the minify
 * toggle. Changing those server settings therefore does NOT invalidate cached
 * AI documents; a new setting only takes effect for uncached URLs or once the
 * entry's TTL expires (restart also clears it, as the cache is in-memory).
 * Accepting this keeps the key (and thus hit rates) stable across requests.
 */
export function aiCacheKeyFor(url: string, options: ResolvedOptions): string {
  return `${options.respondWith}:ai:${url}`;
}

export async function readUrl(
  url: string,
  options: ResolvedOptions,
  config: AppConfig,
  cache: SimpleCache,
): Promise<UrlReadResult> {
  const started = Date.now();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw createUrlFormatError(url);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw createUrlFormatError(`${url} (only http/https are supported)`);
  }
  // Static SSRF check on the literal hostname.
  assertUrlAllowed(parsedUrl, config.allowPrivateUrls);

  // When the AI lane is active for this request, consult it first so a cached
  // AI result is served without a re-fetch. The native lane is then consulted
  // as a fallback (it holds every non-HTML document and any prior native HTML,
  // including a cached "fallback" produced while the AI service was down).
  const aiActiveForRequest = config.ai.enabled && options.aiConvert !== false;
  if (!options.noCache) {
    if (aiActiveForRequest) {
      const aiCached = cache.get(aiCacheKeyFor(url, options));
      if (aiCached !== null) {
        log(config, "debug", `AI cache hit for ${url}`);
        return cachedResult(url, aiCached, "ai", options, started);
      }
    }
    const cached: CacheDocument | null = cache.get(cacheKeyFor(url, options));
    if (cached !== null) {
      log(config, "debug", `cache hit for ${url}`);
      return cachedResult(url, cached, cached.converter, options, started);
    }
  }

  const timeoutMs = options.timeout ?? config.requestTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFollowingRedirects(
      parsedUrl,
      options,
      config,
      controller.signal,
    );
    if (!response) {
      throw createContentError("Exceeded maximum number of redirects.", url);
    }
    if (!response.ok) {
      throw createServerError(
        response.status,
        response.statusText,
        url,
        await safeBodySnippet(response),
      );
    }

    const classification = classifyContentType(
      response.headers.get("content-type"),
    );
    if (classification.kind === "binary") {
      await cancelBody(response);
      throw createContentError(
        `Unsupported content type: ${classification.mediaType}. Binary, media, and archive downloads are intentionally not read.`,
        url,
      );
    }

    const converted = await convertResponse(
      response,
      classification,
      url,
      options,
      config,
    );
    // Persist under the lane that actually produced the markdown so the AI and
    // native results never shadow one another. Store an envelope, not the bare
    // Markdown, so a later cache hit can re-attach title / image / link
    // metadata without re-fetching. Two deliberate exceptions:
    //   * A `fallback` result is NOT cached. It is only what we produced because
    //     the AI service failed this time; caching it would pin the degraded
    //     rendering even after the service recovers. A later request retries.
    //   * When `cacheAiOutput` is off, the AI result is simply not stored, so
    //     the native rendering (if any) and the AI result never both accumulate.
    if (!options.noCache && converted.converter !== "fallback") {
      const doc: CacheDocument = { full: converted.full };
      if (converted.title) doc.title = converted.title;
      if (converted.images?.length) doc.images = converted.images;
      if (converted.links?.length) doc.links = converted.links;
      if (converted.converter) doc.converter = converted.converter;
      if (converted.converter === "ai") {
        if (config.ai.cacheAiOutput) {
          cache.set(aiCacheKeyFor(url, options), doc);
        }
      } else {
        cache.set(cacheKeyFor(url, options), doc);
      }
    }
    log(
      config,
      "info",
      `fetched ${url} (${converted.content.length} chars in ${converted.processingTimeMs}ms` +
        `${converted.converter ? `, converter=${converted.converter}` : ""})`,
    );
    const result: UrlReadResult = {
      url: converted.url,
      content: converted.content,
      title: converted.title,
      images: converted.images,
      links: converted.links,
      byteLength: converted.byteLength,
      cached: false,
      processingTimeMs: converted.processingTimeMs,
      converter: converted.converter,
    };
    return result;
  } catch (error) {
    throw mapFetchError(error, controller, url, timeoutMs);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Build a cache-hit `UrlReadResult` from a stored envelope. */
function cachedResult(
  url: string,
  cached: CacheDocument,
  converter: ConverterKind | undefined,
  options: ResolvedOptions,
  started: number,
): UrlReadResult {
  const content = applyPaginationOptions(cached.full, NO_PAGINATION);
  const result: UrlReadResult = {
    url,
    content,
    cached: true,
    byteLength: 0,
    processingTimeMs: Date.now() - started,
  };
  if (converter) result.converter = converter;
  if (cached.title) result.title = cached.title;
  if (options.withImages && cached.images?.length)
    result.images = cached.images;
  if (options.withLinks && cached.links?.length) result.links = cached.links;
  return result;
}

// ---- Fetch + redirect handling ------------------------------------------

async function fetchFollowingRedirects(
  start: URL,
  options: ResolvedOptions,
  config: AppConfig,
  signal: AbortSignal,
): Promise<Response | null> {
  const dispatcher = createDispatcher(options, config);
  const headers = buildRequestHeaders(options, config);

  let current = start;
  for (let hops = 0; hops <= config.maxRedirects; hops++) {
    // Fail-fast size check on the first hop using a HEAD request. Non-fatal:
    // if the server rejects HEAD we still fall through to the (authoritative)
    // streaming body limit.
    if (hops === 0) {
      const length = await headContentLength(
        current.href,
        config,
        headers,
        signal,
        dispatcher,
      );
      if (length !== null && length > config.maxContentLengthBytes) {
        throw createContentError(
          `Content too large: ${formatBytes(length)} exceeds the ${formatBytes(config.maxContentLengthBytes)} limit.`,
          current.href,
        );
      }
    }
    const response = (await undiciFetch(current.href, {
      signal,
      redirect: "manual",
      headers,
      dispatcher,
    } as any)) as Response;

    if (!REDIRECT_STATUS.has(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    await cancelBody(response);
    const next = new URL(location, current.href);
    // Re-validate every redirect hop so a public URL cannot bounce to an
    // internal address. The safe DNS lookup additionally blocks rebinding.
    assertUrlAllowed(next, config.allowPrivateUrls);
    current = next;
  }
  return null;
}

function createDispatcher(options: ResolvedOptions, config: AppConfig) {
  // Per-request proxy (header) wins over the environment-configured proxy.
  const proxyUrl = options.proxyUrl ?? config.proxyUrl;
  return createUrlReaderAgent(config.allowPrivateUrls, proxyUrl);
}

function buildRequestHeaders(
  options: ResolvedOptions,
  config: AppConfig,
): Record<string, string> {
  const userAgent = options.userAgent ?? config.userAgent;
  return {
    "user-agent": userAgent,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.9",
  };
}

async function headContentLength(
  url: string,
  _config: AppConfig,
  headers: Record<string, string>,
  signal: AbortSignal,
  dispatcher: Dispatcher,
): Promise<number | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = (await undiciFetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers,
      dispatcher,
      signal: signal.aborted ? signal : controller.signal,
    } as any)) as Response;
    const length = response.headers.get("content-length");
    await cancelBody(response);
    if (!length) return null;
    const parsed = parseInt(length, 10);
    return Number.isNaN(parsed) || parsed < 0 ? null : parsed;
  } catch {
    return null; // HEAD is best-effort; the streaming limit is authoritative.
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Bounded body readers ------------------------------------------------

interface BoundedBodyRead {
  exceeded: boolean;
  text: string;
  bytesRead: number;
  hasNulInPrefix: boolean;
}

async function readBodyText(
  response: Response,
  maxBytes: number,
): Promise<BoundedBodyRead> {
  if (response.body === null) {
    return { exceeded: false, text: "", bytesRead: 0, hasNulInPrefix: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let prefixChecked = 0;
  let hasNul = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = BINARY_SNIFF_PREFIX_BYTES - prefixChecked;
      const sniff = value.subarray(0, Math.min(value.byteLength, remaining));
      if (sniff.some((b: number) => b === 0)) hasNul = true;
      prefixChecked += sniff.byteLength;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { exceeded: true, text: "", bytesRead, hasNulInPrefix: hasNul };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = concatenate(chunks, bytesRead);
  return {
    exceeded: false,
    text: new TextDecoder("utf-8").decode(merged),
    bytesRead,
    hasNulInPrefix: hasNul,
  };
}

interface BoundedBytesRead {
  exceeded: boolean;
  bytes: Uint8Array;
  bytesRead: number;
}

async function readBodyBytes(
  response: Response,
  maxBytes: number,
): Promise<BoundedBytesRead> {
  if (response.body === null) {
    return { exceeded: false, bytes: new Uint8Array(0), bytesRead: 0 };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { exceeded: true, bytes: new Uint8Array(0), bytesRead };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    exceeded: false,
    bytes: concatenate(chunks, bytesRead),
    bytesRead,
  };
}

// ---- Conversion ----------------------------------------------------------

type ConvertedContent =
  | {
      kind: "markdown";
      markdown: string;
      title?: string;
      images?: ImageInfo[];
      links?: LinkInfo[];
      converter?: ConverterKind;
    }
  | { kind: "message"; text: string };

/**
 * Convert a fetched response into a `UrlReadResult`. Returns the full
 * (un-paginated) markdown for caching plus the paginated content to return.
 */
async function convertResponse(
  response: Response,
  classification: ContentTypeClassification,
  url: string,
  options: ResolvedOptions,
  config: AppConfig,
): Promise<UrlReadResult & { full: string }> {
  const started = Date.now();

  let converted: ConvertedContent;
  let byteLength: number;

  if (classification.kind === "pdf") {
    const pdfInputLimit = Math.min(
      config.maxContentLengthBytes,
      config.maxPdfBytes,
    );
    const bytes = await readBodyBytes(response, pdfInputLimit);
    if (bytes.exceeded) {
      throw createContentError(
        `PDF exceeds the ${formatBytes(bytes.bytesRead)} input limit.`,
        url,
      );
    }
    byteLength = bytes.bytesRead;
    const pdfLimit = effectivePdfLimit(config);
    const pdfResult = await extractPdfText(
      bytes.bytes,
      pdfLimit,
      config.maxPdfPages,
    );
    converted = pdfToConverted(pdfResult, pdfLimit);
  } else {
    const text = await readBodyText(response, config.maxContentLengthBytes);
    if (text.exceeded) {
      throw createContentError(
        `Content too large: ${formatBytes(text.bytesRead)} exceeds the ${formatBytes(config.maxContentLengthBytes)} limit.`,
        url,
      );
    }
    if (text.hasNulInPrefix) {
      await cancelBody(response);
      throw createContentError(
        `Response declared ${classification.mediaType ?? "a readable type"} but appears binary (NUL byte in the first ${BINARY_SNIFF_PREFIX_BYTES} bytes).`,
        url,
      );
    }
    if (!text.text.trim()) {
      throw createContentError("Website returned empty content.", url);
    }
    byteLength = text.bytesRead;
    if (classification.kind === "html") {
      converted = await convertHtmlContent(text.text, url, options, config);
    } else {
      converted = convertText(text.text, classification, url);
    }
  }

  // What we cache: the full markdown (or the failure message), so pagination
  // is re-applied per request against a stable document.
  const full =
    converted.kind === "markdown" ? converted.markdown : converted.text;

  let content: string;
  if (converted.kind === "message") {
    content = converted.text;
  } else if (converted.markdown.trim() === "") {
    content = createEmptyContentWarning(url);
  } else {
    content = applyPaginationOptions(converted.markdown, NO_PAGINATION);
  }

  return {
    url,
    full,
    content,
    title: converted.kind === "markdown" ? converted.title : undefined,
    images:
      converted.kind === "markdown" && options.withImages
        ? converted.images
        : undefined,
    links:
      converted.kind === "markdown" && options.withLinks
        ? converted.links
        : undefined,
    byteLength,
    cached: false,
    processingTimeMs: Date.now() - started,
    converter: converted.kind === "markdown" ? converted.converter : undefined,
  };
}

/**
 * Convert an HTML document to Markdown, preferring the AI (ReaderLM) converter
 * when enabled for this request, and always falling back to the native
 * `node-html-markdown` renderer. Metadata (title/images/links) is always taken
 * from the RAW HTML via the native extractors so it is present regardless of
 * which renderer produced the body text.
 *
 * When `PREPROCESS_HTML` is enabled (default), the document is first run
 * through the `dom_smoothie` Readability cleaner and BOTH renderers consume the
 * cleaned HTML. This keeps the two paths comparable and gives the model a
 * smaller, article-only input. The cleaner never loses content: if it fails or
 * is unavailable it returns the original HTML, so the conversion still runs.
 * The AI size gate is evaluated against the CLEANED length, which is what the
 * model will actually be sent.
 *
 * When `PREPROCESS_MINIFY_HTML` is enabled, the AI path additionally runs the
 * cleaner's output through the `@minify-html/node` minifier (with its safe,
 * structure-preserving options) so the model prefills fewer bytes. The native
 * renderer keeps consuming the unminified `cleaned` HTML, so toggling this
 * can only change the AI path's input, never the markdown a native deployment
 * serves. The minifier is a native addon that degrades to the unminified HTML
 * if it is missing or fails, so it can never break a conversion. The AI size
 * gate is evaluated against the CLEANED length (the minify step runs after the
 * gate, so a document that is too large is never sent minified to a model that
 * would reject it anyway).
 */
async function convertHtmlContent(
  html: string,
  url: string,
  options: ResolvedOptions,
  config: AppConfig,
): Promise<ConvertedContent> {
  // Metadata from the RAW document so titles/images/links are never lost even
  // if Readability drops them during cleaning.
  const meta = nativeHtmlMetadata(html);

  // Pre-clean once; shared by the native and AI paths. Falls back to `html`.
  const cleaned = await preprocessHtml(html, url, config, (level, msg) =>
    log(config, level, msg),
  );

  const nativeMarkdown = renderNativeHtmlMarkdown(cleaned, url);

  if (!aiShouldAttempt(config, options, cleaned.length)) {
    return {
      kind: "markdown",
      markdown: nativeMarkdown,
      ...meta,
      converter: "native",
    };
  }
  // Shrink the AI input (opt-in). The native renderer above already ran on the
  // unminified `cleaned`; only the bytes handed to the model are minified. This
  // is a no-op that returns `cleaned` when minify is off or the addon is absent.
  const aiInput = await minifyHtml(cleaned, config, (level, msg) =>
    log(config, level, msg),
  );
  const { markdown, converter } = await maybeAiConvert(
    aiInput,
    nativeMarkdown,
    url,
    config,
    (level, msg) => log(config, level, msg),
  );
  return { kind: "markdown", markdown, ...meta, converter };
}

/** Native HTML→markdown; throws a conversion error on failure (unchanged). */
function renderNativeHtmlMarkdown(html: string, url: string): string {
  try {
    return htmlToMarkdown(html);
  } catch {
    throw createConversionError(url);
  }
}

/** Title/image/link extraction straight from the HTML (renderer-agnostic). */
function nativeHtmlMetadata(html: string): {
  title?: string;
  images?: ImageInfo[];
  links?: LinkInfo[];
} {
  return {
    title: extractTitle(html),
    images: extractImages(html),
    links: extractLinks(html),
  };
}

// mcp-searxng's web_url_read supports pagination parameters (startChar,
// maxLength, section, paragraphRange, readHeadings). The Open-WebUI external
// loader contract has no surface for them, so the engine applies none and
// returns the whole document. The mechanism is kept available here for
// future clients that do expose pagination.
const NO_PAGINATION: PaginationOptions = {};

function convertText(
  text: string,
  classification: ContentTypeClassification,
  url: string,
): ConvertedContent {
  if (classification.kind === "json") {
    return { kind: "markdown", markdown: renderJsonMarkdown(text) };
  }
  if (classification.kind === "text") {
    return {
      kind: "markdown",
      markdown: renderFencedMarkdown(classification.language, text),
    };
  }
  // html (and generic, which mcp-searxng also converts as HTML).
  let markdown: string;
  try {
    markdown = htmlToMarkdown(text);
  } catch {
    throw createConversionError(url);
  }
  return {
    kind: "markdown",
    markdown,
    title: extractTitle(text),
    images: extractImages(text),
    links: extractLinks(text),
  };
}

function pdfToConverted(
  pdfResult: Awaited<ReturnType<typeof extractPdfText>>,
  limit: number,
): ConvertedContent {
  switch (pdfResult.kind) {
    case "text":
      return {
        kind: "markdown",
        markdown: renderFencedMarkdown("text", pdfResult.text),
      };
    case "no_text":
      return {
        kind: "message",
        text: "No extractable text (likely a scanned/image PDF; OCR is not supported).",
      };
    case "too_many_pages":
      return {
        kind: "message",
        text: `PDF has too many pages to extract safely (observed: ${pdfResult.totalPages}).`,
      };
    case "text_too_large":
      return {
        kind: "message",
        text: `Extracted PDF text exceeds the safe byte limit: ${formatBytes(pdfResult.bytes)} exceeds ${formatBytes(limit)}.`,
      };
    case "password_protected":
      return {
        kind: "message",
        text: "Password-protected PDF cannot be read.",
      };
    case "external_fetch_attempt":
      return {
        kind: "message",
        text: "PDF attempted an external resource fetch and was blocked.",
      };
    case "parse_error":
      return { kind: "message", text: "Unable to extract text from PDF." };
  }
}

// ---- Small helpers -------------------------------------------------------

function concatenate(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cancellation.
  }
}

async function safeBodySnippet(response: Response): Promise<string> {
  try {
    const snippet = await response.text();
    return snippet.slice(0, 500);
  } catch {
    return "[could not read response body]";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes} bytes)`;
}

function mapFetchError(
  error: unknown,
  controller: AbortController,
  url: string,
  timeoutMs: number,
): EngineError {
  // Security-policy rejections (static SSRF or DNS-rebinding) carry their own
  // 403. They are checked before the generic EngineError shortcut so a block
  // is never downgraded to a timeout or 502 when the request was refused at
  // the security layer rather than failing on the wire.
  if (isSecurityPolicyError(error)) {
    return createSecurityPolicyError(url);
  }
  if ((error as Error)?.name === "EngineError") {
    return error as EngineError;
  }
  if (controller.signal.aborted) {
    return createTimeoutError(timeoutMs, url);
  }
  return createNetworkError(error, url);
}

// ---- Metadata extraction (node-html-parser) -----------------------------

function extractTitle(html: string): string | undefined {
  try {
    const root = parseHtml(html);
    return (
      root.querySelector("title")?.text?.trim() ||
      root.querySelector("h1")?.text?.trim() ||
      root
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content")
        ?.trim()
    );
  } catch {
    return undefined;
  }
}

function extractImages(html: string, limit = 50): ImageInfo[] {
  try {
    const root = parseHtml(html);
    const images: ImageInfo[] = [];
    for (const img of root.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src) continue;
      const info: ImageInfo = { src };
      const alt = img.getAttribute("alt");
      if (alt) info.alt = alt;
      images.push(info);
      if (images.length >= limit) break;
    }
    return images;
  } catch {
    return [];
  }
}

function extractLinks(html: string, limit = 100): LinkInfo[] {
  try {
    const root = parseHtml(html);
    const links: LinkInfo[] = [];
    for (const a of root.querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("javascript:")) continue;
      const info: LinkInfo = { href };
      const text = a.text?.trim();
      if (text) info.text = text;
      links.push(info);
      if (links.length >= limit) break;
    }
    return links;
  } catch {
    return [];
  }
}

function log(
  config: AppConfig,
  level: "warn" | "info" | "debug",
  message: string,
): void {
  const order = { off: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
  if (order[level] <= order[config.logLevel]) {
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${message}`);
  }
}
