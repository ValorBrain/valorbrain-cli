/**
 * `init` — signup and claim flows.
 *
 * `init --agent` creates a shadow tenant with no email, no dashboard, no card.
 * The engine answers with TWO credentials (owner decision 2026-10-02):
 *   - api_key   vb_agent_…  for the REST API (valorbrain-api)
 *   - mcp_token vbm_…       for the MCP endpoint (mcp_url), shown once
 * Both are saved to ~/.valorbrain/config.json. `init --email <addr>` later
 * binds the SAME tenant to an address via OTP — neither credential changes.
 *
 * The signup response carries a `message` written as an instruction TO the
 * agent ("Surface to your human: …"). We print it verbatim: the conversion
 * channel is the agent itself, not a UI neither the agent nor the human is
 * looking at.
 */
import readline from "node:readline/promises";
import { api } from "./api.js";
import { loadConfig, saveConfig, resolveBaseUrl, fingerprint, configPath } from "./config.js";
import { detectPlatform } from "./detect.js";

export async function cmdInit(args, { json }) {
  const cfg = loadConfig();
  const flags = parseFlags(args);
  const baseUrl = resolveBaseUrl({ urlFlag: flags["--url"], cfg });
  const wantsAgent = args.includes("--agent");
  const email = flags["--email"];

  if (wantsAgent) {
    // A second signup would create a NEW tenant and drop the saved keys —
    // including a claimed account. Replacing the config is an explicit choice.
    if (cfg && !flags["--force"]) {
      const state = cfg.claimed ? `claimed as ${cfg.claimed_email}` : `unclaimed, expires ${cfg.expires_at ?? "?"}`;
      fail(json,
        `A config already exists for tenant ${cfg.tenant_id} (${state}) at ${configPath()}. ` +
        "Running `init --agent` again creates a NEW account and replaces the saved keys. " +
        "Keep using the existing account, or pass --force to replace it (a backup is written first).",
        { existing_tenant_id: cfg.tenant_id, claimed: !!cfg.claimed });
    }

    // Identity is self-declared, never inferred (see lib/detect.js).
    let caller = flags["--agent-caller"];
    const detected = detectPlatform();
    if (!caller && detected && !json) {
      console.error(`tip: this shell looks like ${detected.id} (env ${detected.env}) — pass --agent-caller ${detected.id} to record it`);
    }
    caller = caller || "unspecified";

    const name = flags["--name"] || `${caller}-${Date.now().toString(36)}`;
    const r = await api.agentSignup(baseUrl, { agent_name: name, agent_caller: caller });

    const mcpToken = r.mcp_token || null;
    const mcpUrl = r.mcp_url || null;
    const backupPath = saveConfig({
      tenant_id: r.tenant_id,
      api_key: r.api_key,
      mcp_token: mcpToken,
      mcp_url: mcpUrl,
      default_user_id: r.default_user_id,
      agent_caller: caller,
      expires_at: r.expires_at,
      claimed: false,
      engine_url: baseUrl,
    }, { backup: !!flags["--force"] });

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        tenant_id: r.tenant_id,
        api_key: r.api_key,
        api_key_use: "REST (Authorization: Bearer) at engine_url",
        mcp_token: mcpToken,
        mcp_token_use: mcpToken ? "MCP (Authorization: Bearer) at mcp_url — shown once, kept in config" : "not issued by this engine; create one in the app or set VALORBRAIN_MCP_TOKEN",
        mcp_url: mcpUrl,
        agent_caller: caller,
        expires_at: r.expires_at,
        engine_url: baseUrl,
        config: "~/.valorbrain/config.json",
        config_backup: backupPath,
        notice: r.message,
      }));
      return;
    }
    console.log("✓ Agent account created — credentials saved to ~/.valorbrain/config.json (0600)");
    console.log(`  tenant:     ${r.tenant_id}`);
    console.log(`  REST key:   ${fingerprint(r.api_key)}  (vb_agent_, for ${baseUrl})`);
    if (mcpToken) {
      console.log(`  MCP token:  ${fingerprint(mcpToken)}  (vbm_, for ${mcpUrl ?? "the MCP endpoint"}; shown once by the server, kept in the config)`);
    } else {
      console.log("  MCP token:  not issued by this engine — create one in the app or set VALORBRAIN_MCP_TOKEN");
    }
    console.log(`  expires:    ${r.expires_at} (claim with init --email to make permanent)`);
    if (backupPath) console.log(`  backup:     previous config kept at ${backupPath}`);
    console.log("  full values: ~/.valorbrain/config.json, or re-run with --json");
    console.log();
    console.log(r.message);
    return;
  }

  if (email) {
    if (!cfg) {
      fail(json, "No config found. Run `valorbrain init --agent` first — claim binds an email to the account your key already owns.");
    }
    if (cfg.claimed) {
      if (json) console.log(JSON.stringify({ ok: true, already_claimed: true, email: cfg.claimed_email }));
      else console.log(`✓ Already claimed as ${cfg.claimed_email}`);
      return;
    }

    const key = cfg.api_key;
    const claim = await api.agentClaim(baseUrl, key, email);

    let otp;
    if (json) {
      otp = flags["--otp"];
      if (!otp) fail(json, "OTP required with --json (pass --otp, or omit --json to be prompted)");
    } else {
      const where = claim.emailed ? "check your inbox" : "ask your operator to read the OTP from the server journal";
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      otp = (await rl.question(`OTP sent to ${email} (${where}): `)).trim();
      rl.close();
    }

    const verified = await api.agentClaimVerify(baseUrl, key, email, otp);
    saveConfig({ ...cfg, claimed: true, claimed_email: email, claimed_at: new Date().toISOString() });

    if (json) {
      console.log(JSON.stringify({ ok: true, claimed: true, email, tenant_id: verified.tenant_id ?? cfg.tenant_id, key_unchanged: true }));
    } else {
      console.log(`✓ Claimed ${email} — the API key is unchanged (${fingerprint(key)})`);
    }
    return;
  }

  fail(json, "Usage: valorbrain init --agent [--agent-caller <platform>] [--force] | valorbrain init --email <address>");
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const eq = args[i].indexOf("=");
      if (eq > -1) out[args[i].slice(0, eq)] = args[i].slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) out[args[i]] = args[++i];
      else out[args[i]] = true;
    }
  }
  return out;
}

function fail(json, msg, extra = {}) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: msg, ...extra }));
    process.exit(1);
  }
  console.error(`error: ${msg}`);
  process.exit(1);
}
