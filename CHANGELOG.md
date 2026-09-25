# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-24

### Added

- **Opt-in AI (ReaderLM-v2) HTML→Markdown conversion.** When
  `AI_CONVERTER_ENABLED=1`, HTML documents are routed to an optional
  ReaderLM-v2 GPU sidecar (`ai-converter/`, reached over HTTP) with graceful
  `node-html-markdown` fallback on any failure. Off by default: with no AI
  configuration the engine is a pure native loader and never contacts an AI
  service. Per-request opt-out via `x-ai-convert: 0` (or body
  `options.aiConvert: false`).
- **Readability HTML pre-cleaning, on by default** (`PREPROCESS_HTML=1`).
  Every HTML document is stripped of navigation/header/footer boilerplate via
  the bundled static `dom_smoothie_cli` binary before _both_ renderers see
  it. Degrades to raw HTML whenever the cleaner is missing, errors, times
  out, or yields empty output.
- **Optional post-clean minification of the AI input**
  (`PREPROCESS_MINIFY_HTML`, off by default). Shrinks the bytes the AI model
  prefills; the native renderer is never given minified HTML.
- `metadata.converter` (`native` | `ai` | `fallback`) on every response
  reports which renderer produced the markdown; `/health` gains a
  `converter` status block (never includes the auth token).
- Separate `ai:` cache lane so AI and native renderings of the same URL never
  shadow each other; `fallback` results are deliberately not cached so the AI
  path auto-recovers once the sidecar does.
- `docker-compose.yml` now passes through the full documented env surface,
  including `PREPROCESS_MINIFY_HTML`, `AI_CACHE_OUTPUT`, `AI_SEED`, and
  `AI_MAX_QUEUE`.

### Fixed

- `stripOuterCodeFence` no longer corrupts legitimate multi-fence documents.
  A document that opened _and_ closed with a code example (e.g. a tutorial)
  previously had its language tag and final closer deleted, stranding ```
  markers mid-document. Unwrapping now requires a bare-tag opener line, a
  standalone closing fence line, and a fence-free interior.
- The `dom_smoothie_cli` builder stage is architecture-aware
  (`x86_64`/`arm64` via BuildKit `TARGETPLATFORM`); previously it hardcoded
  x86_64, so arm64 image builds either failed or silently shipped a binary
  that could not execute.
- Documentation accuracy: the minifier is described as keeping comments
  (`keep_comments` is forced on) instead of claiming comment removal; AI
  model-status docs describe the value as coming from the last successful
  conversion rather than a "ping".

## [0.1.0]

- Initial release: Open-WebUI-compatible external web loader engine built on
  Bun. Content-type-aware conversion (HTML→Markdown via `node-html-markdown`,
  JSON/XML/YAML/TOML/text fencing, PDF text extraction), SSRF protection with
  DNS-rebinding guard, request/response limits, in-memory cache, and
  `/health`, `/load`, `/load/batch` plus the Open-WebUI `POST /` contract.
