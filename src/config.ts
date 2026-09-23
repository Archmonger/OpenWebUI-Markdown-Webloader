/**
 * Environment configuration.
 *
 * Every knob is read once at startup from process.env so that operators can
 * configure the engine purely via environment (12-factor). Sensitive values
 * (API keys) are only used for constant-time comparisons.
 */
export interface AppConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** Host/interface to bind. Default 0.0.0.0 so it works inside Docker. */
  host: string;
  /** Optional API key. When set, clients must send `Authorization: Bearer <key>`. */
  apiKey: string | undefined;
  /** Default request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum number of bytes to read from a response body. */
  maxContentLengthBytes: number;
  /** Fixed upper bound for PDF input (cannot be raised). */
  maxPdfBytes: number;
  /** Maximum number of PDF pages to extract text from. */
  maxPdfPages: number;
  /** Timeout in milliseconds for PDF text extraction. */
  pdfTimeoutMs: number;
  /** Response cache TTL in milliseconds. */
  cacheTtlMs: number;
  /** Maximum number of cached entries before eviction. */
  cacheMaxEntries: number;
  /** User agent used when no per-request override is provided. */
  userAgent: string;
  /** Allow fetching private/loopback/localhost URLs (SSRF bypass). Off by default. */
  allowPrivateUrls: boolean;
  /** Egress proxy for URL reads (e.g. http://proxy:3128). Optional. */
  proxyUrl: string | undefined;
  /** Comma-separated list of hosts to bypass the proxy for. */
  noProxy: string | undefined;
  /** Maximum number of redirects to follow. */
  maxRedirects: number;
  /** Maximum number of URLs processed concurrently in one request. */
  maxConcurrentUrls: number;
  /** Maximum number of URLs accepted in a single batch request. */
  maxBatchUrls: number;
  /** Log level: off | error | warn | info | debug. */
  logLevel: "off" | "error" | "warn" | "info" | "debug";
  /**
   * Readability-style HTML pre-cleaning (dom_smoothie). When enabled, every
   * HTML document is stripped of navigation/header/footer boilerplate via the
   * `dom_smoothie_cli` binary BEFORE it reaches either converter. This makes
   * the native `node-html-markdown` output more article-focused and shrinks
   * what the AI sidecar must prefill. Applied to BOTH the native and AI paths.
   * Defaults to ON; the step degrades gracefully to the raw HTML if the binary
   * is missing, errors, times out, or yields empty output.
   */
  preprocess: PreprocessConfig;
  /**
   * Optional AI markdown converter (ReaderLM-v2 sidecar). Disabled unless
   * `AI_CONVERTER_ENABLED` is truthy; when disabled the engine behaves exactly
   * as before and performs no calls to any AI service.
   */
  ai: AiConverterConfig;
}

/**
 * Configuration for the optional HTML pre-cleaner (dom_smoothie, a Rust
 * Readability port). The cleaner runs as a small external binary that the Bun
 * loader shells out to; the request path never hard-depends on it because a
 * failure to run it simply uses the original HTML. See `src/preprocess.ts`.
 */
export interface PreprocessConfig {
  /** Master switch (`PREPROCESS_HTML`). Default true. */
  enabled: boolean;
  /** Path to the `dom_smoothie_cli` binary (`PREPROCESS_BINARY`). */
  binaryPath: string;
  /** Hard per-document timeout in ms (`PREPROCESS_TIMEOUT_MS`). */
  timeoutMs: number;
  /**
   * Maximum DOM elements the cleaner will process (`PREPROCESS_MAX_ELEMENTS`).
   * 0 means no limit (matches the binary default). A positive value bounds
   * worst-case CPU on pathological documents.
   */
  maxElements: number;
  /**
   * Only preprocess documents at least this many characters
   * (`PREPROCESS_MIN_CHARS`). Skips tiny documents where the subprocess cost
   * outweighs the benefit.
   */
  minChars: number;
  /**
   * Optional post-clean HTML minification. See {@link MinifyConfig} and
   * `src/minify.ts`. Defaults to OFF (opt-in via `PREPROCESS_MINIFY_HTML`): it
   * only changes the bytes handed to the AI sidecar and never the native
   * renderer output.
   */
  minify: MinifyConfig;
}

