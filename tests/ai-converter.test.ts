import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { resolveOptions } from "../src/options.js";
import {
  aiShouldAttempt,
  aiConvertHtml,
  maybeAiConvert,
} from "../src/ai-converter.js";
import { readUrl, cacheKeyFor, aiCacheKeyFor } from "../src/url-reader.js";
import { SimpleCache } from "../src/cache.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { EngineError } from "../src/error-handler.js";

// ---------------------------------------------------------------------------
// Stub AI converter sidecar (mirrors ai-converter/server.py's contract).
// ---------------------------------------------------------------------------
interface StubState {
  calls: number;
  lastBody: any;
  lastAuth: string | null;
}

type StubMode = "ok" | "empty" | "bad_type" | "error" | "slow";

function makeStub(
  mode: StubMode,
  opts: { token?: string; latencyMs?: number } = {},
) {
  const state: StubState = { calls: 0, lastBody: null, lastAuth: null };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: "ReaderLM-v2" });
      }
      if (url.pathname !== "/convert") {
        return new Response("nope", { status: 404 });
      }
      state.calls += 1;
      state.lastAuth = req.headers.get("authorization");
      state.lastBody = await req.json();
      if (opts.token && state.lastAuth !== `Bearer ${opts.token}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (mode === "error") {
        return Response.json(
          { error: "convert_failed", message: "boom" },
          { status: 500 },
        );
      }
      if (mode === "slow") {
        await new Promise((r) => setTimeout(r, opts.latencyMs ?? 500));
      }
      if (mode === "empty") {
        return Response.json({ markdown: "", tokens: 0, model: "x" });
      }
      if (mode === "bad_type") {
        return Response.json({ markdown: 12345 });
      }
      return Response.json({
        markdown: "# AI Generated\n\nConverted by ReaderLM.",
        tokens: 42,
        model: "ReaderLM-v2",
        latency_ms: 12.3,
      });
    },
  });
  return { server, state, url: `http://127.0.0.1:${server.port}` };
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    API_PORT: "1",
    HOST: "127.0.0.1",
    ALLOW_PRIVATE_URLS: "true",
    LOG_LEVEL: "off",
    ...extra,
  } as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// loadConfig: AI defaults are OFF and parse correctly when set.
