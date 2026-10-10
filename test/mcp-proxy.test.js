/**
 * The stdio proxy must only ever send vbm_ tokens, and an HTTP failure must
 * reach the MCP client as a JSON-RPC error carrying the request id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/valorbrain.js", import.meta.url));
const VBM = "vbm_" + "c".repeat(65);
const AGENT = "vb_agent_" + "a".repeat(32);
const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

async function fakeMcp(status, body) {
  const calls = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      calls.push({ authorization: req.headers.authorization, body: data });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

function freshHome(config) {
  const home = mkdtempSync(join(tmpdir(), "vb-cli-mcp-"));
  if (config) {
    mkdirSync(join(home, ".valorbrain"), { recursive: true });
    writeFileSync(join(home, ".valorbrain", "config.json"), JSON.stringify(config));
  }
  return home;
}

/** Run the proxy, send one line, resolve when it exits (or after one stdout line). */
function proxy(args, { home, send }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "mcp", ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, VALORBRAIN_TOKEN: "", VALORBRAIN_MCP_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.includes("\n")) child.stdin.end();
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (send) child.stdin.write(send + "\n");
    setTimeout(() => child.kill(), 8000).unref();
  });
}

test("a REST key is refused locally, before any request", async () => {
  const mcp = await fakeMcp(200, { jsonrpc: "2.0", id: 1, result: {} });
  try {
    const r = await proxy(["--url", mcp.url, "--token", AGENT], { home: freshHome(), send: INIT });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only accepts vbm_ tokens/);
    assert.equal(mcp.calls.length, 0);
  } finally {
    await mcp.close();
  }
});

test("without any token the proxy explains where one comes from", async () => {
  const r = await proxy([], { home: freshHome(), send: INIT });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /VALORBRAIN_MCP_TOKEN/);
  assert.match(r.stderr, /init --agent/);
});

test("a 401 that is not JSON-RPC becomes a JSON-RPC error with the request id", async () => {
  const mcp = await fakeMcp(401, { error: "invalid_token", message: "Token not found, inactive, or expired" });
  try {
    const r = await proxy(["--url", mcp.url, "--token", VBM], { home: freshHome(), send: INIT });
    const line = r.stdout.trim().split("\n")[0];
    const reply = JSON.parse(line);
    assert.equal(reply.jsonrpc, "2.0");
    assert.equal(reply.id, 1);
    assert.equal(reply.error.code, -32001);
    assert.match(reply.error.message, /401/);
    assert.equal(reply.error.data.status, 401);
    assert.match(r.stderr, /401/);
  } finally {
    await mcp.close();
  }
});

test("a JSON-RPC answer is forwarded untouched, with the saved mcp_token as bearer", async () => {
  const result = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } };
  const mcp = await fakeMcp(200, result);
  const home = freshHome({ tenant_id: "t", api_key: AGENT, mcp_token: VBM, mcp_url: mcp.url });
  try {
    const r = await proxy([], { home, send: INIT });
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n")[0]), result);
    assert.equal(mcp.calls.length, 1);
    assert.equal(mcp.calls[0].authorization, `Bearer ${VBM}`);
    assert.equal(JSON.parse(mcp.calls[0].body).method, "initialize");
  } finally {
    await mcp.close();
  }
});

test("a config without mcp_token never falls back to the REST key", async () => {
  const mcp = await fakeMcp(200, { jsonrpc: "2.0", id: 1, result: {} });
  const home = freshHome({ tenant_id: "t", api_key: AGENT, mcp_url: mcp.url });
  try {
    const r = await proxy([], { home, send: INIT });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no MCP token/);
    assert.equal(mcp.calls.length, 0);
  } finally {
    await mcp.close();
  }
});

test("a piped batch waits for initialize, so later requests carry the session id", async () => {
  const calls = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const msg = JSON.parse(data);
      calls.push({ method: msg.method, session: req.headers["mcp-session-id"] ?? null });
      if (msg.method === "initialize") {
        // Answer late: a proxy that does not wait would already have sent tools/list.
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-1" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
        }, 200);
        return;
      }
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    const batch = [
      INIT,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n") + "\n";
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, "mcp", "--url", url, "--token", VBM], {
        env: { ...process.env, HOME: freshHome(), VALORBRAIN_TOKEN: "", VALORBRAIN_MCP_TOKEN: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(batch); // stdin closes right away: the proxy must still answer everything
      setTimeout(() => child.kill(), 8000).unref();
    });
    const replies = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(replies.map((x) => x.id), [1, 2], r.stderr);
    assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(calls[1].session, "sess-1");
    assert.equal(calls[2].session, "sess-1");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
