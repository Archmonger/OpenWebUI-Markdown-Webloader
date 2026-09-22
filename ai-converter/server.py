#!/usr/bin/env python3
"""
ReaderLM-v2 AI HTML->Markdown converter sidecar.

This is the optional GPU service that the Bun loader (src/ai-converter.ts) calls
over HTTP when `AI_CONVERTER_ENABLED=1`. It wraps `onnxruntime-genai` and mirrors
the exact recipe validated for this project:

  * int4-quantized ReaderLM-v2 with paged attention (builder:
    `use_paged_attention=true`), which removes the dense attention_mask prefill
    spike and enables the continuous-batching Engine API.
  * Greedy decoding (temperature 0 -> do_sample=False) for deterministic,
    faithful markdown, which is the ReaderLM-v2 intended usage.
  * CUDA-graph capture and a bounded `gpu_utilization_factor` at runtime, both
    supplied via the operator-controlled `AI_RUNTIME_CFG` overlay JSON so the
    GPU-vendor-specific session options never have to be hardcoded here.

The whole engine is serialized behind a lock: a single `Engine` owns the paged KV
pool and cross-thread `run()` calls are not safe. HTTP connections are served
concurrently (ThreadingHTTPServer) but actual GPU turns are serialized. A single
document is thus converted per turn with the validated single-stream speed
(prefill ~8k tok/s, decode ~150-180 tok/s on a 16GB RTX 2000 Ada); coalescing
multiple concurrent HTTP requests into one continuous batch is intentionally out
of scope for v1.

Only the Python standard library plus onnxruntime-genai are required at runtime,
which keeps the serving image free of a web framework.

Environment (all read at startup; see .env.example for the loader side):
  AI_MODEL_DIR            Directory containing a built genai model. Default /models.
  AI_RUNTIME_CFG          JSON overlay merged into og.Config (vendor-specific).
  AI_HOST / AI_PORT       Bind address for the HTTP server.
  AI_CONVERTER_TOKEN      Shared bearer token (optional) checked on /convert.
  AI_SYSTEM_PROMPT        Override the default markdown-instruction system prompt.
  AI_STARTUP_PING_HTML    Small HTML used to warm the engine at startup.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
MODEL_DIR = os.environ.get("AI_MODEL_DIR", "/models")

# Proven NVIDIA default overlay: CUDA graph capture (≈5% faster decode) plus a
# conservative gpu_utilization_factor so graph-capture buffers are not starved on
# a shared GPU. Used when AI_RUNTIME_CFG is unset OR empty (a set-but-empty string
# must NOT silently disable the validated default and fall back to the model's
# baked-in enable_cuda_graph=0).
DEFAULT_RUNTIME_CFG = json.dumps(
    {
        "model": {
            "decoder": {
                "session_options": {
                    "provider_options": [{"cuda": {"enable_cuda_graph": "1"}}]
                }
            }
        },
        "engine": {"dynamic_batching": {"gpu_utilization_factor": 0.5}},
    }
)
_raw_cfg = os.environ.get("AI_RUNTIME_CFG", "")
RUNTIME_CFG = _raw_cfg if _raw_cfg.strip() else DEFAULT_RUNTIME_CFG
HOST = os.environ.get("AI_HOST", "0.0.0.0")
PORT = int(os.environ.get("AI_PORT", "8090"))
TOKEN = os.environ.get("AI_CONVERTER_TOKEN") or None
SYSTEM_PROMPT = os.environ.get(
    "AI_SYSTEM_PROMPT", "Convert the HTML to Markdown. Output only the Markdown."
)
MODEL_NAME = os.environ.get("AI_MODEL_NAME", "ReaderLM-v2")

# The engine is not thread-safe for concurrent run(); a single global lock
# serializes every GPU turn while the HTTP server accepts many connections.
_ENGINE_LOCK = threading.Lock()
_ENGINE = None  # type: ignore[var-annotated]
_TOKENIZER = None  # type: ignore[var-annotated]


def _load_model() -> None:
    """Build/hold the global og.Model / og.Tokenizer exactly once."""
    global _ENGINE, _TOKENIZER
    import numpy as np  # noqa: F401  (imported for parity; used by callers)
    import onnxruntime_genai as og

    cfg = og.Config(MODEL_DIR)
    if RUNTIME_CFG and RUNTIME_CFG.strip():
        try:
            # Validate the operator-supplied overlay before handing it to ORT so a
            # malformed AI_RUNTIME_CFG fails loudly at startup, not per-request.
            json.loads(RUNTIME_CFG)
        except (ValueError, TypeError) as exc:
            raise RuntimeError(
                f"AI_RUNTIME_CFG is not valid JSON: {exc}"
            ) from exc
        cfg.overlay(RUNTIME_CFG)
    model = og.Model(cfg)
    _ENGINE = og.Engine(model)
    _TOKENIZER = og.Tokenizer(model)
    print(
        f"[ai-converter] loaded model from {MODEL_DIR} "
        f"(runtime_cfg={RUNTIME_CFG})",
        flush=True,
    )


def _warmup() -> None:
    """Run a tiny conversion so the CUDA graphs are captured before first request."""
    warm_html = os.environ.get(
        "AI_STARTUP_PING_HTML", "<html><body><h1>warm</h1><p>ok</p></body></html>"
    )
    try:
        convert(warm_html, 32, 0.0, 1, 1.0, None)
        print("[ai-converter] warmup complete", flush=True)
    except Exception as exc:  # pragma: no cover - best effort
        print(f"[ai-converter] warmup skipped: {exc}", flush=True)


# --------------------------------------------------------------------------
# Core conversion (mirrors the validated bench recipe)
# --------------------------------------------------------------------------
def convert(
    html: str,
    max_new_tokens: int,
    temperature: float,
    top_k: int,
    top_p: float,
    seed,
) -> dict:
    import numpy as np
    import onnxruntime_genai as og

    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": html},
    ]
    # The validated tokenizer call takes a JSON *string* of the message list.
    prompt = _TOKENIZER.apply_chat_template(json.dumps(msgs), add_generation_prompt=True)
    toks = np.asarray(_TOKENIZER.encode(prompt), dtype=np.int32)

    with _ENGINE_LOCK:
        req = _ENGINE.create_request()
        try:
            topt = og.TurnOptions(req)
            topt.set_max_generated_tokens(int(max_new_tokens))
            # temperature 0 => greedy (deterministic), matching validated config.
            if temperature and temperature > 0.0:
                topt.set_do_sample(True)
                topt.set_temperature(float(temperature))
                topt.set_top_k(int(top_k)) if top_k and top_k > 0 else None
                topt.set_top_p(float(top_p))
            else:
                topt.set_do_sample(False)
                topt.set_temperature(1.0)
                topt.set_top_k(1)
                topt.set_top_p(1.0)
            # Seed is best-effort: not every genai build exposes it, and greedy is
            # deterministic regardless.
            if seed is not None and hasattr(topt, "set_random_seed"):
                try:
                    topt.set_random_seed(int(seed))
                except Exception:
                    pass

            req.begin_turn(toks, topt)
            buf = _ENGINE.create_event_buffer(16)
            generated = 0
            gen_tokens = []
            t0 = time.perf_counter()
            while _ENGINE.has_pending_requests():
                for ev in _ENGINE.run(buf):
                    if ev.flags & og.EngineEventFlags.FAILED:
                        raise RuntimeError(
                            f"engine failure flags={ev.flags} code={ev.error_code}"
                        )
                    if ev.flags & og.EngineEventFlags.TOKEN:
                        generated += 1
                        gen_tokens.append(ev.token)
                    # TURN_FINISHED simply ends the drain loop naturally because
                    # has_pending_requests() becomes False.
            text = _TOKENIZER.decode(gen_tokens) if gen_tokens else ""
            latency_ms = (time.perf_counter() - t0) * 1000.0
        finally:
            try:
                req.close()
            except Exception:
                pass

    return {
        "markdown": text,
        "tokens": generated,
        "model": MODEL_NAME,
        "latency_ms": round(latency_ms, 1),
    }


# --------------------------------------------------------------------------
# HTTP surface
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._send(
                200,
                {"status": "ok", "model": MODEL_NAME, "model_dir": MODEL_DIR},
            )
        else:
            self._send(404, {"error": "not_found", "message": "unknown path"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/convert":
            self._send(404, {"error": "not_found", "message": "unknown path"})
            return
        # Bearer auth (optional).
        if TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {TOKEN}":
                self._send(401, {"error": "unauthorized"})
                return
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, TypeError):
            self._send(400, {"error": "bad_request", "message": "invalid JSON body"})
            return

        html = payload.get("html")
        if not isinstance(html, str) or html.strip() == "":
            self._send(
                400, {"error": "bad_request", "message": "'html' must be a non-empty string"}
            )
            return

        try:
            result = convert(
                html,
                int(payload.get("max_new_tokens", 8192)),
                float(payload.get("temperature", 0.0)),
                int(payload.get("top_k", 1)),
                float(payload.get("top_p", 1.0)),
                payload.get("seed"),
            )
        except Exception as exc:  # Surface as 500 so the loader falls back.
            self._send(
                500,
                {"error": "convert_failed", "message": f"{type(exc).__name__}: {exc}"},
            )
            return

        self._send(200, result)

    # Quieter access log.
    def log_message(self, fmt, *args) -> None:  # noqa: A003
        sys.stderr.write("[ai-converter] %s\n" % (fmt % args))


def main() -> int:
    try:
        _load_model()
        _warmup()
    except Exception as exc:
        print(f"[ai-converter] failed to start: {exc}", flush=True)
        return 1
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[ai-converter] listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
