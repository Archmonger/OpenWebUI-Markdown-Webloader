/**
 * Request/response models.
 *
 * The Open-WebUI integration (`backend/.../loaders/external_web.py`) issues:
 *
 *     POST {EXTERNAL_WEB_LOADER_URL}
 *     Authorization: Bearer {EXTERNAL_WEB_LOADER_API_KEY}
 *     Content-Type: application/json
 *     {"urls": ["https://...", ...]}
 *
 * and expects a JSON **array** back, one document per URL:
 *
 *     [{ "page_content": "...", "metadata": {"source": "...", "title": "..."} }, ...]
 *
 * Those models are reproduced here so the engine is a drop-in replacement.
 * The richer `Load*` models are used by the standalone `/load` and
 * `/load/batch` endpoints, which also speak the same header-driven option set.
 */

/** Output format selector (mirrors the reference `x-respond-with` header). */
export type ResponseFormat = "markdown" | "html" | "text" | "pdf";

export const RESPONSE_FORMATS: readonly ResponseFormat[] = [
  "markdown",
  "html",
  "text",
  "pdf",
] as const;

export function isResponseFormat(value: string): value is ResponseFormat {
  return (RESPONSE_FORMATS as readonly string[]).includes(value.toLowerCase());
}

/** Per-request options, overridable through `x-*` headers. */
export interface LoadOptions {
  /** Output format. Defaults to markdown. */
  respondWith: ResponseFormat;
  /** Skip the response cache for this request. */
  noCache: boolean;
  /** Optional CSS selector: wait until this element exists (best effort). */
  waitForSelector: string | undefined;
  /** Optional CSS selector: extract only the matching subtree. */
  targetSelector: string | undefined;
  /** Optional CSS selector: remove matching elements before extraction. */
  removeSelector: string | undefined;
  /** Optional per-request timeout in ms (falls back to config). */
  timeout: number | undefined;
  /** Optional User-Agent override. */
  userAgent: string | undefined;
  /** Optional egress proxy URL override. */
  proxyUrl: string | undefined;
  /** Include an images list in the response (markdown/html only). */
  withImages: boolean;
  /** Include a links list in the response (markdown/html only). */
  withLinks: boolean;
}

/** Resolved options after merging per-request overrides with the defaults. */
export interface ResolvedOptions extends LoadOptions {}

/** Body for `POST /load` (single URL). */
export interface LoadRequest {
  url: string;
  options?: Partial<LoadOptions>;
}

/** Body for `POST /load/batch` (multiple URLs). */
export interface BatchLoadRequest {
  urls: string[];
  options?: Partial<LoadOptions>;
}

/** Body for `POST /` (the Open-WebUI external web loader contract). */
export interface OpenWebUIRequest {
  urls: string[];
}

export interface ImageInfo {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface LinkInfo {
  href: string;
  text?: string;
}

export interface ResponseMetadata {
  processingTimeMs: number;
  cached: boolean;
  byteLength: number;
}

/** Response for `POST /load`. */
export interface LoadResponse {
  url: string;
  title?: string;
  content: string;
  images?: ImageInfo[];
  links?: LinkInfo[];
  metadata: ResponseMetadata;
}

export interface BatchLoadResult {
  url: string;
  response?: LoadResponse;
  error?: string;
}

/** Response for `POST /load/batch`. */
export interface BatchLoadResponse {
  results: BatchLoadResult[];
  totalProcessingTimeMs: number;
}

/** One document in the Open-WebUI array response. */
export interface OpenWebUIDocument {
  page_content: string;
  metadata: {
    source: string;
    title?: string;
  };
}

export interface HealthResponse {
  status: "ok";
  version: string;
  cache: { size: number };
  defaults: {
    respondWith: ResponseFormat;
    maxContentLengthBytes: number;
    maxPdfPages: number;
    requestTimeoutMs: number;
  };
}
