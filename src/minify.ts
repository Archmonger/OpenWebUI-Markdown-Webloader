/**
 * Optional post-clean HTML minification for the AI path.
 *
 * Runs the `@minify-html/node` minifier over the Readability-cleaned HTML so the
 * AI (ReaderLM) sidecar receives fewer bytes. The AI model's prefill cost grows
 * super-linearly with input length, so cutting a few percent off a large page
 * measurably cuts its prefill latency (measured on the deployment: ~19% off a
 * 572 KB page's prefill). The native `node-html-markdown` path is never given the
 * minified HTML — see `convertHtmlContent` in `url-reader.ts` — so this can only
 * change the AI path's input, never the markdown a native deployment serves.
 *
 * Design contract (mirrors `src/preprocess.ts`): THIS FUNCTION NEVER THROWS AND
 * NEVER LOSES CONTENT. Any of:
 *   - the feature being disabled for this request (`PREPROCESS_MINIFY_HTML=0`),
 *   - the native addon being absent or failing to load on this platform, or
 *   - the minifier throwing on a pathological document,
 * causes a silent fall back to the UNMINIFIED input. The caller therefore always
 * receives a usable HTML string and never needs to branch on the outcome. This
 * keeps the request path safe even if the native addon is missing, mismatched to
 * the platform, or chokes on a document.
 *
 * WHY THE SAFE OPTION SET IS FORCED:
 * `@minify-html/node`'s defaults drop *optional* closing tags (`</td>`, `</tr>`,
 * `</p>`, …) and collapse whitespace. `node-html-markdown` (the fallback renderer
 * and the thing that structures the model output) relies on those closing tags to
 * detect table/paragraph structure — with them removed, a Wikipedia infobox turns
 * from a table into a blockquote and ~30% of the markdown is silently lost. We
 * therefore ALWAYS pass `keep_closing_tags` and `keep_comments` so the minifier
 * only removes whitespace/entities/empty-attributes that are byte-safe for
 * downstream parsing. With that set, the minified markdown is byte-identical to
 * the unminified markdown on the pages that matter (tables, code, `<pre>), which
 * is what makes shrinking the AI input a pure win rather than a correctness risk.
 *
 * The minifier is a native (`.node`) addon loaded lazily on first use. We do not
 * import it at module top level: a missing or incompatible addon must degrade to
 * a no-op, not crash the whole loader process at import time.
 */
import type { AppConfig } from "./config.js";

/**
 * The minifier options we always use. These are the ONLY options the package
 * exposes that change structural output, and both are forced `true` to prevent
 * the destructive defaults. What the minifier therefore removes is collapsed
 * whitespace and redundant/empty attributes only — comments are explicitly
 * KEPT (`keep_comments: true`), both because conditional comments can carry
 * meaning and because keeping them makes the transform strictly byte-safe for
 * downstream parsing. Whitespace collapse is what makes the input smaller.
 */
const SAFE_MINIFY_OPTIONS: {
  keep_closing_tags: boolean;
  keep_comments: boolean;
} = {
  keep_closing_tags: true,
  keep_comments: true,
};

/** Lazily-resolved minifier function, cached after first successful load. */
type MinifyFn = (src: Buffer, cfg?: Record<string, unknown>) => Buffer;

/**
 * The production module specifier for the native minifier. Kept as a named
 * constant so the test-only reset below can always restore it.
 */
const DEFAULT_IMPORT_SPECIFIER = "@minify-html/node";

let minifyFn: MinifyFn | undefined;
/** Set to a reason string if the addon could not be loaded, to avoid retrying. */
let loadFailure: string | undefined;
/**
 * Resolvable module specifier for the native minifier. Defaults to the real
 * package; a test-only setter lets tests point it at a bogus specifier to
 * exercise the "addon missing" degrade path. Never changed in production.
 */
let importSpecifier = DEFAULT_IMPORT_SPECIFIER;

/**
 * Test-only: clear the cached loader/failure and redirect the dynamic import to
 * a different specifier (e.g. a non-existent module) to simulate a missing
 * native addon. Called with no argument it restores the REAL package specifier
 * — so a test that poisoned the specifier can never leak into later tests in the
 * same process. Production code never calls this.
 */
export function _resetMinifyForTests(specifier?: string): void {
  minifyFn = undefined;
  loadFailure = undefined;
  importSpecifier = specifier ?? DEFAULT_IMPORT_SPECIFIER;
}

/**
 * Lazily load the native minifier. Returns the function, or `undefined` if the
 * addon is missing/failed (in which case `loadFailure` explains why). Cached so
 * the dynamic import only happens once. Never throws.
 */
async function loadMinifyFn(): Promise<MinifyFn | undefined> {
  if (minifyFn) return minifyFn;
  if (loadFailure) return undefined;
  try {
    // Dynamic import: a failure here is caught and surfaced as a no-op rather
    // than a process crash. `@minify-html/node` exposes a `minify` function.
    const mod = (await import(importSpecifier)) as unknown as {
      minify?: (src: Buffer, cfg?: Record<string, unknown>) => Buffer;
    };
    const fn = mod?.minify;
    if (typeof fn !== "function") {
      loadFailure = "@minify-html/node loaded but exposed no `minify` function";
      return undefined;
    }
    minifyFn = fn as MinifyFn;
    return minifyFn;
  } catch (err) {
    loadFailure = describe(err);
    return undefined;
  }
}

/**
 * Should this document be minified? Mirrors the `preprocessShouldRun` gate
 * (minify is a sub-step of Readability cleaning) and adds the minify switch:
 * it only runs when pre-cleaning is on, the document is at least
 * `minChars` (the native-addon cost is not worth it for tiny fragments), and
 * `PREPROCESS_MINIFY_HTML` is enabled. Pure so the request path stays
 * readable and the rule is trivially unit-testable.
 */
export function minifyShouldRun(
  config: AppConfig,
  htmlLength: number,
): boolean {
  const pp = config.preprocess;
  if (!pp.enabled) return false;
  if (!pp.minify.enabled) return false;
  if (htmlLength < pp.minChars) return false;
  return true;
}

/**
 * Minify `html` for the AI path, or return it unchanged when minify is off, the
 * native addon is unavailable, or the minifier fails. Never throws; never loses
 * content.
 *
 * @param html    The (already Readability-cleaned) HTML to shrink.
 * @param config  Loaded engine config (reads the `minify` switch).
 * @param log     Optional config-aware logger for one-time degrade diagnostics.
 */
export async function minifyHtml(
  html: string,
  config: AppConfig,
  log: (level: "info" | "debug" | "warn", message: string) => void = () => {},
): Promise<string> {
  if (!minifyShouldRun(config, html.length)) {
    return html;
  }
  const fn = await loadMinifyFn();
  if (!fn) {
    // Addon missing/failed: degrade to the unminified HTML (never throw).
    log(
      "warn",
      `minify disabled at runtime: native @minify-html/node unavailable (${loadFailure}); using unminified HTML`,
    );
    return html;
  }
  try {
    const out = fn(Buffer.from(html, "utf8"), SAFE_MINIFY_OPTIONS).toString(
      "utf8",
    );
    // Never emit an empty result: if the minifier produced nothing (or only
    // whitespace), the document was effectively destroyed — use the original.
    if (out.trim() === "") {
      log("warn", "minify produced empty output; using unminified HTML");
      return html;
    }
    return out;
  } catch (err) {
    log("warn", `minify failed; using unminified HTML: ${describe(err)}`);
    return html;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
