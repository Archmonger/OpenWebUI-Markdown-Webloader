/**
 * Typed error hierarchy for the URL reader. Each error carries a stable
 * `type` string plus an HTTP `status` so the HTTP layer can map failures to
 * sensible status codes without re-parsing messages.
 */

export type EngineErrorType =
  | "url_format"
  | "url_security"
  | "network"
  | "timeout"
  | "server"
  | "content"
  | "conversion"
  | "unknown";

export class EngineError extends Error {
  readonly type: EngineErrorType;
  readonly status: number;

  constructor(type: EngineErrorType, message: string, status = 400) {
    super(message);
    this.name = "EngineError";
    this.type = type;
    this.status = status;
    Object.setPrototypeOf(this, EngineError.prototype);
  }
}

export function createUrlFormatError(url: string): EngineError {
  return new EngineError("url_format", `Invalid URL format: ${url}`, 400);
}

export function createSecurityPolicyError(url: string): EngineError {
  return new EngineError(
    "url_security",
    `Blocked: target is a private or disallowed address (${url}).`,
    403,
  );
}

export function createNetworkError(
  cause: unknown,
  url: string,
  timeoutMs?: number,
): EngineError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new EngineError(
    "network",
    `Network error fetching ${url}: ${detail}`,
    timeoutMs ? 408 : 502,
  );
}

export function createTimeoutError(
  timeoutMs: number,
  url: string,
): EngineError {
  return new EngineError(
    "timeout",
    `Timed out after ${timeoutMs}ms fetching ${url}.`,
    408,
  );
}

export function createServerError(
  status: number,
  statusText: string,
  url: string,
  body?: string,
): EngineError {
  const truncated = body ? ` Body: ${body.slice(0, 500)}` : "";
  return new EngineError(
    "server",
    `Server returned ${status} ${statusText} for ${url}.${truncated}`,
    status >= 500 ? 502 : status,
  );
}

export function createContentError(message: string, url: string): EngineError {
  return new EngineError("content", `${message} (${url})`, 422);
}

export function createConversionError(url: string): EngineError {
  return new EngineError(
    "conversion",
    `Failed to convert the fetched content of ${url} to Markdown.`,
    500,
  );
}

export function createEmptyContentWarning(url: string): string {
  return `(Note: the page at ${url} returned content that converted to an empty document. It may be a JavaScript-only page with no server-rendered text.)`;
}
