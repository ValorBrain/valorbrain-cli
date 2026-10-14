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
  VALORBRAIN_HOOKS_MODE: hosted
```

`VALORBRAIN_HOOKS_MODE=hosted` makes the install hosted by construction: the
plugin never runs a local `valorbrain` binary, even when one is on the
gateway's `PATH` or `VALORBRAIN_BIN` is set. Without the switch a binary on
`PATH` wins and the hooks run self-hosted. In hosted mode the plugin also:

- never falls back to `127.0.0.1:VALORBRAIN_SERVE_PORT` (no engine URL = provider
  disabled, not a local call);
- sends no `X-Tenant-ID` / `X-User-ID`: the `vbm_` token decides the tenant and
  the user, so a `VALORBRAIN_TENANT_ID` left over from a self-hosted setup
  cannot disagree with it.

Tools, registration, contract declaration **and the lifecycle hooks** run on the
engine: bootstrap, per-turn context, pre-compress, post-compact re-injection and
the `tool_execution` middleware go through `POST /api/v1/hooks/run`. The
Stop/PreCompact extraction needs the session transcript, which is **opt-in**:
with `VALORBRAIN_SEND_TRANSCRIPT=on` (or
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
`VALORBRAIN_HOOKS_MODE` unset (or `self-hosted`) keeps the self-hosted order:
the binary runs the hooks; without one, they go to `VALORBRAIN_ENGINE_URL`.

## Moving a machine from the binary to hosted

1. Get a `vbm_` token for the agent (one token per agent or persona).
2. In the `env:` block of `~/.hermes/config.yaml`:
   - set `VALORBRAIN_HOOKS_MODE: hosted`,
     `VALORBRAIN_ENGINE_URL: https://valorbrain-api.valor.digital` and
     `VALORBRAIN_API_TOKEN: vbm_…` (replacing any admin/engine key);
   - remove `VALORBRAIN_BIN`, `VALORBRAIN_SERVE_PORT`, `VALORBRAIN_SERVE_MODE`
     and `VALORBRAIN_TENANT_ID` / `VALORBRAIN_DEFAULT_TENANT_ID` (hosted mode
     ignores them; removing them keeps the file honest);
   - optionally set `VALORBRAIN_SEND_TRANSCRIPT: "on"` to keep the
     decision/handoff extraction (the transcript is uploaded to the engine).

   `npx @valorbrain/connect --token vbm_xxx --harness hermes` writes the first
   three keys for you; the removals are manual.
3. Make sure `~/.hermes/plugins/valorbrain/__init__.py` is plugin 1.8.0 or later
   (`_PLUGIN_VERSION`); older plugins ignore the switch.
4. Restart the Hermes gateway (for a systemd install:
   `systemctl restart hermes-gateway`); the plugin reads the env at startup.
5. Check: the gateway log shows `valorbrain: modo hospedado — hooks via POST
   /api/v1/hooks/run, sem binário local`, and the dashboard lists a new Hermes
   runtime (the hosted runtime key is derived from the token).

Rollback: restore the previous `env:` block (or just remove
`VALORBRAIN_HOOKS_MODE`, which brings back "binary first") and restart the
gateway again.

## What it registers

- **Tools** (REST): `valorbrain_retrieve`, `valorbrain_get`,
  `valorbrain_session_log`, `valorbrain_timeline`, `valorbrain_similar`,
  `valorbrain_store`, `valorbrain_health`, `valorbrain_working_context`.
- **Hooks**: `on_session_end` (decision extraction, handoff, feedback loop) and
  `on_pre_compress` (state preservation) — on the engine in hosted mode, through
  the local binary in self-hosted mode.
- **Contract declaration**: the plugin reports the contract version it ships
  with, so the ValorBrain dashboard shows adoption per harness.

## Environment

| Variable | Meaning |
|---|---|
| `VALORBRAIN_HOOKS_MODE` | `hosted`: hooks always on the engine, never a local binary, no tenant/user headers. `self-hosted` (default): binary first, then the engine |
| `VALORBRAIN_ENGINE_URL` / `VALORBRAIN_API_URL` | REST base of the engine (hosted: `https://valorbrain-api.valor.digital`) |
| `VALORBRAIN_API_TOKEN` | `vbm_` token (hosted) |
| `VALORBRAIN_TENANT_ID` | self-hosted only; hosted derives the tenant from the token |
| `VALORBRAIN_BIN` | path to the `valorbrain` binary (self-hosted; auto-detected on PATH; ignored when hosted) |
| `VALORBRAIN_SEND_PROMPT` | `off` stops sending each turn's prompt (no per-turn recall). Default on |
| `VALORBRAIN_SEND_TRANSCRIPT` | `on` uploads the session transcript to the hosted extraction hooks. Default off |
| `VALORBRAIN_SERVE_PORT` | local engine port (self-hosted; default 7438) |

## Links

- Client installer: <https://github.com/ValorBrain/valorbrain-cli>
- Issues: <https://github.com/ValorBrain/valorbrain-cli/issues>
