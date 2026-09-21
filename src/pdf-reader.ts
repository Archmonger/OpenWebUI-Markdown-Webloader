/**
 * PDF text extraction.
 *
 * Runs in the main thread (Bun). mcp-searxng runs the equivalent in a worker
 * to bound memory; here we instead cap page count and extracted-text size,
 * destroy the document on the way out, and — importantly — run the parser
 * under the network guards from `pdf-network-guard.ts` so an untrusted PDF
 * cannot trigger outbound connections (remote XFA forms, images, scripts).
 *
 * Hardened document options: no wasm, no auto-fetch, no cMap/standard-font
 * URLs, no XFA, no eval. This is what makes the network guards sufficient
 * rather than merely defensive.
 *
 * Returns a discriminated union of outcomes so the URL reader can map each to
 * a precise, user-facing message.
 */
import type { AppConfig } from "./config.js";
import {
  ExternalFetchAttemptError,
  isExternalFetchAttempt,
  installPdfNetworkGuards,
} from "./pdf-network-guard.js";

type PdfDocumentProxy = Awaited<
  ReturnType<typeof import("unpdf")["getDocumentProxy"]>
>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;

/**
 * Hardened PDF.js document options. Every field that could cause the parser
 * to reach for the network, the filesystem, or a wasm blob is disabled.
 */
const PDF_DOCUMENT_OPTIONS = {
  isEvalSupported: false,
  enableXfa: false,
  useSystemFonts: false,
  disableFontFace: true,
  disableAutoFetch: true,
  disableStream: true,
  useWorkerFetch: false,
  useWasm: false,
  cMapUrl: undefined,
  standardFontDataUrl: undefined,
  wasmUrl: undefined,
  iccUrl: undefined,
  verbosity: 0,
} as const;

export type PdfResult =
  | { kind: "text"; text: string; totalPages: number; textBytes: number }
  | { kind: "no_text"; totalPages: number }
  | { kind: "too_many_pages"; totalPages: number }
  | { kind: "text_too_large"; bytes: number }
  | { kind: "password_protected" }
  | { kind: "parse_error" }
  | { kind: "external_fetch_attempt" };

function isPasswordError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "PasswordException"
  );
}

/**
 * Collapse a page's raw text items into tidy prose without destroying line
 * structure: collapse intra-line whitespace, trim line edges, and collapse
 * runs of 3+ newlines to 2. Mirrors mcp-searxng's `normalizeMergedText`.
 */
export function normalizePageText(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return cleaned
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract text from a PDF byte buffer under the network guards.
 * `maxTextBytes` bounds the *output* size; `maxPages` bounds the input.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  maxTextBytes: number,
  maxPages: number,
): Promise<PdfResult> {
  const restore = installPdfNetworkGuards();
  let pdf: PdfDocumentProxy | undefined;
  try {
    const { getDocumentProxy } = await import("unpdf");
    // Import happens inside the guard window so the parser's dependencies
    // cannot capture unguarded references to global network primitives.
    pdf = await getDocumentProxy(bytes, PDF_DOCUMENT_OPTIONS as any);
    if (pdf.numPages > maxPages) {
      return { kind: "too_many_pages", totalPages: pdf.numPages };
    }
    const pageTexts: string[] = [];
    let textBytes = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page: PdfPageProxy = await pdf.getPage(pageNumber);
      let pageText = "";
      try {
        const content = await page.getTextContent();
        // The PDF.js item union includes annotation markers that do not carry
        // a `str` property; keep only the ones that do. A type predicate
        // cannot narrow the vendor's union here, so project through `any`.
        const rawText = (
          content.items as Array<{ str?: string; hasEOL?: boolean }>
        )
          .filter((item) => typeof item.str === "string")
          .map((item) => `${item!.str!}${item.hasEOL ? "\n" : ""}`)
          .join("");
        pageText = normalizePageText(rawText);
      } finally {
        try {
          page.cleanup();
        } catch {
          // Page cleanup is best-effort.
        }
      }
      if (pageText === "") {
        continue;
      }
      textBytes +=
        new TextEncoder().encode(pageText).byteLength +
        (pageTexts.length > 0 ? 1 : 0);
      if (textBytes > maxTextBytes) {
        return { kind: "text_too_large", bytes: textBytes };
      }
      pageTexts.push(pageText);
    }
    const text = pageTexts.join("\n");
    return text === ""
      ? { kind: "no_text", totalPages: pdf.numPages }
      : { kind: "text", text, totalPages: pdf.numPages, textBytes };
  } catch (error) {
    if (
      isExternalFetchAttempt(error) ||
      error instanceof ExternalFetchAttemptError
    ) {
      return { kind: "external_fetch_attempt" };
    }
    if (isPasswordError(error)) {
      return { kind: "password_protected" };
    }
    return { kind: "parse_error" };
  } finally {
    try {
      await pdf?.loadingTask?.destroy();
    } catch {
      // The extraction result is authoritative; teardown stays internal.
    }
    restore();
  }
}

/**
 * Compute the effective PDF input limit: the smaller of the configured max
 * content length and the hard PDF ceiling.
 */
export function effectivePdfLimit(config: AppConfig): number {
  return Math.min(config.maxContentLengthBytes, config.maxPdfBytes);
}
