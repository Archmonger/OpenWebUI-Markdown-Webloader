/**
 * HTML pre-cleaning via `dom_smoothie_cli` (a Rust port of Mozilla Readability).
 *
 * This runs BEFORE either markdown renderer (native `node-html-markdown` or the
 * AI ReaderLM sidecar) and strips navigation/header/footer boilerplate so the
 * document that reaches the renderer — or the model — is article content only.
 * Measured on a large Wikipedia article this removes ~43% of the HTML and ~40%
 * of the model input tokens while preserving headings, tables, code, and links,
 * at ~50 ms CPU per document.
 *
 * Design contract: THIS FUNCTION NEVER THROWS AND NEVER LOSES CONTENT. Any of:
 *   - the feature being disabled for this request,
 *   - the document being below `minChars`,
 *   - the binary being absent or not executable,
 *   - a spawn error, a non-zero exit, an empty stdout, or
 *   - the per-document timeout elapsing,
 * causes a silent fall back to the ORIGINAL html. The caller therefore always
 * receives a usable HTML string and never needs to branch on the outcome. This
 * keeps the request path safe even if the preprocessor is misconfigured or a
 * pathological document makes Readability choke.
 *
 * We shell out to the CLI rather than embedding a native binding so the loader
 * stays a pure Bun process: `dom_smoothie_cli --stdout -f html` reads an HTML
 * document on stdin and writes the cleaned main-content HTML on stdout.
 */
import type { AppConfig } from "./config.js";

/** Config-aware logger shape, mirroring the loader's `log` callback. */
export type PreprocessLog = (
  level: "info" | "debug" | "warn",
  message: string,
) => void;

/**
 * Should this document be preprocessed? Pure function so the request path stays
 * readable and the rule is trivially unit-testable. Server switch wins; a
 * document below `minChars` is left alone (the subprocess cost outweighs the
 * benefit on tiny fragments).
 */
export function preprocessShouldRun(
  config: AppConfig,
  htmlLength: number,
): boolean {
  if (!config.preprocess.enabled) return false;
  if (htmlLength < config.preprocess.minChars) return false;
  return true;
}

/**
 * Run `dom_smoothie_cli` to clean `html`. Returns the cleaned HTML, or the
 * original `html` unchanged if preprocessing is off/short/failed. Never throws.
 *
 * @param html   Raw document string.
 * @param url    The source URL, forwarded to the cleaner so it can resolve
 *               relative links into absolute ones (a Readability nicety).
 * @param config Loaded engine config (provides binary path + timeout).
 * @param log    Optional config-aware logger for fallback diagnostics.
 */
export async function preprocessHtml(
  html: string,
  url: string,
  config: AppConfig,
  log: PreprocessLog = () => {},
): Promise<string> {
  if (!preprocessShouldRun(config, html.length)) {
    return html;
  }

  const { binaryPath, timeoutMs, maxElements } = config.preprocess;

  // Build argv. `-f html` selects clean-HTML output; `--stdout` prints to
  // stdout instead of writing files. We pass the URL for link absolutization and
  // only set a cap when the operator configured a positive one.
  const args = ["--stdout", "-f", "html"];
  if (url) args.push("--document-url", url);
  if (maxElements > 0) args.push("--max-elements", String(maxElements));

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([binaryPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (err) {
    // Binary missing / not executable / not on PATH. Degrade to raw HTML.
    log("warn", `preprocess spawn failed: ${describe(err)}`);
    return html;
  }

  // Feed stdin without blocking the timeout race. A broken pipe (binary exited
  // early) must not surface as an unhandled rejection, so swallow write errors.
  const writePromise = writeAll(child.stdin, html).catch(() => undefined);

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );

  try {
    const raced = await Promise.race([
      finishChild(child).then((r) => ({ kind: "done" as const, ...r })),
      timeout,
    ]);
    // Ensure the stdin write settles before we return to avoid a dangling promise.
    await writePromise;

    if (raced === "timeout") {
      // Kill the wedged child so we don't leak processes, then fall back.
      killChild(child);
      log("warn", `preprocess timed out after ${timeoutMs}ms; using raw html`);
      return html;
    }

    if (raced.exitCode !== 0) {
      log("warn", `preprocess exit ${raced.exitCode}; using raw html`);
      return html;
    }
    if (raced.stdout.trim() === "") {
      log("warn", "preprocess produced empty output; using raw html");
      return html;
    }
    return raced.stdout;
  } catch (err) {
    log("warn", `preprocess error: ${describe(err)}`);
    killChild(child);
    // Last-resort guarantee: never lose the document.
    return html;
  }
}

interface ChildResult {
  exitCode: number;
  stdout: string;
}

/** Read the child's stdout fully and await its exit code. */
async function finishChild(
  child: ReturnType<typeof Bun.spawn>,
): Promise<ChildResult> {
  // Spawned with `stdout: "pipe"`, so stdout is a ReadableStream; Bun's
  // union type also admits a file-descriptor number, which we narrow away.
  const stream = child.stdout as ReadableStream<Uint8Array>;
  const stdout = await new Response(stream).text();
  const exitCode = await child.exited;
  return { exitCode, stdout };
}

/** Write the entire input to a Bun writable stream. */
async function writeAll(
  stdin: ReturnType<typeof Bun.spawn>["stdin"],
  text: string,
): Promise<void> {
  // The stream type union is awkward to express precisely; cast to the writable
  // we know it is when spawned with stdin: "pipe".
  const writer = stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  writer.write(text);
  writer.end();
}

/** Best-effort kill of the child (SIGKILL via Bun's kill). */
function killChild(child: ReturnType<typeof Bun.spawn>): void {
  try {
    child.kill(9);
  } catch {
    // Ignore: process may have already exited.
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
