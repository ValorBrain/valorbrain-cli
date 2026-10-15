/**
 * Contract test: `init --agent` against the signup response the engine returns
 * (src/agent-signup.ts, createShadowTenant) — both credentials must be saved,
 * a second signup must not silently replace them, and the output must carry
 * the next step of the connect contract. `init --email` against the claim
 * response (src/server.ts handleAgentClaim).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { otpWhere } from "../lib/cmd-init.js";

const BIN = fileURLToPath(new URL("../bin/valorbrain.js", import.meta.url));
const API_KEY = "vb_agent_" + "a".repeat(32);
const MCP_TOKEN = "vbm_" + "b".repeat(65);

// Shape returned by POST /api/v1/agents/signup since 2026-10-02.
const SIGNUP = {
  tenant_id: "11111111-2222-4333-8444-555555555555",
  api_key: API_KEY,
  mcp_token: MCP_TOKEN,
  mcp_url: "https://mcpbrain.example.test/mcp",
  default_user_id: "agent-default",
  agent_caller: "claude-code",
  expires_at: "2099-01-01T00:00:00.000Z",
  message: "Surface to your human: claim with `valorbrain init --email <addr>`.",
};

async function fakeEngine(signupBody, { claim = { ok: true, emailed: true, expires_in_minutes: 15 }, verify = { ok: true, tenant_id: signupBody.tenant_id } } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null });
      const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/v1/agents/signup") return send(201, signupBody);
      if (req.method === "POST" && req.url === "/api/v1/agents/claim") return send(200, claim);
      if (req.method === "POST" && req.url === "/api/v1/agents/claim/verify") return send(200, verify);
      send(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

function freshHome(config) {
  const home = mkdtempSync(join(tmpdir(), "vb-cli-init-"));
  if (config) {
    mkdirSync(join(home, ".valorbrain"), { recursive: true });
    writeFileSync(join(home, ".valorbrain", "config.json"), JSON.stringify(config));
  }
  return home;
}

/** A directory holding fake executables, standing in for client binaries on PATH. */
function fakeBin(...names) {
  const dir = mkdtempSync(join(tmpdir(), "vb-cli-bin-"));
  for (const n of names) {
    writeFileSync(join(dir, n), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, n), 0o755);
  }
  return dir;
}

// Async on purpose: the fake engine lives in this process, and a blocking
// spawnSync would stop it from ever answering.
function run(args, { home, url, path = fakeBin(), stdin = null }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: path,
        VALORBRAIN_API_URL: url,
        VALORBRAIN_TOKEN: "",
        VALORBRAIN_MCP_TOKEN: "",
      },
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (stdin !== null) child.stdin.end(stdin);
  });
}

function readConfig(home) {
  return JSON.parse(readFileSync(join(home, ".valorbrain", "config.json"), "utf8"));
}

test("init --agent saves both credentials and reports them with --json", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    const r = await run(["init", "--agent", "--agent-caller", "claude-code", "--json"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.api_key, API_KEY);
    assert.equal(out.mcp_token, MCP_TOKEN);
    assert.equal(out.mcp_url, SIGNUP.mcp_url);
    assert.equal(out.notice, SIGNUP.message);

    const cfg = readConfig(home);
    assert.equal(cfg.api_key, API_KEY);
    assert.equal(cfg.mcp_token, MCP_TOKEN);
    assert.equal(cfg.mcp_url, SIGNUP.mcp_url);
    assert.equal(cfg.tenant_id, SIGNUP.tenant_id);
    assert.equal(cfg.agent_caller, "claude-code");
    if (process.platform !== "win32") {
      const mode = statSync(join(home, ".valorbrain", "config.json")).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    assert.equal(engine.calls.length, 1);
  } finally {
    await engine.close();
  }
});

