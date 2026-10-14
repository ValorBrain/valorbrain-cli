// connect 0.12.1 — repair of the hosted MCP auth shape connect <= 0.12.0 wrote
// into `[mcp_servers.valorbrain]` for codex (~/.codex/config.toml) and grok
// (~/.grok/config.toml): `url` + `bearer_token`. codex-cli 0.160.0 refuses the
// whole config.toml at startup ("bearer_token is not supported for
// streamable_http"; also "env is not supported for streamable_http" with a
// leftover env subtable); grok 1.0.46 never reads the key (handshake "Auth
// required"). They read `http_headers` / `headers` with the same Bearer token.
// The repair runs on explicit install (after the merge), on the heal the
// launcher runs, and --status grades the old shape drift. Fixtures are the
// shapes found on real installs, with synthetic tokens. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_VERSION } from '../hook.mjs';
import { SIGNED_ENV, signedManifestHeaders } from './signed-stub.mjs';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { repairTomlMcp, repairInstalledTomlMcp, planFor, launcherPath } = await import('../index.mjs');

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PKG, 'index.mjs');
const MCP = 'https://mcpbrain.valor.digital/mcp';
const TOKEN = 'vbm_synthetic_0123456789abcdef';
const PH = '<VALORBRAIN_HOOK_LAUNCHER>';
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-mcprepair-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// ── fixtures: the shapes of real installs ───────────────────────────────────

const TOOLS = ['assert_authority_correction', 'feedback_submit', 'memory_prepare', 'memory_retrieve', 'memory_store', 'memory_used'];
const toolsTables = TOOLS.map((t) => `[mcp_servers.valorbrain.tools.${t}]\napproval_mode = "approve"\n`).join('\n');

const CODEX_HEAD = [
    'model = "gpt-5.5"',
    'model_reasoning_effort = "high"',
    '',
    '[projects."/www/valorbrain-platform"]',
    'trust_level = "trusted"',
    '',
].join('\n');
const CODEX_OTHER = '[mcp_servers.chorus]\ncommand = "node"\nargs = [ "/usr/local/lib/chorus.mjs", "mcp",]\nbearer_token = "not-ours"\n';
const CODEX_BROKEN = `${CODEX_HEAD}\n[mcp_servers.valorbrain]\nurl = "${MCP}"\nbearer_token = "${TOKEN}"\n\n${toolsTables}\n${CODEX_OTHER}`;
const CODEX_FIXED = `${CODEX_HEAD}\n[mcp_servers.valorbrain]\nurl = "${MCP}"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\n\n${toolsTables}\n${CODEX_OTHER}`;

const GROK_HEAD = '[model]\ndefault = "grok-composer-2.5-fast"\n\n';
const GROK_OTHER = '[mcp_servers.chorus]\ncommand = "node"\nargs = [ "/usr/local/lib/chorus.mjs", "mcp",]\n';
const GROK_ENV = '[mcp_servers.valorbrain.env]\nPOSTGRES_URL = "postgres://vb:pw@127.0.0.1:6432/valorbrain"\nPOSTGRES_PASSWORD = "synthetic-pw"\nVALORBRAIN_DECLARED_CONTRACT_VERSION = "8"\n';
const GROK_BROKEN = `${GROK_HEAD}[mcp_servers.valorbrain]\nurl = "${MCP}"\nbearer_token = "${TOKEN}"\n\n${GROK_ENV}\n${GROK_OTHER}`;
const GROK_FIXED = `${GROK_HEAD}[mcp_servers.valorbrain]\nurl = "${MCP}"\nheaders = { "Authorization" = "Bearer ${TOKEN}" }\n\n${GROK_OTHER}`;

const SELF_HOSTED = `[mcp_servers.valorbrain]\ncommand = "/opt/valorbrain/bin/valorbrain"\nargs = ["mcp"]\n\n${GROK_ENV}`;

// ── unit: repairTomlMcp ─────────────────────────────────────────────────────

test('codex: bearer_token -> http_headers, same token; every tools.* approval, other servers and the rest of the file kept', () => {
    const out = repairTomlMcp(CODEX_BROKEN, 'codex');
    assert.equal(out, CODEX_FIXED);
    assert.equal(repairTomlMcp(out, 'codex'), out, 'idempotent');
});

