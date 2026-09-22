"""GPU-free unit tests for the AI converter sidecar.

These exercise the HTTP surface and the config/overlay logic by stubbing the
`onnxruntime_genai` module, so they run anywhere `python3` is present without a
GPU, model weights, or the real ORT install. They verify the *contract* the Bun
loader depends on: request/response shape, bearer auth, health/readiness, the
empty-vs-real overlay handling, and the single-owner-thread marshalling (the
Engine binds to the thread that created it, so all conversions funnel through one
worker thread fed by a queue).

Run from the ai-converter directory:
    python3 -m unittest discover -v
or a single file:
    python3 -m unittest tests.test_sidecar -v
"""

import importlib
import json
import os
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR_DIR = os.path.dirname(HERE)
if SIDECAR_DIR not in sys.path:
    sys.path.insert(0, SIDECAR_DIR)

# Captures every og.Config instance the sidecar creates, so overlay assertions can
# inspect the most recent one.
_LAST_CONFIG = {}


class _FakeTokenizer:
    def apply_chat_template(self, msgs_json, add_generation_prompt=True):
        msgs = json.loads(msgs_json)
        return "\n".join(m["content"] for m in msgs)

    def encode(self, s):
        return [len(w) for w in s.split()]

    def decode(self, tokens):
        return "# fake markdown\n\nfrom stub"


class _FakeEvent:
    TOKEN = 1
    FAILED = 2
    TURN_FINISHED = 4


class _FakeRequest:
    def __init__(self, engine):
        self.engine = engine
        self.turn_started = False

    def begin_turn(self, toks, topt):
        # begin_turn arms the engine so has_pending_requests() is True for this
        # turn; the fake `run` then clears it after emitting one token. This makes
        # each turn independent even though the engine instance persists.
        self.turn_started = True
        self.engine._pending = True

    def close(self):
        pass


class _FakeEngine:
    def __init__(self):
        self._pending = False
        self.owner_thread = threading.current_thread()

    def create_request(self):
        # Requests may only be created from the owner thread (mirrors the real
        # engine's ownership rule). If a non-owner thread calls this, surface it.
        if threading.current_thread() is not self.owner_thread:
            raise RuntimeError(
                "Engine operations must be called from the Engine owner thread."
            )
        return _FakeRequest(self)

    def create_event_buffer(self, n):
        return []

    def has_pending_requests(self):
        if threading.current_thread() is not self.owner_thread:
            raise RuntimeError(
                "Engine operations must be called from the Engine owner thread."
            )
        return self._pending

    def run(self, buf):
        if threading.current_thread() is not self.owner_thread:
            raise RuntimeError(
                "Engine operations must be called from the Engine owner thread."
            )
        if not self._pending:
            return []
        self._pending = False
        ev = types.SimpleNamespace(flags=_FakeEvent.TOKEN | _FakeEvent.TURN_FINISHED, token=3)
        return [ev]


class _FakeTurnOptions:
    def __init__(self, req):
        self.req = req
        self.values = {}

    def set_max_generated_tokens(self, v):
        self.values["max"] = v

    def set_do_sample(self, v):
        self.values["sample"] = v

    def set_temperature(self, v):
        self.values["temperature"] = v

    def set_top_k(self, v):
        self.values["top_k"] = v

    def set_top_p(self, v):
        self.values["top_p"] = v


class _FakeConfig:
    def __init__(self, path):
        self.path = path
        self.overlays = []
        _LAST_CONFIG["instance"] = self

    def overlay(self, s):
        self.overlays.append(s)


def _install_fake_genai():
    og = types.ModuleType("onnxruntime_genai")
    og.Config = _FakeConfig
    og.Model = lambda cfg: object()
    og.Tokenizer = lambda model: _FakeTokenizer()
    og.Engine = lambda model: _FakeEngine()
    og.TurnOptions = _FakeTurnOptions
    og.EngineEventFlags = _FakeEvent
    sys.modules["onnxruntime_genai"] = og
    if "numpy" not in sys.modules:
        np = types.ModuleType("numpy")
        np.int32 = "int32"
        np.asarray = lambda x, dtype=None: list(x)
        sys.modules["numpy"] = np


def _load_server(**env):
    """(Re)load the sidecar module with the given env overrides, fakes installed."""
    _install_fake_genai()
    saved = {k: os.environ.get(k) for k in env}
    for k, v in env.items():
        os.environ[k] = v
    for k in (
        "AI_MODEL_DIR",
        "AI_RUNTIME_CFG",
        "AI_HOST",
        "AI_PORT",
        "AI_CONVERTER_TOKEN",
    ):
        if k not in env:
            os.environ.pop(k, None)
    if "server" in sys.modules:
        del sys.modules["server"]
    srv = importlib.import_module("server")
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return srv


def _start_sidecar(srv):
    """Start the engine-owner thread + HTTP server; return the HTTP port."""
    owner = threading.Thread(target=srv._owner_loop, name="test-owner", daemon=True)
    owner.start()
    # The owner thread loads the (fake) model and signals readiness quickly.
    assert srv._READY.wait(timeout=5), "owner thread did not become ready"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    def _stop():
        httpd.shutdown()
        httpd.server_close()

    return port, _stop


