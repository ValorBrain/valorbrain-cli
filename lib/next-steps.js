/**
 * The step after `init --agent`: connect the MCP client to the hosted server.
 *
 * Same commands as https://valorbrain.com.br/connect.md (the single source the
 * engine, the docs and this CLI repeat). Client binaries found on PATH are
 * listed first; detection only orders the list, it never runs anything.
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DEFAULT_MCP_URL } from "./config.js";

export const CONNECT_DOC = "https://valorbrain.com.br/connect.md";
export const CLAIM_COMMAND = "npx -y @valorbrain/cli init --email <email>";
export const STDIO_COMMAND = "npx -y @valorbrain/cli mcp";

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
 * Each entry: { client, binary, detected, command }.
 */
export function connectCommands(mcpToken, mcpUrl = DEFAULT_MCP_URL, env = process.env) {
  const url = mcpUrl || DEFAULT_MCP_URL;
  const clients = [
    {
      client: "claude-code",
      binary: "claude",
      command: `claude mcp add --transport http --scope user valorbrain ${url} --header "Authorization: Bearer ${mcpToken}"`,
    },
    {
      client: "codex",
      binary: "codex",
      command: `export VALORBRAIN_MCP_TOKEN=${mcpToken} && codex mcp add valorbrain --url ${url} --bearer-token-env-var VALORBRAIN_MCP_TOKEN`,
    },
    {
      client: "gemini",
      binary: "gemini",
      command: `add to ~/.gemini/settings.json: ${JSON.stringify({ mcpServers: { valorbrain: { httpUrl: url, headers: { Authorization: `Bearer ${mcpToken}` } } } })}`,
    },
  ].map((c) => ({ ...c, detected: onPath(c.binary, env) }));
  return [...clients.filter((c) => c.detected), ...clients.filter((c) => !c.detected)];
}
