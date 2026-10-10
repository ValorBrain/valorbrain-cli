/**
 * Config — ~/.valorbrain/config.json, mode 0600 — and credential resolution.
 *
 * Same schema the engine's own CLI writes (src/agent-cmd.ts), so both tools
 * interoperate on one machine: whichever ran `init` first, the other reads the
 * same key.
 *
 * Two credentials, never interchangeable:
 *   - api_key   vb_agent_… / vb_…  REST only (valorbrain-api)
 *   - mcp_token vbm_…              MCP only (mcpbrain), shown once by the
 *                                  server — this file is the only place it is kept.
 *
 * Environment (connect contract):
 *   VALORBRAIN_API_KEY    REST key          VALORBRAIN_API_URL  REST base URL
 *   VALORBRAIN_MCP_TOKEN  MCP token         VALORBRAIN_MCP_URL  MCP endpoint
 * Deprecated, still accepted with a warning on stderr:
 *   VALORBRAIN_TOKEN      vbm_… → MCP token, anything else → REST key
 *   VALORBRAIN_API_TOKEN  REST key
 *   VALORBRAIN_URL        REST base URL
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { authError } from "./errors.js";

export const DEFAULT_REST_URL = "https://valorbrain-api.valor.digital";
export const DEFAULT_MCP_URL = "https://mcpbrain.valor.digital/mcp";

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

const warned = new Set();
/** One deprecation line per variable per process, on stderr (never stdout). */
function deprecated(name, replacement) {
  if (warned.has(name)) return;
  warned.add(name);
  process.stderr.write(`warning: ${name} is deprecated — use ${replacement}\n`);
}

/** The MCP host only accepts vbm_ tokens; the REST key is never one. */
export function isMcpToken(value) {
  return typeof value === "string" && value.startsWith("vbm_");
}

/** Resolve the REST base URL. Precedence: flag > env > saved config > default. */
export function resolveBaseUrl({ urlFlag, cfg } = {}) {
  let env = process.env.VALORBRAIN_API_URL;
  if (!env && process.env.VALORBRAIN_URL) {
    deprecated("VALORBRAIN_URL", "VALORBRAIN_API_URL");
    env = process.env.VALORBRAIN_URL;
  }
  return (urlFlag || env || cfg?.engine_url || DEFAULT_REST_URL).replace(/\/+$/, "");
}

/** MCP endpoint lives on the MCP host, never on the REST host. */
export function resolveMcpUrl({ urlFlag, cfg } = {}) {
  return (urlFlag || process.env.VALORBRAIN_MCP_URL || cfg?.mcp_url || DEFAULT_MCP_URL).replace(/\/+$/, "");
}

/**
 * REST API key: flag > VALORBRAIN_API_KEY > VALORBRAIN_TOKEN (when not vbm_) >
 * VALORBRAIN_API_TOKEN > saved api_key. Returns { key, source } or null.
 */
export function findApiKey({ keyFlag, cfg } = {}) {
  if (keyFlag) return { key: keyFlag, source: "flag" };
  if (process.env.VALORBRAIN_API_KEY) return { key: process.env.VALORBRAIN_API_KEY, source: "VALORBRAIN_API_KEY" };
  const legacy = process.env.VALORBRAIN_TOKEN;
  if (legacy && !isMcpToken(legacy)) {
    deprecated("VALORBRAIN_TOKEN", "VALORBRAIN_API_KEY for the REST key (vb_agent_/vb_)");
    return { key: legacy, source: "VALORBRAIN_TOKEN" };
  }
  if (process.env.VALORBRAIN_API_TOKEN) {
    deprecated("VALORBRAIN_API_TOKEN", "VALORBRAIN_API_KEY");
    return { key: process.env.VALORBRAIN_API_TOKEN, source: "VALORBRAIN_API_TOKEN" };
  }
  if (cfg?.api_key) return { key: cfg.api_key, source: "config" };
  return null;
}

/** The REST key as a string, or null (status/fingerprints). */
export function resolveApiKey(opts = {}) {
  return findApiKey(opts)?.key ?? null;
}

/**
 * The REST key, or a CliError (exit 3) that says where one comes from. A vbm_
 * token is refused here: it only works on the MCP host.
 */
export function requireApiKey(opts = {}) {
  const found = findApiKey(opts);
  if (!found) {
    throw authError("no API key. Run `valorbrain init --agent` first, pass --api-key, or set VALORBRAIN_API_KEY.");
  }
  if (isMcpToken(found.key)) {
    throw authError(
      `the credential from ${found.source} is an MCP token (vbm_); the REST API needs the REST key (vb_agent_… or vb_…). ` +
      "The MCP token belongs in VALORBRAIN_MCP_TOKEN or `valorbrain mcp`.",
      "wrong_credential_type",
      { source: found.source }
    );
  }
  return found.key;
}

/**
 * MCP token (vbm_…): flag > VALORBRAIN_MCP_TOKEN > VALORBRAIN_TOKEN (only when
 * it is a vbm_ token) > saved mcp_token. Never falls back to api_key: the MCP
 * host rejects it with a generic "invalid token", which reads like an
 * expired credential.
 */
export function resolveMcpToken({ tokenFlag, cfg } = {}) {
  if (tokenFlag) return tokenFlag;
  if (process.env.VALORBRAIN_MCP_TOKEN) return process.env.VALORBRAIN_MCP_TOKEN;
  if (isMcpToken(process.env.VALORBRAIN_TOKEN)) {
    deprecated("VALORBRAIN_TOKEN", "VALORBRAIN_MCP_TOKEN for the MCP token (vbm_)");
    return process.env.VALORBRAIN_TOKEN;
  }
  return cfg?.mcp_token || null;
}

/** Short, safe-to-print form of a credential. */
export function fingerprint(value) {
  if (!value) return null;
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}
