# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# OpenWebUI-Markdown-Webloader
# A minimal, non-root Bun runtime image.
#
# The Bun runtime is small and self-contained; we do NOT need a browser (the
# engine fetches and converts server-side with undici + node-html-markdown +
# unpdf, mirroring mcp-searxng's web_url_read), so the image stays lean.
# ---------------------------------------------------------------------------

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
EXPOSE 14786

# All configuration comes from the environment (12-factor).
CMD ["bun", "src/index.ts"]
