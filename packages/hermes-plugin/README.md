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

Without a local binary the provider covers tools, registration and contract
declaration; the lifecycle hooks degrade gracefully (they shell out to the
local binary).

## Self-hosted

Requires the `valorbrain` binary (Valor Digital). `valorbrain setup harness
hermes` writes the same artifacts from the engine — including this plugin.

## What it registers

- **Tools** (REST): `valorbrain_retrieve`, `valorbrain_get`,
  `valorbrain_session_log`, `valorbrain_timeline`, `valorbrain_similar`,
  `valorbrain_collections` (read) · `valorbrain_ingest`, `valorbrain_forget`,
  `valorbrain_feedback`, `valorbrain_pin` (write).
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
