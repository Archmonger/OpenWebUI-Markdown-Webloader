# AI Converter — Vendor / GPU configuration

This document covers how to retarget the optional AI converter sidecar to a
different GPU vendor (or CPU) than the validated NVIDIA/CUDA setup. Everything is
driven by Docker **build args** and a runtime **overlay JSON** — no code changes.

The two knobs that matter most:

- **`AI_PYTHON_DEPENDENCIES`** / **`AI_PYTHON_BUILDER_DEPS`** — which
  `onnxruntime-genai` wheel (CPU / CUDA / DirectML) gets installed, plus its
  CUDA/accelerator wheels.
- **`AI_RUNTIME_CFG`** — the JSON overlay merged into the sidecar's
  `onnxruntime_genai.Config` (execution-provider options, CUDA graphs, batching).
  This is a passthrough, so any valid genai config key works here.
- **`AI_BUILDER_ARGS`** — the `-e <provider>` selects the builder execution
  provider and `-p <quant>` selects quantization. Must include `-o /build/model`.

> **Default = the validated NVIDIA setup.** If you change none of these, you get
> int4 + paged attention + CUDA graphs on NVIDIA GPUs. To use a different vendor,
> override the values shown below for that vendor.

## Validated reference (NVIDIA / CUDA)

This is what ships as the default and what was benchmarked on a 16 GB RTX 2000
Ada with the CUDA 13 driver:

```bash
# Build args (defaults; shown explicitly):
AI_PYTHON_BUILDER_DEPS="olive-ai onnxruntime-genai-cuda"
AI_PYTHON_DEPENDENCIES="onnxruntime-genai-cuda==0.16.0 onnxruntime-gpu==1.30.0 numpy"
AI_LINUX_PACKAGES="libgomp1 ca-certificates"
AI_BUILDER_ARGS="-o /build/model -p int4 -e cuda --extra_options use_paged_attention=true paged_block_size=256 gpu_utilization_factor=0.8"

# Runtime overlay (sidecar default):
AI_RUNTIME_CFG='{"model":{"decoder":{"session_options":{"provider_options":[{"cuda":{"enable_cuda_graph":"1"}}]}}},"engine":{"dynamic_batching":{"gpu_utilization_factor":0.5}}}'
```

**Why these values (all validated):**

- **int4 weights (`-p int4`)** — the model is memory-bandwidth bound; int4
  reaches ~80% of the float decode speed at ~⅓ the VRAM.
- **`use_paged_attention=true`** — the single most important setting. The dense
  `attention_mask` in a non-paged build caused a ~9.4 GB prefill spike; paged
  attention replaces it with a fixed block pool and also enables the
  continuous-batching `Engine` API.
- **`enable_cuda_graph=1`** (runtime) — ~5% decode speedup by cutting kernel
  launch overhead.
- **`gpu_utilization_factor=0.5`** (runtime, NOT 0.8 as at build) — 0.8
  over-reserved the pool and starved CUDA-graph capture buffers on a shared card,
  causing `ENGINE_EXECUTION_FAILURE` at higher batch sizes. 0.5 is the safe
  runtime value.
- **Greedy decoding (`temperature=0`)** — ReaderLM-v2 is a conversion model, not
  a chat model; greedy is faithful and deterministic.

### Gotchas learned during validation

- The `libcufft` SONAME stays `12` even under CUDA 13 (from the cu12 pip
  wheels) — harmless, but do not be surprised if you see `libcufft.so.12`.
- The `nvidia-*-cu12` pip wheels bundle their own CUDA/cuDNN, so the runtime
  image does **not** need a system CUDA toolkit — only the host driver +
  `nvidia-container-toolkit`.
- If you later want KV-cache int8 (`int8_per_token`), the built `PagedAttention`
  node emits 19 inputs while the ORT 1.30 schema caps at 17; that path needs a
  version-matched ORT and is **not** enabled in the default.

## AMD GPUs

First-class Linux GPU support for this pipeline via `onnxruntime-genai` is limited.
Two practical options:

**A. Intel/AMD CPU path (portable, no discrete-GPU driver needed).**

```bash
AI_PYTHON_DEPENDENCIES="onnxruntime-genai==0.16.0 numpy"
AI_PYTHON_BUILDER_DEPS="olive-ai onnxruntime-genai"
AI_BUILDER_ARGS="-o /build/model -p int4 -e cpu --extra_options use_paged_attention=true"
AI_RUNTIME_CFG='{"model":{"decoder":{"session_options":{"providers":["CPUExecutionProvider"]}}}}'
```

Drop the `runtime: nvidia` / `NVIDIA_*` keys from the compose `ai-converter`
service and run it as a normal container. Expect roughly CPU throughput (slower
than GPU but fully functional).

**B. OpenVINO (Intel Arc / iGPU / AMD via OpenVINO EP).**

OpenVINO is a separate runtime (`openvino.genai`), not a drop-in wheel swap for
this sidecar. Adapting to it is a larger change than the env knobs cover; treat it
as "not currently wired" and prefer the CPU path or NVIDIA for now.

> **DirectML** (`onnxruntime-genai-directml`) targets Windows/DirectX and is not a
> supported Linux-container GPU path for this project.

## Verifying the sidecar without a client

```bash
# Health:
curl http://<sidecar>:8090/health
# -> {"status":"ok","model":"ReaderLM-v2","model_dir":"/models"}

# Convert (with token if configured):
curl -X POST http://<sidecar>:8090/convert \
  -H "Authorization: Bearer $AI_CONVERTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"html":"<html><body><h1>Title</h1><p>Body text.</p></body></html>"}'
# -> {"markdown":"# Title\n\nBody text.","tokens":NN,"model":"ReaderLM-v2","latency_ms":NN}
```

## Building a custom-vendor image

```bash
docker build ./ai-converter \
  --build-arg AI_PYTHON_DEPENDENCIES="<vendor wheels>" \
  --build-arg AI_PYTHON_BUILDER_DEPS="<vendor build deps>" \
  --build-arg AI_BUILDER_ARGS="-o /build/model -p int4 -e <provider> --extra_options use_paged_attention=true" \
  -t my-org/webloader-ai:<vendor>
```

The model build step runs on CPU regardless of provider, so you can build the
image on a GPU-less build host; only **running** it needs the target accelerator
(plus the matching container runtime for GPU passthrough).
