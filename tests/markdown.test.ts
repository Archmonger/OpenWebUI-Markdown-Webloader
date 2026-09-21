import { describe, expect, test } from "bun:test";
import {
  applyPaginationOptions,
  classifyContentType,
  htmlToMarkdown,
  renderFencedMarkdown,
  renderJsonMarkdown,
} from "../src/markdown.js";

describe("classifyContentType", () => {
  test("maps html types to html", () => {
    expect(classifyContentType("text/html").kind).toBe("html");
    expect(classifyContentType("text/html; charset=utf-8").kind).toBe("html");
    expect(classifyContentType("application/xhtml+xml").kind).toBe("html");
  });

  test("maps json types to json", () => {
    expect(classifyContentType("application/json").kind).toBe("json");
    expect(classifyContentType("application/vnd.api+json").kind).toBe("json");
    expect(classifyContentType("application/json; charset=UTF-8").kind).toBe(
      "json",
    );
  });

  test("maps pdf", () => {
    expect(classifyContentType("application/pdf").kind).toBe("pdf");
  });

  test("maps structured text types to their language", () => {
    const cases: Array<[string, "xml" | "yaml" | "toml"]> = [
      ["application/xml", "xml"],
      ["text/xml", "xml"],
      ["application/yaml", "yaml"],
      ["text/x-yaml", "yaml"],
      ["application/toml", "toml"],
    ];
    for (const [input, expectedLang] of cases) {
      const c = classifyContentType(input);
      expect(c.kind).toBe("text");
      if (c.kind === "text") {
        expect(c.language).toBe(expectedLang);
      }
    }
  });

  test("maps other text/* to text", () => {
    const c = classifyContentType("text/plain");
    expect(c.kind).toBe("text");
    if (c.kind === "text") {
      expect(c.language).toBe("text");
    }
  });

  test("maps binary types", () => {
    expect(classifyContentType("application/octet-stream").kind).toBe("binary");
    expect(classifyContentType("image/png").kind).toBe("binary");
    expect(classifyContentType("video/mp4").kind).toBe("binary");
    expect(classifyContentType("application/zip").kind).toBe("binary");
    expect(classifyContentType("audio/wav").kind).toBe("binary");
  });

  test("falls back to generic for unknown or missing types", () => {
    expect(classifyContentType(null).kind).toBe("generic");
    expect(classifyContentType("").kind).toBe("generic");
    expect(classifyContentType("application/foo").kind).toBe("generic");
  });
});

describe("htmlToMarkdown", () => {
  test("converts headings, paragraphs, and links", () => {
    const md = htmlToMarkdown(
      `<html><body><h1>Title</h1><p>Hello <a href="https://x.dev">link</a></p></body></html>`,
    );
    expect(md).toContain("# Title");
    expect(md).toContain("[link](https://x.dev)");
  });

  test("converts lists to markdown bullets", () => {
    const md = htmlToMarkdown(`<ul><li>a</li><li>b</li></ul>`);
    expect(md).toContain("a");
    expect(md).toContain("b");
    expect(md).toMatch(/[-*]/);
  });

  test("converts tables with pipes", () => {
    const md = htmlToMarkdown(`<table><tr><td>a</td><td>b</td></tr></table>`);
    expect(md).toContain("|");
    expect(md).toContain("a");
    expect(md).toContain("b");
  });

  test("converts <pre> preserving the code (node-html-markdown does not fence bare <pre>)", () => {
    // Faithful to mcp-searxng: node-html-markdown renders a <pre> block as its
    // text content without wrapping it in a code fence.
    const md = htmlToMarkdown(`<pre>const x = 1</pre>`);
    expect(md).toContain("const x = 1");
  });
});

describe("renderJsonMarkdown", () => {
  test("pretty-prints valid JSON in a json fence", () => {
    const md = renderJsonMarkdown(`{"a":1,"b":[2,3]}`);
    expect(md.startsWith("```json")).toBe(true);
    expect(md).toContain('"a": 1');
    expect(md.trim().endsWith("```")).toBe(true);
  });

  test("falls back to a text fence for invalid JSON", () => {
    const md = renderJsonMarkdown(`not json {`);
    expect(md).toContain("could not be parsed");
    expect(md).toContain("```text");
  });
});

describe("renderFencedMarkdown", () => {
  test("uses enough backticks to escape content backticks", () => {
    const md = renderFencedMarkdown("text", "a ``` b");
    expect(md).toContain("````");
    expect(md).toContain("a ``` b");
  });
});

describe("applyPaginationOptions", () => {
  const doc = `# Title

intro paragraph one.

## Section A

alpha text here.

## Section B

beta text here.

paragraph after b.`;

  test("returns the whole doc when no options given", () => {
    expect(applyPaginationOptions(doc, {})).toBe(doc);
  });

  test("readHeadings returns only heading lines", () => {
    const out = applyPaginationOptions(doc, { readHeadings: true });
    expect(out).toBe("# Title\n## Section A\n## Section B");
  });

  test("section extracts from a heading to the next same-level heading", () => {
    const out = applyPaginationOptions(doc, { section: "Section A" });
    // The faithful algorithm slices the line range and joins with newlines, so
    // the captured section keeps a trailing newline before the next heading.
    expect(out.trim()).toBe("## Section A\n\nalpha text here.");
  });

  test("section returns a not-found message when missing", () => {
    const out = applyPaginationOptions(doc, { section: "Nope" });
    expect(out).toContain('Section "Nope" not found');
  });

  test("paragraphRange picks a single paragraph", () => {
    const paragraphs = "p1\n\np2\n\np3";
    expect(applyPaginationOptions(paragraphs, { paragraphRange: "2" })).toBe(
      "p2",
    );
  });

  test("paragraphRange picks a range", () => {
    const paragraphs = "p1\n\np2\n\np3";
    expect(applyPaginationOptions(paragraphs, { paragraphRange: "1-2" })).toBe(
      "p1\n\np2",
    );
    expect(applyPaginationOptions(paragraphs, { paragraphRange: "2-" })).toBe(
      "p2\n\np3",
    );
  });

  test("startChar/maxLength slice characters", () => {
    const out = applyPaginationOptions("0123456789", {
      startChar: 2,
      maxLength: 3,
    });
    expect(out).toBe("234");
  });
});