test("init --agent --json lists the connect commands with the token, detected clients first", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    const r = await run(["init", "--agent", "--json"], { home, url: engine.url, path: fakeBin("codex") });
    assert.equal(r.status, 0, r.stderr);
    const { next_steps: next } = JSON.parse(r.stdout.trim());
    assert.equal(next.connect[0].client, "codex");
    assert.equal(next.connect[0].detected, true);
    // The fake engine is not the public default: connect must be told where the account lives.
    assert.equal(next.connect[0].command, `npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --api ${engine.url} --harness codex`);
    assert.equal(next.connect[0].harness, "codex");
    assert.match(next.connect[0].consent, /prompt of each turn/);
    assert.match(next.connect[0].consent, /--harness codex --prompt off` and `--checkpoint off`.*VALORBRAIN_SEND_PROMPT=off.*only the hooks, re-run the install with --mcp-only; --remove undoes everything/);
    assert.equal(next.connect[0].mcp_only, `npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --api ${engine.url} --harness codex --mcp-only`);
    assert.match(next.connect[0].consent, /what-leaves-your-machine/);
    assert.ok(next.connect[0].mcp_manual.includes(`VALORBRAIN_MCP_TOKEN=${MCP_TOKEN}`));
    assert.ok(next.connect[0].mcp_manual.includes(`--url ${SIGNUP.mcp_url}`));
    const gemini = next.connect.find((c) => c.client === "gemini");
    assert.equal(gemini.harness, "gemini-cli");
    // Gemini CLI passes the env to its hooks except on a GitHub runner (its strict allowlist).
    assert.match(gemini.consent, /--prompt off` and `--checkpoint off` \(or VALORBRAIN_SEND_PROMPT=off \/ VALORBRAIN_CHECKPOINT=off, except on a GitHub runner, where Gemini CLI does not pass them to its hooks; the saved choices always work\)/);
    assert.ok(!next.connect[0].consent.includes("GitHub runner"), "the runner caveat is Gemini's alone");
    const claude = next.connect.find((c) => c.client === "claude-code");
    assert.equal(claude.detected, false);
    assert.equal(claude.mcp_manual,
      `claude mcp add --transport http --scope user valorbrain ${SIGNUP.mcp_url} --header "Authorization: Bearer ${MCP_TOKEN}"`);
    assert.equal(next.stdio, "npx -y @valorbrain/cli mcp");
    assert.equal(next.doc, "https://valorbrain.com.br/connect.md");
    assert.match(next.verify, /memory_prepare/);
    assert.match(next.claim, /init --email/);
  } finally {
    await engine.close();
  }
});

test("init --agent --url passes that engine to connect as --api", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    const r = await run(["--url", `${engine.url}/`, "init", "--agent", "--json"], { home, url: "", path: fakeBin("claude") });
    assert.equal(r.status, 0, r.stderr);
    const claude = JSON.parse(r.stdout.trim()).next_steps.connect.find((c) => c.client === "claude-code");
    assert.equal(claude.command, `npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --api ${engine.url} --harness claude-code`);
    assert.equal(claude.mcp_only, `npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --api ${engine.url} --harness claude-code --mcp-only`);
  } finally {
    await engine.close();
  }
});

test("on the public engine the connect command carries no --api", async () => {
  const { connectCommands } = await import("../lib/next-steps.js");
  const [claude] = connectCommands(MCP_TOKEN, SIGNUP.mcp_url, { PATH: "" });
  assert.equal(claude.command, `npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --harness claude-code`);
  assert.ok(!claude.mcp_only.includes("--api"));
});

test("init --agent prints both credentials labeled and the detected client's command", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    const r = await run(["init", "--agent", "--agent-caller", "claude-code"], { home, url: engine.url, path: fakeBin("claude") });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`REST key:\\s+${API_KEY}`));
    assert.match(r.stdout, /vb_agent_, REST only/);
    assert.match(r.stdout, new RegExp(`MCP token:\\s+${MCP_TOKEN}`));
    assert.match(r.stdout, /vbm_, MCP only/);
    assert.match(r.stdout, /claude-code \(found on PATH\)/);
    const install = r.stdout.indexOf(`npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --api ${engine.url} --harness claude-code`);
    assert.ok(install > 0, "the connect command is printed");
    assert.ok(install < r.stdout.indexOf("claude mcp add"), "connect comes before the MCP-only command");
    assert.ok(r.stdout.includes(`No hooks (MCP + rules): npx -y @valorbrain/connect@latest --token ${MCP_TOKEN} --api ${engine.url} --harness claude-code --mcp-only`));
    assert.match(r.stdout, /Tell your human first: the hooks send the prompt of each turn/);
    assert.ok(r.stdout.includes(`--header "Authorization: Bearer ${MCP_TOKEN}"`));
    assert.ok(!r.stdout.includes("codex mcp add"), "only detected clients are listed when one is found");
    assert.match(r.stdout, /memory_prepare/);
    assert.ok(r.stdout.includes(SIGNUP.message));
  } finally {
    await engine.close();
  }
});

test("init --agent without a known client on PATH lists every client", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    const r = await run(["init", "--agent"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("claude mcp add"));
    assert.ok(r.stdout.includes("codex mcp add"));
    assert.ok(r.stdout.includes(".gemini/settings.json"));
    assert.ok(r.stdout.includes("https://valorbrain.com.br/connect.md"));
  } finally {
    await engine.close();
  }
});

