import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { startFixture, type FixtureServer } from "./fixtures.js";

const FIXTURE_PORT = 14911;
const ENGINE_PORT = 14912;

let fixture: FixtureServer;
let engine: ServerHandle;
let config: AppConfig;
let engineUrl: string;
let fixtureBase: string;

beforeAll(() => {
  fixture = startFixture(FIXTURE_PORT);
  fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;
  config = loadConfig({
    API_PORT: String(ENGINE_PORT),
    HOST: "127.0.0.1",
    ALLOW_PRIVATE_URLS: "true",
    LOG_LEVEL: "off",
    URL_READ_MAX_CONTENT_LENGTH_BYTES: "4096",
  } as NodeJS.ProcessEnv);
  engine = createServer(config);
  engineUrl = `http://127.0.0.1:${engine.port}`;
});

afterAll(() => {
  engine.stop();
  fixture.stop(true);
});

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${engineUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("GET /health", () => {
  test("returns 200 with ok status and version", async () => {
    const res = await fetch(`${engineUrl}/health`);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(body.cache).toHaveProperty("size");
  });
});

describe("POST / (Open-WebUI external loader contract)", () => {
  test("returns a JSON array of documents with page_content + metadata", async () => {
    const res = await post("/", {
      urls: [`${fixtureBase}/html`, `${fixtureBase}/json`],
    });
    const body = (await res.json()) as any[];
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    // Open-WebUI reads exactly these keys:
    expect(body[0]).toHaveProperty("page_content");
    expect(body[0]).toHaveProperty("metadata");
    expect(body[0].metadata.source).toBe(`${fixtureBase}/html`);
    expect(body[0].metadata.title).toBe("Example Article");
    // html is converted to markdown
    expect(body[0].page_content).toContain("# Article Heading");
    expect(body[0].page_content).toContain(
      "[link](https://example.com/linked)",
    );
    // json is pretty-printed in a fence
    expect(body[1].page_content).toStartWith("```json");
    expect(body[1].page_content).toContain('"hello": "world"');
  });

  test("rejects an empty urls array", async () => {
    const res = await post("/", { urls: [] });
    expect(res.status).toBe(400);
  });

  test("rejects a missing urls key", async () => {
    const res = await post("/", {});
    expect(res.status).toBe(400);
  });

  test("caps the number of URLs per request", async () => {
    const urls = Array.from(
      { length: config.maxBatchUrls + 1 },
      () => `${fixtureBase}/text`,
    );
    const res = await post("/", { urls });
    expect(res.status).toBe(400);
  });

  test("continues on failure: a bad URL is skipped, good ones returned", async () => {
    const res = await post("/", {
      urls: [`${fixtureBase}/missing`, `${fixtureBase}/html`],
    });
    const body = (await res.json()) as any[];
    expect(res.status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0].metadata.source).toBe(`${fixtureBase}/html`);
  });
});

