/**
 * `init` — signup and claim flows.
 *
 * `init --agent` creates a shadow tenant with no email, no dashboard, no card.
 * The engine answers with TWO credentials (owner decision 2026-10-02):
 *   - api_key   vb_agent_…  legacy account key: REST API (valorbrain-api) + claim
 *   - mcp_token vbm_…       the client credential: MCP endpoint (mcp_url), shown
 *                           once; the engine REST also accepts it, but this CLI
 *                           only sends it to MCP
 * Both are saved to ~/.valorbrain/config.json. `init --email <addr>` later
 * binds the SAME tenant to an address via OTP — neither credential changes.
 *
 * The signup response carries a `message` written as an instruction TO the
 * agent ("Surface to your human: …"). We print it verbatim: the conversion
 * channel is the agent itself, not a UI neither the agent nor the human is
 * looking at. The output also carries the next step of the connect contract
 * (https://valorbrain.com.br/connect.md): the client command with the token.
 */
import readline from "node:readline/promises";
import { api } from "./api.js";
import { loadConfig, saveConfig, resolveBaseUrl, configPath, requireApiKey, DEFAULT_MCP_URL } from "./config.js";
import { detectPlatform } from "./detect.js";
import { connectCommands, CONNECT_DOC, CLAIM_COMMAND, STDIO_COMMAND } from "./next-steps.js";
import { usage } from "./errors.js";

