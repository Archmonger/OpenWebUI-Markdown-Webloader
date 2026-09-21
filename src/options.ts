/**
 * Resolve per-request options by layering the Open-WebUI-compatible `x-*`
 * request headers (and optional body options) over the engine defaults. This
 * is the same model the reference web-loader-engine uses, so a client that
 * already speaks that header set works unchanged.
 */
import type { Headers } from "undici";
import {
  isResponseFormat,
  type LoadOptions,
  type ResolvedOptions,
} from "./types.js";

function readString(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value && value.trim() !== "" ? value : undefined;
}

function readBool(headers: Headers, name: string): boolean {
  const value = headers.get(name);
  if (value === null) return false;
  return value === "true" || value === "1";
}

function readInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/**
 * Build resolved options from defaults + headers + body options.
 * Precedence (highest wins): body options > x-* headers > engine defaults.
 */
export function resolveOptions(
  headers: Headers,
  bodyOptions?: Partial<LoadOptions>,
): ResolvedOptions {
  const respondWithHeader = readString(headers, "x-respond-with");
  const respondWith =
    bodyOptions?.respondWith ??
    (respondWithHeader && isResponseFormat(respondWithHeader)
      ? (respondWithHeader as ResolvedOptions["respondWith"])
      : "markdown");

  const noCache = bodyOptions?.noCache ?? readBool(headers, "x-no-cache");

  const waitForSelector =
    bodyOptions?.waitForSelector ?? readString(headers, "x-wait-for-selector");
  const targetSelector =
    bodyOptions?.targetSelector ?? readString(headers, "x-target-selector");
  const removeSelector =
    bodyOptions?.removeSelector ?? readString(headers, "x-remove-selector");

  const timeout =
    bodyOptions?.timeout ?? readInt(headers, "x-timeout") ?? undefined;

  const userAgent =
    bodyOptions?.userAgent ?? readString(headers, "x-user-agent");
  const proxyUrl = bodyOptions?.proxyUrl ?? readString(headers, "x-proxy-url");

  const withImages =
    bodyOptions?.withImages ?? readBool(headers, "x-with-images-summary");
  const withLinks =
    bodyOptions?.withLinks ?? readBool(headers, "x-with-links-summary");

  // A per-request timeout, when given, can never exceed a sane ceiling so a
  // misbehaving client cannot pin a worker thread for hours.
  const resolvedTimeout =
    timeout !== undefined ? Math.min(timeout, 10 * 60 * 1000) : undefined;

  return {
    respondWith,
    noCache,
    waitForSelector,
    targetSelector,
    removeSelector,
    timeout: resolvedTimeout,
    userAgent,
    proxyUrl,
    withImages,
    withLinks,
  };
}
