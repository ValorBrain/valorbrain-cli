# ValorBrain for Hermes Agent

ValorBrain is a hosted hybrid-memory service: composite-scored retrieval
(BM25 + vector + graph PPR), lifecycle hooks, and one vault shared across every
agent you run (Hermes, Claude Code, Cursor, Codex, …).

This package is Hermes' **MemoryProvider** plugin plus the MCP tools wiring.

## Install (catalog)

```bash
hermes plugins install valorbrain
hermes memory setup        # pick valorbrain
```

Memory providers are activated through `memory.provider`, not `plugins.enabled`.

## Hosted configuration (no local engine)

The hosted installer writes the config for you:

```bash
npx @valorbrain/connect --token vbm_xxx --harness hermes
hermes memory setup        # pick valorbrain
```

It sets, in `~/.hermes/config.yaml`:

```yaml
env:
  VALORBRAIN_ENGINE_URL: https://valorbrain-api.valor.digital
  VALORBRAIN_API_TOKEN: vbm_xxx
```

Without a local binary the provider covers tools, registration, contract
declaration **and the lifecycle hooks**: bootstrap, per-turn context and the
Stop/PreCompact extraction run on the engine via `POST /api/v1/hooks/run` (the
engine owns the code and the database; the client only ships the transcript).

The three hooks that used to need the client's disk have their own hosted path:

- **postcompact-inject** — the precompact state lives on the engine, scoped per
  tenant+session; the plugin re-injects it on the first turn after compaction
  (the provider's injection channel replaces the `SessionStart` `compact` matcher).
- **curator-nudge** — folded into the hosted `session-bootstrap` as a per-tenant
  nudge (`staleness-check`); the local curator report is host-scoped.
- **pretool-inject** — native Hermes middleware (`tool_execution`): vault context
  for the target file is appended to tool results carrying `file_path`, with a
  background-warmed cache (middleware is synchronous; it never blocks the loop).

## Self-hosted

Requires the `valorbrain` binary (Valor Digital). `valorbrain setup harness
hermes` writes the same artifacts from the engine — including this plugin.

## What it registers

- **Tools** (REST): `valorbrain_retrieve`, `valorbrain_get`,
  `valorbrain_session_log`, `valorbrain_timeline`, `valorbrain_similar`,
  `valorbrain_store`, `valorbrain_health`, `valorbrain_working_context`.
- **Hooks**: `on_session_end` (decision extraction, handoff, feedback loop) and
  `on_pre_compress` (state preservation) — shell-outs to the local binary.
- **Contract declaration**: the plugin reports the contract version it ships
  with, so the ValorBrain dashboard shows adoption per harness.

## Environment

| Variable | Meaning |
|---|---|
| `VALORBRAIN_ENGINE_URL` / `VALORBRAIN_API_URL` | REST base of the engine (hosted: `https://valorbrain-api.valor.digital`) |
| `VALORBRAIN_API_TOKEN` | `vbm_` token (hosted) |
| `VALORBRAIN_TENANT_ID` | optional; the engine derives the tenant from the token |
| `VALORBRAIN_BIN` | path to the `valorbrain` binary (self-hosted; auto-detected on PATH) |
| `VALORBRAIN_SERVE_PORT` | local engine port (default 7438) |

## Links

- Client installer: <https://github.com/ValorBrain/valorbrain-cli>
- Issues: <https://github.com/ValorBrain/valorbrain-cli/issues>
