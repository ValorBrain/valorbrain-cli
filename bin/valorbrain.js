#!/usr/bin/env node
/**
 * valorbrain — agent-native memory CLI.
 *
 * Zero dependencies, Node >= 18 (uses global fetch). Quickstart:
 *
 *   npx @valorbrain/cli init --agent --agent-caller claude-code
 *   npx @valorbrain/cli add "the deploy key lives in the ops vault"
 *   npx @valorbrain/cli search "deploy key"
 *
 * --json (alias --agent) on any command prints one machine-readable object.
 */
import { cmdInit } from "../lib/cmd-init.js";
import { cmdAdd, cmdSearch, cmdList } from "../lib/cmd-memory.js";
import { cmdStatus, cmdIdentify } from "../lib/cmd-status.js";
import { runMcpProxy } from "../lib/mcp-proxy.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const version = require("../package.json").version;

const HELP = `valorbrain ${version} — agent-native memory

Usage: valorbrain <command> [args]

Commands:
  init --agent [--agent-caller <platform>]   Create an account and API key (no email needed)
  init --email <address>                     Claim the account with an email (key stays the same)
  identify <platform>                        Set/fix which agent is calling (idempotent)
  add <text> | --file <path>                 Store a memory [--collection --title --type]
  search <query>                             Search memories [--collection --mode]
  list                                       List collections
  status                                     Local config + remote health
  mcp [--token vbm_…]                        Bridge stdio MCP clients to the hosted MCP server
  help                                       This help (--help for options)

Global:
  --json | --agent      Machine-readable single-object output
  --key <key>           API key (default: ~/.valorbrain/config.json or VALORBRAIN_TOKEN)
  --url <base>          REST base URL (default: https://valorbrain-api.valor.digital)

Config: ~/.valorbrain/config.json (0600) — same file the engine CLI reads.
Docs:   https://valorbrain.valor.digital/docs`;

function helpJson() {
  console.log(JSON.stringify({
    name: "@valorbrain/cli",
    version,
    config: "~/.valorbrain/config.json",
    default_rest_base_url: "https://valorbrain-api.valor.digital",
    default_mcp_url: "https://mcpbrain.valor.digital/mcp",
    global_flags: [
      { flag: "--json", aliases: ["--agent"], description: "machine-readable output" },
      { flag: "--key", description: "API key override" },
      { flag: "--url", description: "REST base URL override" },
    ],
    commands: [
      { name: "init", usage: "init --agent [--agent-caller <platform>] | init --email <address> [--otp <code>]", description: "create an agent account or claim it with an email" },
      { name: "identify", usage: "identify <platform>", description: "idempotent agent_caller backfill" },
      { name: "add", usage: "add <text> [--file <path>] [--collection <name>] [--title <t>] [--type <t>]", description: "store a memory" },
      { name: "search", usage: "search <query> [--collection <name>] [--mode auto|keyword|semantic|hybrid]", description: "search memories" },
      { name: "list", usage: "list", description: "list collections" },
      { name: "status", usage: "status", description: "local config + remote health" },
      { name: "mcp", usage: "mcp [--token vbm_…] [--url <mcp-url>]", description: "stdio ⇄ HTTP MCP proxy" },
      { name: "help", usage: "help [--json]", description: "this surface, machine-readable with --json" },
    ],
  }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  // `--agent` is overloaded: on `init` it selects agent mode (mem0-compatible);
  // everywhere else it is an alias for --json.
  const cmd0 = argv.find((a) => !a.startsWith("--"));
  const agentIsMode = cmd0 === "init";
  const json = argv.includes("--json") || (!agentIsMode && argv.includes("--agent"));
  const args = argv.filter(
    (a) => a !== "--json" && a !== "--help" && !(a === "--agent" && !agentIsMode)
  );
  const cmd = args.shift();

  switch (cmd) {
    case undefined:
    case "help":
      if (json) helpJson();
      else console.log(HELP);
      break;
    case "version":
    case "--version":
    case "-V":
      console.log(json ? JSON.stringify({ version }) : version);
      break;
    case "init":     await cmdInit(args, { json }); break;
    case "identify": await cmdIdentify(args, { json }); break;
    case "add":      await cmdAdd(args, { json }); break;
    case "search":   await cmdSearch(args, { json }); break;
    case "list":     await cmdList(args, { json }); break;
    case "status":   await cmdStatus(args, { json }); break;
    case "mcp":      await runMcpProxy(args); break;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