/**
 * Configuration for the optional HTML minifier (`@minify-html/node`), a fast
 * C++ minifier run on the Readability-cleaned HTML before it is handed to the
 * AI sidecar. It exists to shrink the model's input: ReaderLM's prefill cost
 * grows super-linearly with sequence length, so cutting ~10% off a large
 * document measurably cuts prefill latency (measured: ~19% on a 572 KB page).
 *
 * Two invariants are baked in (see `src/minify.ts`):
 *   1. The minifier's SAFE option set is always used (`keep_closing_tags` and
 *      `keep_comments` are forced true). The package's defaults drop optional
 *      closing tags, and `node-html-markdown`'s structure parsing relies on
 *      them — the defaults would silently corrupt tables into blockquotes.
 *      The minifier is a native addon that may be absent or incompatible, so
 *      the step is off by default and, when on, degrades to the unminified HTML
 *      if the addon cannot be loaded or throws. It can never break a request +
 *      converter; at worst you get a slightly larger AI input.
 *   2. It is applied to the AI-path input only. The native `node-html-markdown`
 *      path keeps consuming the unminified cleaned HTML, so enabling this can
 *      never change the markdown a native (non-AI) deployment serves.
 */
export interface MinifyConfig {
  /** Master switch (`PREPROCESS_MINIFY_HTML`). Default false (opt-in). */
  enabled: boolean;
}

/**
 * Configuration for the optional AI (ReaderLM) HTML->Markdown converter
 * sidecar. The converter runs as a separate process/container because it
 * needs the Python `onnxruntime-genai` GPU runtime, which cannot live inside
 * the Bun process. The engine only talks to it over HTTP when enabled, and
 * always falls back to the built-in `node-html-markdown` renderer when the
 * sidecar is unavailable or errors (unless `fallbackOnError` is turned off).
 */
