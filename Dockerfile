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

# ---- dom_smoothie CLI builder (static musl) --------------------------------
ARG DOM_SMOOTHIE_VERSION=0.18.2
FROM rust:1-alpine AS smoothie-builder
ARG DOM_SMOOTHIE_VERSION
# `git` fetches the tagged source; musl-dev + the Alpine toolchain provide the
# C compiler Rust links the static binary against. `file` verifies the result.
RUN apk add --no-cache git musl-dev file
# Build a fully static, position-independent binary (no libc.so dependency).
# The check asserts the ELF is statically linked so a regression to a dynamic
# build fails the image build rather than shipping a binary the runtime cannot
# run. `file` reports e.g. "static-pie linked" / "statically linked".
RUN git clone --depth 1 --branch "${DOM_SMOOTHIE_VERSION}" \
        https://github.com/niklak/dom_smoothie.git /tmp/smoothie \
    && cd /tmp/smoothie \
    && RUSTFLAGS="-C target-feature=+crt-static" \
       cargo build -p dom_smoothie_cli --release --target x86_64-unknown-linux-musl \
    && BIN=/tmp/smoothie/target/x86_64-unknown-linux-musl/release/dom_smoothie_cli \
    && file "$BIN" \
    && file "$BIN" | grep -qi static \
        || { echo "ERROR: dom_smoothie_cli is not statically linked"; exit 1; }

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
# The static HTML pre-cleaner. Placed on PATH so PREPROCESS_BINARY's default
# ("dom_smoothie_cli") resolves without configuration.
COPY --from=smoothie-builder \
    /tmp/smoothie/target/x86_64-unknown-linux-musl/release/dom_smoothie_cli \
    /usr/local/bin/dom_smoothie_cli
RUN chmod 0755 /usr/local/bin/dom_smoothie_cli

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
