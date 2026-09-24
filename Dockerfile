# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# OpenWebUI-Markdown-Webloader
# A minimal, non-root Bun runtime image.
#
# The Bun runtime is small and self-contained; we do NOT need a browser (the
# engine fetches and converts server-side with undici + node-html-markdown +
# unpdf, mirroring mcp-searxng's web_url_read), so the image stays lean.
#
# HTML pre-cleaning (PREPROCESS_HTML, on by default) uses `dom_smoothie_cli`,
# a Rust Readability port. We build it as a FULLY STATIC musl binary in a
# throwaway builder stage and COPY only the ~3 MB executable into the runtime
# image. Being static, it has zero runtime library dependencies and runs on any
# glibc base image regardless of the Bun image's Debian version. The Rust/
# musl toolchain (hundreds of MB) never lands in the final image.
#
# The loader degrades gracefully if the binary is ever missing or fails: the
# raw HTML is used unchanged, so PREPROCESS_HTML can never break a conversion.
# ---------------------------------------------------------------------------

# ---- dom_smoothie CLI builder (static musl, multi-arch) --------------------
# This stage is built per target platform (BuildKit passes TARGETPLATFORM and
# runs the stage under emulation for foreign arches), so the binary always
# matches the final image's architecture. A hardcoded x86_64 target here once
# meant arm64 builds either failed or shipped an un-runnable binary — silently,
# because the loader falls back to raw HTML when the cleaner cannot execute.
ARG DOM_SMOOTHIE_VERSION=0.18.2
FROM rust:1-alpine AS smoothie-builder
ARG DOM_SMOOTHIE_VERSION
ARG TARGETPLATFORM
# `git` fetches the tagged source; musl-dev + the Alpine toolchain provide the
# C compiler Rust links the static binary against. `file` verifies the result.
RUN apk add --no-cache git musl-dev file
# Build a fully static, position-independent binary (no libc.so dependency).
# Map the BuildKit TARGETPLATFORM onto a Rust musl triple. When TARGETPLATFORM
# is empty (a legacy non-BuildKit build, which does not populate it), fall back
# to the host architecture instead of assuming amd64. Anything else fails the
# build loudly rather than producing a wrong-arch binary. The `file` check
# asserts the ELF is statically linked so a regression to a dynamic build
# fails the image build rather than shipping a binary the runtime cannot run
# (`file` reports e.g. "static-pie linked" / "statically linked").
RUN case "${TARGETPLATFORM:-}" in \
        linux/amd64) RUST_TARGET=x86_64-unknown-linux-musl ;; \
        linux/arm64) RUST_TARGET=aarch64-unknown-linux-musl ;; \
        "") case "$(uname -m)" in \
                x86_64)  RUST_TARGET=x86_64-unknown-linux-musl ;; \
                aarch64) RUST_TARGET=aarch64-unknown-linux-musl ;; \
                *) echo "ERROR: unsupported host arch: $(uname -m)"; exit 1 ;; \
            esac ;; \
        *) echo "ERROR: unsupported TARGETPLATFORM: ${TARGETPLATFORM}"; exit 1 ;; \
    esac \
    && echo "building dom_smoothie_cli for ${RUST_TARGET}" \
    && rustup target add "${RUST_TARGET}" \
    && git clone --depth 1 --branch "${DOM_SMOOTHIE_VERSION}" \
           https://github.com/niklak/dom_smoothie.git /tmp/smoothie \
    && cd /tmp/smoothie \
    && RUSTFLAGS="-C target-feature=+crt-static" \
       cargo build -p dom_smoothie_cli --release --target "${RUST_TARGET}" \
    && BIN=/tmp/smoothie/target/${RUST_TARGET}/release/dom_smoothie_cli \
    && file "$BIN" \
    && file "$BIN" | grep -qi static \
        || { echo "ERROR: dom_smoothie_cli is not statically linked"; exit 1; } \
    && mkdir -p /out && cp "$BIN" /out/dom_smoothie_cli

FROM oven/bun:1.4.2-slim AS dependencies
WORKDIR /app
# Install dependencies first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2-slim AS release
WORKDIR /app
# Copy the runtime deps and source (Bun runs TypeScript directly; no build step).
COPY --from=dependencies /app/node_modules ./node_modules
COPY src ./src
COPY package.json bun.lock ./
# The static HTML pre-cleaner (architecture matches this image, see the
# builder stage). Placed on PATH so PREPROCESS_BINARY's default
# ("dom_smoothie_cli") resolves without configuration.
COPY --from=smoothie-builder --chmod=0755 \
    /out/dom_smoothie_cli /usr/local/bin/dom_smoothie_cli

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# Health endpoint for the container.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:14786/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENV API_PORT=14786
ENV HOST=0.0.0.0
ENV NODE_ENV=production
# HTML pre-cleaning is ON by default; the static binary is on PATH. Set
# PREPROCESS_HTML=0 to disable Readability cleaning (raw HTML to both paths).
ENV PREPROCESS_HTML=1
EXPOSE 14786

# All configuration comes from the environment (12-factor).
CMD ["bun", "src/index.ts"]