export interface AiConverterConfig {
  /** Master switch. When false, no AI path is taken and no deps are needed. */
  enabled: boolean;
  /** Base URL of the sidecar, e.g. http://ai-converter:8090 . */
  serviceUrl: string;
  /** Optional bearer token; sent as `Authorization: Bearer <token>`. */
  token: string | undefined;
  /** Per-request timeout to the sidecar in ms (fail fast -> fallback). */
  timeoutMs: number;
  /** On sidecar failure/timeout, fall back to node-html-markdown (default true). */
  fallbackOnError: boolean;
  /** Generation settings forwarded to the model per request. */
  maxNewTokens: number;
  temperature: number;
  topK: number;
  topP: number;
  /** Sample deterministically when set; otherwise the model uses its own RNG. */
  seed: number | undefined;
  /** Only attempt AI conversion for HTML documents at least this many chars. */
  minHtmlChars: number;
  /** Hard upper bound on HTML chars sent to the model (protects VRAM/latency). */
  maxHtmlChars: number;
  /** Cache the AI output under the `ai:`-namespaced cache key. */
  cacheAiOutput: boolean;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function readBool(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.trim().toLowerCase() === "true" || raw.trim() === "1";
}

function readLogLevel(env: NodeJS.ProcessEnv): AppConfig["logLevel"] {
  const raw = (env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (
    raw === "off" ||
    raw === "error" ||
    raw === "warn" ||
    raw === "info" ||
    raw === "debug"
  ) {
    return raw;
  }
  return "info";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const maxContentLengthBytes = Math.min(
    readInt(env, "URL_READ_MAX_CONTENT_LENGTH_BYTES", 5 * 1024 * 1024),
    50 * 1024 * 1024,
  );
  const maxPdfBytes = Math.min(
    readInt(env, "URL_READ_MAX_PDF_BYTES", 16 * 1024 * 1024),
    64 * 1024 * 1024,
  );
  const maxPdfPages = readInt(env, "URL_READ_MAX_PDF_PAGES", 500);

  return {
    port: readInt(env, "API_PORT", 14786),
    host: env.HOST ?? "0.0.0.0",
    apiKey: env.API_KEY || undefined,
    requestTimeoutMs: readInt(env, "REQUEST_TIMEOUT_MS", 30_000),
    maxContentLengthBytes,
    maxPdfBytes,
    maxPdfPages,
    pdfTimeoutMs: readInt(env, "PDF_TIMEOUT_MS", 30_000),
    cacheTtlMs: readInt(env, "CACHE_TTL_MS", 86_400_000),
    cacheMaxEntries: readInt(env, "CACHE_MAX_ENTRIES", 500),
    userAgent:
      env.USER_AGENT ??
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36 OpenWebUI-Markdown-Webloader/0.1",
    allowPrivateUrls: readBool(env, "ALLOW_PRIVATE_URLS", false),
    proxyUrl: env.PROXY_URL || undefined,
    noProxy: env.NO_PROXY || env.no_proxy || undefined,
    maxRedirects: readInt(env, "MAX_REDIRECTS", 5),
    maxConcurrentUrls: readInt(env, "MAX_CONCURRENT_URLS", 10),
    maxBatchUrls: readInt(env, "MAX_BATCH_URLS", 100),
    logLevel: readLogLevel(env),
    preprocess: loadPreprocessConfig(env),
    ai: loadAiConfig(env),
  };
}

/**
 * Read the HTML pre-cleaner sub-config. On by default: pre-cleaning is a
 * low-risk, high-value step (it always has the raw HTML to fall back to), so
 * operators opt OUT (`PREPROCESS_HTML=0`) rather than in.
 */
function loadPreprocessConfig(env: NodeJS.ProcessEnv): PreprocessConfig {
  return {
    enabled: readBool(env, "PREPROCESS_HTML", true),
    binaryPath: env.PREPROCESS_BINARY?.trim() || "dom_smoothie_cli",
    timeoutMs: readInt(env, "PREPROCESS_TIMEOUT_MS", 3_000),
    // maxElements intentionally allows 0 (= unlimited), so readInt's
    // "<=0 -> fallback" rule cannot express it; parse directly.
    maxElements: parseNonNegativeInt(env.PREPROCESS_MAX_ELEMENTS, 0),
    minChars: readInt(env, "PREPROCESS_MIN_CHARS", 800),
    // Opt-in (default off): minify only shrinks the AI input and is a native
    // addon, so it is off unless the operator enables it. See src/minify.ts.
    minify: { enabled: readBool(env, "PREPROCESS_MINIFY_HTML", false) },
  };
}

/** Parse a non-negative integer, falling back on invalid/missing input. */
function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

/**
 * Read the AI converter sub-config. Everything is opt-in: with
 * `AI_CONVERTER_ENABLED` unset/false, `enabled` is false and the rest of the
 * values are still parsed (so a later enable via header is consistent) but
 * nothing in the request path references the AI service.
 */
function loadAiConfig(env: NodeJS.ProcessEnv): AiConverterConfig {
  const enabled = readBool(env, "AI_CONVERTER_ENABLED", false);
  // Seed only when the operator explicitly provides a non-negative integer.
  const seedRaw = env.AI_SEED;
  let seed: number | undefined;
  if (seedRaw !== undefined && seedRaw.trim() !== "") {
    const parsed = Number.parseInt(seedRaw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) seed = parsed;
  }
  return {
    enabled,
    serviceUrl: (env.AI_SERVICE_URL ?? "http://localhost:8090").replace(
      /\/+$/,
      "",
    ),
    token: env.AI_CONVERTER_TOKEN || undefined,
    timeoutMs: readInt(env, "AI_CONVERT_TIMEOUT_MS", 30_000),
    fallbackOnError: readBool(env, "AI_FALLBACK_ON_ERROR", true),
    maxNewTokens: readInt(env, "AI_MAX_NEW_TOKENS", 8192),
    temperature: readFloat(env, "AI_TEMPERATURE", 0.0),
    topK: readInt(env, "AI_TOP_K", 1),
    topP: readFloat(env, "AI_TOP_P", 1.0),
    seed,
    minHtmlChars: readInt(env, "AI_MIN_HTML_CHARS", 1),
    maxHtmlChars: readInt(env, "AI_MAX_HTML_CHARS", 2_000_000),
    cacheAiOutput: readBool(env, "AI_CACHE_OUTPUT", true),
  };
}

function readFloat(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}
