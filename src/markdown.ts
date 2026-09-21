/**
 * Content-type classification and HTML→Markdown conversion.
 *
 * This is the heart of the "markdown web loader": it takes a fetched HTTP
 * response body and renders it into clean Markdown the same way mcp-searxng's
 * `web_url_read` does.
 *
 *  - HTML / XHTML  -> `node-html-markdown` (the same library mcp-searxng uses)
 *  - JSON / *+json -> pretty-printed inside a fenced ```json block
 *  - other text/*  -> fenced code block tagged with the language (xml/yaml/toml)
 *  - binary        -> rejected with an explanatory message
 *
 * The `applyPaginationOptions` helpers (readHeadings / section /
 * paragraphRange / startChar / maxLength) are also ported from mcp-searxng so
 * consumers can request a slice of a large document instead of the whole thing.
 */
import { NodeHtmlMarkdown } from "node-html-markdown";

export interface PaginationOptions {
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
}

export type ContentTypeClassification =
  | { kind: "html"; mediaType: string }
  | { kind: "json"; mediaType: string }
  | { kind: "pdf"; mediaType: string }
  | {
      kind: "text";
      mediaType: string;
      language: "text" | "yaml" | "toml" | "xml";
    }
  | { kind: "binary"; mediaType: string | null }
  | { kind: "generic"; mediaType: string | null };

const EXACT_READABLE: Record<
  string,
  (mt: string) => ContentTypeClassification
> = {
  "text/html": (mt) => ({ kind: "html", mediaType: mt }),
  "application/xhtml+xml": (mt) => ({ kind: "html", mediaType: mt }),
  "application/json": (mt) => ({ kind: "json", mediaType: mt }),
  "application/xml": (mt) => ({ kind: "text", mediaType: mt, language: "xml" }),
  "text/xml": (mt) => ({ kind: "text", mediaType: mt, language: "xml" }),
  "application/yaml": (mt) => ({
    kind: "text",
    mediaType: mt,
    language: "yaml",
  }),
  "application/x-yaml": (mt) => ({
    kind: "text",
    mediaType: mt,
    language: "yaml",
  }),
  "text/yaml": (mt) => ({ kind: "text", mediaType: mt, language: "yaml" }),
  "text/x-yaml": (mt) => ({ kind: "text", mediaType: mt, language: "yaml" }),
  "application/toml": (mt) => ({
    kind: "text",
    mediaType: mt,
    language: "toml",
  }),
  "application/x-toml": (mt) => ({
    kind: "text",
    mediaType: mt,
    language: "toml",
  }),
  "text/toml": (mt) => ({ kind: "text", mediaType: mt, language: "toml" }),
};

const EXACT_BINARY = new Set<string>([
  "application/octet-stream",
  "binary/octet-stream",
  "application/zip",
  "application/x-zip",
  "application/zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
]);

export function normalizeMediaType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "" ? null : mediaType;
}

function isBinaryMediaType(mediaType: string): boolean {
  if (
    mediaType.startsWith("image/") ||
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/") ||
    mediaType.startsWith("font/")
  ) {
    return true;
  }
  return EXACT_BINARY.has(mediaType);
}

export function classifyContentType(
  contentType: string | null,
): ContentTypeClassification {
  const mediaType = normalizeMediaType(contentType);
  if (mediaType === null) {
    return { kind: "generic", mediaType: null };
  }
  if (mediaType === "application/pdf") {
    return { kind: "pdf", mediaType };
  }
  const exact = EXACT_READABLE[mediaType];
  if (exact) return exact(mediaType);
  if (mediaType.endsWith("+json")) return { kind: "json", mediaType };
  if (isBinaryMediaType(mediaType)) return { kind: "binary", mediaType };
  if (mediaType.endsWith("+xml")) {
    return { kind: "text", mediaType, language: "xml" };
  }
  if (mediaType.startsWith("text/")) {
    return { kind: "text", mediaType, language: "text" };
  }
  return { kind: "generic", mediaType };
}

// ---- Markdown rendering -------------------------------------------------

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Wrap `text` in a fenced code block using enough backticks to be safe. */
export function renderFencedMarkdown(language: string, text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

export function renderJsonMarkdown(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return renderFencedMarkdown("json", JSON.stringify(parsed, null, 2));
  } catch {
    return `Note: Response declared JSON but could not be parsed.\n\n${renderFencedMarkdown("text", text)}`;
  }
}

/**
 * Convert a raw HTML document string to Markdown using node-html-markdown.
 * Throws on conversion failure so the caller can surface a clean error.
 */
export function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html);
}

// ---- Pagination (ported from mcp-searxng) -------------------------------

/**
 * Apply pagination/slicing options to a Markdown document, in the same order
 * as mcp-searxng: headings first, then section, then paragraph range, then
 * character-window last. Returns the (possibly reduced) Markdown string.
 */
export function applyPaginationOptions(
  markdownContent: string,
  options: PaginationOptions = {},
): string {
  let result = markdownContent;
  if (options.readHeadings) {
    return extractHeadings(result);
  }
  if (options.section) {
    const section = extractSection(result, options.section);
    if (section === "") {
      return `Section "${options.section}" not found in the content.`;
    }
    result = section;
  }
  if (options.paragraphRange) {
    const range = extractParagraphRange(result, options.paragraphRange);
    if (range === "") {
      return `Paragraph range "${options.paragraphRange}" is invalid or out of bounds.`;
    }
    result = range;
  }
  if (options.startChar !== undefined || options.maxLength !== undefined) {
    result = sliceCharacterWindow(
      result,
      options.startChar ?? 0,
      options.maxLength,
    );
  }
  return result;
}

function sliceCharacterWindow(
  content: string,
  startChar = 0,
  maxLength?: number,
): string {
  if (startChar >= content.length) {
    return "";
  }
  const start = Math.max(0, startChar);
  const end = maxLength
    ? Math.min(content.length, start + maxLength)
    : content.length;
  return content.slice(start, end);
}

function extractSection(
  markdownContent: string,
  sectionHeading: string,
): string {
  const lines = markdownContent.split("\n");
  const normalizedHeading = sectionHeading.toLowerCase();
  let startIndex = -1;
  let currentLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /^#{1,6}\s/.test(line) &&
      line.toLowerCase().includes(normalizedHeading)
    ) {
      startIndex = i;
      currentLevel = (line.match(/^#+/) ?? [""])[0].length;
      break;
    }
  }
  if (startIndex === -1) {
    return "";
  }
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^#+/);
    if (match && match[0].length <= currentLevel) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

function extractParagraphRange(markdownContent: string, range: string): string {
  const paragraphs = markdownContent
    .split("\n\n")
    .filter((p) => p.trim().length > 0);
  const rangeMatch = range.match(/^(\d+)(?:-(\d*))?$/);
  if (!rangeMatch) {
    return "";
  }
  const start = parseInt(rangeMatch[1], 10) - 1;
  const endStr = rangeMatch[2];
  if (start < 0 || start >= paragraphs.length) {
    return "";
  }
  if (endStr === undefined) {
    return paragraphs[start] ?? "";
  }
  if (endStr === "") {
    return paragraphs.slice(start).join("\n\n");
  }
  const end = parseInt(endStr, 10);
  return paragraphs.slice(start, end).join("\n\n");
}

function extractHeadings(markdownContent: string): string {
  const lines = markdownContent.split("\n");
  const headings = lines.filter((line) => /^#{1,6}\s/.test(line));
  if (headings.length === 0) {
    return "No headings found in the content.";
  }
  return headings.join("\n");
}
