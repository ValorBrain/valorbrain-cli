#!/usr/bin/env python3
"""Offline tests: the Hermes plugin declares X-Run-Kind (ADR-084).

A cron/flush agent context or a machine-paced session source sends
`X-Run-Kind: routine`; a person's session and a subagent send none. An explicit
VALORBRAIN_RUN_KIND wins. VALORBRAIN_REQUESTED_BY / VALORBRAIN_AGENT_TEAM go
out as X-Requested-By / X-Agent-Team.

The network is a real local HTTP server; the Hermes SDK (`agent.memory_provider`)
is a stub in `sys.modules`.

Run: PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s packages/hermes-plugin/tests -v
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "__init__.py"


def _load_plugin():
    agent_mod = types.ModuleType("agent")
    provider_mod = types.ModuleType("agent.memory_provider")

    class MemoryProvider:  # the plugin only subclasses it
        pass

    provider_mod.MemoryProvider = MemoryProvider
    agent_mod.memory_provider = provider_mod
    sys.modules.setdefault("agent", agent_mod)
    sys.modules.setdefault("agent.memory_provider", provider_mod)
    spec = importlib.util.spec_from_file_location("_hermes_plugin_run_kind", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_hermes_plugin_run_kind"] = mod
    spec.loader.exec_module(mod)
    return mod


vb = _load_plugin()

TOKEN = "vbm_runkindtest_0123456789"
ENV_KEYS = (
    "VALORBRAIN_HOOKS_MODE", "VALORBRAIN_ENGINE_URL", "VALORBRAIN_API_URL",
    "VALORBRAIN_API_TOKEN", "VALORBRAIN_TENANT_ID", "VALORBRAIN_DEFAULT_TENANT_ID",
    "VALORBRAIN_USER_ID", "VALORBRAIN_BIN", "CLAWMEM_BIN", "VALORBRAIN_SERVE_PORT",
    "VALORBRAIN_SEND_TRANSCRIPT", "VALORBRAIN_SEND_PROMPT", "VALORBRAIN_SOURCE_AGENT",
    "VALORBRAIN_RUN_KIND", "VALORBRAIN_REQUESTED_BY", "VALORBRAIN_AGENT_TEAM",
    "HERMES_SESSION_SOURCE", "HERMES_SINGLE_QUERY_SESSION", "PATH", "HOME",
)


class _Stub(BaseHTTPRequestHandler):
    requests: list = []

    def log_message(self, *_a):
        pass

    def _record(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        _Stub.requests.append({
            "path": self.path.split("?", 1)[0],
            "headers": {k.lower(): v for k, v in self.headers.items()},
        })

    def _reply(self, payload: dict):
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._record()
        self._reply({})

    def do_POST(self):
        self._record()
        self._reply({"ok": True, "context": ""})


class RunKindTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        os.environ["HOME"] = str(self.root)
        os.environ["PATH"] = str(self.root / "bin")  # no node: no heal
        os.environ["VALORBRAIN_HOOKS_MODE"] = "hosted"
        os.environ["VALORBRAIN_ENGINE_URL"] = self.url
        os.environ["VALORBRAIN_API_TOKEN"] = TOKEN
        _Stub.requests = []
        vb._own_install_id = None
        vb._warned_no_launcher = False
        vb._heal_mem = {}

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _start(self, **kwargs):
        p = vb.ValorBrainProvider()
        p.initialize("sess-run-kind", hermes_home=str(self.root / ".hermes"), **kwargs)
        return p

    def _sent(self, header: str) -> dict:
        """path → header value (None when absent) for every request so far."""
        self.assertTrue(_Stub.requests, "the plugin made no request")
        out: dict = {}
        for r in _Stub.requests:
            out.setdefault(r["path"], set()).add(r["headers"].get(header))
        return out

    def assert_everywhere(self, header: str, value):
        for path, values in self._sent(header).items():
            self.assertEqual(values, {value}, f"{header} on {path}")

    def test_cron_context_sends_routine_on_every_request(self):
        p = self._start(agent_context="cron", platform="cron")
        p._tool_store({"type": "note", "title": "t", "content": "c"})
        paths = set(self._sent("x-run-kind"))
        self.assertIn("/api/v1/hooks/run", paths)
        self.assertIn("/api/v1/memory/store", paths)
        self.assert_everywhere("x-run-kind", "routine")

    def test_flush_context_sends_routine(self):
        self._start(agent_context="flush", platform="cli")
        self.assert_everywhere("x-run-kind", "routine")

    def test_oneshot_session_source_sends_routine(self):
        os.environ["HERMES_SINGLE_QUERY_SESSION"] = "1"
        self._start(agent_context="primary", platform="cli")
        self.assert_everywhere("x-run-kind", "routine")

    def test_batch_session_source_sends_routine(self):
        os.environ["HERMES_SESSION_SOURCE"] = "batch"
        self._start(agent_context="primary")
        self.assert_everywhere("x-run-kind", "routine")

    def test_primary_interactive_session_sends_no_run_kind(self):
        p = self._start(agent_context="primary", platform="cli")
        p._tool_store({"type": "note", "title": "t", "content": "c"})
        self.assert_everywhere("x-run-kind", None)

    def test_messaging_session_sends_no_run_kind(self):
        self._start(agent_context="primary", platform="telegram")
        self.assert_everywhere("x-run-kind", None)

    def test_subagent_sends_no_run_kind(self):
        self._start(agent_context="subagent", platform="cli")
        self.assert_everywhere("x-run-kind", None)

    def test_explicit_env_wins_over_inference(self):
        os.environ["VALORBRAIN_RUN_KIND"] = "pipeline"
        self._start(agent_context="cron", platform="cron")
        self.assert_everywhere("x-run-kind", "pipeline")

    def test_explicit_env_declares_an_interactive_session(self):
        os.environ["VALORBRAIN_RUN_KIND"] = "Routine"
        self._start(agent_context="primary", platform="cli")
        self.assert_everywhere("x-run-kind", "routine")

    def test_invalid_explicit_env_is_ignored(self):
        os.environ["VALORBRAIN_RUN_KIND"] = "batch-job"
        self._start(agent_context="primary", platform="cli")
        self.assert_everywhere("x-run-kind", None)

    def test_requester_and_team_forwarded_ascii_folded(self):
        os.environ["VALORBRAIN_REQUESTED_BY"] = "  Joana Ação  "
        os.environ["VALORBRAIN_AGENT_TEAM"] = "ops,growth"
        self._start(agent_context="primary", platform="cli")
        self.assert_everywhere("x-requested-by", "Joana Acao")
        self.assert_everywhere("x-agent-team", "ops,growth")

    def test_requester_capped_at_120_chars(self):
        os.environ["VALORBRAIN_REQUESTED_BY"] = "r" * 300
        self._start(agent_context="primary", platform="cli")
        self.assert_everywhere("x-requested-by", "r" * 120)

    def test_no_requester_or_team_without_env(self):
        self._start(agent_context="cron", platform="cron")
        self.assert_everywhere("x-requested-by", None)
        self.assert_everywhere("x-agent-team", None)

    def test_local_binary_gets_the_run_kind_in_its_env(self):
        os.environ.pop("VALORBRAIN_HOOKS_MODE")
        fake = self.root / "valorbrain"
        fake.write_text("#!/bin/sh\nexit 0\n")
        fake.chmod(0o755)
        os.environ["VALORBRAIN_BIN"] = str(fake)
        cron = self._start(agent_context="cron", platform="cron")
        self.assertEqual(cron._env_extra.get("VALORBRAIN_RUN_KIND"), "routine")
        person = self._start(agent_context="primary", platform="cli")
        self.assertNotIn("VALORBRAIN_RUN_KIND", person._env_extra)


if __name__ == "__main__":
    unittest.main()
