/**
 * Client for the optional AI (ReaderLM) HTML→Markdown converter sidecar.
 *
 * The sidecar is a separate service (see `ai-converter/`) because the
 * `onnxruntime-genai` GPU runtime it needs cannot be embedded in the Bun
 * process. This module never throws on transport/parse failure: it returns a
 * tagged failure so the caller can fall back to the built-in
 * `node-html-markdown` renderer. The only case it can raise is when the
 * operator has explicitly disabled fallback (`AI_FALLBACK_ON_ERROR=0`) and the
 * sidecar fails — then a conversion error propagates.
 *
 * Security note: the sidecar converts HTML we hand it; it performs no network
 * fetching of our behalf, so routing HTML here adds no new SSRF surface. The
 * sidecar base URL is operator-controlled and is intentionally NOT sent through
 * the egress proxy (it is an internal service).
 */
import type { AppConfig } from "./config.js";
import type { ResolvedOptions } from "./types.js";
import { createConversionError } from "./error-handler.js";

export interface AiConvertSuccess {
  ok: true;
  markdown: string;
  tokens: number;
  model: string;
  latencyMs: number;
}

export interface AiConvertFailure {
  ok: false;
  reason: string;
}

export type AiConvertResult = AiConvertSuccess | AiConvertFailure;

/**
 * Model name from the most recent successful conversion, surfaced in /health
 * without pinging the sidecar. Updated on every AI success; never blocks.
 */
let lastAiModel: string | undefined;
export function getLastAiModel(): string | undefined {
  return lastAiModel;
}

/**
 * Decide whether a given HTML document should be routed through the AI
 * converter, given the resolved request options and server config. Kept pure so
 * it is trivially unit-testable and so the request path stays readable.
 */
export function aiShouldAttempt(
  config: AppConfig,
  options: ResolvedOptions,
  htmlLength: number,
): boolean {
  if (!config.ai.enabled) return false;
  // A per-request opt-out always wins.
  if (options.aiConvert === false) return false;
  if (htmlLength < config.ai.minHtmlChars) return false;
  // Documents larger than the configured ceiling are left to the native
  // renderer rather than silently truncated before the model.
  if (htmlLength > config.ai.maxHtmlChars) return false;
  return true;
}

/**
 * Ask the sidecar to convert `html` to Markdown. Returns a tagged result and
 * never throws for recoverable failures (network, timeout, non-2xx, bad JSON).
 */
export async function aiConvertHtml(
  html: string,
  config: AppConfig,
): Promise<AiConvertResult> {
  const { ai } = config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (ai.token) headers.authorization = `Bearer ${ai.token}`;

  const payload = {
    html,
    max_new_tokens: ai.maxNewTokens,
    temperature: ai.temperature,
    top_k: ai.topK,
    top_p: ai.topP,
    ...(ai.seed !== undefined ? { seed: ai.seed } : {}),
  };

  try {
    const res = await fetch(`${ai.serviceUrl}/convert`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await safeText(res);
      return {
        ok: false,
        reason: `AI converter returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      markdown?: unknown;
      tokens?: unknown;
      model?: unknown;
      latency_ms?: unknown;
    };
    if (typeof data.markdown !== "string" || data.markdown.trim() === "") {
      return { ok: false, reason: "AI converter returned empty markdown" };
    }
    return {
      ok: true,
      markdown: data.markdown,
      tokens: typeof data.tokens === "number" ? data.tokens : 0,
      model: typeof data.model === "string" ? data.model : "readerlm",
      latencyMs:
        typeof data.latency_ms === "number"
          ? data.latency_ms
          : Math.round(performance.now()),
    };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    return {
      ok: false,
      reason: aborted
        ? `AI converter timed out after ${ai.timeoutMs}ms`
        : `AI converter unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * High-level helper used by the request path: attempt AI conversion, and on
 * failure either fall back to the supplied native markdown or raise a
 * conversion error, depending on `fallbackOnError`.
 */
export async function maybeAiConvert(
  html: string,
  nativeMarkdown: string,
  url: string,
  config: AppConfig,
  log: (level: "info" | "debug" | "warn", msg: string) => void,
): Promise<{ markdown: string; converter: "ai" | "native" | "fallback" }> {
  const result = await aiConvertHtml(html, config);
  if (result.ok) {
    lastAiModel = result.model;
    log(
      "info",
      `ai-converted ${url} (${result.tokens} tok, model=${result.model})`,
    );
    return { markdown: result.markdown, converter: "ai" };
  }
  if (!config.ai.fallbackOnError) {
    throw createConversionError(`${url} (AI converter: ${result.reason})`);
  }
  log(
    "warn",
    `ai conversion failed for ${url}; using native: ${result.reason}`,
  );
  return { markdown: nativeMarkdown, converter: "fallback" };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
