// End-to-end smoke: boot the real engine against a local fixture and hit every
// route. Run with: bun tests/smoke.ts
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { startFixture } from "./fixtures.js";

const FIXTURE_PORT = 14899;
const ENGINE_PORT = 14900;

const fixture = startFixture(FIXTURE_PORT);
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;

const config = loadConfig({
  API_PORT: String(ENGINE_PORT),
  HOST: "127.0.0.1",
  ALLOW_PRIVATE_URLS: "true",
  LOG_LEVEL: "warn",
  URL_READ_MAX_CONTENT_LENGTH_BYTES: "4096",
} as NodeJS.ProcessEnv);

const engine = createServer(config);
const engineUrl = `http://127.0.0.1:${engine.port}`;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(
      `  FAIL  ${name}`,
      detail !== undefined ? `-> ${JSON.stringify(detail)}` : "",
    );
  }
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${engineUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

async function main() {
  console.log("== GET /health ==");
  {
    const res = await fetch(`${engineUrl}/health`);
    const body: any = await res.json();
    check("health 200", res.status === 200);
    check("health status ok", body.status === "ok", body);
    check("health version", typeof body.version === "string");
  }

  console.log("== POST / (Open-WebUI contract) ==");
  {
    const res = await post("/", {
      urls: [`${fixtureBase}/html`, `${fixtureBase}/json`],
    });
    const body = (await res.json()) as any[];
    check("openwebui 200", res.status === 200);
    check("openwebui array", Array.isArray(body), body);
    check(
      "openwebui two docs",
      body.length === 2,
      body?.map((d) => d.metadata?.source),
    );
    const htmlDoc = body[0];
    check("doc.page_content string", typeof htmlDoc.page_content === "string");
    check(
      "html->markdown h1",
      htmlDoc.page_content.includes("# Article Heading"),
      htmlDoc.page_content?.slice(0, 200),
    );
    check(
      "html->markdown link",
      htmlDoc.page_content.includes("[link](https://example.com/linked)"),
      htmlDoc.page_content?.slice(0, 400),
    );
    check(
      "doc.metadata.source",
      htmlDoc.metadata.source === `${fixtureBase}/html`,
    );
    check(
      "doc.metadata.title",
      htmlDoc.metadata.title === "Example Article",
      htmlDoc.metadata,
    );
    const jsonDoc = body[1];
    check(
      "json fenced",
      jsonDoc.page_content.startsWith("```json"),
      jsonDoc.page_content?.slice(0, 120),
    );
    check(
      "json pretty",
      jsonDoc.page_content.includes('"hello": "world"'),
      jsonDoc.page_content,
    );
  }

  console.log("== POST /load (single) ==");
  // /html-fresh is a distinct URL from the /html used above, so the first
  // call below is guaranteed to be a fresh fetch (the cache is keyed by URL).
  {
    const res = await post("/load", { url: `${fixtureBase}/html-fresh` });
    const body: any = await res.json();
    check("load 200", res.status === 200);
    check("load url", body.url === `${fixtureBase}/html-fresh`);
    check("load markdown", body.content.includes("# Article Heading"));
    check(
      "load metadata.processingTimeMs",
      typeof body.metadata.processingTimeMs === "number",
    );
    check(
      "load metadata.cached false on first call",
      body.metadata.cached === false,
      body.metadata,
    );
    check("load title", body.title === "Example Article", body.title);
  }
  // cache hit on second call to the same URL
  {
    const res = await post("/load", { url: `${fixtureBase}/html-fresh` });
    const body: any = await res.json();
    check(
      "load cached true on 2nd call",
      body.metadata.cached === true,
      body.metadata,
    );
    check(
      "cache hit keeps title",
      body.title === "Example Article",
      body.title,
    );
    check(
      "cache hit keeps markdown",
      body.content.includes("# Article Heading"),
    );
  }
  // no-cache header forces a re-fetch even after a cache entry exists
  {
    const res = await post(
      "/load",
      { url: `${fixtureBase}/html-fresh` },
      { "x-no-cache": "true" },
    );
    const body: any = await res.json();
    check(
      "load no-cache header",
      body.metadata.cached === false,
      body.metadata,
    );
  }
  // x-respond-with text
  {
    const res = await post(
      "/load",
      { url: `${fixtureBase}/json` },
      { "x-respond-with": "markdown" },
    );
    check("x-respond-with markdown still works", res.status === 200);
  }

  console.log("== POST /load/batch ==");
  {
    const res = await post("/load/batch", {
      urls: [
        `${fixtureBase}/html`,
        `${fixtureBase}/json`,
        `${fixtureBase}/text`,
      ],
    });
    const body: any = await res.json();
    check("batch 200", res.status === 200);
    check(
      "batch results len",
      body.results.length === 3,
      body.results?.map((r: any) => r.url),
    );
    check("batch total time", typeof body.totalProcessingTimeMs === "number");
    check(
      "batch per-result url",
      body.results[0].url === `${fixtureBase}/html`,
    );
  }
  // batch with a failing url continues
  {
    const res = await post("/load/batch", {
      urls: [`${fixtureBase}/html`, `${fixtureBase}/missing`],
    });
    const body: any = await res.json();
    check("batch continue-on-failure 200", res.status === 200);
    check(
      "batch failing url has error",
      typeof body.results[1].error === "string",
      body.results[1],
    );
    check(
      "batch failing url response null/absent",
      body.results[1].response === undefined,
      body.results[1],
    );
  }

  console.log("== content-type handling via /load ==");
  {
    const res = await post("/load", { url: `${fixtureBase}/xml` });
    const body: any = await res.json();
    check(
      "xml fenced",
      body.content.startsWith("```xml"),
      body.content?.slice(0, 80),
    );
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/text` });
    const body: any = await res.json();
    check(
      "text fenced",
      body.content.startsWith("```text"),
      body.content?.slice(0, 80),
    );
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/pdf` });
    const body: any = await res.json();
    check("pdf 200", res.status === 200, body);
    check(
      "pdf fenced text",
      body.content.startsWith("```text"),
      body.content?.slice(0, 120),
    );
    check(
      "pdf contains extracted text",
      body.content.includes("PDF MARKDOWN CONTENT"),
      body.content?.slice(0, 120),
    );
  }

  console.log("== error handling via /load ==");
  {
    const res = await post("/load", { url: `${fixtureBase}/binary` });
    check("binary rejected 422", res.status === 422, { status: res.status });
    const body: any = await res.json();
    check(
      "binary error message",
      /Unsupported content type/i.test(body.message),
      body,
    );
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/nul` });
    check("nul-sniff 422", res.status === 422, { status: res.status });
    const body: any = await res.json();
    check("nul message", /NUL byte|binary/i.test(body.message), body);
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/empty` });
    check("empty 422", res.status === 422, { status: res.status });
    const body: any = await res.json();
    check("empty message", /empty content/i.test(body.message), body);
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/error500` });
    check("500 -> 502", res.status === 502, { status: res.status });
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/big` });
    check("big 422 (size limit)", res.status === 422, { status: res.status });
    const body: any = await res.json();
    check("big message size", /too large|exceeds/i.test(body.message), body);
  }
  {
    const res = await post("/load", { url: "not-a-url" });
    check("bad url 400", res.status === 400, { status: res.status });
  }
  {
    const res = await post("/load", { url: "ftp://example.com/x" });
    check("non-http 400", res.status === 400, { status: res.status });
  }

  console.log("== redirects ==");
  {
    const res = await post("/load", { url: `${fixtureBase}/redirect-html` });
    const body: any = await res.json();
    check("redirect follows to 200", res.status === 200, {
      status: res.status,
    });
    check("redirect content", body.content.includes("# Article Heading"));
  }
  {
    const res = await post("/load", { url: `${fixtureBase}/redirect-loop-a` });
    check("redirect loop 422", res.status === 422, { status: res.status });
  }

  console.log("== SSRF protection (hardened engine, private URLs blocked) ==");
  {
    // The main engine above runs with ALLOW_PRIVATE_URLS=true (so it can reach
    // the local fixture). SSRF rejection is verified against
    // a hardened engine where the private-range checks are active.
    const hardened = createServer(
      loadConfig({
        API_PORT: String(ENGINE_PORT + 2),
        HOST: "127.0.0.1",
        ALLOW_PRIVATE_URLS: "false",
        LOG_LEVEL: "off",
      } as NodeJS.ProcessEnv),
    );
    const hu = `http://127.0.0.1:${hardened.port}`;
    const hpost = (path: string, body: unknown) =>
      fetch(`${hu}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // 169.254.169.254 is link-local (cloud metadata) -> blocked by static check
    const resLink = await hpost("/load", {
      url: "http://169.254.169.254/latest/meta-data",
    });
    check("ssrf link-local blocked 403", resLink.status === 403, {
      status: resLink.status,
    });

    const resLoop = await hpost("/load", { url: "http://127.0.0.1:1" });
    check("ssrf loopback blocked 403", resLoop.status === 403, {
      status: resLoop.status,
    });

    const resV4 = await hpost("/load", { url: "http://192.168.1.1/" });
    check("ssrf private v4 blocked 403", resV4.status === 403, {
      status: resV4.status,
    });

    const resV6 = await hpost("/load", { url: "http://[::1]/" });
    check("ssrf ipv6 loopback blocked 403", resV6.status === 403, {
      status: resV6.status,
    });

    // A public-looking hostname is still allowed through the hardened engine.
    const resPub = await hpost("/load", { url: "https://example.com/" });
    // example.com is public -> must NOT be a 403. It may be 200 (if egress is
    // allowed) or a network/timeout error, but never a security-policy 403.
    check("ssrf public host not blocked", resPub.status !== 403, {
      status: resPub.status,
    });

    hardened.stop();
  }

  console.log("== auth (separate engine with API key) ==");
  {
    const authEngine = createServer(
      loadConfig({
        API_PORT: String(ENGINE_PORT + 1),
        HOST: "127.0.0.1",
        ALLOW_PRIVATE_URLS: "true",
        LOG_LEVEL: "off",
        API_KEY: "secret-key-123",
      } as NodeJS.ProcessEnv),
    );
    const au = `http://127.0.0.1:${authEngine.port}`;
    const noAuth = await fetch(`${au}/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${fixtureBase}/html` }),
    });
    check("auth: missing key 401", noAuth.status === 401, {
      status: noAuth.status,
    });
    const badAuth = await fetch(`${au}/load`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ url: `${fixtureBase}/html` }),
    });
    check("auth: wrong key 401", badAuth.status === 401, {
      status: badAuth.status,
    });
    const okAuth = await fetch(`${au}/load`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-key-123",
      },
      body: JSON.stringify({ url: `${fixtureBase}/html` }),
    });
    check("auth: right key 200", okAuth.status === 200, {
      status: okAuth.status,
    });
    const healthNoAuth = await fetch(`${au}/health`);
    check("auth: health public", healthNoAuth.status === 200, {
      status: healthNoAuth.status,
    });
    authEngine.stop();
  }

  engine.stop();
  fixture.stop(true);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE CRASHED", err);
  process.exit(2);
});