test('grok: bearer_token -> headers, same token; the stale env subtable (POSTGRES_*) dropped; neighbours kept', () => {
    const out = repairTomlMcp(GROK_BROKEN, 'grok');
    assert.equal(out, GROK_FIXED);
    assert.equal(repairTomlMcp(out, 'grok'), out, 'idempotent');
});

test('codex: a hosted table already on http_headers only loses a leftover env subtable', () => {
    assert.equal(repairTomlMcp(CODEX_FIXED, 'codex'), CODEX_FIXED);
    const withEnv = CODEX_FIXED.replace('\n\n[mcp_servers.valorbrain.tools', `\n\n${GROK_ENV}\n[mcp_servers.valorbrain.tools`);
    assert.equal(repairTomlMcp(withEnv, 'codex'), CODEX_FIXED);
});

test('both keys present (a half hand-fix): bearer_token goes, the header line stays — never a duplicate key', () => {
    const raw = `[mcp_servers.valorbrain]\nurl = "${MCP}"\nbearer_token = "${TOKEN}"\nheaders = { "Authorization" = "Bearer ${TOKEN}" }\n`;
    assert.equal(repairTomlMcp(raw, 'grok'), `[mcp_servers.valorbrain]\nurl = "${MCP}"\nheaders = { "Authorization" = "Bearer ${TOKEN}" }\n`);
});

test('a self-hosted table (command/args) is never touched — its env is the credential store', () => {
    assert.equal(repairTomlMcp(SELF_HOSTED, 'grok'), SELF_HOSTED);
    assert.equal(repairTomlMcp(SELF_HOSTED, 'codex'), SELF_HOSTED);
});

test('another server carrying bearer_token is not ours; other harnesses and spellings are left alone', () => {
    const raw = `[mcp_servers.other]\nurl = "https://x.example/mcp"\nbearer_token = "${TOKEN}"\n`;
    assert.equal(repairTomlMcp(raw, 'codex'), raw);
    for (const harness of ['claude-code', 'hermes', '', undefined]) assert.equal(repairTomlMcp(GROK_BROKEN, harness), GROK_BROKEN);
    const quoted = `[mcp_servers."valorbrain"]\nurl = "${MCP}"\nbearer_token = "${TOKEN}"\n`;
    assert.equal(repairTomlMcp(quoted, 'grok'), quoted);
});

test('an unquoted bearer_token value is left alone — never guess a credential', () => {
    const raw = `[mcp_servers.valorbrain]\nurl = "${MCP}"\nbearer_token = ${TOKEN}\n`;
    assert.equal(repairTomlMcp(raw, 'grok'), raw);
});

// ── planFor: install path ───────────────────────────────────────────────────

const mcpArtifact = (path, contents) => ({ kind: 'mcp', path, label: 'MCP server entry (TOML, hosted)', strategy: 'write', best_effort: true, contents });
const OLD_RENDER = `[mcp_servers.valorbrain]\nurl = "${MCP}"\nbearer_token = "vbm_<YOUR_TOKEN>"\n`;
const NEW_RENDER = (key) => `[mcp_servers.valorbrain]\nurl = "${MCP}"\n${key} = { "Authorization" = "Bearer vbm_<YOUR_TOKEN>" }\n`;
const put = (h, rel, body) => { mkdirSync(dirname(join(h, rel)), { recursive: true }); writeFileSync(join(h, rel), body); };
const get = (h, rel) => readFileSync(join(h, rel), 'utf-8');

test('install, codex: an OLD engine render (bearer_token) over the broken file lands as http_headers; approvals kept', () => {
    const h = home();
    put(h, '.codex/config.toml', CODEX_BROKEN);
    const [c] = planFor({ harness: 'codex', artifacts: [mcpArtifact('~/.codex/config.toml', OLD_RENDER)] }, TOKEN, h, false);
    assert.equal(c.after, CODEX_FIXED);
});

test('install, grok: the NEW render over the broken file drops the env subtable; a second plan is a no-op', () => {
    const h = home();
    put(h, '.grok/config.toml', GROK_BROKEN);
    const manifest = { harness: 'grok', artifacts: [mcpArtifact('~/.grok/config.toml', NEW_RENDER('headers'))] };
    const [c] = planFor(manifest, TOKEN, h, false);
    assert.equal(c.after, GROK_FIXED);
    put(h, '.grok/config.toml', c.after);
    assert.equal(planFor(manifest, TOKEN, h, false)[0].changed, false);
});

