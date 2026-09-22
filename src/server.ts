/**
 * The Open-WebUI-compatible HTTP engine.
 *
 * Endpoints (mirrors Edgaras0x4E/web-loader-engine so the reference's client
 * works unchanged, and adds the exact Open-WebUI external-loader contract):
 *
 *   POST /              {urls:[...]}  -> JSON array of {page_content, metadata}
 *   POST /load          {url, options} -> LoadResponse
 *   POST /load/batch    {urls, options} -> BatchLoadResponse
 *   GET  /health        -> HealthResponse
 *
 * Authentication: when `API_KEY` is set, every endpoint (except /health)
 * requires `Authorization: Bearer <API_KEY>` — this is exactly what
 * Open-WebUI's `EXTERNAL_WEB_LOADER_API_KEY` sends.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";
import type {
  BatchLoadRequest,
  BatchLoadResult,
  BatchLoadResponse,
  HealthResponse,
  LoadRequest,
  LoadResponse,
  OpenWebUIDocument,
  ResponseFormat,
} from "./types.js";
import { EngineError } from "./error-handler.js";
import { resolveOptions } from "./options.js";
import { readUrl, type UrlReadResult } from "./url-reader.js";
import { getLastAiModel } from "./ai-converter.js";
import { SimpleCache } from "./cache.js";

const VERSION = "0.1.0";

export interface ServerHandle {
  port: number;
  stop: () => void;
}

/** Compare an `Authorization` header against the configured API key. */
function isAuthorized(headers: Headers, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  const header = headers.get("authorization") ?? "";
  const expected = `Bearer ${apiKey}`;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer(config: AppConfig): ServerHandle {
  const cache = new SimpleCache(config.cacheTtlMs, config.cacheMaxEntries);

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST,GET,OPTIONS",
        "access-control-allow-headers":
          "content-type,authorization,x-respond-with,x-no-cache,x-target-selector,x-remove-selector,x-wait-for-selector,x-timeout,x-user-agent,x-proxy-url,x-with-images-summary,x-with-links-summary,x-ai-convert",
      },
    });

  async function processUrl(
    url: string,
    headers: Headers,
    bodyOptions?: LoadRequest["options"],
  ): Promise<LoadResponse> {
    const options = resolveOptions(headers, bodyOptions);
    try {
      const result: UrlReadResult = await readUrl(url, options, config, cache);
      const response: LoadResponse = {
        url,
        content: result.content,
        metadata: {
          processingTimeMs: result.processingTimeMs,
          cached: result.cached,
          byteLength: result.byteLength,
        },
      };
      if (result.title) response.title = result.title;
      if (result.images?.length) response.images = result.images;
      if (result.links?.length) response.links = result.links;
      return response;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError(
        "unknown",
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
  }

  async function loadSingle(
    url: string,
    headers: Headers,
    bodyOptions?: LoadRequest["options"],
  ): Promise<BatchLoadResult> {
    try {
      return { url, response: await processUrl(url, headers, bodyOptions) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { url, error: message };
    }
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();

      // CORS preflight.
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST,GET,OPTIONS",
            "access-control-allow-headers":
              "content-type,authorization,x-respond-with,x-no-cache,x-target-selector,x-remove-selector,x-wait-for-selector,x-timeout,x-user-agent,x-proxy-url,x-with-images-summary,x-with-links-summary,x-ai-convert",
          },
        });
      }

      // /health is public.
      if (path === "/health" && method === "GET") {
        const converter: HealthResponse["converter"] = {
          ai_enabled: config.ai.enabled,
        };
        if (config.ai.enabled) {
          converter.ai_service_url = config.ai.serviceUrl;
          converter.ai_fallback_on_error = config.ai.fallbackOnError;
          // Populated after the first successful conversion; not fetched here
          // so /health never depends on the sidecar being reachable.
          const model = getLastAiModel();
          if (model) converter.ai_model = model;
        }
        const body: HealthResponse = {
          status: "ok",
          version: VERSION,
          cache: { size: cache.size },
          defaults: {
            respondWith: "markdown" as ResponseFormat,
            maxContentLengthBytes: config.maxContentLengthBytes,
            maxPdfPages: config.maxPdfPages,
            requestTimeoutMs: config.requestTimeoutMs,
          },
          converter,
        };
        return json(200, body);
      }

      // Auth for all other endpoints.
      if (!isAuthorized(request.headers, config.apiKey)) {
        return json(401, {
          error: "Unauthorized",
          message:
            "Missing or invalid API key. Send 'Authorization: Bearer <key>'.",
        });
      }

      try {
        // Open-WebUI external loader: POST {urls} -> [{page_content, metadata}]
        if (path === "/" && method === "POST") {
          const body = (await request.json()) as OpenWebUIDocument & {
            urls?: string[];
          };
          const urls = Array.isArray(body.urls)
            ? body.urls.filter((u) => typeof u === "string")
            : [];
          if (!Array.isArray(body.urls) || urls.length === 0) {
            return json(400, {
              error: "Bad Request",
              message:
                'Expected a JSON body of the form {"urls": ["https://..."]}.',
            });
          }
          if (urls.length > config.maxBatchUrls) {
            return json(400, {
              error: "Bad Request",
              message: `Too many URLs (max ${config.maxBatchUrls}).`,
            });
          }
          const options = resolveOptions(request.headers, body as any);
          const results: OpenWebUIDocument[] = [];
          // Track the first *upstream* failure so a total-failure batch does not
          // silently masquerade as a successful `200 []` (which Open-WebUI
          // cannot distinguish from "the page genuinely has no content"). A
          // content-derived outcome (empty page, unsupported type, etc.) is a
          // successful fetch that yielded no document, and is NOT treated as an
          // upstream HTTP failure.
          let firstUpstreamError: EngineError | undefined;
          // Process in small concurrent groups to bound resource use.
          for (let i = 0; i < urls.length; i += config.maxConcurrentUrls) {
            const group = urls.slice(i, i + config.maxConcurrentUrls);
            const settled = await Promise.all(
              group.map(async (target) => {
                try {
                  const result: UrlReadResult = await readUrl(
                    target,
                    options,
                    config,
                    cache,
                  );
                  const doc: OpenWebUIDocument = {
                    page_content: result.content,
                    metadata: { source: target },
                  };
                  if (result.title) doc.metadata.title = result.title;
                  return doc;
                } catch (error) {
                  // Continue on failure: skip failed URLs so a partial success
                  // still returns the documents that loaded (Open-WebUI's
                  // ExternalWebLoader continue_on_failure semantics). Only a
                  // genuine upstream HTTP error (type "server") is retained so
                  // an all-failed batch can surface the real status code.
                  if (
                    error instanceof EngineError &&
                    error.type === "server" &&
                    !firstUpstreamError
                  ) {
                    firstUpstreamError = error;
                  }
                  return null;
                }
              }),
            );
            for (const doc of settled) {
              if (doc) results.push(doc);
            }
          }
          // If every URL failed with an upstream HTTP error, surface that
          // status instead of an empty 200 so callers (and Open-WebUI) see the
          // real failure reason (e.g. a 404).
          if (results.length === 0 && firstUpstreamError) {
            return json(firstUpstreamError.status, {
              error: firstUpstreamError.type,
              message: firstUpstreamError.message,
            });
          }
          return json(200, results);
        }

        if (path === "/load" && method === "POST") {
          const body = (await request.json()) as LoadRequest;
          if (!body.url || typeof body.url !== "string") {
            return json(400, {
              error: "Bad Request",
              message:
                'Expected a JSON body of the form {"url": "https://..."}.',
            });
          }
          try {
            const response = await processUrl(
              body.url,
              request.headers,
              body.options,
            );
            return json(200, response);
          } catch (error) {
            if (error instanceof EngineError) {
              return json(error.status, {
                error: error.type,
                message: error.message,
              });
            }
            return json(500, { error: "unknown", message: String(error) });
          }
        }

        if (path === "/load/batch" && method === "POST") {
          const body = (await request.json()) as BatchLoadRequest;
          if (!Array.isArray(body.urls) || body.urls.length === 0) {
            return json(400, {
              error: "Bad Request",
              message:
                'Expected a JSON body of the form {"urls": ["https://..."]}.',
            });
          }
          if (body.urls.length > config.maxBatchUrls) {
            return json(400, {
              error: "Bad Request",
              message: `Too many URLs (max ${config.maxBatchUrls}).`,
            });
          }
          const started = Date.now();
          const results: BatchLoadResult[] = [];
          for (let i = 0; i < body.urls.length; i += config.maxConcurrentUrls) {
            const group = body.urls.slice(i, i + config.maxConcurrentUrls);
            const settled = await Promise.all(
              group.map((target) =>
                loadSingle(target, request.headers, body.options),
              ),
            );
            results.push(...settled);
          }
          return json(200, {
            results,
            totalProcessingTimeMs: Date.now() - started,
          } satisfies BatchLoadResponse);
        }

        return json(404, {
          error: "Not Found",
          message: `No endpoint at ${path}. Try POST / , /load, /load/batch, or GET /health.`,
        });
      } catch (error) {
        // Malformed JSON or unexpected parse errors.
        const message =
          error instanceof Error ? error.message : "Invalid request.";
        return json(400, { error: "Bad Request", message });
      }
    },
  });

  const port = server.port ?? 0; // runtime: always set by Bun.serve
  return { port, stop: () => server.stop(true) };
}

export function startServer(config: AppConfig): ServerHandle {
  const handle = createServer(config);
  // eslint-disable-next-line no-console
  console.log(
    `[openwebui-markdown-webloader] listening on http://${config.host}:${handle.port} ` +
      `(auth: ${config.apiKey ? "enabled" : "disabled"})`,
  );
  return handle;
}
