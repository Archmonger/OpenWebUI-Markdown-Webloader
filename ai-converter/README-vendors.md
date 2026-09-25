# AI Converter — Vendor / GPU configuration

The optional AI converter sidecar is **only** built and run when you opt into AI
markdown conversion. This guide shows how to retarget it to a different vendor
(or CPU). Everything is controlled by Docker **build args** plus a runtime
**overlay JSON** — no code changes for the supported paths.

> The **Bun loader itself is vendor-agnostic**: it only makes HTTP calls to the
> sidecar. All GPU/vendor concerns live entirely in `ai-converter/`. Adding a
> vendor never requires changing the loader.

## The knobs that matter

| Knob | Where | What it selects |
|------|-------|-----------------|
| `AI_PYTHON_DEPENDENCIES` | build | The `onnxruntime-genai` wheel installed at **runtime** (CPU / CUDA / DirectML) plus its accelerator wheels. |
| `AI_PYTHON_BUILDER_DEPS` | build | Build-time deps (`olive-ai` + the matching genai package for the `-e` provider). |
| `AI_BUILDER_ARGS` | build | `-e <provider>` picks the builder execution provider; `-p <quant>` picks quantization. Must include `-o /build/model`. |
| `AI_RUNTIME_CFG` | runtime | JSON merged into the sidecar's `onnxruntime_genai` config (execution-provider options, CUDA graphs, batching). A passthrough — any valid genai key works. |

**Default = the validated NVIDIA/CUDA setup.** If you change none of these you
get int4 + paged attention + CUDA graphs + `gpu_utilization_factor=0.9` on
NVIDIA. To use a different vendor, override the values below.

## Validated default (NVIDIA / CUDA)

Benchmarked end-to-end on a 16 GB RTX 2000 Ada (CUDA 13 driver). These are the
image defaults — shown explicitly:

```bash
AI_PYTHON_BUILDER_DEPS="olive-ai onnxruntime-genai-cuda"
AI_PYTHON_DEPENDENCIES="onnxruntime-genai-cuda==0.16.0 onnxruntime-gpu==1.30.0 numpy"
AI_CUDA_REPO_DISTRO="debian13"
AI_LINUX_PACKAGES="cuda-cudart-13-4 libcublas-13-4 libcudnn9-cuda-13 libcufft-13-4 libcurand-13-4"
AI_BUILDER_ARGS="-o /build/model -p int4 -e cuda --extra_options use_paged_attention=true paged_block_size=256 gpu_utilization_factor=0.8"
AI_RUNTIME_CFG='{"model":{"decoder":{"session_options":{"provider_options":[{"cuda":{"enable_cuda_graph":"1"}}]}}},"engine":{"dynamic_batching":{"gpu_utilization_factor":0.9}}}'
```

Notes on the defaults:

- **`gpu_utilization_factor=0.9` (runtime)** sizes the paged-KV pool as large as
  the card allows, so the biggest possible document can be converted. It leaves
  ~10% of VRAM as headroom (verified: a 0.92 factor loads the model and
  captures CUDA graphs on the 16 GB card, using ~15.5 GB). If you share the GPU
  with other CUDA-graph workloads or hit graph-capture failures / OOM, lower it
  (0.5–0.8) via `AI_RUNTIME_CFG`.
- The CUDA **runtime** libraries come from the NVIDIA apt repo
  (`AI_CUDA_REPO_DISTRO` + `AI_LINUX_PACKAGES`); the wheels don't bundle them.
  The host still needs the NVIDIA driver + `nvidia-container-toolkit`.
- Greedy decoding (`AI_TEMPERATURE=0`) is the faithful, deterministic recipe for
  a conversion model.
- **ARG-quoting:** multi-word `--build-arg` values must be quoted
  (`--build-arg X="a b c"`); an unquoted value is truncated to its first token by
  some builders.

## Vendor support matrix

