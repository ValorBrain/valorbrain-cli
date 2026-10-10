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
 * --json on any command prints one machine-readable object — errors included,
 * on stdout, with the exit codes in lib/errors.js.
 */
import { cmdInit } from "../lib/cmd-init.js";
import { cmdAdd, cmdSearch, cmdList, cmdForget } from "../lib/cmd-memory.js";
import { cmdStatus, cmdIdentify } from "../lib/cmd-status.js";
import { runMcpProxy } from "../lib/mcp-proxy.js";
import { parseArgv, describeSurface } from "../lib/args.js";
import { CliError, EXIT } from "../lib/errors.js";
import { DEFAULT_REST_URL, DEFAULT_MCP_URL } from "../lib/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const version = require("../package.json").version;

const HELP = `valorbrain ${version} — agent-native memory

Usage: valorbrain <command> [args] [flags]

Commands:
  init --agent [--agent-caller <platform>]   Create an account: REST key + MCP token (no email needed)
       [--force]                             Replace an existing config (a backup is written first)
  init --email <address> [--otp <code>]      Claim the account with an email (keys stay the same)
  identify <platform>                        Set/fix which agent is calling (idempotent)
  add <text> | --file <path>                 Store a memory
       [--key <name>]                        Stable identity: adding the same key again is a revision
       [--supersedes <docid|path>]           Mark an older memory as superseded (repeatable)
       [--collection --title --path]
       [--type decision|observation|problem|milestone|handoff|lesson|note]
       [--sensitivity public|internal|private|company_confidential]
  search <query>                             Search memories [--collection --limit <1-100>]
       [--mode auto|keyword|semantic|hybrid]
  forget <docid>                             Forget a memory (it stops appearing in search)
  list                                       List collections
  status                                     Local config + remote health
  mcp [--token vbm_… | --token-file <path>]  Bridge stdio MCP clients to the hosted MCP server
                                             (default token: mcp_token from the config, or VALORBRAIN_MCP_TOKEN)
  help                                       This help (help --json: the whole surface)

Global flags (any position, before or after the command):
  --json              Machine-readable single-object output; errors too, on stdout
  --api-key <vb_…>    REST API key (--key is an alias, except after \`add\` where it is the memory key)
  --url <base>        REST base URL (default: ${DEFAULT_REST_URL}; on \`mcp\`: the MCP URL)
Unknown flags are errors. Text that starts with a dash goes after \`--\`.

Credentials: vb_agent_… is the REST key (api_key); vbm_… is the MCP token (mcp_token).
Env: VALORBRAIN_API_KEY · VALORBRAIN_MCP_TOKEN · VALORBRAIN_API_URL · VALORBRAIN_MCP_URL
     (VALORBRAIN_TOKEN still works with a warning: vbm_ → MCP, anything else → REST)
Exit codes: 0 ok · 1 server/network failure · 2 usage error · 3 credential missing/wrong/rejected
Config: ~/.valorbrain/config.json (0600) — same file the engine CLI reads.
Connect: https://valorbrain.com.br/connect.md`;

function helpJson() {
  return {
    name: "@valorbrain/cli",
    version,
    config: "~/.valorbrain/config.json",
    default_rest_base_url: DEFAULT_REST_URL,
    default_mcp_url: DEFAULT_MCP_URL,
    connect_doc: "https://valorbrain.com.br/connect.md",
    credentials: [
      { prefix: "vb_agent_", config_field: "api_key", env: "VALORBRAIN_API_KEY", flag: "--api-key", accepted_on: "REST (default_rest_base_url)" },
      { prefix: "vbm_", config_field: "mcp_token", env: "VALORBRAIN_MCP_TOKEN", flag: "--token (mcp)", accepted_on: "MCP (default_mcp_url)" },
    ],
    env: {
      VALORBRAIN_API_KEY: "REST key",
      VALORBRAIN_MCP_TOKEN: "MCP token",
      VALORBRAIN_API_URL: "REST base URL",
      VALORBRAIN_MCP_URL: "MCP endpoint",
      deprecated: {
        VALORBRAIN_TOKEN: "vbm_ → MCP token, anything else → REST key (warning on stderr)",
        VALORBRAIN_API_TOKEN: "REST key (warning on stderr)",
        VALORBRAIN_URL: "REST base URL (warning on stderr)",
      },
    },
    exit_codes: { 0: "ok", 1: "server or network failure", 2: "usage error", 3: "credential missing, wrong type, or rejected" },
    error_shape: "{ ok: false, error: <message>, code: <string>, exit_code: <int>, ... } on stdout with --json",
    ...describeSurface(),
  };
}

async function main(argv) {
  // --json is known before parsing, so even a parse error comes out as JSON.
  const wantsJson = argv.includes("--json");
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    return report(e, wantsJson);
  }
  const json = !!parsed.globals["--json"];
  const ctx = { json };

  try {
    if (parsed.globals["--version"] || parsed.command === "version") {
      console.log(json ? JSON.stringify({ version }) : version);
      return;
    }
    if (parsed.globals["--help"] || parsed.command === null || parsed.command === "help") {
      console.log(json ? JSON.stringify(helpJson(), null, 2) : HELP);
      return;
    }
    switch (parsed.command) {
      case "init":     return await cmdInit(parsed, ctx);
      case "identify": return await cmdIdentify(parsed, ctx);
      case "add":      return await cmdAdd(parsed, ctx);
      case "search":   return await cmdSearch(parsed, ctx);
      case "forget":   return await cmdForget(parsed, ctx);
      case "list":     return await cmdList(parsed, ctx);
      case "status":   return await cmdStatus(parsed, ctx);
      case "mcp":      return await runMcpProxy(parsed);
    }
  } catch (e) {
    return report(e, json);
  }
}

function report(e, json) {
  const err = e instanceof CliError
    ? e
    : e?.code === "ENOENT"
      ? new CliError(`file not found: ${e.path ?? e.message}`, { code: "file_not_found", exit: EXIT.USAGE })
      : new CliError(e?.message ?? String(e), { code: "internal_error", exit: EXIT.FAILURE });
  if (json) {
    console.log(JSON.stringify({ ok: false, error: err.message, code: err.code, exit_code: err.exit, ...err.extra }));
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exitCode = err.exit;
}

main(process.argv.slice(2));
