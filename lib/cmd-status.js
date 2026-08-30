/**
 * `status` — local config + remote health in one read.
 * `identify <platform>` — idempotent agent_caller backfill.
 */
import { api } from "./api.js";
import { loadConfig, resolveBaseUrl, resolveApiKey, configPath } from "./config.js";

export async function cmdStatus(_args, { json }) {
  const cfg = loadConfig();
  const baseUrl = resolveBaseUrl({ cfg });
  const key = resolveApiKey({ cfg });

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
      tenant_id: cfg?.tenant_id ?? null,
      key_fingerprint: key ? `${key.slice(0, 12)}…${key.slice(-4)}` : null,
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
  console.log(`key:     ${key.slice(0, 12)}…${key.slice(-4)}`);
  console.log(`caller:  ${cfg.agent_caller ?? "unspecified"}`);
  console.log(`claimed: ${cfg.claimed ? cfg.claimed_email : `no — expires ${cfg.expires_at}`}`);
}

export async function cmdIdentify(args, { json }) {
  const caller = args.find((a) => !a.startsWith("--"));
  if (!caller) {
    console.error("error: usage: valorbrain identify <platform>");
    process.exit(1);
  }
  const cfg = loadConfig();
  const key = resolveApiKey({ cfg });
  if (!key) {
    console.error("error: no API key — run `valorbrain init --agent` first");
    process.exit(1);
  }
  const baseUrl = resolveBaseUrl({ cfg });
  const r = await api.agentIdentify(baseUrl, key, caller);
  if (cfg) {
    const { saveConfig } = await import("./config.js");
    saveConfig({ ...cfg, agent_caller: caller });
  }
  if (json) console.log(JSON.stringify({ ok: true, agent_caller: caller, tenant_id: r.tenant_id }));
  else console.log(`✓ agent_caller = ${caller}`);
}
