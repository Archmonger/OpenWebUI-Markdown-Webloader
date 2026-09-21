# OpenWebUI-Markdown-Webloader

An [Open-WebUI](https://github.com/open-webui/open-webui)-compatible **web loader engine** that fetches a URL and returns clean **Markdown** instead of raw HTML.

> **Why Markdown?** This project exists to improve LLM understanding of web content. LLMs are notably better at comprehending Markdown than raw HTML, JS, and CSS — all the scaffolding, inline styles, scripts, and markup noise get stripped away, leaving the semantic content and structure (`#` headings, `[links]`, `**emphasis**`, lists, et cetera) that a model can reason over most effectively. Feeding a model Markdown instead of a wall of tags reduces token waste and measurably improves retrieval and summarization quality in RAG pipelines and web-from-web agent workflows.

Built on [Bun](https://bun.sh) — the package manager, test runner, and runtime.

---

## Features

- **Open-WebUI compatible** — speaks the exact `ExternalWebLoader` contract (`POST /` with `{"urls":[...]}` → `[{page_content, metadata}]`), so it plugs straight into Open-WebUI's `EXTERNAL_WEB_LOADER_URL`.
- **Markdown, not HTML** — HTML/XHTML → Markdown via `node-html-markdown`; JSON → pretty-printed `json` fence; XML/YAML/TOML/plain text → fenced blocks; PDFs → extracted text.
- **Content-type aware** — JSON is pretty-printed, structured text is fenced with the right language, binary/media/archive downloads are intentionally rejected (with an explanatory message).
- **SSRF protection** — rejects private/loopback/link-local/multicast and IPv6 ULA addresses, plus a DNS-rebinding guard that re-validates every resolved address. Cloud-metadata (`169.254.169.254`) and internal-only fetches are blocked by default.
- **Safety limits** — 5 MB body cap (configurable), binary NUL-byte sniffing of the first 1 KiB, PDF page-count and text-size caps, request timeouts, and redirect-loop protection.
- **Smart caching** — LRU-with-`hitCount` eviction and TTL; the same document's metadata (title, image/link lists) is re-attached on a cache hit.
- **Optional bearer auth** — `API_KEY` enables `Authorization: Bearer <key>` on all endpoints except `/health`, matching Open-WebUI's `EXTERNAL_WEB_LOADER_API_KEY`.
- **Egress proxy support** — undici `ProxyAgent` via `PROXY_URL`/`NO_PROXY` or the per-request `x-proxy-url` header.
- **Batch + redirect handling** — concurrent URL groups, continue-on-failure for a single bad URL in a batch, and manual redirect following with per-hop SSRF re-validation.

## Quick Start

### Docker (recommended)

```bash
docker run -d \
  --name openwebui-markdown-webloader \
  -p 14786:14786 \
  -e API_KEY=your-secret-key \
  ghcr.io/archmonger/openwebui-markdown-webloader:latest
```

### Docker Compose

```yaml
services:
  web-loader:
    image: ghcr.io/archmonger/openwebui-markdown-webloader:latest
    container_name: openwebui-markdown-webloader
    restart: unless-stopped
    ports:
      - "14786:14786"
    environment:
      API_KEY: ${WEB_LOADER_API_KEY:-change-me}
      ALLOW_PRIVATE_URLS: "false"
```

```bash
WEB_LOADER_API_KEY=your-secret-key docker compose up -d
```

### From source (Bun)

```bash
bun install
bun run start        # default http://0.0.0.0:14786
bun run dev          # watch mode
```

Connect **Open-WebUI**:

1. `Admin Settings → Web Loader`.
2. Set `EXTERNAL_WEB_LOADER_URL` to `http://<host-or-service>:14786`.
3. Set `EXTERNAL_WEB_LOADER_API_KEY` to the `API_KEY` you configured (or leave both empty for no auth).

## API

### Open-WebUI external loader — `POST /`

```bash
curl -X POST http://localhost:14786/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-key" \
  -d '{"urls": ["https://example.com/article"]}'
```

```json
[
  {
    "page_content": "# Article Title\n\n...clean markdown...",
    "metadata": {
      "source": "https://example.com/article",
      "title": "Article Title"
    }
  }
]
```

### Single URL — `POST /load`

```bash
curl -X POST http://localhost:14786/load \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "content": "# Example Domain\n\n...markdown...",
  "metadata": {
    "processingTimeMs": 123,
    "cached": false,
    "byteLength": 512
  }
}
```

### Batch — `POST /load/batch`

```bash
curl -X POST http://localhost:14786/load/batch \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/a", "https://example.com/b"]}'
```

### Health — `GET /health`

```bash
curl http://localhost:14786/health
```

## Request Headers

| Header | Values | Description |
|--------|--------|-------------|
| `Authorization` | `Bearer <API_KEY>` | Required when `API_KEY` is set (except `/health`) |
| `x-respond-with` | `markdown` (default) | Output format |
| `x-no-cache` | `true` | Bypass the response cache |
| `x-timeout` | milliseconds | Per-request timeout override |
| `x-user-agent` | UA string | Per-request User-Agent override |
| `x-proxy-url` | proxy URL | Per-request egress proxy override |
| `x-wait-for-selector` | CSS selector | (reserved) wait-for selector |
| `x-target-selector` | CSS selector | (reserved) extract matching subtree |
| `x-remove-selector` | CSS selector | (reserved) remove matching elements |
| `x-with-images-summary` | `true` | Include an image list in `/load` |
| `x-with-links-summary` | `true` | Include a link list in `/load` |

## Configuration

All configuration is via environment (12-factor). See [`.env.example`](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `14786` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | – | Bearer auth token (empty = no auth) |
| `REQUEST_TIMEOUT_MS` | `30000` | Default per-request timeout |
| `URL_READ_MAX_CONTENT_LENGTH_BYTES` | `5242880` (5 MB) | Max response body (clamped to 50 MB) |
| `URL_READ_MAX_PDF_BYTES` | `16777216` (16 MB) | Hard PDF input ceiling |
| `URL_READ_MAX_PDF_PAGES` | `500` | Max PDF pages to extract |
| `PDF_TIMEOUT_MS` | `30000` | PDF extraction timeout |
| `MAX_REDIRECTS` | `5` | Max redirects to follow |
| `MAX_BATCH_URLS` | `100` | Max URLs per batch request |
| `MAX_CONCURRENT_URLS` | `10` | Concurrent per-batch workers |
| `CACHE_TTL_MS` | `86400000` (24 h) | Cache TTL |
| `CACHE_MAX_ENTRIES` | `500` | Cache capacity |
| `USER_AGENT` | a browser UA | Outbound User-Agent |
| `ALLOW_PRIVATE_URLS` | `false` | **Disable SSRF protection — never on a public server** |
| `PROXY_URL` / `NO_PROXY` | – | Egress proxy config (undici `ProxyAgent`) |
| `LOG_LEVEL` | `info` | `off` \| `error` \| `warn` \| `info` \| `debug` |

## How it converts content

| Content-Type | Output |
|--------------|--------|
| `text/html`, `application/xhtml+xml` | Markdown (`node-html-markdown`) |
| `application/json`, `*+json` | Pretty-printed `json` fence |
| `text/*`, `+xml`, `yaml`, `toml` | Fenced block tagged with the language |
| `application/pdf` | Extracted text in a `text` fence (no OCR) |
| binary / media / archives | Rejected with an explanatory message |

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests
bun test            # 83 unit + integration tests (bun test)
bun run tests/smoke.ts   # end-to-end smoke against a local fixture
```
