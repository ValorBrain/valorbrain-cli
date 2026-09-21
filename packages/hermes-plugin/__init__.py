"""ValorBrain memory provider plugin for Hermes Agent.

On-device hybrid memory with composite scoring, graph traversal, and
lifecycle management. Integrates via REST API (tools) and CLI shell-out
(lifecycle hooks).

Requires:
  - valorbrain binary on PATH (or configured via VALORBRAIN_BIN)
  - valorbrain serve running (or managed mode starts it automatically)

Config via environment variables:
  VALORBRAIN_BIN           — Path to valorbrain binary (default: auto-detect on PATH)
  VALORBRAIN_SERVE_PORT    — REST API port (default: 7438)
  VALORBRAIN_SERVE_MODE    — "external" (default) or "managed" (plugin starts/stops serve)
  VALORBRAIN_PROFILE       — Retrieval profile: speed, balanced, deep (default: balanced)
  VALORBRAIN_EMBED_URL     — GPU embedding server URL (optional)
  VALORBRAIN_LLM_URL       — GPU LLM server URL (optional)
  VALORBRAIN_LLM_MODEL     — Model name sent to the GPU/cloud LLM endpoint (optional)
  VALORBRAIN_LLM_REASONING_EFFORT — Top-level reasoning_effort for supporting Chat Completions endpoints (optional)
  VALORBRAIN_LLM_NO_THINK  — Append /no_think to remote prompts; false disables it for standard OpenAI models (optional)
  VALORBRAIN_RERANK_URL    — GPU reranker server URL (optional)

Agent-context isolation:
  Hermes ``run_agent.py`` passes ``agent_context`` to ``initialize()``
  with one of "primary", "subagent", "cron", or "flush". Per the
  ``MemoryProvider`` ABC contract ("Providers should skip writes for
  non-primary contexts (cron system prompts would corrupt user
  representations)"), this plugin treats the read-side hooks
  (session-bootstrap, context-surfacing) as always safe but routes the
  write-side surfaces (transcript appends in ``sync_turn``, extraction
  in ``on_session_end`` and ``on_pre_compress``) through a primary-only
  guard. Non-primary contexts get retrieval but no vault writes.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_DEFAULT_PORT = 7438

# Versão do contrato que este plugin implementa. Manter em sincronia com
# CONTRACT_VERSION em src/harness/contract.ts — tests/unit/hermes-plugin.test.ts
# falha se divergir. Vai no capabilities do register/heartbeat: é o que permite
# medir a adoção do contrato por harness (agent_runtimes.contract_declared_at).
_CONTRACT_VERSION = "5"

# Versão do pacote do plugin (plugin.yaml do catálogo do Hermes). O teste
# tests/unit/hermes-plugin.test.ts falha se divergir do manifest.
_PLUGIN_VERSION = "1.6.0"

# Teto do transcript enviado ao engine no caminho hospedado (o servidor corta em
# 8MB; cortamos antes para não empurrar payload grande por nada).
_HOOK_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
_HOOK_TIMEOUT = 30  # seconds — fast hooks (bootstrap, lifecycle)
_CONTEXT_SURFACING_TIMEOUT = 90  # seconds — retrieval hook can take ~60s on bench tenants
_REST_TIMEOUT = 5.0  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_valorbrain_bin() -> Optional[str]:
    """Find the valorbrain binary. Check env (VALORBRAIN_BIN, then CLAWMEM_BIN
    for backward compat), then PATH. Falls back to legacy `clawmem` name."""
    for env_name in ("VALORBRAIN_BIN", "CLAWMEM_BIN"):
        env_bin = os.environ.get(env_name)
        if env_bin and os.path.isfile(env_bin) and os.access(env_bin, os.X_OK):
            return env_bin
    return shutil.which("valorbrain") or shutil.which("clawmem")


def _slugify_agent(name: str) -> str:
    import re
    import unicodedata
    s = unicodedata.normalize("NFKD", (name or "").strip().lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return (s[:64] if s else "agent")


def _resolve_source_agent() -> str:
    """Stable persona/agent slug for attribution (multi-tenant safe).

    Priority:
      1. VALORBRAIN_SOURCE_AGENT if set and not a generic placeholder
      2. Hermes profile directory name (…/profiles/<slug>)
      3. HERMES_PROFILE / HERMES_AGENT_PROFILE env
      4. fallback ``hermes``
    """
    generic = {"", "hermes", "hermes-plugin", "unknown", "agent", "mcp-http"}
    raw = (os.environ.get("VALORBRAIN_SOURCE_AGENT") or "").strip()
    if raw and raw.lower() not in generic:
        return _slugify_agent(raw)

    hermes_home = (os.environ.get("HERMES_HOME") or "").rstrip("/")
    if "/profiles/" in hermes_home:
        slug = hermes_home.rsplit("/profiles/", 1)[-1].split("/")[0]
        if slug:
            return _slugify_agent(slug)

    for key in ("HERMES_PROFILE", "HERMES_AGENT_PROFILE", "HERMES_AGENT_NAME"):
        v = (os.environ.get(key) or "").strip()
        if v:
            return _slugify_agent(v)

    return _slugify_agent(raw) if raw else "hermes"


def _run_hook(bin_path: str, hook_name: str, hook_input: dict,
              timeout: int = _HOOK_TIMEOUT, env_extra: Optional[dict] = None) -> Optional[str]:
    """Shell out to valorbrain hook <name>. Returns stdout or None on failure."""
    proc: Optional[subprocess.Popen[str]] = None
    try:
        env = {**os.environ, **(env_extra or {})}
        # Match in-hook timeout so the child self-exits before we SIGKILL.
        env.setdefault(
            "VALORBRAIN_HOOK_TIMEOUT_MS",
            str(max(5, (timeout - 2)) * 1000),
        )
        proc = subprocess.Popen(
            [bin_path, "hook", hook_name],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(
                input=json.dumps(hook_input),
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            # Kill the whole hook process group — a timed-out parent must not
            # leave bun hooks spinning at 100% CPU for tens of minutes.
            try:
                import os as _os
                import signal as _signal
                _os.killpg(proc.pid, _signal.SIGKILL)
            except Exception:
                proc.kill()
            proc.communicate()
            logger.debug("valorbrain hook %s timed out after %ds (killed)", hook_name, timeout)
            return None
        if proc.returncode == 0:
            return stdout
        logger.debug(
            "valorbrain hook %s exited %d: %s",
            hook_name,
            proc.returncode,
            (stderr or "")[:300],
        )
        return None
    except Exception as e:
        if proc is not None and proc.poll() is None:
            try:
                import os as _os
                import signal as _signal
                _os.killpg(proc.pid, _signal.SIGKILL)
            except Exception:
                proc.kill()
        logger.debug("valorbrain hook %s failed: %s", hook_name, e)
        return None


def _engine_base_url(port: int) -> str:
    """Remote engine URL when set; otherwise local valorbrain serve."""
    url = os.environ.get("VALORBRAIN_ENGINE_URL") or os.environ.get("VALORBRAIN_API_URL")
    if url:
        return url.rstrip("/")
    return f"http://127.0.0.1:{port}"


def _runtime_seed() -> Optional[str]:
    """Semente estável da chave de runtime.

    Tenant quando houver; senão o prefixo do token (modo hospedado: o engine
    deriva o tenant do bearer e o prefixo já aparece no dashboard). Sem nenhum
    dos dois não há o que registrar.
    """
    tenant_id = (
        os.environ.get("VALORBRAIN_TENANT_ID")
        or os.environ.get("VALORBRAIN_DEFAULT_TENANT_ID")
    )
    if tenant_id:
        return tenant_id
    token = (os.environ.get("VALORBRAIN_API_TOKEN") or "").strip()
    return token[:12] if token else None


def _rest_call(port: int, method: str, path: str,
               body: Optional[dict] = None, timeout: float = _REST_TIMEOUT,
               raw: bool = False):
    """Call the ValorBrain REST API. Parsed JSON, raw text (raw=True), or None.

    Multi-tenant headers:
      X-Tenant-ID    — from VALORBRAIN_TENANT_ID env (engine scopes data
                       to this tenant via RLS when running as valorbrain_app).
      X-Source-Agent — defaults to 'hermes-plugin' so the engine can attribute
                       writes to this client.
      X-Source-System — from VALORBRAIN_SOURCE_SYSTEM env, defaults 'hermes'.
    """
    headers: dict = {"Content-Type": "application/json"}
    token = os.environ.get("VALORBRAIN_API_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    tenant_id = os.environ.get("VALORBRAIN_TENANT_ID") or os.environ.get("VALORBRAIN_DEFAULT_TENANT_ID")
    if tenant_id:
        headers["X-Tenant-ID"] = tenant_id

    user_id = os.environ.get("VALORBRAIN_USER_ID")
    if user_id:
        headers["X-User-ID"] = user_id

    source_agent = _resolve_source_agent()
    headers["X-Source-Agent"] = source_agent

    source_system = os.environ.get("VALORBRAIN_SOURCE_SYSTEM", "hermes")
    headers["X-Source-System"] = source_system

    base = _engine_base_url(port)

    try:
        import httpx
    except ImportError:
        # Fallback to urllib for zero-dependency operation
        import urllib.request
        import urllib.error
        url = f"{base}{path}"
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode() if body else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = resp.read().decode()
                return payload if raw else json.loads(payload)
        except (urllib.error.URLError, Exception) as e:
            logger.debug("ValorBrain REST %s %s failed: %s", method, path, e)
            return None

    try:
        client = httpx.Client(timeout=timeout)
        if method == "GET":
            resp = client.get(f"{base}{path}", headers=headers)
        else:
            resp = client.post(
                f"{base}{path}",
                json=body or {},
                headers=headers,
            )
        resp.raise_for_status()
        return resp.text if raw else resp.json()
    except Exception as e:
        logger.debug("ValorBrain REST %s %s failed: %s", method, path, e)
        return None


def _extract_context(hook_output: str) -> str:
    """Extract additionalContext from hook JSON output."""
    if not hook_output:
        return ""
    try:
        parsed = json.loads(hook_output.strip().split("\n")[-1])
        hso = parsed.get("hookSpecificOutput", {})
        return hso.get("additionalContext", "")
    except (json.JSONDecodeError, IndexError):
        return ""


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

RETRIEVE_SCHEMA = {
    "name": "valorbrain_retrieve",
    "description": (
        "Search long-term memory with auto-routing. Handles keyword, semantic, "
        "causal, and timeline queries automatically. Use for recalling past "
        "decisions, preferences, session history, and learned patterns."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
            "limit": {"type": "integer", "description": "Max results (default: 10)."},
        },
        "required": ["query"],
    },
}

GET_SCHEMA = {
    "name": "valorbrain_get",
    "description": (
        "Retrieve full content of a memory document by its docid (6-char hex prefix)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "docid": {"type": "string", "description": "Document ID (6-char hex prefix)."},
        },
        "required": ["docid"],
    },
}

SESSION_LOG_SCHEMA = {
    "name": "valorbrain_session_log",
    "description": "List recent session summaries for cross-session context.",
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "Number of sessions (default: 5)."},
        },
    },
}

TIMELINE_SCHEMA = {
    "name": "valorbrain_timeline",
    "description": "Show temporal context around a document — what was created before and after.",
    "parameters": {
        "type": "object",
        "properties": {
            "docid": {"type": "string", "description": "Document ID (6-char hex prefix)."},
            "before": {"type": "integer", "description": "Docs before (default: 5)."},
            "after": {"type": "integer", "description": "Docs after (default: 5)."},
        },
        "required": ["docid"],
    },
}

SIMILAR_SCHEMA = {
    "name": "valorbrain_similar",
    "description": "Find documents semantically similar to a given document.",
    "parameters": {
        "type": "object",
        "properties": {
            "docid": {"type": "string", "description": "Document ID (6-char hex prefix)."},
            "limit": {"type": "integer", "description": "Max results (default: 5)."},
        },
        "required": ["docid"],
    },
}

# --- v1.1.0 additions: tools that the MCP server gained 2026-07-28/29 ---

STORE_SCHEMA = {
    "name": "valorbrain_store",
    "description": (
        "Save a structured memory (decision, observation, milestone, etc.) "
        "to ValorBrain via REST. Use for facts that should survive across sessions."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "description": "Memory type: decision|observation|problem|milestone|lesson|note"},
            "title": {"type": "string", "description": "Short title (5-200 chars)."},
            "content": {"type": "string", "description": "Full content in markdown."},
            "collection": {"type": "string", "description": "Collection name (default: memories)."},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags."},
        },
        "required": ["type", "title", "content"],
    },
}

HEALTH_SCHEMA = {
    "name": "valorbrain_health",
    "description": (
        "Check ValorBrain memory health: open proposals, conflicts, "
        "high-priority items, and canonical sources with drift."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "Max high-priority proposals (default: 3)."},
        },
    },
}

WORKING_CONTEXT_SCHEMA = {
    "name": "valorbrain_working_context",
    "description": (
        "One-shot stable facts + recent decisions + optional session scratchpad. "
        "Prefer this at session start instead of multiple retrieve calls."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

# FB-0003: o canal de feedback existia só no MCP; o namespace tipado do Hermes
# (que fala REST) não o expunha. submit abre um FB-XXXX; check acompanha.
FEEDBACK_SCHEMA = {
    "name": "valorbrain_feedback",
    "description": (
        "Report a ValorBrain product defect (empty/wrong memory_retrieve, ranking noise, "
        "missing capability, verified fix as praise) or track a submitted one. "
        "Not for bugs in your own harness/CLI/editor — those belong to their projects."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["submit", "check"], "description": "submit a new FB or check status."},
            "title": {"type": "string", "description": "submit: short title (5-200 chars)."},
            "description": {"type": "string", "description": "submit: what happened / expected / steps."},
            "category": {"type": "string", "description": "submit: bug|feature|question|improvement|praise|feedback."},
            "priority": {"type": "string", "description": "submit: low|normal|high|critical."},
            "feedback_id": {"type": "string", "description": "check: FB-XXXX or 'all'."},
        },
        "required": ["action"],
    },
}


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------

class ValorBrainProvider(MemoryProvider):
    """ValorBrain memory provider for Hermes Agent."""

    def __init__(self):
        self._bin: Optional[str] = None
        self._port: int = _DEFAULT_PORT
        self._session_id: str = ""
        self._transcript_path: str = ""
        self._hermes_home: str = ""
        self._serve_mode: str = "external"
        self._serve_proc: Optional[subprocess.Popen] = None
        self._env_extra: dict = {}
        # Agent-context isolation. "primary" = full read+write; everything else
        # ("subagent", "cron", "flush") = reads OK, writes suppressed. See file
        # docstring for the ABC contract this implements.
        self._agent_context: str = "primary"

        # Prefetch state (generation counter prevents stale overwrites)
        self._prefetch_result: str = ""
        self._prefetch_result_gen: int = 0  # generation of stored result
        self._prefetch_generation: int = 0  # latest queued generation
        self._prefetch_consumed_gen: int = 0  # last generation consumed by prefetch()
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None

        # Bootstrap context (consumed on first prefetch)
        self._bootstrap_context: str = ""

        # Persistent runtime registry (Multica-style)
        self._runtime_key: Optional[str] = None
        self._runtime_id: Optional[str] = None
        self._last_runtime_hb: float = 0.0

        # Pós-compactação: marcado em on_pre_compress, consumido no próximo
        # prefetch (o canal de injeção do provider substitui o SessionStart
        # matcher "compact" do Claude Code).
        self._postcompact_pending: bool = False

    @property
    def name(self) -> str:
        return "valorbrain"

    # -- Config ----------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "serve_port",
                "description": "ValorBrain REST API port",
                "default": str(_DEFAULT_PORT),
                "env_var": "VALORBRAIN_SERVE_PORT",
            },
            {
                "key": "serve_mode",
                "description": "Server mode: 'external' (you run valorbrain serve) or 'managed' (plugin manages it)",
                "default": "external",
                "choices": ["external", "managed"],
                "env_var": "VALORBRAIN_SERVE_MODE",
            },
            {
                "key": "profile",
                "description": "Retrieval profile: speed (BM25 only), balanced (hybrid), deep (full pipeline)",
                "default": "balanced",
                "choices": ["speed", "balanced", "deep"],
                "env_var": "VALORBRAIN_PROFILE",
            },
            {
                "key": "bin_path",
                "description": "Path to valorbrain binary (auto-detected if on PATH)",
                "env_var": "VALORBRAIN_BIN",
            },
            {
                "key": "embed_url",
                "description": "GPU embedding server URL (e.g., http://localhost:8088)",
                "secret": False,
                "env_var": "VALORBRAIN_EMBED_URL",
            },
            {
                "key": "llm_url",
                "description": "GPU LLM server URL (e.g., http://localhost:8089)",
                "secret": False,
                "env_var": "VALORBRAIN_LLM_URL",
            },
            {
                "key": "llm_model",
                "description": "Model name sent to the GPU LLM server (e.g., qwen3, gpt-5.4-mini)",
                "secret": False,
                "env_var": "VALORBRAIN_LLM_MODEL",
            },
            {
                "key": "llm_reasoning_effort",
                "description": "Optional top-level reasoning_effort for Chat Completions endpoints that support it",
                "secret": False,
                "env_var": "VALORBRAIN_LLM_REASONING_EFFORT",
            },
            {
                "key": "llm_no_think",
                "description": "Append /no_think to remote LLM prompts; disable for standard OpenAI models",
                "secret": False,
                "env_var": "VALORBRAIN_LLM_NO_THINK",
            },
        ]

    # -- Core lifecycle --------------------------------------------------------

    def is_available(self) -> bool:
        """Disponível com binário local (hooks) OU engine remoto configurado.

        Hospedado não tem binário `valorbrain`: com VALORBRAIN_ENGINE_URL (ou
        VALORBRAIN_API_URL) + VALORBRAIN_API_TOKEN o provider funciona para
        tools/registro; os hooks de ciclo de vida seguem exigindo o binário.
        """
        if _find_valorbrain_bin() is not None:
            return True
        return bool(
            os.environ.get("VALORBRAIN_ENGINE_URL") or os.environ.get("VALORBRAIN_API_URL")
        )

    def initialize(self, session_id: str, **kwargs) -> None:
        self._bin = _find_valorbrain_bin()
        remote_engine = bool(
            os.environ.get("VALORBRAIN_ENGINE_URL") or os.environ.get("VALORBRAIN_API_URL")
        )
        if not self._bin and not remote_engine:
            logger.warning("valorbrain binary not found on PATH — provider disabled")
            return
        if not self._bin:
            logger.info(
                "valorbrain: engine remoto configurado — tools/registro ativos; "
                "hooks de ciclo de vida seguem desativados (sem binário local)"
            )

        self._session_id = session_id
        try:
            self._port = int(os.environ.get("VALORBRAIN_SERVE_PORT", _DEFAULT_PORT))
        except (ValueError, TypeError):
            self._port = _DEFAULT_PORT
        self._serve_mode = os.environ.get("VALORBRAIN_SERVE_MODE", "external")
        self._hermes_home = kwargs.get("hermes_home", str(Path.home() / ".hermes"))
        self._agent_context = str(kwargs.get("agent_context", "primary") or "primary")
        if self._agent_context != "primary":
            logger.info(
                "valorbrain: agent_context=%s — reads enabled, writes suppressed",
                self._agent_context,
            )

        # Build env for hook shell-outs (GPU endpoints, profile)
        for var in (
            "VALORBRAIN_EMBED_URL",
            "VALORBRAIN_LLM_URL",
            "VALORBRAIN_LLM_MODEL",
            "VALORBRAIN_LLM_REASONING_EFFORT",
            "VALORBRAIN_LLM_NO_THINK",
            "VALORBRAIN_RERANK_URL",
            "VALORBRAIN_PROFILE",
            "VALORBRAIN_API_TOKEN",
            "VALORBRAIN_ENGINE_URL",
            "VALORBRAIN_API_URL",
            "VALORBRAIN_USER_ID",
        ):
            val = os.environ.get(var)
            if val:
                self._env_extra[var] = val

        tenant_id = (
            os.environ.get("VALORBRAIN_TENANT_ID")
            or os.environ.get("VALORBRAIN_DEFAULT_TENANT_ID")
        )
        if tenant_id:
            self._env_extra["VALORBRAIN_TENANT_ID"] = tenant_id
            self._env_extra["VALORBRAIN_DEFAULT_TENANT_ID"] = tenant_id

        source_agent = _resolve_source_agent()
        self._env_extra["VALORBRAIN_SOURCE_AGENT"] = source_agent
        # Keep process env aligned so hooks inherit the resolved slug
        os.environ["VALORBRAIN_SOURCE_AGENT"] = source_agent

        # Create transcript directory
        transcript_dir = Path(self._hermes_home) / "valorbrain-transcripts"
        transcript_dir.mkdir(parents=True, exist_ok=True)
        self._transcript_path = str(transcript_dir / f"{session_id}.jsonl")

        # Start managed serve if configured
        if self._serve_mode == "managed":
            self._start_serve()

        # Run session-bootstrap hook
        hook_input = {
            "session_id": session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "SessionStart",
        }
        output = self._invoke_hook("session-bootstrap", hook_input)
        if output:
            ctx = _extract_context(output)
            if ctx:
                self._bootstrap_context = ctx
                logger.info("valorbrain: session-bootstrap returned %d chars of context", len(ctx))

        # Fallback: REST working_context if CLI hook returned nothing.
        # format=md — the agent reads this as bootstrap context; raw JSON
        # dumps waste tokens and bury the facts (review finding).
        if not self._bootstrap_context:
            try:
                wc_text = _rest_call(self._port, "GET", "/api/v1/memory/working-context?format=md", raw=True)
                if isinstance(wc_text, str) and len(wc_text) > 10:
                    self._bootstrap_context = wc_text
                    logger.info("valorbrain: REST working_context returned %d chars", len(wc_text))
            except Exception:
                pass

        # Sprint 8 — Foundations injection (Tier-0 cross-cutting context)
        # Fetches pinned foundations from /foundations endpoint and prepends
        # them to bootstrap context so every Hermes session starts with
        # world-knowledge anchors (INFRA, brain-vs-memory, brain-first-lookup).
        try:
            foundations_text = self._fetch_foundations_text()
            if foundations_text:
                # Prepend foundations to bootstrap (foundations come first)
                if self._bootstrap_context:
                    self._bootstrap_context = foundations_text + "\n\n" + self._bootstrap_context
                else:
                    self._bootstrap_context = foundations_text
                logger.info("valorbrain: foundations prefetched (%d chars)", len(foundations_text))
        except Exception as e:
            logger.debug("valorbrain: foundations fetch failed (non-fatal): %s", e)

        self._register_runtime()

    def _remote_engine(self) -> bool:
        return bool(
            os.environ.get("VALORBRAIN_ENGINE_URL") or os.environ.get("VALORBRAIN_API_URL")
        )

    def _has_hooks(self) -> bool:
        """Hooks rodam local (binário) ou no engine via REST (hospedado)."""
        return bool(self._bin) or self._remote_engine()

    def _invoke_hook(self, hook_name: str, hook_input: dict,
                     timeout: int = _HOOK_TIMEOUT) -> Optional[str]:
        """Roda um hook de ciclo de vida.

        Self-hosted: shell-out para o binário (comportamento original).
        Hospedado: POST /api/v1/hooks/run — o engine roda o MESMO código com o
        tenant do token; o cliente só manda o transcript (o engine não lê o
        disco dele).
        """
        if self._bin:
            return _run_hook(
                self._bin, hook_name, hook_input,
                timeout=timeout, env_extra=self._env_extra,
            )
        return self._run_hook_remote(hook_name, hook_input, timeout=timeout)

    def _run_hook_remote(self, hook_name: str, hook_input: dict,
                         timeout: int = _HOOK_TIMEOUT) -> Optional[str]:
        """Hook hospedado. Devolve stdout no dialeto do binário para o
        `_extract_context` continuar valendo (JSON com additionalContext)."""
        try:
            payload: dict = {"hook": hook_name}
            inp: dict = {}
            for src, dst in (
                ("session_id", "sessionId"),
                ("prompt", "prompt"),
                ("hook_event_name", "hookEventName"),
                ("working_dir", "workingDir"),
            ):
                if hook_input.get(src) is not None:
                    inp[dst] = hook_input[src]
            if inp:
                payload["input"] = inp
            transcript_path = hook_input.get("transcript_path")
            if transcript_path and os.path.isfile(transcript_path):
                with open(transcript_path, "r", errors="replace") as fh:
                    payload["transcript"] = fh.read(_HOOK_TRANSCRIPT_MAX_BYTES)
            data = _rest_call(
                self._port, "POST", "/api/v1/hooks/run", payload, timeout=float(timeout)
            )
            if not isinstance(data, dict) or not data.get("ok"):
                return None
            context = data.get("context") or ""
            if not context:
                return None
            return json.dumps({"hookSpecificOutput": {"additionalContext": context}})
        except Exception as e:
            logger.debug("valorbrain: remote hook %s failed: %s", hook_name, e)
            return None

    def _build_runtime_key(self) -> Optional[str]:
        seed = _runtime_seed()
        if not seed:
            return None
        import hashlib
        import socket
        host = socket.gethostname()
        digest = hashlib.sha256(f"{seed}:{host}:hermes:1.0".encode()).hexdigest()[:16]
        return f"hermes:{host}:{digest}"

    def _register_runtime(self) -> None:
        runtime_key = self._build_runtime_key()
        if not runtime_key:
            return
        self._runtime_key = runtime_key
        import socket
        host = socket.gethostname()
        health = _rest_call(self._port, "GET", "/health") or {}
        config_health = "ok" if health else "unreachable"
        payload = {
            "runtime_key": runtime_key,
            "agent_platform": "hermes",
            "display_name": f"{host} (Hermes)",
            "hostname": host,
            "plugin_version": _PLUGIN_VERSION,
            "capabilities": {
                "memory_provider": True,
                "hooks": True,
                "tools": True,
                "harness": "hermes",
                "contract_version": _CONTRACT_VERSION,
            },
            "config_health": config_health,
        }
        res = _rest_call(self._port, "POST", "/api/v1/runtimes/register", payload, timeout=8.0)
        if res and res.get("runtime", {}).get("id"):
            self._runtime_id = res["runtime"]["id"]
            logger.info("valorbrain: hermes runtime registered (%s)", self._runtime_id)
        else:
            logger.debug("valorbrain: hermes runtime register failed")

    def _maybe_heartbeat_runtime(self, session_id: str = "") -> None:
        if not self._runtime_key:
            return
        now = time.time()
        if now - self._last_runtime_hb < 300:
            return
        self._last_runtime_hb = now
        payload = {
            "runtime_key": self._runtime_key,
            "session_key": session_id or self._session_id,
            "config_health": "ok",
            "capabilities": {"contract_version": _CONTRACT_VERSION},
        }
        _rest_call(self._port, "POST", "/api/v1/runtimes/heartbeat", payload, timeout=5.0)

    def _maybe_fetch_setup_instructions(self, query: str) -> str:
        """Sprint 11.5 — Detect 'Setup ValorBrain from <url>' or '/vb-setup'
        in user query. If detected, fetch /setup/instructions endpoint and
        return formatted block pra agent guiar setup interativo.

        Patterns matched:
          - "Setup ValorBrain from https://valorbrain.valor.digital/setup"
          - "/vb-setup" (slash command)
          - "configurar valorbrain" (PT)
        """
        import re
        # Detect setup intent
        ql = query.lower()
        setup_patterns = [
            r"setup\s+valorbrain\s+from\s+(https?://\S+)",
            r"/vb-setup\b",
            r"configurar\s+valorbrain\s+(?:do|de|from)\s+(\S+)",
            r"install\s+valorbrain",
        ]
        matched = False
        url = None
        for pattern in setup_patterns:
            m = re.search(pattern, query, re.IGNORECASE)
            if m:
                matched = True
                if m.groups():
                    url = m.group(1)
                break
        if not matched:
            return ""

        # Fetch instructions
        try:
            agent = os.environ.get("VALORBRAIN_SOURCE_AGENT", "hermes-plugin")
            resp = _rest_call(self._port, "GET", f"/setup/instructions?agent={agent}")
            if not resp or "valorbrain_setup" not in resp:
                return ""
            data = resp["valorbrain_setup"]
            parts = ["<vb-setup-instructions>",
                     f"User asked to setup ValorBrain. Guide them through the steps below.",
                     ""]
            for method in data.get("methods", []):
                if not method.get("recommended"):
                    continue
                parts.append(f"## {method['name']}")
                parts.append(method.get("description", ""))
                parts.append("")
                for step in method.get("steps", []):
                    parts.append(f"**Step {step['order']}: {step.get('title', '')}**")
                    if step.get("command"):
                        parts.append(f"```\n{step['command']}\n```")
                    if step.get("text"):
                        parts.append(step["text"])
                    if step.get("note"):
                        parts.append(f"_Note: {step['note']}_")
                    parts.append("")
            parts.append("</vb-setup-instructions>")
            return "\n".join(parts)
        except Exception as e:
            logger.debug("valorbrain: _maybe_fetch_setup_instructions error: %s", e)
            return ""

    def _fetch_foundations_text(self, limit: int = 10) -> str:
        """Fetch Tier-0 foundations from engine and format as text block.

        Returns empty string if endpoint unavailable. Fail-soft: bootstrap
        continues with whatever else is configured.
        """
        try:
            data = _rest_call(self._port, "GET", f"/foundations?limit={limit}")
            if not data or not isinstance(data, dict):
                return ""
            foundations = data.get("foundations", [])
            if not foundations:
                return ""
            parts = ["<vault-foundations>",
                     "<!-- Tier-0 cross-cutting context. Always relevant. -->"]
            for f in foundations:
                title = f.get("title", "")
                ptype = f.get("page_type", "")
                body = (f.get("body") or "").strip()
                if not body:
                    continue
                # Truncate per-foundation to 1500 chars to keep budget reasonable
                if len(body) > 1500:
                    body = body[:1500] + "\n[…truncated]"
                parts.append(f"\n## {title} ({ptype})")
                parts.append(body)
            parts.append("</vault-foundations>")
            return "\n".join(parts)
        except Exception as e:
            logger.debug("valorbrain: _fetch_foundations_text error: %s", e)
            return ""

    def system_prompt_block(self) -> str:
        if not self._has_hooks():
            return ""
        agent = _resolve_source_agent()
        # Portable, multi-tenant, multi-language friendly. No company-specific rules.
        # Tools: production Hermes uses MCP tools (memory_retrieve, etc.), not REST plugin tools.
        return (
            "# ValorBrain — shared company brain (memory + context)\n"
            f"You are attributed as source_agent=`{agent}`. Writes go to your tenant only (RLS).\n"
            "\n"
            "## What ValorBrain is (and is not)\n"
            "- IS: persistent shared memory, retrieval, durable facts, lessons, session continuity.\n"
            "- IS NOT: your runtime's multi-agent scheduler. Hermes/OpenClaw/etc. own task "
            "orchestration (tmux, AMC, native multi-agent). Do not dump persona prompts into handoffs.\n"
            "\n"
            "## How to think before acting\n"
            "1. **Brain-first:** call `memory_retrieve` (or MCP equivalent) before external search/APIs "
            "when the answer may already live in the company brain.\n"
            "2. **Prefer structured truth for numbers/status:** if a human corrected a fact, use "
            "`assert_authority_correction` (with `losing_values` for wrong prior values) or "
            "`upsert_keyed_fact` — do not only write a free-form note.\n"
            "3. **Durable vs ephemeral:** decisions, lessons, milestones → store as proper content types; "
            "scratch thoughts stay local or low-confidence notes.\n"
            "4. **Team OS is optional:** if `team_members` exist, start with `team_briefing`. "
            "Use `team_handoff` only for real async work assignment (what to do + context + open questions). "
            "Never paste system/persona text as a handoff summary.\n"
            "5. **Attribution:** keep a stable agent slug per persona so teammates can see who wrote what.\n"
            "\n"
            "## Tools (MCP)\n"
            "Read: `memory_retrieve`, `get`, `timeline`, `memory_prepare`, `keyed_facts_as_of`.\n"
            "Write: store/import tools, `record_lesson`, `assert_authority_correction`, "
            "`team_message` / `team_handoff` (only when Team OS is active).\n"
            "Quality loop (required after recall): when your answer relied on retrieved "
            "memory, call `memory_used` with the docids (e.g. `#ab12cd`) or paths of the "
            "memories you actually used. Delivered context lines carry their id/path — "
            "copy them. Used memories rise in ranking, ignored ones decay; without the "
            "declaration the quality signal stays blind. When the user CONFIRMS what a "
            "memory said, pass verdict=\"confirmed\"; when the user CORRECTS or "
            "contradicts it, pass verdict=\"corrected\" — that feeds the trust loop.\n"
            "Product feedback: `feedback_submit` / `feedback_check` — report ValorBrain product "
            "bugs, bad retrieval, missing capabilities, or verified fixes to the VB team "
            "(returns FB-XXXX). Use when the *product* fails you — not for normal domain work.\n"
            "Lifecycle (automatic): session bootstrap, context surfacing, session-end extraction.\n"
            "\n"
            "## Feedback hygiene (required)\n"
            "Call `feedback_submit` once per distinct product issue when: tool/MCP errors, empty "
            "or wrong recall when knowledge should exist, ranking noise, or a fix you verified "
            "(category=praise). Title = one actionable line; description = repro + expected vs "
            "actual. Never put secrets in feedback. Track with `feedback_check`.\n"
        )

    # -- Prefetch / recall -----------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return cached prefetch result + any unconsumed bootstrap context."""
        # Wait for background thread if still running
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)

        parts = []

        # Consume bootstrap context (one-shot, first turn only)
        if self._bootstrap_context:
            parts.append(self._bootstrap_context)
            self._bootstrap_context = ""

        # Consume prefetched context only if it's from a generation we haven't consumed yet
        with self._prefetch_lock:
            if (self._prefetch_result
                    and self._prefetch_result_gen > self._prefetch_consumed_gen):
                parts.append(self._prefetch_result)
            # Always advance consumed_gen to current queued generation — this
            # prevents late-arriving results from leaking into the next turn
            self._prefetch_consumed_gen = self._prefetch_generation
            self._prefetch_result = ""

        return "\n\n".join(parts) if parts else ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background: run context-surfacing hook for next turn."""
        self._maybe_heartbeat_runtime(session_id)
        if not query or len(query) < 5:
            return

        # Sprint 11.5 — Setup-via-chat detection
        # Quando user/agent envia "Setup ValorBrain from <url>" ou "/vb-setup",
        # plugin auto-fetch /setup/instructions e injeta como context pra agent
        # guiar o setup interativo.
        setup_text = self._maybe_fetch_setup_instructions(query)
        if setup_text:
            with self._prefetch_lock:
                self._prefetch_result = setup_text
                self._prefetch_result_gen = self._prefetch_generation + 1
                self._prefetch_generation += 1
            return  # skip context-surfacing pra esse turn — focus em setup

        # Increment generation so older threads can't overwrite newer results,
        # and snapshot the session id + transcript path under the same lock so a
        # concurrent on_session_switch() can't make the worker read a torn
        # (new id / old path) pair — the worker uses the snapshot, never live state.
        with self._prefetch_lock:
            self._prefetch_generation += 1
            my_gen = self._prefetch_generation
            run_session_id = self._session_id
            run_transcript_path = self._transcript_path

        def _run():
            hook_input = {
                "session_id": run_session_id,
                "transcript_path": run_transcript_path,
                "prompt": query,
                "hook_event_name": "UserPromptSubmit",
            }
            parts: list = []

            # Pós-compactação: o Hermes não tem SessionStart com matcher
            # "compact"; o canal é o próprio prefetch. Re-injeta o estado
            # (precompact-state.md) uma vez no turno seguinte à compressão —
            # local via binário, hospedado via REST no engine.
            with self._prefetch_lock:
                pending_postcompact = self._postcompact_pending
                self._postcompact_pending = False
            if pending_postcompact:
                pc = self._invoke_hook("postcompact-inject", {
                    "session_id": run_session_id,
                    "transcript_path": run_transcript_path,
                    "hook_event_name": "SessionStart",
                })
                if pc:
                    pc_ctx = _extract_context(pc)
                    if pc_ctx:
                        parts.append(pc_ctx)

            output = self._invoke_hook(
                "context-surfacing",
                hook_input,
                timeout=_CONTEXT_SURFACING_TIMEOUT,
            )
            if output:
                ctx = _extract_context(output)
                if ctx:
                    parts.append(ctx)

            if not parts:
                # Fallback: REST memory_prepare se o hook não devolveu nada
                # (sem binário e sem engine remoto, hook falhou, ou vazio).
                # fast_mode: o funil por turno entregou docs=0 em 30/30 amostras
                # de produção custando ~3.5s de p50 (perfil 2026-08-15) —
                # identity/recall/goals continuam vindo, o funil de documentos
                # não.
                try:
                    rest_body = {"message": query, "recall_budget": 600, "fast_mode": True}
                    rest_data = _rest_call(self._port, "POST", "/api/v1/memory/prepare", rest_body)
                    if rest_data:
                        rest_ctx = json.dumps(rest_data, ensure_ascii=False)
                        if rest_ctx and len(rest_ctx) > 10:
                            parts.append(rest_ctx)
                except Exception:
                    pass  # Degrada em silêncio

            if parts:
                with self._prefetch_lock:
                    # Only write if we're still the latest generation
                    if my_gen == self._prefetch_generation:
                        self._prefetch_result = "\n\n".join(parts)
                        self._prefetch_result_gen = my_gen

        # Wait for any previous prefetch to finish
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="valorbrain-prefetch"
        )
        self._prefetch_thread.start()

    # -- Sync / transcript management ------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Append turn to plugin-managed transcript JSONL.

        Writes in Claude Code transcript format so ValorBrain hooks can read it.
        Suppressed for non-primary agent contexts (subagent/cron/flush) so the
        vault never absorbs system-prompt or background-task content.
        """
        if self._agent_context != "primary":
            return
        if not self._transcript_path:
            return

        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            with open(self._transcript_path, "a") as f:
                # User message
                f.write(json.dumps({
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": user_content,
                    },
                    "timestamp": ts,
                }) + "\n")
                # Assistant message
                f.write(json.dumps({
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": assistant_content,
                    },
                    "timestamp": ts,
                }) + "\n")
        except Exception as e:
            logger.debug("valorbrain: sync_turn write failed: %s", e)

    # -- Session end / compression hooks ---------------------------------------

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Run extraction hooks in parallel.

        Suppressed for non-primary agent contexts (subagent/cron/flush) — the
        decision-extractor / handoff-generator / feedback-loop pipeline would
        otherwise capture cron system prompts or subagent intermediate state
        as if it were primary-agent reasoning.
        """
        if self._agent_context != "primary":
            return
        if not self._has_hooks() or not self._transcript_path:
            return

        hook_input = {
            "session_id": self._session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "Stop",
        }

        threads = []
        for hook_name in ("decision-extractor", "handoff-generator", "feedback-loop"):
            t = threading.Thread(
                target=self._invoke_hook,
                args=(hook_name, hook_input),
                daemon=True,
                name=f"valorbrain-{hook_name}",
            )
            t.start()
            threads.append(t)

        # Wait for all extraction hooks (bounded)
        for t in threads:
            t.join(timeout=_HOOK_TIMEOUT + 5)

        logger.info("valorbrain: session %s extraction complete", self._session_id[:8])

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs,
    ) -> None:
        """Refresh session-derived state when Hermes rotates session_id mid-process.

        Fires on /new (reset=True), /resume, /branch, and compression (reset=False).
        ValorBrain reads _session_id and the session-keyed _transcript_path live in
        queue_prefetch / sync_turn / on_session_end / on_pre_compress, so a switch
        must repoint them and drop the prior session's prefetch + bootstrap context
        (unconditional — NOT gated on reset, or stale recall leaks into the new
        session). Cache coherence, not a vault write, so it runs for all contexts.
        """
        new_id = str(new_session_id or "").strip()
        if not new_id or not self._has_hooks():
            return
        # Idempotent re-fire (duplicate dispatch) with no reset is a no-op.
        if new_id == self._session_id and not reset:
            return

        new_path = self._transcript_path
        if self._hermes_home:
            transcript_dir = Path(self._hermes_home) / "valorbrain-transcripts"
            transcript_dir.mkdir(parents=True, exist_ok=True)
            new_path = str(transcript_dir / f"{new_id}.jsonl")

        with self._prefetch_lock:
            self._session_id = new_id
            self._transcript_path = new_path
            # Bump generation MONOTONICALLY (never reset to 0): an in-flight
            # prefetch worker then fails its `my_gen == _prefetch_generation`
            # check and discards its result instead of leaking it into the new
            # session. Advancing consumed_gen drops any already-cached result.
            self._prefetch_generation += 1
            self._prefetch_result = ""
            self._prefetch_result_gen = 0
            self._prefetch_consumed_gen = self._prefetch_generation
            # Startup context is session-derived; must not cross session ids.
            self._bootstrap_context = ""

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Run precompact-extract (side effect only — Hermes ignores return).

        Suppressed for non-primary agent contexts so the precompact state file
        in auto-memory never picks up cron/subagent context as primary state.
        """
        if self._agent_context != "primary":
            return ""
        if not self._has_hooks() or not self._transcript_path:
            return ""

        hook_input = {
            "session_id": self._session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "PreCompact",
        }
        self._invoke_hook("precompact-extract", hook_input)
        # O estado acabou de ser escrito (local ou no engine); o próximo turno
        # re-injeta via prefetch.
        self._postcompact_pending = True
        return ""

    # -- Tools (REST API) ------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            RETRIEVE_SCHEMA, GET_SCHEMA, SESSION_LOG_SCHEMA,
            TIMELINE_SCHEMA, SIMILAR_SCHEMA,
            STORE_SCHEMA, HEALTH_SCHEMA, WORKING_CONTEXT_SCHEMA,
            FEEDBACK_SCHEMA,
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "valorbrain_retrieve":
                return self._tool_retrieve(args)
            elif tool_name == "valorbrain_get":
                return self._tool_get(args)
            elif tool_name == "valorbrain_session_log":
                return self._tool_session_log(args)
            elif tool_name == "valorbrain_timeline":
                return self._tool_timeline(args)
            elif tool_name == "valorbrain_similar":
                return self._tool_similar(args)
            elif tool_name == "valorbrain_store":
                return self._tool_store(args)
            elif tool_name == "valorbrain_health":
                return self._tool_health(args)
            elif tool_name == "valorbrain_working_context":
                return self._tool_working_context(args)
            elif tool_name == "valorbrain_feedback":
                return self._tool_feedback(args)
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _tool_retrieve(self, args: dict) -> str:
        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required"})
        body = {"query": query, "compact": True}
        if args.get("limit"):
            body["limit"] = args["limit"]
        data = _rest_call(self._port, "POST", "/retrieve", body)
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_get(self, args: dict) -> str:
        docid = args.get("docid", "")
        if not docid:
            return json.dumps({"error": "docid is required"})
        data = _rest_call(self._port, "GET", f"/documents/{docid}")
        if data is None:
            return json.dumps({"error": f"Document not found: {docid}"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_session_log(self, args: dict) -> str:
        limit = args.get("limit", 5)
        data = _rest_call(self._port, "GET", f"/sessions?limit={limit}")
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_timeline(self, args: dict) -> str:
        docid = args.get("docid", "")
        if not docid:
            return json.dumps({"error": "docid is required"})
        before = args.get("before", 5)
        after = args.get("after", 5)
        data = _rest_call(self._port, "GET", f"/timeline/{docid}?before={before}&after={after}")
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_similar(self, args: dict) -> str:
        docid = args.get("docid", "")
        if not docid:
            return json.dumps({"error": "docid is required"})
        limit = args.get("limit", 5)
        data = _rest_call(self._port, "GET", f"/graph/similar/{docid}?limit={limit}")
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_store(self, args: dict) -> str:
        """Store a structured memory via POST /api/v1/memory/store."""
        mem_type = args.get("type", "note")
        title = args.get("title", "")
        content = args.get("content", "")
        if not title or not content:
            return json.dumps({"error": "title and content are required"})
        body = {
            "type": mem_type,
            "title": title,
            "content": content,
            "collection": args.get("collection", "memories"),
        }
        if args.get("tags"):
            body["tags"] = args["tags"]
        data = _rest_call(self._port, "POST", "/api/v1/memory/store", body)
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_health(self, args: dict) -> str:
        """Check memory health via GET /api/v1/memory/health."""
        limit = args.get("limit", 3)
        data = _rest_call(self._port, "GET", f"/api/v1/memory/health?limit={limit}")
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_working_context(self, args: dict) -> str:
        """Get working context via GET /api/v1/memory/working-context."""
        data = _rest_call(self._port, "GET", "/api/v1/memory/working-context")
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_feedback(self, args: dict) -> str:
        """Submit or track agent feedback (FB-0003)."""
        action = (args.get("action") or "check").lower()
        if action == "submit":
            title = (args.get("title") or "").strip()
            description = (args.get("description") or "").strip()
            if len(title) < 5 or len(description) < 10:
                return json.dumps({"error": "submit requires title (>=5) and description (>=10)"})
            body = {"title": title, "description": description}
            for key in ("category", "priority"):
                if args.get(key):
                    body[key] = args[key]
            data = _rest_call(self._port, "POST", "/api/v1/feedback", body=body)
            if data is None:
                return json.dumps({"error": "ValorBrain REST API unreachable"})
            return json.dumps(data, ensure_ascii=False)
        feedback_id = args.get("feedback_id") or "all"
        data = _rest_call(self._port, "GET", f"/api/v1/feedback/{feedback_id}")
        if data is None:
            return json.dumps({"error": "ValorBrain REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    # -- Managed serve ---------------------------------------------------------

    def _start_serve(self) -> None:
        """Start valorbrain serve as a managed child process with readiness probe."""
        if not self._bin:
            return
        try:
            env = {**os.environ, **self._env_extra}
            self._serve_proc = subprocess.Popen(
                [self._bin, "serve", "--port", str(self._port)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
            )
            # Readiness probe — wait up to 5s for /health to respond
            for attempt in range(10):
                # Check if process exited immediately (port conflict, crash)
                if self._serve_proc.poll() is not None:
                    logger.warning("valorbrain: managed serve exited immediately (code=%d)",
                                   self._serve_proc.returncode)
                    self._serve_proc = None
                    return
                time.sleep(0.5)
                health = _rest_call(self._port, "GET", "/health", timeout=1.0)
                if health:
                    logger.info("valorbrain: managed serve ready (pid=%d, port=%d)",
                                self._serve_proc.pid, self._port)
                    return
            logger.warning("valorbrain: managed serve started but health check timed out (pid=%d)",
                           self._serve_proc.pid)
        except Exception as e:
            logger.warning("valorbrain: failed to start managed serve: %s", e)

    # -- Shutdown --------------------------------------------------------------

    def shutdown(self) -> None:
        # Wait for background threads
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)

        # Stop managed serve
        if self._serve_proc and self._serve_proc.poll() is None:
            self._serve_proc.terminate()
            try:
                self._serve_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._serve_proc.kill()
            logger.info("valorbrain: managed serve stopped")


# ---------------------------------------------------------------------------
# PreToolUse middleware — contexto do vault por arquivo, sem bloquear o agente
# ---------------------------------------------------------------------------
#
# O hook `pretool-inject` (matcher Read|Edit|Write) injeta decisões/antipadrões
# do vault sobre o arquivo alvo. Hospedado não tem hook de PreToolUse no
# harness: usamos o middleware NATIVO do Hermes (`tool_execution`), que roda
# dentro do processo do agente. Middleware é síncrono — uma chamada HTTP ali
# travaria o loop — então o desenho é cache + aquecimento em background: a
# resposta do turno nunca espera; a partir da segunda interação com o mesmo
# arquivo o contexto aparece.

_FILE_CTX_TTL_S = 600
_PRETOOL_TIMEOUT_S = 5
_file_ctx_cache: dict = {}
_file_ctx_inflight: set = set()
_file_ctx_lock = threading.Lock()


def _cached_file_context(provider, path: str) -> str:
    """Contexto do vault para `path`: devolve o cache e aquece em background."""
    now = time.time()
    with _file_ctx_lock:
        entry = _file_ctx_cache.get(path)
        if entry and (now - entry[0]) < _FILE_CTX_TTL_S:
            return entry[1]
        if path in _file_ctx_inflight:
            return entry[1] if entry else ""
        _file_ctx_inflight.add(path)

    def _warm() -> None:
        try:
            out = provider._invoke_hook(
                "pretool-inject",
                {"tool_input": {"file_path": path}, "hook_event_name": "PreToolUse"},
                timeout=_PRETOOL_TIMEOUT_S,
            )
            ctx = _extract_context(out) if out else ""
            with _file_ctx_lock:
                _file_ctx_cache[path] = (time.time(), ctx)
        except Exception:
            pass
        finally:
            with _file_ctx_lock:
                _file_ctx_inflight.discard(path)

    threading.Thread(target=_warm, daemon=True, name="valorbrain-pretool").start()
    return entry[1] if entry else ""


def _tool_execution_middleware(provider):
    """Appenda o contexto do vault ao resultado de tools com `file_path`."""

    def middleware(tool_name, args, next_call, **context):
        result = next_call(args)
        try:
            candidate = None
            if isinstance(args, dict):
                candidate = args.get("file_path") or args.get("path")
            if isinstance(candidate, str) and len(candidate) >= 5 and isinstance(result, str):
                block = _cached_file_context(provider, candidate)
                if block:
                    return result + "\n\n" + block
        except Exception:
            pass
        return result

    return middleware


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

_GATEWAY_RUNTIME_HB_STOP = threading.Event()


def _gateway_runtime_heartbeat_loop(runtime_key: str, port: int) -> None:
    """Keep Hermes visible in SaaS Integrations while the gateway process is up."""
    while not _GATEWAY_RUNTIME_HB_STOP.wait(300):
        _rest_call(
            port,
            "POST",
            "/api/v1/runtimes/heartbeat",
            {
                "runtime_key": runtime_key,
                "config_health": "ok",
                "capabilities": {"contract_version": _CONTRACT_VERSION},
            },
            timeout=5.0,
        )


def _eager_register_gateway_runtime() -> None:
    """Register runtime at plugin load — not only when a chat session starts."""
    seed = _runtime_seed()
    if not seed:
        logger.debug("valorbrain: skip gateway runtime register — no tenant id/token")
        return
    try:
        port = int(os.environ.get("VALORBRAIN_SERVE_PORT", _DEFAULT_PORT))
    except (ValueError, TypeError):
        port = _DEFAULT_PORT
    import hashlib
    import socket

    host = socket.gethostname()
    digest = hashlib.sha256(f"{seed}:{host}:hermes:1.0".encode()).hexdigest()[:16]
    runtime_key = f"hermes:{host}:{digest}"
    health = _rest_call(port, "GET", "/health") or {}
    config_health = "ok" if health else "unreachable"
    payload = {
        "runtime_key": runtime_key,
        "agent_platform": "hermes",
        "display_name": f"{host} (Hermes)",
        "hostname": host,
        "plugin_version": _PLUGIN_VERSION,
        "capabilities": {
            "memory_provider": True,
            "hooks": True,
            "tools": True,
            "harness": "hermes",
            "contract_version": _CONTRACT_VERSION,
        },
        "config_health": config_health,
    }
    res = _rest_call(port, "POST", "/api/v1/runtimes/register", payload, timeout=8.0)
    if res and res.get("runtime", {}).get("id"):
        logger.info(
            "valorbrain: hermes gateway runtime registered (%s)",
            res["runtime"]["id"],
        )
        threading.Thread(
            target=_gateway_runtime_heartbeat_loop,
            args=(runtime_key, port),
            daemon=True,
            name="valorbrain-runtime-hb",
        ).start()
    else:
        logger.warning("valorbrain: hermes gateway runtime register failed")


def register(ctx) -> None:
    """Register ValorBrain as a memory provider plugin."""
    provider = ValorBrainProvider()
    ctx.register_memory_provider(provider)
    # PreToolUse nativo: contexto por arquivo no resultado das tools (o harness
    # hospedado não tem hook de PreToolUse; middleware é o caminho). Não-bloqueante.
    try:
        ctx.register_middleware("tool_execution", _tool_execution_middleware(provider))
    except Exception as e:
        logger.debug("valorbrain: tool middleware registration skipped: %s", e)
    _eager_register_gateway_runtime()