test('mergeToml: a hosted table written over a self-hosted one takes the env subtable with it (codex refuses env on streamable_http)', () => {
    const h = home();
    put(h, '.codex/config.toml', `${SELF_HOSTED}\n${toolsTables}`);
    const [c] = planFor({ harness: 'codex', artifacts: [mcpArtifact('~/.codex/config.toml', NEW_RENDER('http_headers'))] }, TOKEN, h, false);
    assert.equal(c.after, `[mcp_servers.valorbrain]\nurl = "${MCP}"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\n\n${toolsTables}`);
});

test('remove strips the table and its env subtable, never repairs into it', () => {
    const h = home();
    put(h, '.grok/config.toml', GROK_BROKEN);
    const [c] = planFor({ harness: 'grok', artifacts: [mcpArtifact('~/.grok/config.toml', NEW_RENDER('headers'))] }, TOKEN, h, true);
    assert.doesNotMatch(c.after, /valorbrain/);
    assert.match(c.after, /\[mcp_servers\.chorus\]/);
});

// ── repairInstalledTomlMcp: the heal's file write ───────────────────────────

test('heal repair: both files fixed in place, file mode kept, backup written, idempotent', () => {
    const h = home();
    put(h, '.codex/config.toml', CODEX_BROKEN);
    put(h, '.grok/config.toml', GROK_BROKEN);
    chmodSync(join(h, '.codex/config.toml'), 0o600);
    chmodSync(join(h, '.grok/config.toml'), 0o640);
    const done = repairInstalledTomlMcp(h);
    assert.equal(done.length, 2);
    assert.equal(get(h, '.codex/config.toml'), CODEX_FIXED);
    assert.equal(get(h, '.grok/config.toml'), GROK_FIXED);
    assert.equal(statSync(join(h, '.codex/config.toml')).mode & 0o777, 0o600);
    assert.equal(statSync(join(h, '.grok/config.toml')).mode & 0o777, 0o640);
    assert.equal(get(h, '.codex/config.toml.valorbrain-bak'), CODEX_BROKEN);
    assert.deepEqual(repairInstalledTomlMcp(h), [], 'second run: nothing to do');
    assert.equal(get(h, '.codex/config.toml'), CODEX_FIXED);
});

test('heal repair: a symlinked config stays a symlink; self-hosted and correct files are not rewritten', () => {
    const h = home();
    put(h, 'dotfiles/codex.toml', CODEX_BROKEN);
    mkdirSync(join(h, '.codex'), { recursive: true });
    symlinkSync(join(h, 'dotfiles/codex.toml'), join(h, '.codex/config.toml'));
    put(h, '.grok/config.toml', SELF_HOSTED);
    const mtime = statSync(join(h, '.grok/config.toml')).mtimeMs;
    repairInstalledTomlMcp(h);
    assert.ok(lstatSync(join(h, '.codex/config.toml')).isSymbolicLink());
    assert.equal(get(h, 'dotfiles/codex.toml'), CODEX_FIXED);
    assert.equal(get(h, '.grok/config.toml'), SELF_HOSTED);
    assert.equal(statSync(join(h, '.grok/config.toml')).mtimeMs, mtime);
    assert.equal(existsSync(join(h, '.grok/config.toml.valorbrain-bak')), false);
});

// ── end to end: install, launcher heal and --status against a stub engine ───

function manifestFor(harness, { launcher = false } = {}) {
    const files = {
        grok: ['~/.grok/config.toml', '~/.grok/AGENTS.md', NEW_RENDER('headers')],
        codex: ['~/.codex/config.toml', '~/.codex/AGENTS.md', OLD_RENDER],
        'claude-code': [null, '~/.claude/CLAUDE.md', null],
    }[harness];
    const hooks = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${PH}" hook prompt --harness=${harness}`, timeout: 10 }] }] } };
    return JSON.stringify({
        name: harness, harness, contract_version: '8', mcp_url: MCP, token_placeholder: 'vbm_<YOUR_TOKEN>', hooks_available: launcher, notes: [], hook_protocol: 2,
        artifacts: [
            ...(files[0] ? [mcpArtifact(files[0], files[2])] : []),
            { kind: 'rules', path: files[1], label: 'agent instructions (managed block)', strategy: 'merge', best_effort: false, contents: `<!-- valorbrain:begin -->\n<!-- valorbrain-contract: v8 harness: ${harness} -->\nUse memory.\n<!-- valorbrain:end -->\n` },
            ...(launcher && harness === 'claude-code' ? [{ kind: 'hooks', path: '~/.claude/settings.json', label: 'lifecycle hooks', strategy: 'merge', best_effort: false, contents: JSON.stringify(hooks) }] : []),
        ],
        ...(launcher ? { hook_client: 'launcher', hook_client_version: CLIENT_VERSION, hook_client_integrity: 'sha512-AAAA', hook_client_tarball: 'http://127.0.0.1:9/none.tgz', hook_client_placeholder: PH, data_scope: 1 } : {}),
    });
}

