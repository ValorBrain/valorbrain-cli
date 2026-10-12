// connect 0.9 — --mcp-only, unknown flags warned (never an error), and the
// saved --checkpoint switch (Gemini CLI strips env from hooks). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkpointEnabled, readCreds, runHook, setPrivacy, writeCreds } from '../hook.mjs';
import { SIGNED_ENV, signedManifestHeaders } from './signed-stub.mjs';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { parseArgs, planFor, isPerTurn } = await import('../index.mjs');

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-09-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// ── stub engine: the claude-code manifest (MCP + rules + hooks), signed ─────

const HOOK = 'npx -y @valorbrain/connect@0.9.0 hook';
const block = (v) => `<!-- valorbrain:begin -->\n<!-- valorbrain-contract: v${v} harness: claude-code -->\nUse memory v${v}.\n<!-- valorbrain:end -->\n`;
const hookEntry = (name) => [{ matcher: '', hooks: [{ type: 'command', command: `${HOOK} ${name} --harness=claude-code`, timeout: 10 }] }];
const claude = (v) => ({
    name: 'Claude Code', harness: 'claude-code', contract_version: String(v), hooks_available: true, hook_protocol: 2,
    notes: ['Hooks (protocol v2) read the token from ~/.valorbrain/connect.json (0600).'],
    artifacts: [
        { kind: 'mcp', path: '~/.claude.json', label: 'MCP server entry (hosted)', strategy: 'write', best_effort: false,
            contents: JSON.stringify({ mcpServers: { valorbrain: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer vbm_<YOUR_TOKEN>' } } } }, null, 2) + '\n' },
        { kind: 'rules', path: '~/.claude/CLAUDE.md', label: 'agent instructions (managed block)', strategy: 'merge', best_effort: false, contents: block(v) },
        { kind: 'hooks', path: '~/.claude/settings.json', label: 'lifecycle hooks', strategy: 'write', best_effort: false,
            contents: JSON.stringify({ hooks: { SessionStart: hookEntry('session-start'), UserPromptSubmit: hookEntry('prompt'), Stop: hookEntry('stop') } }, null, 2) + '\n' },
    ],
});

function stubEngine() {
    const state = { version: 7, cues: 0 };
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        req.resume();
        req.on('end', () => {
            if (u.pathname === '/setup/artifacts') {
                const body = JSON.stringify(claude(state.version));
                res.writeHead(200, { 'content-type': 'application/json', ...signedManifestHeaders(body) });
                return res.end(body);
            }
            if (u.pathname === '/api/v1/hooks/cue') state.cues++;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(u.pathname === '/api/v1/hooks/cue' ? { context: '' } : { ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function cli(h, url, args, { stdin = '', env = {} } = {}) {
    const fullEnv = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_API_URL: url, VALORBRAIN_HEAL_INTERVAL_MS: '1', ...SIGNED_ENV, ...env };
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [CLI, ...args], { env: fullEnv, timeout: 30_000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
        });
        child.stdin.end(stdin);
    });
}

const install = (h, url, extra = []) => cli(h, url, ['--token', 'vbm_test', '--harness', 'claude-code', ...extra]);
const settings = (h) => join(h, '.claude', 'settings.json');
const ourHooks = (h) => (existsSync(settings(h)) ? readFileSync(settings(h), 'utf-8').includes('@valorbrain/connect') : false);
const savedEntry = (h) => JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8')).harnesses['claude-code'];

// ── unknown flags ───────────────────────────────────────────────────────────

test('parseArgs collects unknown flags and keeps every known form and alias', () => {
    const a = parseArgs(['--harness=codex', 'kiro', '--no-browser', '--token', 'vbm_x', '-h', '--mcp-only', '--yes', '--checkpoint=off', '-q']);
    assert.deepEqual(a.harnesses, ['codex', 'kiro']);
    assert.equal(a.noBrowser, true);
    assert.equal(a.token, 'vbm_x');
    assert.equal(a.help, true);
    assert.equal(a.mcpOnly, true);
    assert.equal(a.privacy.checkpoint, false);
    assert.deepEqual(a.unknown, ['--yes', '-q']);
    // A flag's value is never mistaken for an unknown flag.
    assert.deepEqual(parseArgs(['--api', 'https://x', '--scope', 'user', '--kiro-engine', 'legacy', '--prompt', 'off']).unknown, []);
});

test('an unknown flag is named on stderr and the install still runs in full', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    const r = await install(h, url, ['--bogus', '--also-bogus']);
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: ignoring unknown flag\(s\): --bogus --also-bogus/);
    assert.equal(ourHooks(h), true);
    assert.match(readFileSync(join(h, '.claude', 'CLAUDE.md'), 'utf-8'), /contract: v7/);
});

// ── --mcp-only ──────────────────────────────────────────────────────────────

test('--mcp-only writes MCP + instructions, no hooks; --status reports it; a plain run upgrades; --mcp-only again downgrades', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    // Someone else's hook in the shared settings.json must survive every step.
    mkdirSync(join(h, '.claude'), { recursive: true });
    const theirs = { type: 'command', command: 'echo theirs' };
    writeFileSync(settings(h), JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [theirs] }] } }, null, 2));

    const only = await install(h, url, ['--mcp-only']);
    assert.equal(only.code, 0, only.stderr);
    assert.doesNotMatch(only.stderr, /unknown flag/);
    assert.match(readFileSync(join(h, '.claude.json'), 'utf-8'), /Bearer vbm_test/);
    assert.match(readFileSync(join(h, '.claude', 'CLAUDE.md'), 'utf-8'), /contract: v7/);
    assert.equal(ourHooks(h), false);
    assert.deepEqual(JSON.parse(readFileSync(settings(h), 'utf-8')).hooks.Stop[0].hooks, [theirs]);
    assert.equal(savedEntry(h).mode, 'mcp-only');
    assert.equal(readCreds(h, 'claude-code').mode, 'mcp-only');
    assert.match(only.stdout, /--mcp-only — no hooks, so nothing is sent on each turn/);
    assert.doesNotMatch(only.stdout, /note: Hooks \(protocol v2\)/);

    const st = await cli(h, url, ['--status', '--harness', 'claude-code']);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /mode: mcp-only — MCP tools \+ instructions, no hooks/);
    assert.match(st.stdout, /hooks none — installed with --mcp-only/);

    const full = await install(h, url);
    assert.equal(full.code, 0, full.stderr);
    assert.equal(ourHooks(h), true);
    assert.equal(savedEntry(h).mode, undefined);
    assert.match((await cli(h, url, ['--status', '--harness', 'claude-code'])).stdout, /mode: hooks\n/);

    const down = await install(h, url, ['--mcp-only']);
    server.close();
    assert.equal(down.code, 0, down.stderr);
    assert.equal(ourHooks(h), false);
    const after = JSON.parse(readFileSync(settings(h), 'utf-8'));
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.hooks.Stop[0].hooks, [theirs]);
    assert.equal(savedEntry(h).mode, 'mcp-only');
});

