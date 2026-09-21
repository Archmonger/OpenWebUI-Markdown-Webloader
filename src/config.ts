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
  };
}
