/**
 * Entrypoint. Reads configuration from the environment and starts the HTTP
 * engine. Kept deliberately thin so it is trivial to test the pieces around
 * it and to swap the transport in the future.
 */
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

function main(): void {
  const config = loadConfig();
  const server = startServer(config);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(
      `[openwebui-markdown-webloader] received ${signal}, shutting down`,
    );
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only auto-start when run directly (not when imported by tests).
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[openwebui-markdown-webloader] failed to start:", error);
    process.exit(1);
  }
}
