# AI Markdown Conversion (ReaderLM-v2)

This file documents the **optional** AI conversion feature of
OpenWebUI-Markdown-Webloader. Everything here is opt-in: with
`AI_CONVERTER_ENABLED` unset or `0`, the engine is a pure, dependency-free
`node-html-markdown` loader and nothing AI-related is installed, contacted, or
required.

All environment variables for the loader **and** the sidecar are listed in the
main [README's Configuration table](../README.md#configuration). This file
covers how the feature behaves, how to enable and tune it, and the
post-clean minification option.

## Enabling it

```bash
# 1. Point the loader at the sidecar and turn the feature on:
export AI_CONVERTER_ENABLED=1
export AI_SERVICE_URL=http://ai-converter:8090
# (optional) shared secret between loader and sidecar:
export AI_CONVERTER_TOKEN=***

# 2. Start BOTH the loader and the sidecar via the `ai` compose profile:
docker compose --profile ai up -d
```

Without `--profile ai` the sidecar never starts and `AI_CONVERTER_ENABLED` is
irrelevant — you get the pure native loader. The `.env` default is `0` (off).

## How it behaves

- **HTML only.** Non-HTML content is never sent to the model.
- **Size window.** Documents outside `AI_MIN_HTML_CHARS`..`AI_MAX_HTML_CHARS`
  are rendered natively, protecting VRAM and latency.
- **Graceful fallback.** Any sidecar failure returns the native rendering and
  marks `metadata.converter = "fallback"` instead of erroring (unless you set
  `AI_FALLBACK_ON_ERROR=0`).
- **Cache lanes.** AI output is cached under a separate `ai:` key so it never
  shadows the native rendering of the same URL, and vice versa. A `fallback`
  result is **not** cached, so a later request retries the AI once the service
  recovers.
- **Provenance.** Every response's `metadata.converter` reports `"native"`,
  `"ai"`, or `"fallback"` so you can see what produced the output.

## Per-request control

Send `x-ai-convert: 0` (or body `{"options": {"aiConvert": false}}`) to force a
single request through the native converter even when the feature is globally on
(a per-document opt-out). A request can never force the AI *on* when the
operator has not enabled it server-wide.

## The validated configuration

The default sidecar settings are the ones validated end-to-end on a 16 GB RTX
2000 Ada with CUDA 13:

- **Weights:** int4 (memory-bandwidth bound; ~80% of the fp ceiling at ⅓ the VRAM).
- **Attention:** paged attention (`use_paged_attention=true`) — eliminates the
  dense attention-mask prefill spike and enables the continuous-batching engine.
- **CUDA graphs:** enabled at runtime for a ~5% decode speedup.
- **Utilization factor:** `0.9` at runtime (`gpu_utilization_factor`) to size the
  paged-KV pool as large as the card allows, maximizing the biggest document
  that can be converted. Lower it (0.5–0.8) via `AI_RUNTIME_CFG` if you share
  the GPU with other CUDA-graph workloads or hit capture failures / OOM.
- **Decoding:** greedy (temperature 0) for faithful, deterministic markdown.

Approximate single-stream throughput: prefill ~8k tok/s, decode ~150–180 tok/s.

## Post-clean minification of the AI input (opt-in)

With `PREPROCESS_MINIFY_HTML=1`, the Readability-cleaned HTML is additionally
run through the [`@minify-html/node`](https://www.npmjs.com/package/@minify-html/node)
minifier **before** it is handed to the AI sidecar. This removes collapsible
whitespace, comments, and empty/redundant attributes from the model's input
(measured ~12% smaller on a large Wikipedia article, ~2-3% on a typical page),
and because the AI's **prefill cost grows super-linearly** with input length,
it measurably cuts AI prefill latency (~19% on a 572 KB page).

This is safe by construction, with two invariants baked in (see
[`src/minify.ts`](../src/minify.ts)):

- **Structure-preserving.** The minifier's *defaults* drop optional closing tags
  (`</td>`, `</tr>`, `</p>`, …) — and `node-html-markdown` relies on those tags to detect
  tables/paragraphs. With the defaults, a Wikipedia infobox silently turns
  from a table into a blockquote and ~30% of the markdown is lost. The engine
  therefore **always** passes `keep_closing_tags` + `keep_comments`, so
  minification only removes byte-safe whitespace/entities. The resulting
  markdown is byte-identical to the unminified markdown on the pages that
  matter (tables, code, `<pre>`).
- **AI path only.** The native `node-html-markdown` renderer always consumes the
  *unminified* cleaned HTML, so this toggle can never change the markdown a
  native (non-AI) deployment serves — it only shrinks the bytes the AI model
  prefills.

The minifier is a **native addon** and the step degrades gracefully: if it is
missing, mismatched to the platform, or errors on a document, the unminified
HTML is used instead. It can never break a conversion — at worst you pay a
slightly larger AI prefill. It is gated on the same `PREPROCESS_HTML` +
`PREPROCESS_MIN_CHARS` rules as the cleaner, so tiny fragments are never
minified.

> **Cache note:** the AI output is cached under the `:ai:<url>` key, which does
> not encode the minify setting. Toggling `PREPROCESS_MINIFY_HTML` on an already
> cached URL serves the cached (whitespace-level) variant until the cache
> expires or is cleared — a cold start reflects the new setting immediately.

## Sidecar-side and build-time variables

Sidecar-side and build-time variables (see [README-vendors.md](README-vendors.md))
let you retarget other GPU vendors — `AI_BUILDER_ARGS`, `AI_PYTHON_DEPENDENCIES`,
`AI_LINUX_PACKAGES`, and the `AI_RUNTIME_CFG` overlay.