// ---------------------------------------------------------------------------
describe("AI config defaults", () => {
  test("disabled by default with sane values", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.ai.enabled).toBe(false);
    expect(cfg.ai.serviceUrl).toBe("http://localhost:8090");
    expect(cfg.ai.fallbackOnError).toBe(true);
    expect(cfg.ai.maxNewTokens).toBe(8192);
    expect(cfg.ai.temperature).toBe(0.0);
    expect(cfg.ai.topK).toBe(1);
    expect(cfg.ai.cacheAiOutput).toBe(true);
    expect(cfg.ai.seed).toBeUndefined();
  });

  test("trailing slash trimmed from service URL", () => {
    const cfg = loadConfig(baseEnv({ AI_SERVICE_URL: "http://x:9/" }));
    expect(cfg.ai.serviceUrl).toBe("http://x:9");
  });

  test("parses enabled + overrides + seed", () => {
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "true",
        AI_FALLBACK_ON_ERROR: "0",
        AI_MAX_NEW_TOKENS: "1024",
        AI_TEMPERATURE: "0.7",
        AI_SEED: "42",
        AI_MAX_HTML_CHARS: "123",
        AI_CACHE_OUTPUT: "false",
      }),
    );
    expect(cfg.ai.enabled).toBe(true);
    expect(cfg.ai.fallbackOnError).toBe(false);
    expect(cfg.ai.maxNewTokens).toBe(1024);
    expect(cfg.ai.temperature).toBe(0.7);
    expect(cfg.ai.seed).toBe(42);
    expect(cfg.ai.maxHtmlChars).toBe(123);
    expect(cfg.ai.cacheAiOutput).toBe(false);
  });

  test("fallbackOnError defaults true even when only enabled is set", () => {
    const cfg = loadConfig(baseEnv({ AI_CONVERTER_ENABLED: "1" }));
    expect(cfg.ai.enabled).toBe(true);
    expect(cfg.ai.fallbackOnError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aiShouldAttempt: the routing gate.
// ---------------------------------------------------------------------------
describe("aiShouldAttempt gate", () => {
  const disabled = loadConfig(baseEnv());
  const enabled = loadConfig(baseEnv({ AI_CONVERTER_ENABLED: "1" }));
  const win = loadConfig(
    baseEnv({
      AI_CONVERTER_ENABLED: "1",
      AI_MIN_HTML_CHARS: "100",
      AI_MAX_HTML_CHARS: "1000",
    }),
  );
  const on = resolveOptions(new Headers()); // aiConvert undefined
  const off = resolveOptions(new Headers(), { aiConvert: false });

  test("false when feature disabled", () => {
    expect(aiShouldAttempt(disabled, on, 500)).toBe(false);
  });
  test("true when enabled, no opt-out, within window", () => {
    expect(aiShouldAttempt(enabled, on, 500)).toBe(true);
  });
  test("false on per-request opt-out even if enabled", () => {
    expect(aiShouldAttempt(enabled, off, 500)).toBe(false);
  });
  test("false below min chars", () => {
    expect(aiShouldAttempt(win, on, 50)).toBe(false);
  });
  test("false above max chars", () => {
    expect(aiShouldAttempt(win, on, 5000)).toBe(false);
  });
  test("true within explicit window", () => {
    expect(aiShouldAttempt(win, on, 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aiConvertHtml: HTTP client against the stub.
// ---------------------------------------------------------------------------
describe("aiConvertHtml client", () => {
  test("success returns markdown/tokens/model", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const res = await aiConvertHtml("<html><body>hi</body></html>", cfg);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.markdown).toContain("AI Generated");
      expect(res.tokens).toBe(42);
      expect(res.model).toBe("ReaderLM-v2");
    }
    expect(stub.state.lastBody.html).toContain("hi");
    stub.server.stop(true);
  });

  test("sends bearer token when configured", async () => {
    const stub = makeStub("ok", { token: "s3cr3t" });
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: stub.url,
        AI_CONVERTER_TOKEN: "s3cr3t",
      }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(true);
    expect(stub.state.lastAuth).toBe("Bearer s3cr3t");
    stub.server.stop(true);
  });

  test("auth mismatch -> failure", async () => {
    const stub = makeStub("ok", { token: "right" });
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: stub.url,
        AI_CONVERTER_TOKEN: "wrong",
      }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("401");
    stub.server.stop(true);
  });

  test("empty markdown -> failure", async () => {
    const stub = makeStub("empty");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("empty");
    stub.server.stop(true);
  });

  test("non-string markdown -> failure", async () => {
    const stub = makeStub("bad_type");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(false);
    stub.server.stop(true);
  });

  test("500 from sidecar -> failure", async () => {
    const stub = makeStub("error");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("500");
    stub.server.stop(true);
  });

  test("unreachable sidecar -> failure (never throws)", async () => {
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: "http://127.0.0.1:1",
      }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("unreachable");
  });

  test("timeout -> failure", async () => {
    const stub = makeStub("slow", { latencyMs: 400 });
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: stub.url,
        AI_CONVERT_TIMEOUT_MS: "80",
      }),
    );
    const res = await aiConvertHtml("<b>x</b>", cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("timed out");
    stub.server.stop(true);
  });
});

// ---------------------------------------------------------------------------
// maybeAiConvert: fallback vs raise.
// ---------------------------------------------------------------------------
describe("maybeAiConvert", () => {
  const noop = () => {};
  test("returns ai on success", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const out = await maybeAiConvert(
      "<b>x</b>",
      "NATIVE",
      "http://u",
      cfg,
      noop,
    );
    expect(out.converter).toBe("ai");
    expect(out.markdown).toContain("AI Generated");
    stub.server.stop(true);
  });
  test("returns fallback when enabled but sidecar down + fallbackOnError", async () => {
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: "http://127.0.0.1:1",
      }),
    );
    const out = await maybeAiConvert(
      "<b>x</b>",
      "NATIVE",
      "http://u",
      cfg,
      noop,
    );
    expect(out.converter).toBe("fallback");
    expect(out.markdown).toBe("NATIVE");
  });
  test("throws when fallbackOnError is false and sidecar down", async () => {
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: "http://127.0.0.1:1",
        AI_FALLBACK_ON_ERROR: "0",
      }),
    );
    let threw: unknown = null;
    try {
      await maybeAiConvert("<b>x</b>", "NATIVE", "http://u", cfg, noop);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(EngineError);
    expect((threw as EngineError).type).toBe("conversion");
    expect((threw as EngineError).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// readUrl integration: the actual request path through the loader.
// ---------------------------------------------------------------------------
const FIXTURE_PORT = 14931;
let fixture: ReturnType<typeof Bun.serve>;
let fixtureBase: string;

beforeAll(() => {
  fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: FIXTURE_PORT,
    fetch: (req: Request) => {
      const p = new URL(req.url).pathname;
      if (p === "/html") {
        return new Response(
          "<html><head><title>T</title></head><body><h1>Native Heading</h1><p>hello</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (p === "/json") {
        return new Response(JSON.stringify({ a: 1 }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nf", { status: 404 });
    },
  });
  fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
});

afterAll(() => {
  fixture.stop(true);
});

describe("readUrl AI integration", () => {
  test("AI disabled -> native converter, no sidecar call", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(baseEnv({ AI_SERVICE_URL: stub.url })); // enabled not set
    const cache = new SimpleCache(60_000, 10);
    const r = await readUrl(
      `${fixtureBase}/html`,
      resolveOptions(new Headers()),
      cfg,
      cache,
    );
    expect(r.converter).toBe("native");
    expect(r.content).toContain("Native Heading");
    expect(stub.state.calls).toBe(0);
    stub.server.stop(true);
  });

  test("AI enabled -> converter=ai, cached under ai: lane", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const cache = new SimpleCache(60_000, 10);
    const opts = resolveOptions(new Headers());
    const r = await readUrl(`${fixtureBase}/html`, opts, cfg, cache);
    expect(r.converter).toBe("ai");
    expect(r.content).toContain("AI Generated");
    expect(stub.state.calls).toBe(1);

    // Second call should hit the AI cache lane and NOT call the stub again.
    const r2 = await readUrl(`${fixtureBase}/html`, opts, cfg, cache);
    expect(r2.cached).toBe(true);
    expect(r2.converter).toBe("ai");
    expect(stub.state.calls).toBe(1);
    // The AI result lives under the ai-namespaced key, not the plain key.
    expect(
      cache.get(aiCacheKeyFor(`${fixtureBase}/html`, opts)),
    ).not.toBeNull();
    expect(cache.get(cacheKeyFor(`${fixtureBase}/html`, opts))).toBeNull();
    stub.server.stop(true);
  });

  test("per-request opt-out -> native even when AI enabled", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const cache = new SimpleCache(60_000, 10);
    const opts = resolveOptions(new Headers(), { aiConvert: false });
    const r = await readUrl(`${fixtureBase}/html`, opts, cfg, cache);
    expect(r.converter).toBe("native");
    expect(stub.state.calls).toBe(0);
    stub.server.stop(true);
  });

  test("AI enabled + header opt-out -> native", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const cache = new SimpleCache(60_000, 10);
    // Resolve options from a header carrying x-ai-convert: 0.
    const headers = new Headers({ "x-ai-convert": "0" });
    const opts = resolveOptions(headers);
    expect(opts.aiConvert).toBe(false);
    const r = await readUrl(`${fixtureBase}/html`, opts, cfg, cache);
    expect(r.converter).toBe("native");
    expect(stub.state.calls).toBe(0);
    stub.server.stop(true);
  });

  test("AI enabled but sidecar down -> fallback to native", async () => {
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: "http://127.0.0.1:1",
      }),
    );
    const cache = new SimpleCache(60_000, 10);
    const r = await readUrl(
      `${fixtureBase}/html`,
      resolveOptions(new Headers()),
      cfg,
      cache,
    );
    expect(r.converter).toBe("fallback");
    expect(r.content).toContain("Native Heading");
  });

  test("AI enabled, sidecar down, no fallback -> EngineError 500", async () => {
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: "http://127.0.0.1:1",
        AI_FALLBACK_ON_ERROR: "0",
      }),
    );
    const cache = new SimpleCache(60_000, 10);
    let threw: unknown = null;
    try {
      await readUrl(
        `${fixtureBase}/html`,
        resolveOptions(new Headers()),
        cfg,
        cache,
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(EngineError);
    expect((threw as EngineError).status).toBe(500);
  });

  test("non-HTML (json) is never AI-routed", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({ AI_CONVERTER_ENABLED: "1", AI_SERVICE_URL: stub.url }),
    );
    const cache = new SimpleCache(60_000, 10);
    const r = await readUrl(
      `${fixtureBase}/json`,
      resolveOptions(new Headers()),
      cfg,
      cache,
    );
    expect(r.converter).toBeUndefined();
    expect(r.content).toStartWith("```json");
    expect(stub.state.calls).toBe(0);
    stub.server.stop(true);
  });

  test("cacheAiOutput=false keeps AI result out of the cache lane", async () => {
    const stub = makeStub("ok");
    const cfg = loadConfig(
      baseEnv({
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: stub.url,
        AI_CACHE_OUTPUT: "false",
      }),
    );
    const cache = new SimpleCache(60_000, 10);
    const opts = resolveOptions(new Headers());
    const r = await readUrl(`${fixtureBase}/html`, opts, cfg, cache);
    expect(r.converter).toBe("ai");
    // With cacheAiOutput off, the AI doc is not stored under the ai: key.
    expect(cache.get(aiCacheKeyFor(`${fixtureBase}/html`, opts))).toBeNull();
    // A second call must hit the sidecar again (no AI cache to serve).
    await readUrl(`${fixtureBase}/html`, opts, cfg, cache);
    expect(stub.state.calls).toBe(2);
    stub.server.stop(true);
  });
});

