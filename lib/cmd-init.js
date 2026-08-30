/**
 * `init` — signup and claim flows.
 *
 * `init --agent` creates a shadow tenant and issues a vb_agent_ key with no
 * email, no dashboard, no card. `init --email <addr>` later binds the SAME
 * tenant to an address via OTP — the key never changes.
 *
 * The signup response carries a `message` written as an instruction TO the
 * agent ("Surface to your human: …"). We print it verbatim: the conversion
 * channel is the agent itself, not a UI neither the agent nor the human is
 * looking at.
 */
import readline from "node:readline/promises";
import { api } from "./api.js";
import { loadConfig, saveConfig, resolveBaseUrl } from "./config.js";
import { detectPlatform } from "./detect.js";

function keyFingerprint(key) {
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

export async function cmdInit(args, { json }) {
  const cfg = loadConfig();
  const baseUrl = resolveBaseUrl({ cfg });

  const flags = parseFlags(args);
  const wantsAgent = args.includes("--agent");
  const email = flags["--email"];

  if (wantsAgent) {
    // Identity is self-declared, never inferred (see lib/detect.js).
    let caller = flags["--agent-caller"];
    const detected = detectPlatform();
    if (!caller && detected && !json) {
      console.error(`tip: this shell looks like ${detected.id} (env ${detected.env}) — pass --agent-caller ${detected.id} to record it`);
    }
    caller = caller || "unspecified";

    const name = flags["--name"] || `${caller}-${Date.now().toString(36)}`;
    const r = await api.agentSignup(baseUrl, { agent_name: name, agent_caller: caller });

    saveConfig({
      tenant_id: r.tenant_id,
      api_key: r.api_key,
      default_user_id: r.default_user_id,
      agent_caller: caller,
      expires_at: r.expires_at,
      claimed: false,
      engine_url: baseUrl,
    });

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        tenant_id: r.tenant_id,
        api_key: r.api_key,
        agent_caller: caller,
        expires_at: r.expires_at,
        engine_url: baseUrl,
        config: "~/.valorbrain/config.json",
        notice: r.message,
      }));
      return;
    }
    console.log("✓ Agent account created — key saved to ~/.valorbrain/config.json (0600)");
    console.log(`  tenant:    ${r.tenant_id}`);
    console.log(`  api key:   ${r.api_key}`);
    console.log(`  expires:   ${r.expires_at} (claim with init --email to make permanent)`);
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
      console.log(`✓ Claimed ${email} — the API key is unchanged (${keyFingerprint(key)})`);
    }
    return;
  }

  fail(json, "Usage: valorbrain init --agent [--agent-caller <platform>] | valorbrain init --email <address>");
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

function fail(json, msg) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: msg }));
    process.exit(1);
  }
  console.error(`error: ${msg}`);
  process.exit(1);
}