| Vendor / accelerator | Provider | How | Status |
|----------------------|----------|-----|--------|
| NVIDIA discrete | CUDA (`-e cuda`, `onnxruntime-genai-cuda`) | Build-args + runtime overlay (default) | **Validated** |
| Any CPU (Intel/AMD) | CPU (`-e cpu`, plain `onnxruntime-genai`) | Build-args + runtime overlay only | **Works (env-only)** |
| Intel Arc / Core iGPU | OpenVINO | Separate `openvino-genai` stack — **source change** | Not wired (see below) |
| AMD Ryzen AI NPU (Strix) | AMD Ryzen AI (AIE/Vitis-AI) | Vendor artifacts + **source/runtime change** | Not wired |
| AMD Radeon discrete (Linux) | (ROCm — not a genai EP) | No packaged OGA path | **Unsupported** |
| AMD/Intel on Windows | DirectML (`-e dml`, `onnxruntime-genai-directml`) | Different OS; not a Linux container | Out of scope |

### CPU path (Intel or AMD CPU) — env-only, works today

```bash
AI_PYTHON_BUILDER_DEPS="olive-ai onnxruntime-genai"
AI_PYTHON_DEPENDENCIES="onnxruntime-genai==0.16.0 numpy"
AI_BUILDER_ARGS="-o /build/model -p int4 -e cpu --extra_options use_paged_attention=true"
AI_RUNTIME_CFG='{"model":{"decoder":{"session_options":{"providers":["CPUExecutionProvider"]}}}}'
AI_CUDA_REPO_DISTRO=""          # no NVIDIA apt repo
AI_LINUX_PACKAGES="libgomp1"    # OpenMP only
```

Then **remove the NVIDIA keys** from the compose `ai-converter` service
(`runtime: nvidia`, `NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`) and
run it as a normal container. Expect CPU throughput — functional but slower than
GPU.

## Supporting Intel & AMD GPUs (what changes are needed)

**Loader:** none. The Bun loader does not know or care which GPU the sidecar uses
— no loader env vars change for a different vendor.

Everything below is in the **sidecar** (`ai-converter/`):

1. **Pick the execution provider** — set `-e <provider>` in `AI_BUILDER_ARGS`
   and the matching wheels in `AI_PYTHON_DEPENDENCIES` /
   `AI_PYTHON_BUILDER_DEPS`.

2. **Provider packaging reality** (this is the limiting factor):
   - **CPU** and **CUDA** have ready-made PyPI wheels
     (`onnxruntime-genai`, `onnxruntime-genai-cuda`) → env-only, no code change.
   - **OpenVINO** (Intel Arc / iGPU) and **AMD** accelerators are **not** drop-in
     `onnxruntime-genai` wheels. Intel's supported route is the separate
     **`openvino-genai`** library (`openvino.genai.LLM`), whose API differs from
     `onnxruntime_genai`'s `Model`/`Engine`. AMD's supported accelerators are
     the **Ryzen AI** NPU stack. Neither can be reached by swapping the wheel
     string in this sidecar as written.

3. **Source change required for Intel/AMD GPU.** To use OpenVINO or a Ryzen AI
   NPU you must adapt `ai-converter/server.py` to that runtime's API
   (`openvino.genai` or the AMD flow) — a different model-load + generate loop
   than the current `onnxruntime_genai` `Engine`. In practice this is a
   **vendor-specific sidecar image** rather than a value in `AI_RUNTIME_CFG`.
   (AMD Radeon on Linux has **no** onnxruntime-genai provider at all; DirectML
   works only on Windows/DirectX, not in this Linux container.)

4. **Container runtime / device passthrough** — a deployment change, not env in
   the loader:
   - NVIDIA: `runtime: nvidia` + `NVIDIA_*` (current default).
   - Intel Arc/iGPU: mount the GPU (`/dev/dri`) into the container and install
     the Intel compute/OneAPI runtime in the image.
   - AMD: use the AMD container toolkit / device passthrough for the chosen flow.

**Bottom line:** CPU on Intel/AMD is a pure env swap (above). GPU acceleration on
Intel Arc or AMD is **not achievable by environment variables alone** in the
current sidecar — it needs a source-level port to that vendor's runtime plus the
matching base image and device passthrough. The existing knobs were designed for
the CUDA wheel family; a second vendor means a second sidecar build target.

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

The model-build step runs on CPU regardless of provider, so the image can be
built on a GPU-less host; only **running** it needs the target accelerator (plus
the matching container runtime for passthrough).
