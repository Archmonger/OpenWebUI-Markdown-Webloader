"""GPU-free unit tests for the AI converter sidecar.

These exercise the HTTP surface and the config/overlay logic by stubbing the
`onnxruntime_genai` module, so they run anywhere `python3` is present without a
GPU, model weights, or the real ORT install. They verify the *contract* the Bun
loader depends on: request/response shape, bearer auth, health, and the
empty-vs-real overlay handling.

Run from the ai-converter directory:
    python3 -m unittest discover -v
or a single file:
    python3 -m unittest tests.test_sidecar -v
"""

import importlib
import json
import os
import sys
import types
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR_DIR = os.path.dirname(HERE)
if SIDECAR_DIR not in sys.path:
    sys.path.insert(0, SIDECAR_DIR)


class _FakeTokenizer:
    def apply_chat_template(self, msgs_json, add_generation_prompt=True):
        msgs = json.loads(msgs_json)
        return "\n".join(m["content"] for m in msgs)

    def encode(self, s):
        # One "token" per whitespace-separated word, deterministic.
        return [len(w) for w in s.split()]

    def decode(self, tokens):
        return "# fake markdown\n\nfrom stub"


class _FakeEvent:
    TOKEN = 1
    FAILED = 2
    TURN_FINISHED = 4


class _FakeEngine:
    def create_request(self):
        return _FakeRequest()

    def create_event_buffer(self, n):
        return []

    def has_pending_requests(self):
        # True exactly once so the drain loop runs a single pass.
        if getattr(self, "_pending", None) is None:
            self._pending = True
            return True
        if self._pending:
            self._pending = False
            return True
        return False

    def run(self, buf):
        ev = types.SimpleNamespace(
            flags=_FakeEvent.TOKEN | _FakeEvent.TURN_FINISHED, token=3
        )
        self._pending = False
        return [ev]


class _FakeRequest:
    def begin_turn(self, toks, topt):
        # Real Engine API entry point; recorded so tests can assert the turn ran.
        self.toks = toks
        self.topt = topt

    def close(self):
        pass


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

    def overlay(self, s):
        self.overlays.append(s)


def _install_fake_genai():
    """Register a fake `onnxruntime_genai` + numpy in sys.modules."""
    og = types.ModuleType("onnxruntime_genai")
    og.Config = _FakeConfig
    og.Model = lambda cfg: object()
    og.Tokenizer = lambda model: _FakeTokenizer()
    og.Engine = lambda model: _FakeEngine()
    og.TurnOptions = _FakeTurnOptions
    og.EngineEventFlags = _FakeEvent
    sys.modules["onnxruntime_genai"] = og
    # numpy: the sidecar only uses np.asarray(x, dtype=np.int32) and len().
    if "numpy" not in sys.modules:
        np = types.ModuleType("numpy")
        np.int32 = "int32"
        np.asarray = lambda x, dtype=None: list(x)
        sys.modules["numpy"] = np
    return og


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
    for mod in list(sys.modules):
        if mod == "server":
            del sys.modules[mod]
    srv = importlib.import_module("server")
    # Restore env after import (module captured its config at import time).
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return srv


def _http_json(port, method, path, body=None, token=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


class SidecarContractTest(unittest.TestCase):
    def _serve(self, srv):
        srv._ENGINE = _FakeEngine()
        srv._TOKENIZER = _FakeTokenizer()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        port = httpd.server_address[1]
        import threading

        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()

        def _stop():
            httpd.shutdown()
            httpd.server_close()

        self.addCleanup(_stop)
        return port

    def test_convert_success_contract(self):
        srv = _load_server()
        port = self._serve(srv)
        status, body = _http_json(
            port, "POST", "/convert", {"html": "<h1>hi</h1>", "max_new_tokens": 128}
        )
        self.assertEqual(status, 200)
        self.assertIn("markdown", body)
        self.assertIn("tokens", body)
        self.assertIn("model", body)
        self.assertIn("latency_ms", body)
        self.assertIsInstance(body["markdown"], str)
        self.assertTrue(body["markdown"])

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
        status, body = _http_json(port, "POST", "/convert", {"html": "<b>x</b>"})
        self.assertEqual(status, 401)
        status, body = _http_json(
            port, "POST", "/convert", {"html": "<b>x</b>"}, token="topsecret"
        )
        self.assertEqual(status, 200)

    def test_empty_html_rejected(self):
        srv = _load_server()
        port = self._serve(srv)
        status, body = _http_json(port, "POST", "/convert", {"html": "   "})
        self.assertEqual(status, 400)

    def test_unknown_path_404(self):
        srv = _load_server()
        port = self._serve(srv)
        status, _ = _http_json(port, "POST", "/nope", {"html": "x"})
        self.assertEqual(status, 404)

    def test_default_overlay_is_the_proven_default(self):
        # When AI_RUNTIME_CFG is unset or empty, the sidecar must use the
        # proven default overlay (CUDA graph + gpu_utilization_factor 0.5).
        srv = _load_server(AI_RUNTIME_CFG="")
        cfg = json.loads(srv.RUNTIME_CFG)
        provider = cfg["model"]["decoder"]["session_options"]["provider_options"][0]
        self.assertEqual(provider["cuda"]["enable_cuda_graph"], "1")
        self.assertEqual(
            cfg["engine"]["dynamic_batching"]["gpu_utilization_factor"], 0.5
        )

    def test_custom_overlay_passthrough(self):
        custom = json.dumps({"engine": {"dynamic_batching": {"gpu_utilization_factor": 0.7}}})
        srv = _load_server(AI_RUNTIME_CFG=custom)
        self.assertEqual(srv.RUNTIME_CFG, custom)

    def test_overlay_applied_to_model(self):
        srv = _load_server()
        # Simulate model load with the fake ORT and assert overlay() was called.
        recorded = {}
        og = sys.modules["onnxruntime_genai"]
        original_config = og.Config

        class RecordingConfig(_FakeConfig):
            def overlay(self, s):
                recorded["overlay"] = s
                super().overlay(s)

        og.Config = RecordingConfig
        try:
            srv._load_model()
        finally:
            og.Config = original_config
        self.assertIn("overlay", recorded)
        # It is valid JSON (the sidecar validates before applying).
        json.loads(recorded["overlay"])


if __name__ == "__main__":
    unittest.main()