export async function cmdInit({ globals, flags }, { json }) {
  const cfg = loadConfig();
  const baseUrl = resolveBaseUrl({ urlFlag: globals["--url"], cfg });
  const wantsAgent = !!globals["--agent"];
  const email = flags["--email"];
  if (wantsAgent && email) throw usage("use `init --agent` to sign up, then `init --email` to claim — not both at once", "conflicting_flags");

  if (wantsAgent) {
    // A second signup would create a NEW tenant and drop the saved keys —
    // including a claimed account. Replacing the config is an explicit choice.
    if (cfg && !flags["--force"]) {
      const state = cfg.claimed ? `claimed as ${cfg.claimed_email}` : `unclaimed, expires ${cfg.expires_at ?? "?"}`;
      throw usage(
        `A config already exists for tenant ${cfg.tenant_id} (${state}) at ${configPath()}. ` +
        "Running `init --agent` again creates a NEW account and replaces the saved keys. " +
        "Keep using the existing account, or pass --force to replace it (a backup is written first).",
        "config_exists",
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

    const steps = mcpToken ? connectCommands(mcpToken, mcpUrl, process.env, baseUrl) : [];
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
        next_steps: {
          connect: steps.map(({ client, detected, command, harness, consent, mcp_only, mcp_manual }) => ({ client, detected, command, harness, consent, mcp_only, mcp_manual })),
          stdio: STDIO_COMMAND,
          verify: "call the memory_prepare tool",
          claim: CLAIM_COMMAND,
          doc: CONNECT_DOC,
        },
      }));
      return;
    }
    console.log("✓ Agent account created — credentials saved to ~/.valorbrain/config.json (0600)");
    console.log(`  tenant:     ${r.tenant_id}`);
    console.log(`  REST key:   ${r.api_key}`);
    console.log(`              (vb_agent_, REST only, for ${baseUrl})`);
    if (mcpToken) {
      console.log(`  MCP token:  ${mcpToken}`);
      console.log(`              (vbm_, MCP only, for ${mcpUrl ?? DEFAULT_MCP_URL}; the server shows it once, it is kept in the config)`);
    } else {
      console.log("  MCP token:  not issued by this engine — create one in the app or set VALORBRAIN_MCP_TOKEN");
    }
    console.log(`  expires:    ${r.expires_at} (claim with init --email to make permanent)`);
    if (backupPath) console.log(`  backup:     previous config kept at ${backupPath}`);
    console.log();
    if (steps.length) {
      const found = steps.filter((s) => s.detected);
      console.log("Next: connect your client — CLIs with hooks: one command for MCP + rules + hooks; then restart the session.");
      for (const s of found.length ? found : steps) {
        console.log(`  ${s.client}${s.detected ? " (found on PATH)" : ""}:`);
        console.log(`    ${s.command}`);
        if (s.consent) {
          console.log(`    ${s.consent}`);
          console.log(`    No hooks (MCP + rules): ${s.mcp_only}`);
          console.log(`    or by hand: ${s.mcp_manual}`);
        }
      }
      console.log(`  any stdio client: ${STDIO_COMMAND}   (uses the saved token)`);
      console.log(`  other clients: ${CONNECT_DOC}`);
      console.log("Then verify: call the memory_prepare tool.");
      console.log();
    }
    console.log(r.message);
    return;
  }

  if (email) {
    if (cfg?.claimed) {
      if (json) console.log(JSON.stringify({ ok: true, already_claimed: true, email: cfg.claimed_email }));
      else console.log(`✓ Already claimed as ${cfg.claimed_email}`);
      return;
    }
    // Claim binds an email to the account the REST key already owns.
    const key = requireApiKey({ keyFlag: globals["--api-key"] ?? globals["--key"], cfg });
    // With --otp the code was already sent by an earlier `init --email`:
    // verify it without asking the server to mail a new one.
    let otp = flags["--otp"]?.trim() || null;
    if (!otp) {
      const claim = await api.agentClaim(baseUrl, key, email);
      const where = otpWhere(claim, baseUrl, email);
      if (json) {
        console.log(JSON.stringify({
          ok: true,
          otp_requested: true,
          emailed: claim.emailed === true,
          email,
          expires_in_minutes: claim.expires_in_minutes ?? null,
          message: where,
          next: `valorbrain init --email ${email} --otp <code> --json`,
        }));
        return;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      otp = (await rl.question(`${where}\nOTP: `)).trim();
      rl.close();
    }

    const verified = await api.agentClaimVerify(baseUrl, key, email, otp);
    if (cfg) saveConfig({ ...cfg, claimed: true, claimed_email: email, claimed_at: new Date().toISOString() });

    // The engine returns where the human creates the app login (or adds this
    // workspace to the account the e-mail already has); null on an engine
    // without the SaaS. New MCP tokens then come from the app.
    const loginUrl = typeof verified.login_url === "string" && verified.login_url ? verified.login_url : null;
    if (json) {
      console.log(JSON.stringify({ ok: true, claimed: true, email, tenant_id: verified.tenant_id ?? cfg.tenant_id, key_unchanged: true, login_url: loginUrl }));
    } else {
      console.log(`✓ Claimed ${email} — the REST key and the MCP token are unchanged`);
      if (loginUrl) {
        console.log(`  Open ${loginUrl} to create your app login (or add this workspace to your account).`);
        console.log("  There you see the memories and create new MCP tokens (Settings → MCP Tokens).");
      }
    }
    return;
  }

  throw usage("usage: valorbrain init --agent [--agent-caller <platform>] [--force] | valorbrain init --email <address> [--otp <code>]", "missing_argument");
}

/**
 * Where the OTP went. The hosted service mails it; when that mail fails the
 * customer has no operator to ask, so the advice is to request it again. Only
 * a self-hosted engine keeps the fallback code in its own journal.
 */
export function otpWhere(claim, baseUrl, email) {
  if (claim.emailed === true) return `OTP sent to ${email} — check your inbox (and spam).`;
  if (isHosted(baseUrl)) {
    return `The OTP email to ${email} could not be sent right now. Wait a minute and run \`valorbrain init --email ${email}\` again.`;
  }
  return `OTP requested for ${email}. This engine did not confirm an email; on a self-hosted engine the code is in the engine journal.`;
}

function isHosted(baseUrl) {
  try {
    return new URL(baseUrl).hostname.endsWith(".valor.digital");
  } catch {
    return false;
  }
}
