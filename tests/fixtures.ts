// Local fixture server for integration smoke tests. Serves a variety of
// content types plus redirect / error behaviors on a fixed port.

const HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Example Article</title>
  <meta property="og:title" content="Og Title">
  <meta name="description" content="A test article">
</head>
<body>
  <nav><a href="/">home</a></nav>
  <article>
    <h1>Article Heading</h1>
    <h2>Section One</h2>
    <p>First paragraph with a <a href="https://example.com/linked">link</a>.</p>
    <img src="/img/photo.png" alt="A photo" width="100" height="50">
    <ul><li>alpha</li><li>beta</li></ul>
    <table><tr><td>cell1</td><td>cell2</td></tr></table>
    <pre>monospace
      code block</pre>
  </article>
  <footer><a href="https://example.com/footer">footer link</a></footer>
</body>
</html>`;

const JSON_BODY = JSON.stringify({ hello: "world", n: 42, tags: ["a", "b"] });

// Minimal valid single-page PDF with extractable text (correct xref).
export function buildPdf(label: string): string {
  const header = "%PDF-1.4 \n";
  const stream = `BT /F1 18 Tf 30 30 Td (${label}) Tj ET\n`;
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "";
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(header.length + body.length);
    body += o;
  }
  const xrefStart = header.length + body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  return (
    header +
    body +
    xref +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  );
}

export function buildMultiPagePdf(pages: string[]): Uint8Array {
  const header = "%PDF-1.4 \n";
  const pageObjIds = pages.map((_, i) => 3 + i * 2);
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`,
  ];
  pages.forEach((label, i) => {
    const pageId = 3 + i * 2;
    const contentId = 4 + i * 2;
    const stream = `BT /F1 18 Tf 30 30 Td (${label}) Tj ET\n`;
    objs.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>\nendobj\n`,
      `${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
    );
  });
  const fontId = 3 + pages.length * 2;
  objs.push(
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );
  let body = "";
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(header.length + body.length);
    body += o;
  }
  const xrefStart = header.length + body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const raw =
    header +
    body +
    xref +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(raw);
}

export function startFixture(port: number) {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req: Request) => {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/html" || p === "/html-fresh") {
        // /html-fresh serves identical HTML at a different path so the cache
        // (keyed by URL) stays empty for it, letting tests assert a fresh vs
        // cached fetch independently of the Open-WebUI section.
        return new Response(HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (p === "/json") {
        return new Response(JSON_BODY, {
          headers: { "content-type": "application/json" },
        });
      }
      if (p === "/xml") {
        return new Response("<root><item>1</item></root>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (p === "/text") {
        return new Response("plain text body\nsecond line", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (p === "/pdf") {
        return new Response(
          new TextEncoder().encode(buildPdf("PDF MARKDOWN CONTENT")),
          { headers: { "content-type": "application/pdf" } },
        );
      }
      if (p === "/binary") {
        const b = new Uint8Array(64);
        b.fill(0);
        return new Response(b, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (p === "/nul") {
        const b = new Uint8Array(128);
        b.fill(65);
        b[3] = 0;
        return new Response(b, { headers: { "content-type": "text/html" } });
      }
      if (p === "/empty") {
        return new Response("", { headers: { "content-type": "text/html" } });
      }
      if (p === "/error500") {
        return new Response("boom", {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
      if (p === "/redirect-html") {
        return new Response(null, {
          status: 302,
          headers: { location: "/html" },
        });
      }
      if (p === "/redirect-loop-a") {
        return new Response(null, {
          status: 302,
          headers: { location: "/redirect-loop-b" },
        });
      }
      if (p === "/redirect-loop-b") {
        return new Response(null, {
          status: 302,
          headers: { location: "/redirect-loop-a" },
        });
      }
      if (p === "/big") {
        // Comfortably larger than the engine's test cap so the size limit fires.
        const big =
          "<html><head><title>Big</title></head><body>" +
          "x".repeat(20000) +
          "</body></html>";
        return new Response(big, {
          headers: {
            "content-type": "text/html",
            "content-length": String(big.length),
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
}
export type FixtureServer = ReturnType<typeof startFixture>;
