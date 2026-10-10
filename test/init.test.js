/**
 * Contract test: `init --agent` against the signup response the engine returns
 * (src/agent-signup.ts, createShadowTenant) — both credentials must be saved,
 * and a second signup must not silently replace them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

async function fakeEngine(signupBody) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === "POST" && req.url === "/api/v1/agents/signup") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(signupBody));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), "vb-cli-init-"));
}

// Async on purpose: the fake engine lives in this process, and a blocking
// spawnSync would stop it from ever answering.
function run(args, { home, url }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        VALORBRAIN_URL: url,
        VALORBRAIN_TOKEN: "",
        VALORBRAIN_MCP_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
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

test("init --agent prints fingerprints, never the full secrets", async () => {
  const engine = await fakeEngine(SIGNUP);
  const home = freshHome();
  try {
    const r = await run(["init", "--agent", "--agent-caller", "claude-code"], { home, url: engine.url });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(API_KEY), "full REST key must not be printed");
    assert.ok(!r.stdout.includes(MCP_TOKEN), "full MCP token must not be printed");
    assert.match(r.stdout, /REST key:\s+vb_agent_/);
    assert.match(r.stdout, /MCP token:\s+vbm_/);
    assert.ok(r.stdout.includes(SIGNUP.message));
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
    assert.equal(second.status, 1);
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
    assert.equal(readConfig(home).mcp_token, null);
  } finally {
    await engine.close();
  }
});
