/**
 * Config — ~/.valorbrain/config.json, mode 0600.
 *
 * Same schema the engine's own CLI writes (src/agent-cmd.ts), so both tools
 * interoperate on one machine: whichever ran `init` first, the other reads the
 * same key.
 *
 * Two credentials live here since the engine started minting an MCP token at
 * signup (2026-10-02):
 *   - api_key   vb_agent_…  REST only (valorbrain-api)
 *   - mcp_token vbm_…       MCP only (mcpbrain), shown once by the server —
 *                           this file is the only place it is kept.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export function configPath() {
  return resolve(homedir(), ".valorbrain", "config.json");
}

export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the config. With `backup: true` an existing file is copied to
 * `config.json.bak.<timestamp>` (also 0600) before being replaced, so a
 * re-run of `init --agent` never silently drops a claimed account.
 * Returns the backup path, or null when nothing was backed up.
 */
export function saveConfig(cfg, { backup = false } = {}) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  let backupPath = null;
  if (backup && existsSync(p)) {
    backupPath = `${p}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(p, backupPath);
    chmodSync(backupPath, 0o600);
  }
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return backupPath;
}

/** Resolve the REST base URL. Precedence: flag > env > saved config > default. */
export function resolveBaseUrl({ urlFlag, cfg } = {}) {
  return (
    urlFlag ||
    process.env.VALORBRAIN_URL ||
    cfg?.engine_url ||
    "https://valorbrain-api.valor.digital"
  ).replace(/\/+$/, "");
}

/** MCP endpoint lives on the MCP host, never on the REST host. */
export function resolveMcpUrl({ urlFlag, cfg } = {}) {
  return (
    urlFlag ||
    process.env.VALORBRAIN_MCP_URL ||
    cfg?.mcp_url ||
    "https://mcpbrain.valor.digital/mcp"
  ).replace(/\/+$/, "");
}

/** REST API key (vb_agent_…): flag > env > saved config. */
export function resolveApiKey({ keyFlag, cfg } = {}) {
  return keyFlag || process.env.VALORBRAIN_TOKEN || cfg?.api_key || null;
}

/** The MCP host only accepts vbm_ tokens; the REST key is never one. */
export function isMcpToken(value) {
  return typeof value === "string" && value.startsWith("vbm_");
}

/**
 * MCP token (vbm_…): flag > VALORBRAIN_MCP_TOKEN > VALORBRAIN_TOKEN (only when
 * it is a vbm_ token — people export the REST key under that name too) >
 * saved config. Never falls back to api_key: the MCP host rejects it with a
 * generic "invalid token", which reads like an expired credential.
 */
export function resolveMcpToken({ tokenFlag, cfg } = {}) {
  if (tokenFlag) return tokenFlag;
  if (process.env.VALORBRAIN_MCP_TOKEN) return process.env.VALORBRAIN_MCP_TOKEN;
  if (isMcpToken(process.env.VALORBRAIN_TOKEN)) return process.env.VALORBRAIN_TOKEN;
  return cfg?.mcp_token || null;
}

/** Short, safe-to-print form of a credential. */
export function fingerprint(value) {
  if (!value) return null;
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}