test('--mcp-only on a fresh home never creates settings.json; --dry-run writes nothing', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    const dry = await install(h, url, ['--mcp-only', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /write credentials, mcp-only/);
    assert.equal(existsSync(join(h, '.claude.json')), false);
    assert.equal(existsSync(join(h, '.valorbrain', 'connect.json')), false);
    const r = await install(h, url, ['--mcp-only']);
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(settings(h)), false);
});

test('self-heal of an --mcp-only install updates the instructions and never brings the hooks back', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url, ['--mcp-only'])).code, 0);
    state.version = 8;
    // A hook run by hand (the person kept an old hook somewhere): the saved
    // connect.json token is used, the heal runs with contract drift.
    await cli(h, url, ['hook', 'session-start', '--harness=claude-code'], {
        stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: h }),
    });
    server.close();
    assert.match(readFileSync(join(h, '.claude', 'CLAUDE.md'), 'utf-8'), /contract: v8/);
    assert.equal(ourHooks(h), false);
});

test('--mcp-only on Gemini (MCP and hooks share settings.json): the hooks step is a no-op, the MCP entry stays', () => {
    const h = home();
    const manifest = {
        artifacts: [
            { kind: 'mcp', path: '~/.gemini/settings.json', strategy: 'write', contents: JSON.stringify({ mcpServers: { valorbrain: { httpUrl: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer vbm_<YOUR_TOKEN>' } } } }) },
            { kind: 'hooks', path: '~/.gemini/settings.json', strategy: 'write', contents: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${HOOK} session-start --harness=gemini-cli` }] }] } }) },
        ],
    };
    const [mcp, hooks] = planFor(manifest, 'vbm_g', h, isPerTurn);
    assert.equal(mcp.changed, true);
    assert.match(mcp.after, /Bearer vbm_g/);
    assert.equal(hooks.changed, false);
    assert.equal(hooks.after, mcp.after);
});

// ── --checkpoint ────────────────────────────────────────────────────────────

test('checkpoint switch: env > connect.json > on, per harness; re-install keeps it', () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_a', harness: 'gemini-cli' });
    assert.equal(checkpointEnabled(h, 'gemini-cli'), true);
    setPrivacy(h, 'gemini-cli', { checkpoint: false });
    writeCreds(h, { api: 'https://api.example', token: 'vbm_b', harness: 'gemini-cli' });
    assert.equal(checkpointEnabled(h, 'gemini-cli'), false);
    assert.equal(checkpointEnabled(h, 'gemini'), false); // alias reads the same entry
    assert.equal(checkpointEnabled(h, 'claude-code'), true);
    assert.equal(checkpointEnabled(h, 'gemini-cli', { VALORBRAIN_CHECKPOINT: 'on' }), true);
    assert.equal(checkpointEnabled(h, 'claude-code', { VALORBRAIN_CHECKPOINT: 'off' }), false);
    assert.equal(checkpointEnabled(h, 'claude-code', { VALORBRAIN_CHECKPOINT: '0' }), false);
});

test('checkpoint off in connect.json: the Stop hook makes no call and stays silent', async () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_a', harness: 'gemini-cli' });
    setPrivacy(h, 'gemini-cli', { checkpoint: false });
    const calls = [];
    const out = [];
    const code = await runHook(['stop', '--harness=gemini-cli'], {
        env: {}, home: h,
        payload: { hook_event_name: 'AfterAgent', session_id: 'g1', cwd: h },
        fetchImpl: async (u) => { calls.push(String(u)); return Response.json({}); },
        out: (s) => out.push(s), err: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(out, ['{}']);
});

test('--checkpoint off|on records the choice and exits; a bad value is refused', async () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_a', harness: 'gemini-cli' });
    const off = await cli(h, 'http://127.0.0.1:9', ['--harness', 'gemini-cli', '--checkpoint', 'off']);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /gemini-cli: checkpoint off/);
    assert.equal(savedEntry(h) ?? null, null); // claude-code untouched
    const saved = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8')).harnesses['gemini-cli'];
    assert.equal(saved.checkpoint, false);
    assert.equal(saved.token, 'vbm_a');
    assert.equal((await cli(h, 'http://127.0.0.1:9', ['--harness', 'gemini-cli', '--checkpoint=on'])).code, 0);
    assert.equal(checkpointEnabled(h, 'gemini-cli'), true);
    const bad = await cli(h, 'http://127.0.0.1:9', ['--harness', 'gemini-cli', '--checkpoint', 'maybe']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--checkpoint must be "on" or "off"/);
});