describe("POST /load", () => {
  test("returns markdown with title and metadata", async () => {
    const res = await post("/load", { url: `${fixtureBase}/html-fresh` });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.url).toBe(`${fixtureBase}/html-fresh`);
    expect(body.content).toContain("# Article Heading");
    expect(body.title).toBe("Example Article");
    expect(body.metadata).toHaveProperty("processingTimeMs");
    expect(body.metadata.cached).toBe(false);
  });

  test("second call to the same URL is served from cache with metadata intact", async () => {
    const res = await post("/load", { url: `${fixtureBase}/html-fresh` });
    const body = (await res.json()) as any;
    expect(body.metadata.cached).toBe(true);
    expect(body.title).toBe("Example Article");
    expect(body.content).toContain("# Article Heading");
  });

  test("x-no-cache forces a re-fetch", async () => {
    const res = await post(
      "/load",
      { url: `${fixtureBase}/html-fresh` },
      { "x-no-cache": "true" },
    );
    const body = (await res.json()) as any;
    expect(body.metadata.cached).toBe(false);
  });

  test("rejects a malformed url", async () => {
    const res = await post("/load", { url: "not a url" });
    expect(res.status).toBe(400);
  });

  test("rejects non-http(s) schemes", async () => {
    const res = await post("/load", { url: "ftp://example.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /load content-type handling", () => {
  test("xml is fenced as xml", async () => {
    const res = await post("/load", {
      url: `${fixtureBase}/xml`,
      options: { noCache: true },
    });
    const body = (await res.json()) as any;
    expect(body.content.startsWith("```xml")).toBe(true);
  });
  test("plain text is fenced as text", async () => {
    const res = await post("/load", {
      url: `${fixtureBase}/text`,
      options: { noCache: true },
    });
    const body = (await res.json()) as any;
    expect(body.content.startsWith("```text")).toBe(true);
  });
  test("pdf is extracted and fenced as text", async () => {
    const res = await post("/load", {
      url: `${fixtureBase}/pdf`,
      options: { noCache: true },
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.content.startsWith("```text")).toBe(true);
    expect(body.content).toContain("PDF MARKDOWN CONTENT");
  });
  test("binary is rejected with a content error", async () => {
    const res = await post("/load", { url: `${fixtureBase}/binary` });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(/Unsupported content type/i.test(body.message)).toBe(true);
  });
  test("html declaring a NUL byte in the prefix is rejected", async () => {
    const res = await post("/load", { url: `${fixtureBase}/nul` });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(/NUL byte|binary/i.test(body.message)).toBe(true);
  });
  test("an empty page is reported as empty content", async () => {
    const res = await post("/load", { url: `${fixtureBase}/empty` });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(/empty content/i.test(body.message)).toBe(true);
  });
  test("an upstream 500 maps to 502", async () => {
    const res = await post("/load", { url: `${fixtureBase}/error500` });
    expect(res.status).toBe(502);
  });
  test("an oversized body is rejected by the size limit", async () => {
    const res = await post("/load", { url: `${fixtureBase}/big` });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(/too large|exceeds/i.test(body.message)).toBe(true);
  });
});

describe("POST /load/batch", () => {
  test("returns one result per url with timing", async () => {
    const res = await post("/load/batch", {
      urls: [
        `${fixtureBase}/html`,
        `${fixtureBase}/json`,
        `${fixtureBase}/text`,
      ],
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.results.length).toBe(3);
    expect(typeof body.totalProcessingTimeMs).toBe("number");
    expect(body.results[0].url).toBe(`${fixtureBase}/html`);
    expect(body.results[0].response.content).toContain("# Article Heading");
  });

  test("per-url failures are reported inline without failing the batch", async () => {
    const res = await post("/load/batch", {
      urls: [`${fixtureBase}/html-fresh`, `${fixtureBase}/missing`],
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.results.length).toBe(2);
    expect(body.results[0].response).toBeDefined();
    expect(typeof body.results[1].error).toBe("string");
    expect(body.results[1].response).toBeUndefined();
  });

  test("rejects an empty urls array", async () => {
    const res = await post("/load/batch", { urls: [] });
    expect(res.status).toBe(400);
  });
});

describe("redirect handling", () => {
  test("follows a redirect to the final document", async () => {
    const res = await post("/load", {
      url: `${fixtureBase}/redirect-html`,
      options: { noCache: true },
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.content).toContain("# Article Heading");
  });
  test("fails when a redirect loops past the cap", async () => {
    const res = await post("/load", { url: `${fixtureBase}/redirect-loop-a` });
    expect(res.status).toBe(422);
  });
});

describe("SSRF protection (hardened engine)", () => {
  let hardened: ServerHandle;
  let hardenedUrl: string;
  beforeAll(() => {
    hardened = createServer(
      loadConfig({
        API_PORT: String(ENGINE_PORT + 1),
        HOST: "127.0.0.1",
        ALLOW_PRIVATE_URLS: "false",
        LOG_LEVEL: "off",
      } as NodeJS.ProcessEnv),
    );
    hardenedUrl = `http://127.0.0.1:${hardened.port}`;
  });
  afterAll(() => hardened.stop());

  const hpost = (body: unknown) =>
    fetch(`${hardenedUrl}/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test.each([
    "http://169.254.169.254/latest/meta-data", // cloud metadata
    "http://127.0.0.1:1",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://localhost/",
  ])("blocks private address %s", async (url) => {
    const res = await hpost({ url });
    expect(res.status).toBe(403);
  });

  test("does not block a public hostname", async () => {
    const res = await hpost({ url: "https://example.com/" });
    // public -> must not be a security-policy 403 (may be 200 or a network error)
    expect(res.status).not.toBe(403);
  });
});

describe("authentication", () => {
  let authed: ServerHandle;
  let authedUrl: string;
  beforeAll(() => {
    authed = createServer(
      loadConfig({
        API_PORT: String(ENGINE_PORT + 2),
        HOST: "127.0.0.1",
        ALLOW_PRIVATE_URLS: "true",
        LOG_LEVEL: "off",
        API_KEY: "test-secret-key",
      } as NodeJS.ProcessEnv),
    );
    authedUrl = `http://127.0.0.1:${authed.port}`;
  });
  afterAll(() => authed.stop());

  test("401 without a key", async () => {
    const res = await fetch(`${authedUrl}/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${fixtureBase}/html` }),
    });
    expect(res.status).toBe(401);
  });

  test("401 with a wrong key", async () => {
    const res = await fetch(`${authedUrl}/load`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ url: `${fixtureBase}/html` }),
    });
    expect(res.status).toBe(401);
  });

  test("200 with the correct key", async () => {
    const res = await fetch(`${authedUrl}/load`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret-key",
      },
      body: JSON.stringify({ url: `${fixtureBase}/html` }),
    });
    expect(res.status).toBe(200);
  });

  test("health remains public under auth", async () => {
    const res = await fetch(`${authedUrl}/health`);
    expect(res.status).toBe(200);
  });
});