function stubEngine() {
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        req.resume();
        req.on('end', () => {
            if (u.pathname === '/setup/artifacts') {
                const body = manifestFor(u.searchParams.get('agent'), { launcher: u.searchParams.get('client') === 'launcher' });
                res.writeHead(200, { 'content-type': 'application/json', ...signedManifestHeaders(body) });
                return res.end(body);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    // unref: a failed assertion before server.close() must not hang the run.
    server.unref();
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(cmdPath, args, h, url) {
    const env = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_API_URL: url, ...SIGNED_ENV };
    return new Promise((resolve) => {
        const child = execFile(cmdPath, args, { env, timeout: 60_000, cwd: h }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
        });
        child.stdin.end('');
    });
}
const cli = (h, url, args) => run(process.execPath, [CLI, ...args], h, url);

test('explicit install --harness codex against an engine that still renders bearer_token: codex gets http_headers, approvals kept', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.codex/config.toml', CODEX_BROKEN);
    chmodSync(join(h, '.codex/config.toml'), 0o600);
    const r = await cli(h, url, ['--token', TOKEN, '--harness', 'codex', '--mcp-only']);
    server.close();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(get(h, '.codex/config.toml'), CODEX_FIXED);
    assert.equal(statSync(join(h, '.codex/config.toml')).mode & 0o777, 0o600);
});

test('launcher heal (any harness) repairs the codex and grok files it finds; a second heal changes nothing', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    const inst = await cli(h, url, ['--token', TOKEN, '--harness', 'claude-code']);
    assert.equal(inst.code, 0, inst.stderr + inst.stdout);
    assert.ok(existsSync(launcherPath(h)), 'the launcher is installed');
    // The shapes connect <= 0.12.0 left behind; codex cannot even start, so
    // its own hooks never fire — another harness's heal must repair it.
    put(h, '.codex/config.toml', CODEX_BROKEN);
    put(h, '.grok/config.toml', GROK_BROKEN);
    const healed = await run(process.execPath, [launcherPath(h), 'heal', '--harness=claude-code'], h, url);
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(get(h, '.codex/config.toml'), CODEX_FIXED);
    assert.equal(get(h, '.grok/config.toml'), GROK_FIXED);
    assert.match(get(h, '.valorbrain/connect.log'), /repaired the hosted MCP auth \(http_headers, same token\)/);
    const again = await run(process.execPath, [launcherPath(h), 'heal', '--harness=claude-code'], h, url);
    server.close();
    assert.equal(again.code, 0, again.stderr);
    assert.equal(get(h, '.codex/config.toml'), CODEX_FIXED);
    assert.equal(get(h, '.grok/config.toml'), GROK_FIXED);
});

test('--status: the old shape is drift with the fix; the repaired one is registered', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.grok/config.toml', GROK_BROKEN);
    put(h, '.valorbrain/connect.json', JSON.stringify({ version: 2, harnesses: { grok: { api_url: url, token: TOKEN, updated_at: new Date().toISOString(), install_id: 'a'.repeat(32), consented_scope: 1 } } }));
    const before = await cli(h, url, ['--status', '--harness', 'grok']);
    put(h, '.grok/config.toml', GROK_FIXED);
    const after = await cli(h, url, ['--status', '--harness', 'grok']);
    server.close();
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /◐ mcp\s+hosted auth in the old shape/);
    assert.match(before.stdout, /npx -y @valorbrain\/connect --harness grok/);
    assert.match(after.stdout, /● mcp\s+registered/);
});
