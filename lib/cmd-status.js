/**
 * `status` — local config + remote health in one read.
 * `identify <platform>` — idempotent agent_caller backfill.
 */
import { api } from "./api.js";
import { loadConfig, saveConfig, resolveBaseUrl, resolveApiKey, resolveMcpUrl, resolveMcpToken, fingerprint, configPath } from "./config.js";
import { restContext } from "./cmd-memory.js";
import { usage } from "./errors.js";

export async function cmdStatus({ globals }, { json }) {
  const cfg = loadConfig();
  const baseUrl = resolveBaseUrl({ urlFlag: globals["--url"], cfg });
  const key = resolveApiKey({ keyFlag: globals["--api-key"] ?? globals["--key"], cfg });
  const mcpUrl = resolveMcpUrl({ cfg });
  const mcpToken = resolveMcpToken({ cfg });

  let health = null;
  try {
    health = await api.health(baseUrl);
  } catch (e) {
    health = { error: e.message };
  }

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      configured: !!cfg,
      config_path: configPath(),
      engine_url: baseUrl,
      mcp_url: mcpUrl,
      tenant_id: cfg?.tenant_id ?? null,
      key_fingerprint: fingerprint(key),
      mcp_token_fingerprint: fingerprint(mcpToken),
      agent_caller: cfg?.agent_caller ?? null,
      claimed: cfg?.claimed ?? false,
      expires_at: cfg?.expires_at ?? null,
      remote_health: health,
    }));
    return;
  }

  const healthy = health && !health.error;
  console.log(`remote:  ${baseUrl} ${healthy ? "healthy" : `UNREACHABLE (${health.error ?? "unknown"})`}`);
  if (!cfg) {
    console.log("local:   not configured — run `valorbrain init --agent`");
    return;
  }
  console.log(`config:  ${configPath()}`);
  console.log(`tenant:  ${cfg.tenant_id}`);
  console.log(`key:     ${fingerprint(key) ?? "none"}  (REST)`);
  console.log(
    mcpToken
      ? `mcp:     ${mcpUrl} token ${fingerprint(mcpToken)}`
      : `mcp:     ${mcpUrl} — no MCP token saved (account created with CLI < 0.1.2?); set VALORBRAIN_MCP_TOKEN or re-run \`init --agent --force\``
  );
  console.log(`caller:  ${cfg.agent_caller ?? "unspecified"}`);
  console.log(`claimed: ${cfg.claimed ? cfg.claimed_email : `no — expires ${cfg.expires_at}`}`);
}

export async function cmdIdentify({ globals, positionals }, { json }) {
  const caller = positionals[0];
  if (!caller) throw usage("usage: valorbrain identify <platform>", "missing_argument");
  const { cfg, key, baseUrl } = restContext(globals);
  const r = await api.agentIdentify(baseUrl, key, caller);
  if (cfg) saveConfig({ ...cfg, agent_caller: caller });
  if (json) console.log(JSON.stringify({ ok: true, agent_caller: caller, tenant_id: r.tenant_id }));
  else console.log(`✓ agent_caller = ${caller}`);
}
