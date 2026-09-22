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
   * Optional AI markdown converter (ReaderLM-v2 sidecar). Disabled unless
   * `AI_CONVERTER_ENABLED` is truthy; when disabled the engine behaves exactly
   * as before and performs no calls to any AI service.
   */
  ai: AiConverterConfig;
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
    ai: loadAiConfig(env),
  };
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
