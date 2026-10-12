/**
 * The step after `init --agent`: connect the MCP client to the hosted server.
 *
 * Same commands as https://valorbrain.com.br/connect.md (the single source the
 * engine, the docs and this CLI repeat). Client binaries found on PATH are
 * listed first; detection only orders the list, it never runs anything.
 *
 * CLIs with hooks (Claude Code, Codex, Gemini CLI) get the connect installer
 * first: one command for MCP + rules + hooks. The hooks send the prompt of each
 * turn to the engine, so the human hears it before the install (`consent`);
 * a human who declines gets `mcp_only` (the same command with --mcp-only: MCP
 * server + rules, nothing sent per turn) or wires it by hand (`mcp_manual`).
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DEFAULT_MCP_URL, DEFAULT_REST_URL } from "./config.js";

export const CONNECT_DOC = "https://valorbrain.com.br/connect.md";
export const CLAIM_COMMAND = "npx -y @valorbrain/cli init --email <email>";
export const STDIO_COMMAND = "npx -y @valorbrain/cli mcp";
export const CONNECT_COMMAND = "npx -y @valorbrain/connect@latest";
export const WHAT_LEAVES_URL = "https://docs.valorbrain.com.br/docs/concepts/what-leaves-your-machine";

/** The one-line consent for the hooks of `harness`, with the opt-outs connect 0.9.0 has. */
export function hooksConsent(harness) {
  // Gemini CLI strips the environment of its hooks: only the saved choices work there.
  const env = harness === "gemini-cli" ? "" : " (or VALORBRAIN_SEND_PROMPT=off / VALORBRAIN_CHECKPOINT=off)";
  return `Tell your human first: the hooks send the prompt of each turn of this CLI to their ValorBrain workspace to fetch memory. ` +
    `Opt out after the install with \`${CONNECT_COMMAND} --harness ${harness} --prompt off\` and \`--checkpoint off\`${env}; to drop only the hooks, re-run the install with --mcp-only; --remove undoes everything (MCP entry, rules, hooks, saved credentials). ` +
    `What leaves the machine: ${WHAT_LEAVES_URL}`;
}

/** True when an executable called `name` is on PATH. */
export function onPath(name, env = process.env) {
  const exts = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return true;
      } catch { /* unreadable dir entry */ }
    }
  }
  return false;
}

/**
 * Client connect commands for an MCP token, detected clients first.
 * `apiUrl` is the engine the account was created on: connect falls back to the
 * public engine unless told otherwise, so any other engine goes in as --api.
 * Each entry: { client, binary, detected, command }; for a CLI with hooks
 * `command` is the connect installer and the entry adds { harness, consent, mcp_only, mcp_manual }.
 */
export function connectCommands(mcpToken, mcpUrl = DEFAULT_MCP_URL, env = process.env, apiUrl = DEFAULT_REST_URL) {
  const url = mcpUrl || DEFAULT_MCP_URL;
  const api = apiUrl && apiUrl.replace(/\/+$/, "") !== DEFAULT_REST_URL ? ` --api ${apiUrl.replace(/\/+$/, "")}` : "";
  const clients = [
    {
      client: "claude-code",
      binary: "claude",
      harness: "claude-code",
      command: `claude mcp add --transport http --scope user valorbrain ${url} --header "Authorization: Bearer ${mcpToken}"`,
    },
    {
      client: "codex",
      binary: "codex",
      harness: "codex",
      command: `export VALORBRAIN_MCP_TOKEN=${mcpToken} && codex mcp add valorbrain --url ${url} --bearer-token-env-var VALORBRAIN_MCP_TOKEN`,
    },
    {
      client: "gemini",
      binary: "gemini",
      harness: "gemini-cli",
      command: `add to ~/.gemini/settings.json: ${JSON.stringify({ mcpServers: { valorbrain: { httpUrl: url, headers: { Authorization: `Bearer ${mcpToken}` } } } })}`,
    },
  ].map(({ harness, command, ...c }) => ({
    ...c,
    detected: onPath(c.binary, env),
    ...(harness
      ? {
          harness,
          command: `${CONNECT_COMMAND} --token ${mcpToken}${api} --harness ${harness}`,
          consent: hooksConsent(harness),
          mcp_only: `${CONNECT_COMMAND} --token ${mcpToken}${api} --harness ${harness} --mcp-only`,
          mcp_manual: command,
        }
      : { command }),
  }));
  return [...clients.filter((c) => c.detected), ...clients.filter((c) => !c.detected)];
}
