# @valorbrain/cli

Agent-native memory for AI agents and the humans who work with them. Zero
dependencies, Node >= 18.

## Quickstart

```bash
npx @valorbrain/cli init --agent --agent-caller claude-code
npx @valorbrain/cli add "the deploy key lives in the ops vault"
npx @valorbrain/cli search "deploy key"
```

That's the whole signup: no email, no dashboard, no card. Two credentials land
in `~/.valorbrain/config.json` (mode 0600) and work immediately:

| Credential | Prefix | Works on |
|---|---|---|
| REST key (`api_key`) | `vb_agent_…` | the REST API (`https://valorbrain-api.valor.digital`) |
| MCP token (`mcp_token`) | `vbm_…` | the hosted MCP server (`https://mcpbrain.valor.digital/mcp`) |

The MCP token is shown once by the server — the config file is the only place
it lives. `init --agent` refuses to replace an existing config (that would
create a second account and drop both keys); pass `--force` to replace it,
and a backup is written first.

## Commands

| Command | What it does |
|---|---|
| `init --agent [--agent-caller <platform>] [--force]` | Creates an account with a REST key and an MCP token |
| `init --email <address>` | Binds the account to an email via OTP — **the key does not change** |
| `identify <platform>` | Records which agent is calling (idempotent) |
| `add <text>` / `--file <path>` | Stores a memory (`--collection`, `--title`, `--type`) |
| `search <query>` | Search (`--collection`, `--mode auto\|keyword\|semantic\|hybrid`) |
| `list` | Lists collections |
| `status` | Local config + remote health |
| `mcp [--token vbm_…]` | Bridges stdio MCP clients to the hosted MCP server (uses the saved `mcp_token`) |
| `help --json` | The whole surface, machine-readable |

Every command takes `--json` (alias `--agent`) for single-object
machine-readable output, `--key` for an explicit API key, and `--url` to point
at another deployment.

Environment: `VALORBRAIN_TOKEN` is the REST key, `VALORBRAIN_MCP_TOKEN` the
MCP token (`VALORBRAIN_TOKEN` is also accepted by `mcp` when it holds a
`vbm_` token); `VALORBRAIN_URL` and `VALORBRAIN_MCP_URL` override the hosts.

## Notes for agents

- **Say who you are.** `--agent-caller` is self-declared and never inferred
  from the environment — the env sniff only suggests. Usage attribution only
  works if you declare it.
- **Your text is stored verbatim.** Portuguese stays Portuguese, English
  stays English — nothing is translated or paraphrased on write.
- **The notice in `init` output is for you.** It tells you what to surface to
  your human at your next user-facing turn. Do not skip it.

## Connecting MCP clients

Clients that speak streamable HTTP connect directly, with the MCP token as a
bearer (Claude Code example):

```bash
claude mcp add --transport http valorbrain https://mcpbrain.valor.digital/mcp \
  --header "Authorization: Bearer vbm_…"
```

Clients that only speak stdio go through the proxy, which reads the saved
`mcp_token` (or `--token` / `VALORBRAIN_MCP_TOKEN`):

```json
{
  "mcpServers": {
    "valorbrain": {
      "command": "npx",
      "args": ["-y", "@valorbrain/cli", "mcp"]
    }
  }
}
```

The proxy only sends `vbm_` tokens. A REST key (`vb_agent_…`) is refused
locally with an explanation instead of reaching the server, and any HTTP
error from the MCP host comes back to the client as a JSON-RPC error carrying
the request id.

## Self-hosting

Point at your own deployment:

```bash
valorbrain --url https://your-engine.example.com init --agent
```

REST base default: `https://valorbrain-api.valor.digital` · MCP default:
`https://mcpbrain.valor.digital/mcp`

## License

MIT — see [LICENSE](./LICENSE).