def _http_json(port, method, path, body=None, token=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


class SidecarContractTest(unittest.TestCase):
    def setUp(self):
        _LAST_CONFIG.clear()

    def _serve(self, srv):
        port, stop = _start_sidecar(srv)
        self.addCleanup(stop)
        return port

    def test_convert_success_contract(self):
        srv = _load_server()
        port = self._serve(srv)
        status, body = _http_json(
            port, "POST", "/convert", {"html": "<h1>hi</h1>", "max_new_tokens": 128}
        )
        self.assertEqual(status, 200)
        for key in ("markdown", "tokens", "model", "latency_ms"):
            self.assertIn(key, body)
        self.assertIsInstance(body["markdown"], str)
        self.assertTrue(body["markdown"])

    def test_owner_thread_marshalling(self):
        # Conversions must be funneled to the single engine-owner thread, not the
        # HTTP handler thread. We assert the fake engine only ever ran on its
        # owner thread (a violation would have raised RuntimeError -> 500).
        srv = _load_server()
        port = self._serve(srv)
        # Fire several concurrent conversions from different HTTP threads.
        results = []
        threads = []
        for i in range(4):
            def call():
                s, b = _http_json(port, "POST", "/convert", {"html": "<p>x</p>"})
                results.append((s, b))
            th = threading.Thread(target=call)
            threads.append(th)
            th.start()
        for th in threads:
            th.join(timeout=15)
        self.assertEqual(len(results), 4)
        for s, b in results:
            self.assertEqual(s, 200, msg=f"expected 200 (no owner-thread error), got {b}")

    def test_health_contract(self):
        srv = _load_server(AI_MODEL_NAME="ReaderLM-custom")
        port = self._serve(srv)
        status, body = _http_json(port, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["model"], "ReaderLM-custom")

    def test_bearer_auth_required(self):
        srv = _load_server(AI_CONVERTER_TOKEN="topsecret")
        port = self._serve(srv)
        status, _ = _http_json(port, "POST", "/convert", {"html": "<b>x</b>"})
        self.assertEqual(status, 401)
        status, _ = _http_json(
            port, "POST", "/convert", {"html": "<b>x</b>"}, token="topsecret"
        )
        self.assertEqual(status, 200)

    def test_empty_html_rejected(self):
        srv = _load_server()
        port = self._serve(srv)
        status, _ = _http_json(port, "POST", "/convert", {"html": "   "})
        self.assertEqual(status, 400)

    def test_unknown_path_404(self):
        srv = _load_server()
        port = self._serve(srv)
        status, _ = _http_json(port, "POST", "/nope", {"html": "x"})
        self.assertEqual(status, 404)

    def test_default_overlay_is_the_proven_default(self):
        # When AI_RUNTIME_CFG is unset/empty, the proven NVIDIA default applies.
        srv = _load_server(AI_RUNTIME_CFG="")
        cfg = json.loads(srv.RUNTIME_CFG)
        provider = cfg["model"]["decoder"]["session_options"]["provider_options"][0]
        self.assertEqual(provider["cuda"]["enable_cuda_graph"], "1")
        self.assertEqual(cfg["engine"]["dynamic_batching"]["gpu_utilization_factor"], 0.5)

    def test_custom_overlay_passthrough(self):
        custom = json.dumps(
            {"engine": {"dynamic_batching": {"gpu_utilization_factor": 0.7}}}
        )
        srv = _load_server(AI_RUNTIME_CFG=custom)
        self.assertEqual(srv.RUNTIME_CFG, custom)

    def test_overlay_applied_to_model(self):
        srv = _load_server()
        self._serve(srv)
        # The owner thread created an og.Config and applied an overlay.
        cfg = _LAST_CONFIG.get("instance")
        self.assertIsNotNone(cfg, "og.Config was not created by the owner loop")
        self.assertEqual(len(cfg.overlays), 1)
        # It is valid JSON (the sidecar validates before applying).
        json.loads(cfg.overlays[0])

    def test_queue_saturation_sheds(self):
        # With the queue at/over the cap, convert() must raise ServerBusy instead
        # of growing the backlog. Owner thread is intentionally NOT started here,
        # so the one queued dummy never drains.
        srv = _load_server(AI_MAX_QUEUE="1")
        # Do NOT call _start_sidecar (owner would drain). Just queue one dummy.
        srv._WORK_QUEUE.put(({}, {}, threading.Event()))
        self.assertEqual(srv.MAX_QUEUE, 1)
        self.assertGreaterEqual(srv._WORK_QUEUE.qsize(), 1)
        with self.assertRaises(srv.ServerBusy):
            srv.convert("<p>x</p>", 10, 0.0, 1, 1.0, None)

    def test_busy_maps_to_503(self):
        # End-to-end through the handler: a full queue returns HTTP 503 busy.
        srv = _load_server(AI_MAX_QUEUE="0")
        # Start a *paused* owner so readiness gating passes but nothing drains.
        # Easiest: pre-set readiness, fill the queue, hit the endpoint.
        srv._READY.set()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        status, body = _http_json(port, "POST", "/convert", {"html": "<b>x</b>"})
        self.assertEqual(status, 503)
        self.assertEqual(body.get("error"), "busy")

    def test_load_failure_marks_health_error(self):
        # Simulate a model load failure: the owner thread records the error and
        # sets READY; health then reports 503 and convert refuses with 503.
        srv = _load_server()
        # Pre-arm an error so _owner_loop takes the failure branch.
        srv._LOAD_ERROR["error"] = "forced failure"
        srv._READY.set()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        status, body = _http_json(port, "GET", "/health")
        self.assertEqual(status, 503)
        self.assertEqual(body["status"], "error")
        status, _ = _http_json(port, "POST", "/convert", {"html": "<b>x</b>"})
        self.assertEqual(status, 503)


if __name__ == "__main__":
    unittest.main()
