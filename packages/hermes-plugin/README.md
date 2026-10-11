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
declaration **and the lifecycle hooks**: bootstrap and per-turn context run on
the engine via `POST /api/v1/hooks/run`. The Stop/PreCompact extraction needs the
session transcript, which is **opt-in**: with `VALORBRAIN_SEND_TRANSCRIPT=on` (or
`npx -y @valorbrain/connect --harness hermes --transcript on`) the plugin keeps
the transcript and ships it with those hooks; without it the transcript is not
written, nothing is uploaded and the extraction does not run. The prompt of each
turn is sent by default for recall; `VALORBRAIN_SEND_PROMPT=off` (or
`--prompt off`) stops it.

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
| `VALORBRAIN_SEND_PROMPT` | `off` stops sending each turn's prompt (no per-turn recall). Default on |
| `VALORBRAIN_SEND_TRANSCRIPT` | `on` uploads the session transcript to the hosted extraction hooks. Default off |
| `VALORBRAIN_SERVE_PORT` | local engine port (default 7438) |

## Links

- Client installer: <https://github.com/ValorBrain/valorbrain-cli>
- Issues: <https://github.com/ValorBrain/valorbrain-cli/issues>
