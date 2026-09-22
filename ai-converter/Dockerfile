# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# OpenWebUI-Markdown-Webloader — AI converter sidecar (OPTIONAL)
#
# This image is only built/pulled when the operator opts into AI markdown
# conversion. The default `Dockerfile` (Bun loader) never references it and never
# installs any AI dependency.
#
# Two stages:
#   builder  : downloads the source model and runs the onnxruntime-genai builder
#              (CPU-only: int4 quantization + paged-attention graph rewrite). Needs
#              torch/olive, which are large and stay in this discarded stage.
#   runtime  : tiny Python image holding ONLY the built model + the inference
#              runtime wheels + server.py. The `onnxruntime-genai-cuda` /
#              `onnxruntime-gpu` wheels bundle the CUDA/cuDNN libs they need via
#              the `nvidia-*-cu12` pip wheels, so a system CUDA toolkit is NOT
#              required — just the host NVIDIA driver + nvidia-container-toolkit.
#
# All knobs are build ARGs so other GPU vendors are supported by changing args:
#   --build-arg AI_MODEL_SOURCE=jinaai/ReaderLM-v2
#   --build-arg AI_BUILDER_ARGS="-o /build/model -p int4 -e cuda --extra_options use_paged_attention=true paged_block_size=256 gpu_utilization_factor=0.8"
#   --build-arg AI_PYTHON_BUILDER_DEPS="olive-ai onnxruntime-genai-cuda"
#   --build-arg AI_PYTHON_DEPENDENCIES="onnxruntime-genai-cuda==0.16.0 onnxruntime-gpu==1.30.0 numpy"
#   --build-arg AI_LINUX_PACKAGES="libgomp1 ca-certificates"
#
# AMD ROCm / Intel example (illustrative — pick the matching wheels and builder
# provider, and run on the corresponding container runtime):
#   -e rocm  +  onnxruntime-genai-rocm   (runtime: --runtime=amd / amdgpu)
#   -e openvino + onnxruntime-genai-openvino (CPU/iGPU; no GPU passthrough)
# ---------------------------------------------------------------------------

ARG AI_PYTHON_VERSION=3.12

############ builder ############
FROM python:${AI_PYTHON_VERSION}-slim AS builder

# Source model on the Hugging Face hub (or a local path mounted at build time).
ARG AI_MODEL_SOURCE=jinaai/ReaderLM-v2
# `-o /build/model` so the runtime stage can copy a stable path. Keep the rest of
# the validated recipe: int4 weights + paged attention to kill the dense-mask
# prefill spike and enable continuous batching.
# NOTE: multi-word ARG defaults MUST be quoted. The legacy (non-BuildKit) builder
# truncates an unquoted multi-word default to its first token (e.g. "a b c" ->
# "a"). Quoting makes the default expand correctly under both the legacy builder
# and BuildKit. Users overriding via --build-arg are unaffected.
ARG AI_BUILDER_ARGS="-o /build/model -p int4 -e cuda --extra_options use_paged_attention=true paged_block_size=256 gpu_utilization_factor=0.8"
# Heavy build-only deps (torch/olive live only in this discarded stage). Use the
# CUDA genai package (NOT plain `onnxruntime-genai`, which conflicts) so the
# `-e cuda` builder provider is available.
ARG AI_PYTHON_BUILDER_DEPS="olive-ai onnxruntime-genai-cuda"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# `--extra-index-url` for the Hugging Face downloads; builders need network.
RUN pip install --no-cache-dir ${AI_PYTHON_BUILDER_DEPS}

RUN set -eux; \
    # `-o` may be supplied in AI_BUILDER_ARGS; require the canonical output path.
    if ! printf '%s' "${AI_BUILDER_ARGS}" | grep -q -- '-o /build/model'; then \
        echo "AI_BUILDER_ARGS must include '-o /build/model' for the runtime copy"; \
        exit 1; \
    fi; \
    python -m onnxruntime_genai.models.builder -i "${AI_MODEL_SOURCE}" ${AI_BUILDER_ARGS}

############ runtime ############
FROM python:${AI_PYTHON_VERSION}-slim AS runtime

# NVIDIA CUDA repo distro used to source the CUDA *runtime* libraries. The CUDA-13
# `onnxruntime-genai-cuda` wheel links against libcublasLt.so.13 / libcudnn.so.9
# / libcufft / libcurand at runtime but does NOT bundle them, so they must come
# from the NVIDIA apt repo (this is the validated setup). Set this to an empty
# string to skip the repo add (e.g. a CPU-only or non-NVIDIA vendor build).
ARG AI_CUDA_REPO_DISTRO=debian13
# OS-level packages installed at runtime. The default is the exact set of CUDA-13
# runtime libraries validated for the paged int4 model. libgomp1 (ORT OpenMP) is
# installed unconditionally below. Override for a different CUDA point-release or
# vendor. (Quoted — see the ARG-truncation note in the builder stage.)
ARG AI_LINUX_PACKAGES="cuda-cudart-13-4 libcublas-13-4 libcudnn9-cuda-13 libcufft-13-4 libcurand-13-4"
# Runtime Python deps. Keep pinned to the validated set for reproducibility.
ARG AI_PYTHON_DEPENDENCIES="onnxruntime-genai-cuda==0.16.0 onnxruntime-gpu==1.30.0 numpy"

# Add the NVIDIA CUDA apt repo (unless disabled) and install the CUDA runtime libs
# + shims. Keyring is NVIDIA's published cuda-keyring package.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg libgomp1; \
    if [ -n "${AI_CUDA_REPO_DISTRO}" ]; then \
        curl -fsSL "https://developer.download.nvidia.com/compute/cuda/repos/${AI_CUDA_REPO_DISTRO}/x86_64/cuda-keyring_1.1-1_all.deb" \
            -o /tmp/cuda-keyring.deb; \
        dpkg -i /tmp/cuda-keyring.deb; \
        rm /tmp/cuda-keyring.deb; \
        apt-get update; \
    fi; \
    apt-get install -y --no-install-recommends ${AI_LINUX_PACKAGES}; \
    ldconfig; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir ${AI_PYTHON_DEPENDENCIES}

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 converter

# The built model and the server.
COPY --from=builder /build/model /models
COPY server.py healthcheck.py /app/
RUN chown -R converter:converter /models /app

USER converter

ENV AI_MODEL_DIR=/models \
    AI_HOST=0.0.0.0 \
    AI_PORT=8090 \
    AI_MODEL_NAME=ReaderLM-v2

EXPOSE 8090

# Liveness: the HTTP /health is only up after the model loads and warms, so give
# a generous start period (model load + CUDA graph capture can take a couple of
# minutes on first boot). The probe is a standalone script to avoid shell/JSON
# newline-escaping issues.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=4 \
  CMD ["python", "/app/healthcheck.py"]

ENTRYPOINT ["python", "/app/server.py"]
