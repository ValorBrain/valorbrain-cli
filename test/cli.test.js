/**
 * CLI 0.2.0 contract (PRD M1/M4/M6): strict flags, JSON errors with exit
 * codes, --key memory identity and revisions, --supersedes, --sensitivity,
 * --limit, forget, global --api-key/--key/--url in any position, env contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv, COMMANDS, GLOBAL_FLAGS } from "../lib/args.js";
import { keyPath } from "../lib/cmd-memory.js";

const BIN = fileURLToPath(new URL("../bin/valorbrain.js", import.meta.url));
const KEY = "vb_agent_" + "k".repeat(32);
const OTHER_KEY = "vb_agent_" + "o".repeat(32);
const VBM = "vbm_" + "m".repeat(65);

/** Fake engine: records every request; /documents tracks revisions per path. */
async function fakeEngine() {
  const calls = [];
  const docs = new Map();
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status, b) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${KEY}` && req.headers.authorization !== `Bearer ${OTHER_KEY}`) {
        return send(401, { error: "invalid_token" });
      }
      if (req.method === "POST" && req.url === "/documents") {
        const id = `${body.collection}/${body.path}`;
        const prev = docs.get(id);
        const action = !prev ? "created" : prev.content === body.content ? "unchanged" : "updated";
        const revision_count = !prev ? 1 : action === "updated" ? prev.revision_count + 1 : prev.revision_count;
        docs.set(id, { content: body.content, revision_count });
        const out = { docid: "a1b2c3", collection: body.collection, path: body.path, title: body.title, action, revision_count, embed_state: "pending", sensitivity: body.sensitivity ?? "internal" };
        if (body.supersedes) out.supersedes = [].concat(body.supersedes).map((s) => ({ docid: "d4e5f6", path: s }));
        return send(action === "created" ? 201 : 200, out);
      }
      if (req.method === "POST" && req.url === "/search") {
        return send(200, { results: Array.from({ length: 8 }, (_, i) => ({ docid: `00000${i}`, title: `hit ${i}`, collection: "memories" })) });
      }
      const forget = req.url.match(/^\/documents\/([^/]+)\/forget$/);
      if (req.method === "POST" && forget) {
        if (forget[1] !== "a1b2c3") return send(404, { error: `Document not found: ${forget[1]}` });
        return send(200, { docid: forget[1], forgotten: true });
      }
      if (req.method === "GET" && req.url === "/collections") return send(200, { collections: [] });
      send(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

function home(config = { tenant_id: "t", api_key: KEY, mcp_token: VBM }) {
  const h = mkdtempSync(join(tmpdir(), "vb-cli-"));
  if (config) {
    mkdirSync(join(h, ".valorbrain"), { recursive: true });
    writeFileSync(join(h, ".valorbrain", "config.json"), JSON.stringify(config));
  }
  return h;
}

function run(args, { h = home(), env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env, HOME: h, USERPROFILE: h,
        VALORBRAIN_TOKEN: "", VALORBRAIN_MCP_TOKEN: "", VALORBRAIN_API_KEY: "", VALORBRAIN_API_TOKEN: "",
        VALORBRAIN_API_URL: "", VALORBRAIN_URL: "", VALORBRAIN_MCP_URL: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr, json: tryJson(stdout) }));
  });
}
const tryJson = (s) => { try { return JSON.parse(s.trim()); } catch { return null; } };

// ── parser ───────────────────────────────────────────────────────────────────

test("an unknown flag is an error and its value never becomes text", () => {
  assert.throws(() => parseArgv(["add", "real", "text", "--colection", "work"]),
    (e) => e.code === "unknown_flag" && e.exit === 2 && e.extra.flag === "--colection");
});

test("global flags work before and after the command", () => {
  const a = parseArgv(["--key", KEY, "--url", "https://x.test", "search", "q"]);
  assert.deepEqual([a.command, a.globals["--key"], a.globals["--url"], a.positionals], ["search", KEY, "https://x.test", ["q"]]);
  const b = parseArgv(["search", "q", "--api-key=" + KEY, "--json"]);
  assert.equal(b.globals["--api-key"], KEY);
  assert.equal(b.globals["--json"], true);
});

test("after `add`, --key is the memory key; before it, the credential", () => {
  const a = parseArgv(["--key", KEY, "add", "t", "--key", "deploy key"]);
  assert.equal(a.globals["--key"], KEY);
  assert.equal(a.flags["--key"], "deploy key");
});

test("--agent is only valid on init", () => {
  assert.equal(parseArgv(["init", "--agent"]).globals["--agent"], true);
  assert.throws(() => parseArgv(["search", "q", "--agent"]), (e) => e.code === "unknown_flag" && /--json/.test(e.message));
});

test("values are validated: enum, integer range, missing value, duplicates, extra arguments", () => {
  assert.throws(() => parseArgv(["add", "t", "--type", "memo"]), (e) => e.code === "invalid_value" && e.extra.allowed.includes("decision"));
  assert.equal(parseArgv(["add", "t", "--type", "Decision"]).flags["--type"], "decision");
  assert.throws(() => parseArgv(["search", "q", "--limit", "0"]), (e) => e.code === "invalid_value");
  assert.throws(() => parseArgv(["search", "q", "--limit", "ten"]), (e) => e.code === "invalid_value");
  assert.equal(parseArgv(["search", "q", "--limit", "5"]).flags["--limit"], 5);
  assert.throws(() => parseArgv(["add", "t", "--title"]), (e) => e.code === "missing_value");
  assert.throws(() => parseArgv(["add", "t", "--title", "--json"]), (e) => e.code === "missing_value");
  assert.throws(() => parseArgv(["add", "t", "--title", "a", "--title", "b"]), (e) => e.code === "duplicate_flag");
  assert.throws(() => parseArgv(["list", "extra"]), (e) => e.code === "unexpected_argument");
  assert.throws(() => parseArgv(["frobnicate"]), (e) => e.code === "unknown_command");
  assert.deepEqual(parseArgv(["add", "t", "--supersedes", "a1b2c3", "--supersedes", "notes/x"]).flags["--supersedes"], ["a1b2c3", "notes/x"]);
  assert.deepEqual(parseArgv(["add", "--", "--not-a-flag", "text"]).positionals, ["--not-a-flag", "text"]);
});

test("keyPath builds a stable ASCII slug", () => {
  assert.equal(keyPath("Deploy key / Produção"), "cli/key/deploy-key-producao");
  assert.equal(keyPath("deploy-key"), "cli/key/deploy-key");
  assert.throws(() => keyPath("!!!"), (e) => e.code === "invalid_value");
});

// ── help --json matches the parser ──────────────────────────────────────────

test("help --json is generated from the specs the parser enforces", async () => {
  const r = await run(["help", "--json"]);
  assert.equal(r.status, 0);
  const help = r.json;
  assert.deepEqual(help.commands.map((c) => c.name), Object.keys(COMMANDS));
  for (const c of help.commands) assert.deepEqual(c.flags.map((f) => f.flag), Object.keys(COMMANDS[c.name].flags));
  assert.deepEqual(help.global_flags.map((f) => f.flag), Object.keys(GLOBAL_FLAGS));
  assert.deepEqual(help.exit_codes, { 0: "ok", 1: "server or network failure", 2: "usage error", 3: "credential missing, wrong type, or rejected" });
});

// ── JSON errors and exit codes ──────────────────────────────────────────────

test("with --json every error is one JSON object on stdout with its exit code", async () => {
  const unknown = await run(["add", "text", "--colection", "work", "--json"]);
  assert.equal(unknown.status, 2);
  assert.deepEqual([unknown.json.ok, unknown.json.code, unknown.json.exit_code], [false, "unknown_flag", 2]);
  assert.equal(unknown.stderr, "");

  const noKey = await run(["search", "q", "--json"], { h: home(null) });
  assert.equal(noKey.status, 3);
  assert.equal(noKey.json.code, "no_credential");

  const badCmd = await run(["--json", "frobnicate"]);
  assert.equal(badCmd.status, 2);
  assert.equal(badCmd.json.code, "unknown_command");

  const missingFile = await run(["add", "--file", "/nonexistent/x.md", "--json"]);
  assert.equal(missingFile.status, 2);
  assert.equal(missingFile.json.code, "file_not_found");
});

test("server failures keep their status: 401 exits 3, 404 exits 1", async () => {
  const e = await fakeEngine();
  try {
    const denied = await run(["list", "--json", "--api-key", "vb_agent_wrong", "--url", e.url]);
    assert.equal(denied.status, 3);
    assert.deepEqual([denied.json.code, denied.json.status], ["unauthorized", 401]);
    const missing = await run(["forget", "ffffff", "--json", "--url", e.url]);
    assert.equal(missing.status, 1);
    assert.equal(missing.json.status, 404);
  } finally { await e.close(); }
});

test("without --json errors go to stderr and stdout stays empty", async () => {
  const r = await run(["add", "x", "--bogus"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^error: unknown flag --bogus/);
});

// ── add / search / forget against the fake engine ───────────────────────────

test("add --key: stable path, re-adding is a revision with action and revision_count", async () => {
  const e = await fakeEngine();
  try {
    const h = home();
    const first = await run(["add", "deploy key is in vault A", "--key", "Deploy key", "--json", "--url", e.url], { h });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual([first.json.path, first.json.action, first.json.revision_count, first.json.key], ["cli/key/deploy-key", "created", 1, "Deploy key"]);
    assert.equal(first.json.content_type, "note");

    const second = await run(["add", "deploy key moved to vault B", "--key", "Deploy key", "--url", e.url], { h });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /revised memories\/cli\/key\/deploy-key \(docid #a1b2c3, revision 2/);
    assert.equal(e.calls[1].body.path, "cli/key/deploy-key");
  } finally { await e.close(); }
});

test("add --key refuses a credential-looking value and points to --api-key", async () => {
  const r = await run(["add", "text", "--key", KEY, "--json"]);
  assert.equal(r.status, 2);
  assert.match(r.json.error, /--api-key/);
});

test("add sends --supersedes, --sensitivity and --type, and echoes them", async () => {
  const e = await fakeEngine();
  try {
    const r = await run(["add", "v2 of the rule", "--supersedes", "#d4e5f6", "--sensitivity", "private", "--type", "decision", "--json", "--url", e.url]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      [e.calls[0].body.supersedes, e.calls[0].body.sensitivity, e.calls[0].body.content_type],
      ["#d4e5f6", "private", "decision"]);
    assert.deepEqual([r.json.sensitivity, r.json.content_type], ["private", "decision"]);
    assert.deepEqual(r.json.supersedes, [{ docid: "d4e5f6", path: "#d4e5f6" }]);

    const two = await run(["add", "v3", "--supersedes", "a", "--supersedes", "b", "--json", "--url", e.url]);
    assert.deepEqual(e.calls[1].body.supersedes, ["a", "b"]);
    assert.equal(two.status, 0);
    assert.equal("sensitivity" in e.calls[1].body, false, "no --sensitivity leaves the server default");
  } finally { await e.close(); }
});

test("an unknown flag sends nothing to the server", async () => {
  const e = await fakeEngine();
  try {
    const r = await run(["add", "secret text", "--colection", "work", "--url", e.url]);
    assert.equal(r.status, 2);
    assert.equal(e.calls.length, 0);
  } finally { await e.close(); }
});

test("search --limit is sent and honored", async () => {
  const e = await fakeEngine();
  try {
    const r = await run(["search", "deploy", "--limit", "3", "--mode", "keyword", "--json", "--url", e.url]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([e.calls[0].body.limit, e.calls[0].body.mode], [3, "keyword"]);
    assert.equal(r.json.count, 3);
  } finally { await e.close(); }
});

test("forget takes a docid with or without #", async () => {
  const e = await fakeEngine();
  try {
    const r = await run(["forget", "#A1B2C3", "--json", "--url", e.url]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { ok: true, docid: "a1b2c3", forgotten: true });
    assert.equal(e.calls[0].url, "/documents/a1b2c3/forget");
    const bad = await run(["forget", "notes/x.md", "--json", "--url", e.url]);
    assert.equal(bad.status, 2);
    assert.equal(e.calls.length, 1);
  } finally { await e.close(); }
});

// ── credentials and URLs in any position, env contract ─────────────────────

test("--api-key / --key / --url are honored before the command", async () => {
  const e = await fakeEngine();
  try {
    const r = await run(["--key", OTHER_KEY, "--url", e.url, "list", "--json"], { h: home(null) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(e.calls[0].auth, `Bearer ${OTHER_KEY}`);
  } finally { await e.close(); }
});

test("VALORBRAIN_API_KEY and VALORBRAIN_API_URL work; legacy VALORBRAIN_TOKEN warns on stderr", async () => {
  const e = await fakeEngine();
  try {
    const modern = await run(["list", "--json"], { h: home(null), env: { VALORBRAIN_API_KEY: OTHER_KEY, VALORBRAIN_API_URL: e.url } });
    assert.equal(modern.status, 0, modern.stderr);
    assert.equal(modern.stderr, "");
    assert.equal(e.calls[0].auth, `Bearer ${OTHER_KEY}`);

    const legacy = await run(["list", "--json"], { h: home(null), env: { VALORBRAIN_TOKEN: OTHER_KEY, VALORBRAIN_API_URL: e.url } });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stderr, /VALORBRAIN_TOKEN is deprecated/);
    assert.equal(legacy.json.ok, true, "the warning never touches stdout");
  } finally { await e.close(); }
});

test("a vbm_ token is refused for REST with exit 3", async () => {
  const r = await run(["list", "--json"], { h: home(null), env: { VALORBRAIN_API_KEY: VBM } });
  assert.equal(r.status, 3);
  assert.equal(r.json.code, "wrong_credential_type");
});
