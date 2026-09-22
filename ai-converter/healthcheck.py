#!/usr/bin/env python3
"""Container health probe for the AI converter sidecar.

Referenced by both the Dockerfile HEALTHCHECK and docker-compose `test:` as
`python /app/healthcheck.py` so there is exactly one place that knows how to
check liveness (and no shell/JSON newline-escaping pitfalls). Exits 0 on a 200
from /health, 1 otherwise.
"""
import os
import sys
import urllib.request

port = os.environ.get("AI_PORT", "8090")
url = f"http://127.0.0.1:{port}/health"
try:
    with urllib.request.urlopen(url, timeout=8) as resp:
        sys.exit(0 if resp.status == 200 else 1)
except Exception:
    sys.exit(1)
