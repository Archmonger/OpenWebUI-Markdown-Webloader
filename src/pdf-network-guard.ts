/**
 * Network guards installed around PDF parsing.
 *
 * A PDF is untrusted, attacker-controlled input. PDF.js, when configured
 * loosely, can be induced to fetch external resources (remote images, XFA
 * forms, embedded scripts) while parsing, turning a "read this PDF" request
 * into an outbound connection — a blind SSRF / data-exfiltration vector.
 *
 * We neutralize this by pointing the document loader at a hardened config
 * (`disableAutoFetch`, no cMap/standard-font/wasm URLs, no wasm) AND by
 * temporarily monkey-patching the global network primitives so any attempt to
 * open a socket, make an HTTP request, or call `fetch` throws
 * `ExternalFetchAttemptError`, which the caller maps to a clean failure
 * rather than an actual request.
 *
 * The restore function returned by `installPdfNetworkGuards()` is always run
 * in a `finally` block so the process's network stack is never left patched.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export class ExternalFetchAttemptError extends Error {
  constructor() {
    super("PDF_EXTERNAL_FETCH_ATTEMPT");
    this.name = "ExternalFetchAttemptError";
    Object.setPrototypeOf(this, ExternalFetchAttemptError.prototype);
  }
}

type NetworkModules = {
  http: { get: typeof http.get; request: typeof http.request };
  https: { get: typeof https.get; request: typeof https.request };
  net: {
    connect: typeof net.connect;
    createConnection: typeof net.createConnection;
  };
  tls: { connect: typeof tls.connect };
};

/**
 * Patch the global network primitives to throw. Returns a restore function
 * that returns them to their original state.
 */
export function installPdfNetworkGuards(): () => void {
  const modules: NetworkModules = { http, https, net, tls };
  const originals = {
    fetch: globalThis.fetch,
    httpGet: modules.http.get,
    httpRequest: modules.http.request,
    httpsGet: modules.https.get,
    httpsRequest: modules.https.request,
    netConnect: modules.net.connect,
    netCreateConnection: modules.net.createConnection,
    tlsConnect: modules.tls.connect,
  };
  const blocked = (() => {
    throw new ExternalFetchAttemptError();
  }) as unknown as typeof http.get &
    typeof http.request &
    typeof https.get &
    typeof https.request &
    typeof net.connect &
    typeof net.createConnection &
    typeof tls.connect;

  globalThis.fetch = blocked as unknown as typeof globalThis.fetch;
  modules.http.get = blocked;
  modules.http.request = blocked;
  modules.https.get = blocked;
  modules.https.request = blocked;
  modules.net.connect = blocked;
  modules.net.createConnection = blocked;
  modules.tls.connect = blocked;

  return () => {
    globalThis.fetch = originals.fetch;
    modules.http.get = originals.httpGet;
    modules.http.request = originals.httpRequest;
    modules.https.get = originals.httpsGet;
    modules.https.request = originals.httpsRequest;
    modules.net.connect = originals.netConnect;
    modules.net.createConnection = originals.netCreateConnection;
    modules.tls.connect = originals.tlsConnect;
  };
}

/** True when the error chain indicates the parser tried an external fetch. */
export function isExternalFetchAttempt(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") {
      return false;
    }
    const candidate = current as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      candidate.name === "ExternalFetchAttemptError" ||
      (typeof candidate.message === "string" &&
        candidate.message.includes("PDF_EXTERNAL_FETCH_ATTEMPT"))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
