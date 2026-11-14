import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { preprocessHtml, preprocessShouldRun } from "../src/preprocess.js";
import { makeFakeCli } from "./helpers/fake-cli.js";

// Helper: build a config from env (PREPROCESS_* knobs map straight through, so
// binaryPath/timeout/min/max can all be driven from a plain env object).
function cfg(env: Record<string, string>): AppConfig {
  return loadConfig(env as NodeJS.ProcessEnv);
}

// A native executable (compiled once per test process) that emulates the
// `dom_smoothie_cli` contract. Unlike a bash script it also runs on Windows.

describe("loadConfig: PREPROCESS_* defaults", () => {
  test("preprocessing is ON by default with the CLI on PATH", () => {
    const c = cfg({});
    expect(c.preprocess.enabled).toBe(true);
    expect(c.preprocess.binaryPath).toBe("dom_smoothie_cli");
    expect(c.preprocess.timeoutMs).toBe(3000);
    expect(c.preprocess.maxElements).toBe(0); // 0 == unlimited
    expect(c.preprocess.minChars).toBe(800);
  });

  test("PREPROCESS_HTML=0 turns it off; =1 turns it on", () => {
    expect(cfg({ PREPROCESS_HTML: "0" }).preprocess.enabled).toBe(false);
    expect(cfg({ PREPROCESS_HTML: "1" }).preprocess.enabled).toBe(true);
    expect(cfg({ PREPROCESS_HTML: "false" }).preprocess.enabled).toBe(false);
    expect(cfg({ PREPROCESS_HTML: "true" }).preprocess.enabled).toBe(true);
  });

  test("overlays binary path, timeout, max-elements and min-chars", () => {
    const c = cfg({
      PREPROCESS_BINARY: "/opt/dom_smoothie_cli",
      PREPROCESS_TIMEOUT_MS: "1500",
      PREPROCESS_MAX_ELEMENTS: "4096",
      PREPROCESS_MIN_CHARS: "250",
    });
    expect(c.preprocess.binaryPath).toBe("/opt/dom_smoothie_cli");
    expect(c.preprocess.timeoutMs).toBe(1500);
    expect(c.preprocess.maxElements).toBe(4096);
    expect(c.preprocess.minChars).toBe(250);
  });

  test("max-elements accepts 0 (unlimited) and falls back on garbage", () => {
    expect(cfg({ PREPROCESS_MAX_ELEMENTS: "0" }).preprocess.maxElements).toBe(
      0,
    );
    // Negative / non-numeric -> fallback (0).
    expect(cfg({ PREPROCESS_MAX_ELEMENTS: "-5" }).preprocess.maxElements).toBe(
      0,
    );
    expect(cfg({ PREPROCESS_MAX_ELEMENTS: "x" }).preprocess.maxElements).toBe(
      0,
    );
  });
});

describe("preprocessShouldRun", () => {
  test("respects the master switch", () => {
    expect(preprocessShouldRun(cfg({ PREPROCESS_HTML: "0" }), 10_000)).toBe(
      false,
    );
    expect(preprocessShouldRun(cfg({ PREPROCESS_HTML: "1" }), 10_000)).toBe(
      true,
    );
  });

  test("skips documents below minChars", () => {
    const c = cfg({ PREPROCESS_HTML: "1", PREPROCESS_MIN_CHARS: "800" });
    expect(preprocessShouldRun(c, 799)).toBe(false);
    expect(preprocessShouldRun(c, 800)).toBe(true);
  });
});

describe("preprocessHtml: decision short-circuits (no spawn needed)", () => {
  const original = `<html><body>${"x".repeat(2000)}</body></html>`;

  test("disabled -> returns the exact original html", async () => {
    const c = cfg({ PREPROCESS_HTML: "0", PREPROCESS_BINARY: "/no/such/bin" });
    expect(await preprocessHtml(original, "https://x.test", c)).toBe(original);
  });

  test("short document -> returns the exact original html", async () => {
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "100000",
      PREPROCESS_BINARY: "/no/such/bin",
    });
    expect(await preprocessHtml(original, "https://x.test", c)).toBe(original);
  });
});

