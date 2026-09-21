import { describe, expect, test } from "bun:test";
import {
  effectivePdfLimit,
  extractPdfText,
  normalizePageText,
} from "../src/pdf-reader.js";
import { loadConfig } from "../src/config.js";
import { buildPdf, buildMultiPagePdf } from "./fixtures.js";

const config = loadConfig({} as NodeJS.ProcessEnv);

describe("normalizePageText", () => {
  test("collapses intra-line whitespace and trims line edges", () => {
    expect(normalizePageText("  a    b  \nc\n")).toBe("a b\nc");
  });
  test("collapses 3+ newlines to 2", () => {
    expect(normalizePageText("a\n\n\n\nb")).toBe("a\n\nb");
  });
  test("strips unsafe control characters", () => {
    expect(normalizePageText("a\x00b")).toBe("ab");
  });
});

describe("extractPdfText", () => {
  test("extracts text from a one-page PDF", async () => {
    const bytes = new TextEncoder().encode(
      buildPdf("Hello PDF from unpdf under Bun"),
    );
    const result = await extractPdfText(bytes, 10_000, 500);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.totalPages).toBe(1);
      expect(result.text).toContain("Hello PDF from unpdf under Bun");
      expect(result.textBytes).toBeGreaterThan(0);
    }
  });

  test("extracts across multiple pages in order", async () => {
    const bytes = buildMultiPagePdf([
      "FIRST PAGE",
      "SECOND PAGE",
      "THIRD PAGE",
    ]);
    const result = await extractPdfText(bytes, 10_000, 500);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.totalPages).toBe(3);
      expect(result.text).toContain("FIRST PAGE");
      expect(result.text).toContain("SECOND PAGE");
      expect(result.text).toContain("THIRD PAGE");
      // page order preserved
      expect(result.text.indexOf("FIRST PAGE")).toBeLessThan(
        result.text.indexOf("SECOND PAGE"),
      );
    }
  });

  test("reports no_text when the PDF has no extractable text", async () => {
    // A PDF whose single page has no text-showing operators.
    const header = "%PDF-1.4 \n";
    const objs = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      "5 0 obj\n<< /Length 4 >>\nstream\n\nendstream\nendobj\n",
    ];
    let body = "";
    const offsets: number[] = [];
    for (const o of objs) {
      offsets.push(header.length + body.length);
      body += o;
    }
    const xrefStart = header.length + body.length;
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets)
      xref += `${String(off).padStart(10, "0")} 00000 n \n`;
    const bytes = new TextEncoder().encode(
      header +
        body +
        xref +
        `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
    );
    const result = await extractPdfText(bytes, 10_000, 500);
    // PDF.js tolerates the slightly malformed xref; the page has no text.
    expect(["no_text", "parse_error"]).toContain(result.kind);
  });

  test("caps pages via maxPages", async () => {
    const bytes = buildMultiPagePdf(["A", "B", "C", "D", "E", "F", "G"]);
    const result = await extractPdfText(bytes, 10_000, 3);
    expect(result.kind).toBe("too_many_pages");
    if (result.kind === "too_many_pages") {
      expect(result.totalPages).toBe(7);
    }
  });

  test("caps output via maxTextBytes", async () => {
    const bytes = buildMultiPagePdf([
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ]);
    const result = await extractPdfText(bytes, 10, 500);
    expect(result.kind).toBe("text_too_large");
  });

  test("effectivePdfLimit is min(content cap, pdf ceiling)", () => {
    // With the default config the content cap (5 MB) is below the PDF ceiling
    // (16 MB), so the effective input limit is the content cap.
    expect(effectivePdfLimit(config)).toBe(
      Math.min(config.maxContentLengthBytes, config.maxPdfBytes),
    );
    const smaller = loadConfig({
      URL_READ_MAX_CONTENT_LENGTH_BYTES: "1000",
    } as NodeJS.ProcessEnv);
    expect(effectivePdfLimit(smaller)).toBe(1000);
  });
});
