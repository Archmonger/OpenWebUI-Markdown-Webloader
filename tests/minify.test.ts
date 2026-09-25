import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { resolveOptions } from "../src/options.js";
import {
  minifyHtml,
  minifyShouldRun,
  _resetMinifyForTests,
} from "../src/minify.js";
import { readUrl } from "../src/url-reader.js";
import { SimpleCache } from "../src/cache.js";

/**
 * A deterministic fixture document: large enough to clear `PREPROCESS_MIN_CHARS`,
 * full of collapsible whitespace, a table, a `<pre>` block, and explicit closing
 * tags. The last three are exactly what the SAFE minify options must preserve so
 * `node-html-markdown` keeps structuring the document. Served over HTTP by the
 * integration stub and also used directly as the `html` argument to `minifyHtml`.
 */
const FIXTURE_HTML =
  "<html>\n  <head>\n    <title>\n      Minify\n      Fixture\n    </title>\n  </head>\n" +
  "  <body>\n    <article>\n" +
  "      <h1>    Heading    with    gaps    </h1>\n" +
  "      <table>\n        <tr>\n          <td>one</td>\n          <td>two</td>\n        </tr>\n" +
  "        <tr>\n          <td>three</td>\n          <td>four</td>\n        </tr>\n      </table>\n" +
  "      <pre>\n        def f(  x  ):\n            return  x +  1\n      </pre>\n" +
  "      <p>    This    first    paragraph    is    intentionally    padded    with    many    extra    spaces    and    blank    lines    around    it.    </p>\n" +
  "      <p>    A    second    paragraph    here    to    push    the    document    comfortably    over    the    default    eight    hundred    character    pre-clean    threshold.    </p>\n" +
  "      <p>    And    a    third    closing    paragraph    so    the    whitespace    the    minifier    strips    is    a    meaningful    share    of    the    input.    </p>\n" +
  "    </article>\n  </body>\n</html>\n";

/** Build a config from a plain env object (mirrors ai-converter.test.ts). */
function cfg(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    API_PORT: "1",
    HOST: "127.0.0.1",
    ALLOW_PRIVATE_URLS: "true",
    LOG_LEVEL: "off",
    ...extra,
  } as NodeJS.ProcessEnv);
}

/** An executable script that reads stdin and writes it back unchanged. */
function makePassthrough(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `minify-${name}-`));
  const path = join(dir, name);
  writeFileSync(path, "#!/usr/bin/env bash\ncat\n");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  // Restore the real addon specifier + clear the cached loader so one test's
  // "missing addon" simulation cannot poison the others.
  _resetMinifyForTests();
});