describe("preprocessHtml: real CLI contract via emulated binaries", () => {
  test("cleans via stdin->stdout and forwards document-url", async () => {
    const argsLog = join(mkdtempSync(join(tmpdir(), "pp-clean-")), "args.txt");
    const bin = makeFakeCli("cleaner", { mode: "clean", argsLog });
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
    });
    const input = `<html><body><nav>junk</nav><article>hi</article></body></html>`;
    const out = await preprocessHtml(input, "https://ex.test/page", c);

    expect(out).toContain('data-cleaned="1"'); // stdin flowed through
    const gotArgs = await Bun.file(argsLog).text();
    expect(gotArgs).toContain("--stdout");
    expect(gotArgs).toContain("-f html");
    expect(gotArgs).toContain("--document-url https://ex.test/page");
  });

  test("max-elements>0 adds the --max-elements arg; 0 omits it", async () => {
    const argsLog = join(mkdtempSync(join(tmpdir(), "pp-max-")), "args.txt");
    const bin = makeFakeCli("cap", { mode: "log-args", argsLog });
    const withCap = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
      PREPROCESS_MAX_ELEMENTS: "2048",
    });
    await preprocessHtml(
      `<html><body>${"y".repeat(100)}</body></html>`,
      "u",
      withCap,
    );
    let got = await Bun.file(argsLog).text();
    expect(got).toContain("--max-elements 2048");

    const noCap = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
      PREPROCESS_MAX_ELEMENTS: "0",
    });
    await preprocessHtml(
      `<html><body>${"y".repeat(100)}</body></html>`,
      "u",
      noCap,
    );
    got = await Bun.file(argsLog).text();
    expect(got).not.toContain("--max-elements");
  });

  test("non-zero exit -> falls back to original html (never throws)", async () => {
    const bin = makeFakeCli("fail", { mode: "fail" });
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
    });
    const input = "<html><body>body</body></html>";
    expect(await preprocessHtml(input, "u", c)).toBe(input);
  });

  test("empty stdout -> falls back to original html", async () => {
    const bin = makeFakeCli("empty", { mode: "empty" }); // consumes stdin, prints nothing
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
    });
    const input = "<html><body>keep me</body></html>";
    expect(await preprocessHtml(input, "u", c)).toBe(input);
  });

  test("whitespace-only stdout is treated as empty -> fallback", async () => {
    const bin = makeFakeCli("ws", { mode: "whitespace" });
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
    });
    const input = "<html><body>x</body></html>";
    expect(await preprocessHtml(input, "u", c)).toBe(input);
  });

  test("timeout -> kills the wedged child and returns original html", async () => {
    // Program that reads stdin then hangs well past our 200 ms budget.
    const bin = makeFakeCli("slow", { mode: "hang" });
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: bin,
      PREPROCESS_TIMEOUT_MS: "200",
    });
    const input = "<html><body>slow site</body></html>";
    const start = Date.now();
    const out = await preprocessHtml(input, "u", c);
    const elapsed = Date.now() - start;
    expect(out).toBe(input);
    // Returned via the timeout path, not after the 30 s sleep.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("preprocessHtml: missing binary degrades to raw html", () => {
  test("binary not on PATH -> original html, no throw", async () => {
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: "/this/binary/does/not/exist",
    });
    const input = "<html><body>fallback</body></html>";
    expect(await preprocessHtml(input, "u", c)).toBe(input);
  });
});

describe("preprocessHtml: optional real dom_smoothie_cli integration", () => {
  // Only exercised when a real binary is provided, e.g.:
  //   PREPROCESS_TEST_BINARY=./dom_smoothie/target/release/dom_smoothie_cli bun test
  const real = process.env.PREPROCESS_TEST_BINARY;
  const t = real ? test : test.skip;

  t("real binary cleans a document with boilerplate", async () => {
    const c = cfg({
      PREPROCESS_HTML: "1",
      PREPROCESS_MIN_CHARS: "10",
      PREPROCESS_BINARY: real as string,
    });
    const input = `<!doctype html><html><head><title>Doc</title></head><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <div id="content"><h1>Real Heading</h1>
      <p>${"This is the main article body that should be preserved. ".repeat(50)}</p>
      </div>
      <footer>© 2026 Footer Junk</footer></body></html>`;
    const out = await preprocessHtml(input, "https://example.test/doc", c);
    // Cleaned output keeps the article but drops nav/footer chrome and shrinks.
    expect(out).toContain("Real Heading");
    expect(out).toContain("main article body");
    expect(out).not.toContain("Footer Junk");
    expect(out.length).toBeLessThan(input.length);
  });
});