// ---------------------------------------------------------------------------
// /health converter block reflects AI state (no sidecar dependency).
// ---------------------------------------------------------------------------
describe("health converter block", () => {
  test("ai_enabled reflects config; token never leaked", async () => {
    const cfg = loadConfig(
      baseEnv({
        API_PORT: "14933",
        AI_CONVERTER_ENABLED: "1",
        AI_SERVICE_URL: "http://ai.example:8090",
        AI_CONVERTER_TOKEN: "secret-token",
      }),
    );
    cfg.port = 14933;
    const server: ServerHandle = createServer(cfg);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      const body = (await res.json()) as any;
      expect(body.converter.ai_enabled).toBe(true);
      expect(body.converter.ai_service_url).toBe("http://ai.example:8090");
      expect(body.converter.ai_fallback_on_error).toBe(true);
      // Token must never be serialized into /health.
      expect(JSON.stringify(body)).not.toContain("secret-token");
    } finally {
      server.stop();
    }
  });

  test("ai_enabled false by default", async () => {
    const cfg = loadConfig(baseEnv({ API_PORT: "14934" }));
    cfg.port = 14934;
    const server = createServer(cfg);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      const body = (await res.json()) as any;
      expect(body.converter.ai_enabled).toBe(false);
      expect(body.converter.ai_service_url).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});
