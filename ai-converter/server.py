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
  * No operator-facing token budget: generation stops at the model's EOS
    token, and the caller-side timeout (loader AI_CONVERT_TIMEOUT_MS) is the
    only other stop factor. onnxruntime-genai's TurnOptions still requires a
    numeric ceiling, so a large internal runaway guard exists; it is a
    degenerate-output safety valve, not a tuning knob (the loader timeout
    always cuts in first in normal operation).
  * CUDA-graph capture and a bounded `gpu_utilization_factor` at runtime, both
    supplied via the operator-controlled `AI_RUNTIME_CFG` overlay JSON so the
    GPU-vendor-specific session options never have to be hardcoded here.

Threading model (important): an `onnxruntime_genai.Engine` binds to the thread
that created it and rejects operations from any other thread ("Engine operations
must be called from the Engine owner thread"). We therefore run the Engine on ONE
dedicated worker thread that owns the model and processes a FIFO of conversion
requests. The HTTP layer is multi-threaded (so `/health` stays responsive while a
long conversion runs), but every engine call is marshalled to the owner thread via
a queue and a per-request completion event.

This v1 processes one document per turn at the validated single-stream speed
(prefill ~8k tok/s, decode ~150-180 tok/s on a 16GB RTX 2000 Ada). Coalescing
concurrent HTTP requests into a single continuous-batching turn is out of scope
for v1.

Only the Python standard library plus onnxruntime-genai are required at runtime.

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
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
MODEL_DIR = os.environ.get("AI_MODEL_DIR", "/models")

# Default NVIDIA overlay: CUDA graph capture (≈5% faster decode) plus a
# high gpu_utilization_factor (0.9) so the paged-KV pool is as large as the
# card allows, maximizing how big a document can be converted before it becomes
# unserviceable. Used when AI_RUNTIME_CFG is unset OR empty (a set-but-empty
# string must NOT silently disable the validated default and fall back to the
# model's baked-in enable_cuda_graph=0).
#
# Tuning note: 0.9 leaves ~10% of VRAM as headroom. This was verified on the
# 16 GB RTX 2000 Ada with CUDA graphs enabled: a 0.92 factor loaded the model
# and captured graphs without failure, using ~15.5 GB. If you share the GPU with
# other CUDA-graph workloads or hit CUDA-graph capture failures / OOM, lower
# this (e.g. 0.5–0.8) via AI_RUNTIME_CFG.
DEFAULT_RUNTIME_CFG = json.dumps(
    {
        "model": {
            "decoder": {
                "session_options": {
                    "provider_options": [{"cuda": {"enable_cuda_graph": "1"}}]
                }
            }
        },
        "engine": {"dynamic_batching": {"gpu_utilization_factor": 0.9}},
    }
)
_raw_cfg = os.environ.get("AI_RUNTIME_CFG", "")
RUNTIME_CFG = _raw_cfg if _raw_cfg.strip() else DEFAULT_RUNTIME_CFG

HOST = os.environ.get("AI_HOST", "0.0.0.0")
PORT = int(os.environ.get("AI_PORT", "8090"))
TOKEN = os.environ.get("AI_CONVERTER_TOKEN") or None
# Soft cap on queued conversions. Because the GPU is serialized behind one owner
# thread, a request flood would otherwise grow the queue without bound and keep
# burning GPU cycles on documents whose client has already timed out (the loader
# aborts after AI_CONVERT_TIMEOUT_MS but the queued turn would still run). When
# the queue is at/over this depth we return 503 `busy`, which the loader treats
# as an AI failure and falls back to native — graceful overload shedding. qsize()
# is approximate under concurrency but sufficient as a soft bound.
MAX_QUEUE = int(os.environ.get("AI_MAX_QUEUE", "50"))
SYSTEM_PROMPT = os.environ.get(
    "AI_SYSTEM_PROMPT", "Convert the HTML to Markdown. Output only the Markdown."
)
MODEL_NAME = os.environ.get("AI_MODEL_NAME", "ReaderLM-v2")
# onnxruntime-genai's TurnOptions API REQUIRES a maximum generated-token
# count, but there is deliberately no operator-facing token budget: the
# intended stop conditions are the model's EOS token and the caller's
# timeout (loader AI_CONVERT_TIMEOUT_MS). This large constant only guards
# against degenerate never-EOS generation; any real conversion or the loader
# timeout finishes far below it. Do not tune this to shape output length —
# raise AI_CONVERT_TIMEOUT_MS instead.
RUNAWAY_TOKEN_CAP = 65536

# Shared readiness state between the owner thread and the HTTP handlers.
_READY = threading.Event()
_LOAD_ERROR = {"error": None}

# Requests for the engine-owner thread: (kwargs, result_container_dict, done_event).
_WORK_QUEUE = queue.Queue()


# --------------------------------------------------------------------------
# Core conversion (runs ONLY on the engine-owner thread)
# --------------------------------------------------------------------------
def _convert_on_owner(engine, tokenizer, html, max_new_tokens, temperature, top_k, top_p, seed):
    import numpy as np
    import onnxruntime_genai as og

    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": html},
    ]
    # The validated tokenizer call takes a JSON *string* of the message list.
    prompt = tokenizer.apply_chat_template(json.dumps(msgs), add_generation_prompt=True)
    toks = np.asarray(tokenizer.encode(prompt), dtype=np.int32)

    req = engine.create_request()
    try:
        topt = og.TurnOptions(req)
        topt.set_max_generated_tokens(int(max_new_tokens))
        # temperature 0 => greedy (deterministic), matching validated config.
        if temperature and temperature > 0.0:
            topt.set_do_sample(True)
            topt.set_temperature(float(temperature))
            if top_k and top_k > 0:
                topt.set_top_k(int(top_k))
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
        buf = engine.create_event_buffer(16)
        generated = 0
        gen_tokens = []
        t0 = time.perf_counter()
        while engine.has_pending_requests():
            for ev in engine.run(buf):
                if ev.flags & og.EngineEventFlags.FAILED:
                    raise RuntimeError(
                        f"engine failure flags={ev.flags} code={ev.error_code}"
                    )
                if ev.flags & og.EngineEventFlags.TOKEN:
                    generated += 1
                    gen_tokens.append(ev.token)
                # TURN_FINISHED ends the drain loop naturally via
                # has_pending_requests() becoming False.
        text = tokenizer.decode(gen_tokens) if gen_tokens else ""
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
# Engine-owner thread: loads the model, warms up, then serves the work queue.
# --------------------------------------------------------------------------
def _owner_loop():
    try:
        import onnxruntime_genai as og

        cfg = og.Config(MODEL_DIR)
        if RUNTIME_CFG and RUNTIME_CFG.strip():
            try:
                # Validate the operator overlay before ORT sees it, so a
                # malformed AI_RUNTIME_CFG fails loudly at startup.
                json.loads(RUNTIME_CFG)
            except (ValueError, TypeError) as exc:
                raise RuntimeError(f"AI_RUNTIME_CFG is not valid JSON: {exc}") from exc
            cfg.overlay(RUNTIME_CFG)
        model = og.Model(cfg)
        engine = og.Engine(model)
        tokenizer = og.Tokenizer(model)
        print(
            f"[ai-converter] loaded model from {MODEL_DIR} (runtime_cfg={RUNTIME_CFG})",
            flush=True,
        )

        # Warmup: one tiny conversion so CUDA graphs are captured before the
        # first real request. Best-effort; never blocks readiness.
        warm_html = os.environ.get(
            "AI_STARTUP_PING_HTML",
            "<html><body><h1>warm</h1><p>ok</p></body></html>",
        )
        try:
            _convert_on_owner(engine, tokenizer, warm_html, 32, 0.0, 1, 1.0, None)
            print("[ai-converter] warmup complete", flush=True)
        except Exception as exc:  # pragma: no cover - best effort
            print(f"[ai-converter] warmup skipped: {exc}", flush=True)

        _READY.set()
    except Exception as exc:  # Mark failed readiness so we can report 503.
        _LOAD_ERROR["error"] = f"{type(exc).__name__}: {exc}"
        _READY.set()
        print(f"[ai-converter] failed to load model: {exc}", flush=True)
        return

    # Serve the FIFO forever, on this single owner thread.
    while True:
        kwargs, result, done = _WORK_QUEUE.get()
        try:
            result["value"] = _convert_on_owner(engine, tokenizer, **kwargs)
        except Exception as exc:  # Surface per-request failures to the caller.
            result["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            done.set()


# Raised when the GPU queue is saturated and we are shedding load rather than
# queueing an unbounded backlog of requests whose clients may already be gone.
class ServerBusy(Exception):
    pass


# Public entry used by the HTTP layer: enqueue a conversion and block for it.
def convert(html, temperature, top_k, top_p, seed):
    # Overload shedding: if too many conversions are already queued, refuse this
    # one (503) instead of growing the backlog. The loader treats 503 as an AI
    # failure and falls back to the native renderer, so this degrades gracefully.
    if _WORK_QUEUE.qsize() >= MAX_QUEUE:
        raise ServerBusy(f"queue full ({MAX_QUEUE} pending)")
    result = {}
    done = threading.Event()
    kwargs = {
        "html": html,
        # Not request-configurable: see RUNAWAY_TOKEN_CAP.
        "max_new_tokens": RUNAWAY_TOKEN_CAP,
        "temperature": temperature,
        "top_k": top_k,
        "top_p": top_p,
        "seed": seed,
    }
    _WORK_QUEUE.put((kwargs, result, done))
    # Block with a generous ceiling; the client-side timeout bounds UX.
    done.wait(timeout=600)
    if not done.is_set():
        raise RuntimeError("conversion timed out waiting for the engine")
    if "error" in result:
        raise RuntimeError(result["error"])
    if "value" not in result:
        raise RuntimeError("no result produced")
    return result["value"]


# --------------------------------------------------------------------------
# HTTP surface (multi-threaded; health does NOT touch the engine)
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") == "/health":
            if not _READY.is_set():
                self._send(503, {"status": "loading", "model": MODEL_NAME})
                return
            if _LOAD_ERROR["error"]:
                self._send(503, {"status": "error", "message": _LOAD_ERROR["error"]})
                return
            self._send(200, {"status": "ok", "model": MODEL_NAME, "model_dir": MODEL_DIR})
        else:
            self._send(404, {"error": "not_found", "message": "unknown path"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/convert":
            self._send(404, {"error": "not_found", "message": "unknown path"})
            return
        if TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {TOKEN}":
                self._send(401, {"error": "unauthorized"})
                return
        # Refuse work until the engine is ready (and forever if it failed to load).
        if not _READY.is_set():
            self._send(503, {"error": "loading", "message": "model not ready"})
            return
        if _LOAD_ERROR["error"]:
            self._send(503, {"error": "model_unavailable", "message": _LOAD_ERROR["error"]})
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
                400,
                {"error": "bad_request", "message": "'html' must be a non-empty string"},
            )
            return

        try:
            # There is no max_new_tokens field: generation stops at EOS or the
            # caller's timeout. A legacy request that still sends one has the
            # field ignored (old loaders keep working).
            result = convert(
                html,
                float(payload.get("temperature", 0.0)),
                int(payload.get("top_k", 1)),
                float(payload.get("top_p", 1.0)),
                payload.get("seed"),
            )
        except ServerBusy as exc:
            # Load-shed rather than build an unbounded GPU backlog. The loader
            # treats any non-2xx as an AI failure and falls back to native.
            self._send(503, {"error": "busy", "message": str(exc)})
            return
        except Exception as exc:  # Surface as 500 so the loader falls back.
            self._send(500, {"error": "convert_failed", "message": str(exc)})
            return

        self._send(200, result)

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("[ai-converter] %s\n" % (fmt % args))


def main():
    # Start the engine-owner thread BEFORE the HTTP server so it begins loading
    # immediately. Readiness is signalled via _READY; handlers gate on it.
    owner = threading.Thread(target=_owner_loop, name="engine-owner", daemon=True)
    owner.start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[ai-converter] listening on http://{HOST}:{PORT} (model loading...)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
