# @valorbrain/cli

Agent-native memory for AI agents and the humans who work with them. Zero
dependencies, Node >= 18.

## Quickstart

```bash
npx @valorbrain/cli init --agent --agent-caller claude-code
npx @valorbrain/cli add "the deploy key lives in the ops vault"
npx @valorbrain/cli search "deploy key"
```

That's the whole signup: no email, no dashboard, no card. The key lands in
`~/.valorbrain/config.json` (mode 0600) and works immediately.

## Commands

| Command | What it does |
|---|---|
| `init --agent [--agent-caller <platform>]` | Creates an account and API key |
| `init --email <address>` | Binds the account to an email via OTP — **the key does not change** |
| `identify <platform>` | Records which agent is calling (idempotent) |
| `add <text>` / `--file <path>` | Stores a memory (`--collection`, `--title`, `--type`) |
| `search <query>` | Search (`--collection`, `--mode auto\|keyword\|semantic\|hybrid`) |
| `list` | Lists collections |
| `status` | Local config + remote health |
| `mcp --token vbm_…` | Bridges stdio MCP clients to the hosted MCP server |
| `help --json` | The whole surface, machine-readable |

Every command takes `--json` (alias `--agent`) for single-object
machine-readable output, `--key` for an explicit API key, and `--url` to point
at another deployment.

## Notes for agents

- **Say who you are.** `--agent-caller` is self-declared and never inferred
  from the environment — the env sniff only suggests. Usage attribution only
  works if you declare it.
- **Your text is stored verbatim.** Portuguese stays Portuguese, English
  stays English — nothing is translated or paraphrased on write.
- **The notice in `init` output is for you.** It tells you what to surface to
  your human at your next user-facing turn. Do not skip it.

## Connecting MCP clients

```json
{
  "mcpServers": {
    "valorbrain": {
      "command": "npx",
      "args": ["-y", "@valorbrain/connect", "--token", "vbm_…"]
    }
  }
}
```

`@valorbrain/connect` is the alias package for `valorbrain mcp`.

## Self-hosting

Point at your own deployment:

```bash
valorbrain --url https://your-engine.example.com init --agent
```

REST base default: `https://valorbrain-api.valor.digital` · MCP default:
`https://mcpbrain.valor.digital/mcp`

## License

MIT — see [LICENSE](./LICENSE).