// ---------------------------------------------------------------------------
// loadConfig: PREPROCESS_MINIFY_HTML parses and is OFF by default.
// ---------------------------------------------------------------------------
describe("loadConfig: PREPROCESS_MINIFY_HTML", () => {
  test("minify is OFF by default (opt-in)", () => {
    expect(cfg({}).preprocess.minify.enabled).toBe(false);
  });
  test("PREPROCESS_MINIFY_HTML=1 turns it on; =0/false off", () => {
    expect(cfg({ PREPROCESS_MINIFY_HTML: "1" }).preprocess.minify.enabled).toBe(
      true,
    );
    expect(
      cfg({ PREPROCESS_MINIFY_HTML: "true" }).preprocess.minify.enabled,
    ).toBe(true);
    expect(cfg({ PREPROCESS_MINIFY_HTML: "0" }).preprocess.minify.enabled).toBe(
      false,
    );
    expect(
      cfg({ PREPROCESS_MINIFY_HTML: "false" }).preprocess.minify.enabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// minifyShouldRun: mirrors the preprocess gate + the minify switch.
// ---------------------------------------------------------------------------
describe("minifyShouldRun", () => {
  test("off when preprocessing is disabled, even if minify is on", () => {
    expect(
      minifyShouldRun(
        cfg({ PREPROCESS_HTML: "0", PREPROCESS_MINIFY_HTML: "1" }),
        10_000,
      ),
    ).toBe(false);
  });
  test("off when minify is disabled, even if preprocessing is on", () => {
    expect(
      minifyShouldRun(
        cfg({ PREPROCESS_HTML: "1", PREPROCESS_MINIFY_HTML: "0" }),
        10_000,
      ),
    ).toBe(false);
  });
  test("off for documents below PREPROCESS_MIN_CHARS", () => {
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MINIFY_HTML: "1",
      PREPROCESS_MIN_CHARS: "800",
    });
    expect(minifyShouldRun(c, 799)).toBe(false);
    expect(minifyShouldRun(c, 800)).toBe(true);
  });
  test("on when preprocessing on, minify on, and at/over minChars", () => {
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MINIFY_HTML: "1",
      PREPROCESS_MIN_CHARS: "800",
    });
    expect(minifyShouldRun(c, 5000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// minifyHtml: the never-throw / never-lose contract + the safe-config guarantee.
// ---------------------------------------------------------------------------
describe("minifyHtml: behavior", () => {
  test("disabled -> returns the exact input unchanged", async () => {
    const out = await minifyHtml(
      FIXTURE_HTML,
      cfg({ PREPROCESS_MINIFY_HTML: "0" }),
    );
    expect(out).toBe(FIXTURE_HTML);
  });

  test("enabled -> shrinks the input (collapsible whitespace removed)", async () => {
    const out = await minifyHtml(
      FIXTURE_HTML,
      cfg({ PREPROCESS_MINIFY_HTML: "1" }),
    );
    expect(out).not.toBe(FIXTURE_HTML);
    expect(out.length).toBeLessThan(FIXTURE_HTML.length);
  });

  test("safe options are forced: closing tags survive minification", async () => {
    const out = await minifyHtml(
      FIXTURE_HTML,
      cfg({ PREPROCESS_MINIFY_HTML: "1" }),
    );
    // The minifier's DEFAULTS drop optional closing tags; our forced
    // keep_closing_tags must preserve them so downstream structure is intact.
    expect(out).toContain("</td>");
    expect(out).toContain("</tr>");
    expect(out).toContain("</p>");
    expect(out).toContain("</pre>");
  });

  test("empty output -> returns the original (never returns empty)", async () => {
    const onlyWhitespace = "   \n  \n  ";
    const out = await minifyHtml(
      onlyWhitespace,
      cfg({ PREPROCESS_MINIFY_HTML: "1", PREPROCESS_MIN_CHARS: "1" }),
    );
    // A whitespace-only doc minifies to nothing; we must hand back the original
    // so a conversion never sees an empty body.
    expect(out).toBe(onlyWhitespace);
  });

  test("missing native addon -> returns the original, does not throw", async () => {
    // Point the lazy loader at a package that does not exist.
    _resetMinifyForTests("./does/not/exist-minify-pkg");
    let out: string | null = null;
    let threw: unknown = null;
    try {
      out = await minifyHtml(
        FIXTURE_HTML,
        cfg({ PREPROCESS_MINIFY_HTML: "1" }),
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    expect(out).toBe(FIXTURE_HTML);
  });
});

// ---------------------------------------------------------------------------
// readUrl integration: the AI path receives minified HTML; the native path does not.
// The preprocessor is a passthrough (stdin->stdout) so `cleaned === raw` and we
// can assert precisely on the bytes the AI sidecar received vs. the native output.
// ---------------------------------------------------------------------------
interface AiStubState {
  calls: number;
  lastBody: { html?: string } | null;
}

function makeAiStub() {
  const state: AiStubState = { calls: 0, lastBody: null };
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
      state.lastBody = (await req.json()) as { html?: string };
      return Response.json({
        markdown: "# AI Generated\n\nConverted by ReaderLM.\n",
        tokens: 7,
        model: "ReaderLM-v2",
        latency_ms: 1,
      });
    },
  });
  return { server, state, url: `http://127.0.0.1:${server.port}` };
}

describe("readUrl: minify feeds the AI input, never the native output", () => {
  const PORT = 14941;
  let base: string;
  const passthrough = makePassthrough("passthrough");
  let fixtureStop: (() => void) | undefined;

  beforeAll(() => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: PORT,
      fetch: () =>
        new Response(FIXTURE_HTML, {
          headers: { "content-type": "text/html" },
        }),
    });
    base = `http://127.0.0.1:${PORT}`;
    fixtureStop = () => server.stop(true);
  });

  afterAll(() => {
    fixtureStop?.();
  });

  test("minify ON -> the sidecar receives minified (smaller, closing-tag-preserving) HTML", async () => {
    const stub = makeAiStub();
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_BINARY: passthrough,
      PREPROCESS_MIN_CHARS: "1",
      PREPROCESS_MINIFY_HTML: "1",
      AI_CONVERTER_ENABLED: "1",
      AI_SERVICE_URL: stub.url,
    });
    const r = await readUrl(
      `${base}/html`,
      resolveOptions(new Headers()),
      c,
      new SimpleCache(60_000, 10),
    );
    expect(r.converter).toBe("ai");
    expect(stub.state.calls).toBe(1);
    const aiInput = stub.state.lastBody?.html ?? "";
    // The model received a strictly smaller payload than the raw document ...
    expect(aiInput.length).toBeLessThan(FIXTURE_HTML.length);
    // ... yet the safe options kept the structure the parser depends on.
    expect(aiInput).toContain("</td>");
    expect(aiInput).toContain("</tr>");
    stub.server.stop(true);
  });

  test("minify OFF -> the sidecar receives the unminified cleaned HTML", async () => {
    const stub = makeAiStub();
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_BINARY: passthrough,
      PREPROCESS_MIN_CHARS: "1",
      PREPROCESS_MINIFY_HTML: "0",
      AI_CONVERTER_ENABLED: "1",
      AI_SERVICE_URL: stub.url,
    });
    await readUrl(
      `${base}/html`,
      resolveOptions(new Headers()),
      c,
      new SimpleCache(60_000, 10),
    );
    expect(stub.state.calls).toBe(1);
    // Passthrough preprocessor + minify off == the raw document, unchanged.
    expect(stub.state.lastBody?.html).toBe(FIXTURE_HTML);
    stub.server.stop(true);
  });

  test("native output is byte-identical whether minify is on or off", async () => {
    const mk = (minify: string) =>
      cfg({
        PREPROCESS_HTML: "1",
        PREPROCESS_BINARY: passthrough,
        PREPROCESS_MIN_CHARS: "1",
        PREPROCESS_MINIFY_HTML: minify,
        AI_CONVERTER_ENABLED: "0",
      });
    const on = await readUrl(
      `${base}/html`,
      resolveOptions(new Headers()),
      mk("1"),
      new SimpleCache(60_000, 10),
    );
    const off = await readUrl(
      `${base}/html`,
      resolveOptions(new Headers()),
      mk("0"),
      new SimpleCache(60_000, 10),
    );
    expect(on.converter).toBe("native");
    expect(off.converter).toBe("native");
    // Toggling minify must never change what a native (non-AI) deployment serves.
    expect(on.content).toBe(off.content);
    // And the native renderer still renders the table as a table (pipes) and NOT
    // a degenerate blockquote — the safe keep_closing_tags option preserved it.
    expect(on.content).toContain("|");
    expect(on.content).not.toContain("> one");
  });
});