test("a second init --agent is refused without --force and keeps the config", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    assert.equal((await run(["init", "--agent", "--json"], { home, url: engine.url })).status, 0);
    const second = await run(["init", "--agent", "--json"], { home, url: engine.url });
    assert.equal(second.status, 2, "config_exists is a usage error (exit 2)");
    assert.equal(JSON.parse(second.stdout.trim()).code, "config_exists");
    const out = JSON.parse(second.stdout.trim());
    assert.equal(out.ok, false);
    assert.equal(out.existing_tenant_id, SIGNUP.tenant_id);
    assert.match(out.error, /--force/);
    assert.equal(engine.calls.length, 1, "no second signup request must be sent");
    assert.equal(readConfig(home).mcp_token, MCP_TOKEN);
  } finally {
    await engine.close();
  }
});

test("init --agent --force replaces the config and writes a backup", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    assert.equal((await run(["init", "--agent", "--json"], { home, url: engine.url })).status, 0);
    const r = await run(["init", "--agent", "--force", "--json"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.config_backup, "backup path reported");
    const files = readdirSync(join(home, ".valorbrain"));
    assert.ok(files.some((f) => f.startsWith("config.json.bak.")), `backup present in ${files}`);
    assert.equal(engine.calls.length, 2);
  } finally {
    await engine.close();
  }
});

test("an engine that does not issue an MCP token leaves mcp_token null", async () => {
  const { mcp_token: _t, mcp_url: _u, ...older } = SIGNUP;
  const engine = await fakeEngine(older);
  const home = freshHome();
  try {
    const r = await run(["init", "--agent", "--json"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.mcp_token, null);
    assert.deepEqual(out.next_steps.connect, []);
    assert.equal(readConfig(home).mcp_token, null);
  } finally {
    await engine.close();
  }
});

const SAVED = { tenant_id: SIGNUP.tenant_id, api_key: API_KEY, mcp_token: MCP_TOKEN, claimed: false };

test("init --email --json requests the OTP and says how to finish, without failing", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome(SAVED);
  try {
    const r = await run(["init", "--email", "a@example.com", "--json"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.otp_requested, true);
    assert.equal(out.emailed, true);
    assert.match(out.message, /check your inbox/);
    assert.match(out.next, /--otp <code>/);
    assert.deepEqual(engine.calls.map((c) => c.url), ["/api/v1/agents/claim"]);
  } finally {
    await engine.close();
  }
});

test("init --email --otp verifies without asking the server to mail a new code", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome(SAVED);
  try {
    const r = await run(["init", "--email", "a@example.com", "--otp", "123456", "--json"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).claimed, true);
    assert.deepEqual(engine.calls.map((c) => c.url), ["/api/v1/agents/claim/verify"]);
    assert.deepEqual(engine.calls[0].body, { email: "a@example.com", otp: "123456" });
    assert.equal(readConfig(home).claimed, true);
    assert.equal(readConfig(home).mcp_token, MCP_TOKEN, "claim keeps the MCP token");
  } finally {
    await engine.close();
  }
});

test("init --email prints the login_url the engine returns (PRD R9) and keeps it in --json", async () => {
  const loginUrl = "https://valorbrain.valor.digital/claim/abc.def";
  const engine = await fakeEngine(SIGNUP, { verify: { ok: true, tenant_id: SIGNUP.tenant_id, login_url: loginUrl } });
  try {
    const text = await run(["init", "--email", "a@example.com", "--otp", "123456"], { home: freshHome(SAVED), url: engine.url });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`Open ${loginUrl} to create your app login`), text.stdout);
    const json = await run(["init", "--email", "a@example.com", "--otp", "123456", "--json"], { home: freshHome(SAVED), url: engine.url });
    assert.equal(JSON.parse(json.stdout.trim()).login_url, loginUrl);
  } finally {
    await engine.close();
  }
});

test("init --email without a login_url (self-hosted engine) prints no link", async () => {
  const engine = await fakeEngine(SIGNUP);
  try {
    const r = await run(["init", "--email", "a@example.com", "--otp", "123456"], { home: freshHome(SAVED), url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /login/);
  } finally {
    await engine.close();
  }
});

test("a failed OTP email on the hosted service never says 'ask your operator'", () => {
  const hosted = otpWhere({ emailed: false }, "https://valorbrain-api.valor.digital", "a@example.com");
  assert.ok(!/operator|journal/i.test(hosted), hosted);
  assert.match(hosted, /init --email a@example.com/);
  assert.match(otpWhere({ emailed: true }, "https://valorbrain-api.valor.digital", "a@example.com"), /check your inbox/);
  assert.match(otpWhere({ emailed: false }, "http://127.0.0.1:3000", "a@example.com"), /self-hosted/);
});
