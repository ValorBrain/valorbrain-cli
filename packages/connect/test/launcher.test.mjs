// connect 0.11 — hooks that evolve on their own (contracts A, C, D). Run: npm test
//   Hooks run `node "~/.valorbrain/bin/connect/launcher.mjs" hook …`; the
//   launcher runs current.json's version; heal updates that version from the
//   signed manifest (tarball + sha512) without touching any harness file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { CLIENT_VERSION, clientHeaders, launcherPin, noticePin, readHealState, runHook, writeCreds, writeHealState } from '../hook.mjs';
import { SIGNED_ENV, signedManifestHeaders } from './signed-stub.mjs';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { downloadClientVersion, gcClientVersions, launcherPath, launcherWanted, planFor, readCurrent, untarPackage } = await import('../index.mjs');

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PKG, 'index.mjs');
const PH = '<VALORBRAIN_HOOK_LAUNCHER>';
const NEXT = '0.11.9';
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-011-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// ── a tarball of this package at another version (what npm would serve) ─────

function tarEntry(name, data) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tgz = (files) => gzipSync(Buffer.concat([...files.map(([n, d]) => tarEntry(n, Buffer.from(d))), Buffer.alloc(1024)]));
const integrityOf = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/** This package as version `v`: package.json and CLIENT_VERSION rewritten, so its requests say connect/<v>. */
function packageAt(v) {
    const files = ['package.json', 'manifest-signature.mjs', 'login.mjs', 'launcher.mjs', 'index.mjs', 'hook.mjs'].map((n) => {
        let text = readFileSync(join(PKG, n), 'utf-8');
        if (n === 'package.json') text = text.replace(/"version": "[^"]+"/, `"version": "${v}"`);
        if (n === 'hook.mjs') text = text.replace(/export const CLIENT_VERSION = '[^']+';/, `export const CLIENT_VERSION = '${v}';`);
        return [`package/${n}`, text];
    });
    return tgz(files);
}

// ── stub engine: signed client=launcher manifests ───────────────────────────

const cmd = (command) => ({ type: 'command', command, timeout: 10 });
const rules = (harness) => `<!-- valorbrain:begin -->\n<!-- valorbrain-contract: v7 harness: ${harness} -->\nUse memory.\n<!-- valorbrain:end -->\n`;
const LAUNCH = (ev, harness) => `node "${PH}" hook ${ev} --harness=${harness}`;
const NPX = (pin, ev, harness) => `npx --no-update-notifier --loglevel=warn -y @valorbrain/connect@${pin} hook ${ev} --harness=${harness}`;
const EVENTS = [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop']];
const FILES = { 'claude-code': ['~/.claude/CLAUDE.md', '~/.claude/settings.json'], codex: ['~/.codex/AGENTS.md', '~/.codex/hooks.json'] };

function manifest(harness, { launcher, pin, integrity, tarball, scope }) {
    const command = (ev) => (launcher ? LAUNCH(ev, harness) : NPX(pin, ev, harness));
    const hooks = { hooks: Object.fromEntries(EVENTS.map(([event, ev]) => [event, [{ hooks: [cmd(command(ev))] }]])) };
    const [rulesPath, hooksPath] = FILES[harness];
    return {
        name: harness, harness, contract_version: '7', hooks_available: true, notes: [], hook_protocol: 2,
        artifacts: [
            { kind: 'rules', path: rulesPath, label: 'agent instructions (managed block)', strategy: 'merge', best_effort: false, contents: rules(harness) },
            { kind: 'hooks', path: hooksPath, label: 'lifecycle hooks', strategy: 'write', best_effort: false, contents: JSON.stringify(hooks, null, 2) },
        ],
        ...(launcher ? { hook_client: 'launcher', hook_client_version: pin, hook_client_integrity: integrity, hook_client_tarball: tarball, hook_client_placeholder: PH, data_scope: scope } : {}),
    };
}

function stubEngine() {
    const state = { pin: CLIENT_VERSION, scope: 1, tarballs: {}, badIntegrity: false, clientPin: null, requests: [] };
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            state.requests.push({ path: u.pathname, search: u.search, headers: req.headers });
            const url = `http://127.0.0.1:${server.address().port}`;
            if (u.pathname === '/setup/artifacts') {
                const launcher = u.searchParams.get('client') === 'launcher';
                const tar = state.tarballs[state.pin];
                const m = manifest(u.searchParams.get('agent'), {
                    launcher, pin: state.pin, scope: state.scope,
                    integrity: state.badIntegrity ? integrityOf(Buffer.from('not it')) : tar ? integrityOf(tar) : 'sha512-AAAA',
                    tarball: `${url}/tarball/connect-${state.pin}.tgz`,
                });
                const text = JSON.stringify(m);
                res.writeHead(200, { 'content-type': 'application/json', ...signedManifestHeaders(text) });
                return res.end(text);
            }
            if (u.pathname.startsWith('/tarball/')) {
                const v = /connect-(.+)\.tgz$/.exec(u.pathname)[1];
                if (!state.tarballs[v]) { res.writeHead(404); return res.end(); }
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                return res.end(state.tarballs[v]);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            if (u.pathname === '/api/v1/hooks/cue') {
                return res.end(JSON.stringify({ context: '<vault-context>recall</vault-context>', ...(state.clientPin ? { client_pin: { version: state.clientPin, data_scope: 1 } } : {}) }));
            }
            res.end(JSON.stringify({ ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(cmdPath, args, { h, url, stdin = '', env = {} }) {
    const fullEnv = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_API_URL: url, ...SIGNED_ENV, ...env };
    const t0 = performance.now();
    return new Promise((resolve) => {
        const child = execFile(cmdPath, args, { env: fullEnv, timeout: 60_000, cwd: h }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr, ms: performance.now() - t0 });
        });
        child.stdin.end(stdin);
    });
}
const cli = (h, url, args, opts = {}) => run(process.execPath, [CLI, ...args], { h, url, ...opts });
const install = (h, url, harness = 'claude-code', extra = []) => cli(h, url, ['--token', 'vbm_test', '--harness', harness, ...extra]);
const launch = (h, url, args, opts = {}) => run(process.execPath, [launcherPath(h), ...args], { h, url, ...opts });
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const PAYLOAD = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'what did we decide?' });
async function waitFor(fn, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 50));
    }
    return fn();
}

// ── install ─────────────────────────────────────────────────────────────────

test('install: client=launcher, the stable command, current.json, a self-contained version dir', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    const r = await install(h, url);
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(state.requests.some((q) => q.path === '/setup/artifacts' && q.search.includes('client=launcher')));
    const settings = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf-8'));
    const prompt = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.equal(prompt, `node "${launcherPath(h)}" hook prompt --harness=claude-code`);
    assert.ok(!prompt.includes('||') && !prompt.includes(CLIENT_VERSION), 'no fallback chain and no version: parses in PowerShell 5.1 and never changes');
    assert.deepEqual({ ...readCurrent(h), installed_at: 'x' }, { version: CLIENT_VERSION, integrity: 'sha512-AAAA', data_scope: 1, installed_at: 'x' });
    const dir = join(h, '.valorbrain', 'bin', 'connect', CLIENT_VERSION);
    for (const f of ['hook.mjs', 'index.mjs', 'launcher.mjs', 'login.mjs', 'manifest-signature.mjs', 'package.json']) assert.ok(existsSync(join(dir, f)), f);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'hook.mjs')).mode & 0o022, 0);
    const creds = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8')).harnesses['claude-code'];
    assert.match(creds.install_id, /^[0-9a-f]{32}$/);
    assert.equal(creds.consented_scope, 1);
    assert.match(r.stdout, new RegExp(`hook launcher → ${CLIENT_VERSION.replace(/\./g, '\\.')}`));
});

test('the hook runs through the launcher with node alone (no node_modules in the version dir)', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() });
    const r = await launch(h, url, ['hook', 'prompt', '--harness=claude-code'], { stdin: PAYLOAD });
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /recall/);
    assert.equal(existsSync(join(h, '.valorbrain', 'bin', 'connect', CLIENT_VERSION, 'node_modules')), false);
});

test('Windows: the launcher is the default everywhere, and its command has no `||`', () => {
    assert.equal(launcherWanted({}), true);
    assert.equal(launcherWanted({ VALORBRAIN_HOOK_CLIENT: 'npx' }), false);
    const h = home();
    const [, hooks] = planFor(manifest('claude-code', { launcher: true, pin: CLIENT_VERSION, integrity: 'sha512-AAAA', tarball: 'https://x', scope: 1 }), 'vbm_x', h, false, h, { launcher: 'C:/Users/Ana/.valorbrain/bin/connect/launcher.mjs' });
    for (const c of JSON.stringify(JSON.parse(hooks.after)).match(/"command":"[^"]*(?:\\"[^"]*)*"/g)) assert.ok(!c.includes('||'), c);
    assert.ok(hooks.after.includes('node \\"C:/Users/Ana/.valorbrain/bin/connect/launcher.mjs\\" hook stop --harness=claude-code'));
    const [, refused] = planFor(manifest('claude-code', { launcher: true, pin: CLIENT_VERSION, scope: 1 }), 'vbm_x', h, false, h, {});
    assert.match(refused.error, /launcher is not installed/);
});

// ── the launcher's own rules ────────────────────────────────────────────────

test('launcher: missing or corrupt current.json, or a missing version — one stderr line, the empty answer, exit 0', async () => {
    const h = home();
    const root = join(h, '.valorbrain', 'bin', 'connect');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    writeFileSync(join(root, 'launcher.mjs'), readFileSync(join(PKG, 'launcher.mjs')), { mode: 0o644 });
    const cases = [
        ['missing', null, /no current\.json/],
        ['corrupt', '{not json', /no current\.json/],
        ['bad version', JSON.stringify({ version: 'latest' }), /no valid version/],
        ['absent dir', JSON.stringify({ version: '0.11.7' }), /0\.11\.7 is not installed/],
    ];
    for (const [what, content, why] of cases) {
        if (content === null) rmSync(join(root, 'current.json'), { force: true });
        else writeFileSync(join(root, 'current.json'), content);
        for (const [harness, empty] of [['claude-code', ''], ['gemini-cli', '{}'], ['cursor', '{}']]) {
            const r = await launch(h, 'http://127.0.0.1:9', ['hook', 'stop', `--harness=${harness}`], { stdin: '{}' });
            assert.equal(r.code, 0, what);
            assert.equal(r.stdout.trim(), empty, `${what} ${harness}`);
            assert.match(r.stderr, why, what);
            assert.equal(r.stderr.trim().split('\n').length, 1, `${what}: one line`);
        }
    }
});

test('launcher: refuses a version dir that is a symlink or writable by others', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    server.close();
    const dir = join(h, '.valorbrain', 'bin', 'connect', CLIENT_VERSION);
    chmodSync(dir, 0o777);
    let r = await launch(h, url, ['hook', 'prompt', '--harness=gemini-cli'], { stdin: PAYLOAD });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '{}');
    assert.match(r.stderr, /writable by others/);
    chmodSync(dir, 0o700);
    const real = join(h, 'elsewhere');
    rmSync(real, { recursive: true, force: true });
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(h, '.valorbrain', 'bin', 'connect', 'current.json'), JSON.stringify({ version: '0.11.8' }));
    symlinkSync(real, join(h, '.valorbrain', 'bin', 'connect', '0.11.8'));
    r = await launch(h, url, ['hook', 'prompt', '--harness=claude-code'], { stdin: PAYLOAD });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /is a symlink/);
});

// ── update channel ──────────────────────────────────────────────────────────

test('update A → B: tarball checked against the signed sha512, current.json switches, zero bytes change in harness files', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    const watched = [join(h, '.claude', 'settings.json'), join(h, '.claude', 'CLAUDE.md')];
    const before = watched.map(sha);
    state.tarballs[NEXT] = packageAt(NEXT);
    state.pin = NEXT;
    const healed = await launch(h, url, ['heal', '--harness=claude-code']);
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(readCurrent(h).version, NEXT);
    assert.equal(readCurrent(h).integrity, integrityOf(state.tarballs[NEXT]));
    assert.deepEqual(watched.map(sha), before, 'no harness config file changed');
    // The next hook runs B: its requests say so.
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() });
    const r = await launch(h, url, ['hook', 'prompt', '--harness=claude-code'], { stdin: PAYLOAD });
    server.close();
    assert.match(r.stdout, /recall/);
    assert.equal(state.requests.filter((q) => q.path === '/api/v1/hooks/cue').at(-1).headers['x-valorbrain-client'], `connect/${NEXT}`);
});

test('update refused: integrity mismatch, a pin below 0.11, a tag — nothing installed, current.json unchanged', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    state.tarballs[NEXT] = packageAt(NEXT);
    state.pin = NEXT;
    state.badIntegrity = true;
    await launch(h, url, ['heal', '--harness=claude-code']);
    assert.equal(readCurrent(h).version, CLIENT_VERSION);
    assert.equal(existsSync(join(h, '.valorbrain', 'bin', 'connect', NEXT)), false);
    assert.match(readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8'), /update to 0\.11\.9 not applied — tarball integrity mismatch/);
    server.close();
    for (const bad of ['0.10.1', 'latest', '^0.11.0', '0.11', '']) assert.equal(launcherPin(bad), null, bad);
    await assert.rejects(downloadClientVersion(h, { version: NEXT, tarball: `${url}/x.tgz`, integrity: 'sha1-abc' }), /no sha512 integrity/);
    await assert.rejects(downloadClientVersion(h, { version: NEXT, tarball: 'http://example.com/x.tgz', integrity: integrityOf(Buffer.from('x')) }), /not https/);
});

test('tar reader: `..`, absolute paths and links are never extracted', () => {
    assert.throws(() => untarPackage(tgz([['package/../evil.mjs', 'x']])), /refusing tar path/);
    assert.throws(() => untarPackage(tgz([['/etc/passwd', 'x']])), /refusing tar path/);
    const link = tarEntry('package/link', Buffer.alloc(0));
    link[156] = '2'.charCodeAt(0);
    assert.deepEqual(untarPackage(gzipSync(Buffer.concat([link, tarEntry('package/ok.mjs', Buffer.from('ok')), Buffer.alloc(1024)]))).map((f) => f.name), ['ok.mjs']);
});

test('scope guard: a manifest above the consented data_scope is held — logged once, reported in headers', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    const settings = sha(join(h, '.claude', 'settings.json'));
    state.tarballs[NEXT] = packageAt(NEXT);
    state.pin = NEXT;
    state.scope = 2;
    await launch(h, url, ['heal', '--harness=claude-code']);
    await launch(h, url, ['heal', '--harness=claude-code']);
    assert.equal(readCurrent(h).version, CLIENT_VERSION, 'held');
    assert.equal(existsSync(join(h, '.valorbrain', 'bin', 'connect', NEXT)), false);
    assert.equal(sha(join(h, '.claude', 'settings.json')), settings);
    const log = readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8');
    assert.equal(log.match(/update held/g).length, 1);
    assert.equal(readHealState(h).update_blocked['claude-code'].scope, 2);
    assert.equal(clientHeaders(h, 'claude-code')['x-valorbrain-client-state'], 'blocked-scope=2');
    // A person who runs the installer consents to the new scope: the update applies.
    assert.equal((await install(h, url)).code, 0);
    server.close();
    assert.equal(readCurrent(h).version, NEXT);
    assert.equal(readHealState(h).update_blocked?.['claude-code'], undefined);
});

test('pin hint: a cue naming another version heals at once, once per pin', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() });
    state.tarballs[NEXT] = packageAt(NEXT);
    state.pin = NEXT;
    state.clientPin = NEXT;
    const r = await launch(h, url, ['hook', 'prompt', '--harness=claude-code'], { stdin: PAYLOAD });
    assert.ok(r.ms < 1500, `the hook waited ${r.ms} ms`);
    assert.equal(await waitFor(() => readCurrent(h)?.version === NEXT), true, 'updated without waiting for the 6h throttle');
    server.close();
    // Unit: the same pin twice, or this version, spawns nothing.
    const g = home();
    writeCreds(g, { api: 'https://api.example', token: 'vbm_x', harness: 'claude-code' });
    const spawned = [];
    const deps = { env: { HOME: g }, home: g, self: '/v/hook.mjs', spawnImpl: (c, a) => { spawned.push([c, ...a]); return { on() {}, unref() {} }; } };
    assert.equal(noticePin({ version: '0.11.5' }, ['--harness=claude-code'], {}, deps), true);
    assert.equal(noticePin({ version: '0.11.5' }, ['--harness=claude-code'], {}, deps), false);
    assert.equal(noticePin({ version: CLIENT_VERSION }, ['--harness=claude-code'], {}, deps), false);
    assert.equal(noticePin({ version: 'latest' }, ['--harness=claude-code'], {}, deps), false);
    assert.deepEqual(spawned, [[process.execPath, '/v/index.mjs', 'heal', '--harness=claude-code']]);
});

// ── migration from 0.10.1 ───────────────────────────────────────────────────

/** A 0.10.1 install as it sits on disk: local-copy commands, no install ids. */
function fixture0101(h, url) {
    const v = '0.10.1';
    const local = (ev, harness) => `node "${h}/.valorbrain/bin/connect/${v}/hook.mjs" hook ${ev} --harness=${harness} || npx --prefer-offline --no-update-notifier --loglevel=warn -y @valorbrain/connect@${v} hook ${ev} --harness=${harness} || npx --no-update-notifier --loglevel=warn -y @valorbrain/connect@${v} hook ${ev} --harness=${harness}`;
    const files = {};
    for (const harness of ['claude-code', 'codex']) {
        const [rulesPath, hooksPath] = FILES[harness].map((p) => join(h, p.slice(2)));
        mkdirSync(dirname(hooksPath), { recursive: true });
        writeFileSync(rulesPath, rules(harness));
        writeFileSync(hooksPath, JSON.stringify({ hooks: Object.fromEntries(EVENTS.map(([event, ev]) => [event, [{ hooks: [cmd(local(ev, harness))] }]])) }, null, 2));
        files[harness] = hooksPath;
    }
    mkdirSync(join(h, '.valorbrain', 'bin', 'connect', v), { recursive: true, mode: 0o700 });
    writeFileSync(join(h, '.valorbrain', 'bin', 'connect', v, 'hook.mjs'), '// 0.10.1');
    writeFileSync(join(h, '.valorbrain', 'connect.json'), JSON.stringify({ version: 2, harnesses: {
        'claude-code': { api_url: url, token: 'vbm_a', updated_at: 'x', send_prompt: true },
        codex: { api_url: url, token: 'vbm_b', updated_at: 'x' },
    } }), { mode: 0o600 });
    return files;
}

test('migration from 0.10.1: the first heal moves Claude Code to the launcher once; Codex is left and reports needs-reinstall', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    const files = fixture0101(h, url);
    const codexBefore = sha(files.codex);
    // What a 0.10.1 local client's heal-dispatch runs: `npx @<pin> heal`, i.e. this package's index.mjs.
    assert.equal((await cli(h, url, ['heal', '--harness=claude-code'])).code, 0);
    const claude = readFileSync(files['claude-code'], 'utf-8');
    assert.ok(claude.includes(`node \\"${launcherPath(h)}\\" hook prompt --harness=claude-code`), claude);
    assert.ok(!claude.includes('0.10.1'));
    assert.equal(readCurrent(h).version, CLIENT_VERSION);
    const creds = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8')).harnesses;
    for (const id of ['claude-code', 'codex']) {
        assert.match(creds[id].install_id, /^[0-9a-f]{32}$/, id);
        assert.equal(creds[id].consented_scope, 1, id);
    }
    assert.notEqual(creds['claude-code'].install_id, creds.codex.install_id);
    assert.equal(creds['claude-code'].send_prompt, true, 'choices kept');

    await cli(h, url, ['heal', '--harness=codex']);
    assert.equal(sha(files.codex), codexBefore, 'Codex hook entries are never migrated by a heal');
    assert.equal(readHealState(h).needs_reinstall.codex, true);
    assert.equal(clientHeaders(h, 'codex')['x-valorbrain-client-state'], 'needs-reinstall');
    // The installer, a person present, migrates Codex.
    assert.equal((await install(h, url, 'codex')).code, 0);
    server.close();
    assert.ok(readFileSync(files.codex, 'utf-8').includes(launcherPath(h)));
    assert.equal(readHealState(h).needs_reinstall?.codex, undefined);
    // 0.10.1's dir is kept while a hook file still names it; the GC takes it once none does.
    assert.ok(existsSync(join(h, '.valorbrain', 'bin', 'connect', '0.10.1')));
    assert.ok(state.requests.length > 0);
});

// ── headers (contract D) ────────────────────────────────────────────────────

test('headers: cue, hooks/run (legacy hook and transcript uploader) and runtimes/register all say who they are', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    const install_id = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8')).harnesses['claude-code'].install_id;
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() });
    await launch(h, url, ['hook', 'prompt', '--harness=claude-code'], { stdin: PAYLOAD });
    await launch(h, url, ['hook', 'decision-extractor', '--harness=claude-code'], { stdin: '{}' });
    const transcript = join(h, 't.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    await launch(h, url, ['transcript-upload', '--harness=claude-code', '--session=s1', `--transcript=${transcript}`]);
    server.close();
    const seen = new Set();
    for (const q of state.requests.filter((r) => ['/api/v1/hooks/cue', '/api/v1/hooks/run', '/api/v1/runtimes/register'].includes(r.path))) {
        seen.add(q.path);
        assert.equal(q.headers['x-valorbrain-client'], `connect/${CLIENT_VERSION}`, q.path);
        assert.equal(q.headers['x-valorbrain-harness'], 'claude-code', q.path);
        assert.equal(q.headers['x-valorbrain-install'], install_id, q.path);
        assert.equal(q.headers['x-valorbrain-client-state'], undefined, q.path);
    }
    assert.deepEqual([...seen].sort(), ['/api/v1/hooks/cue', '/api/v1/hooks/run', '/api/v1/runtimes/register']);
});

test('install id: the omp bridge\'s own id is adopted, never a second one', () => {
    const h = home();
    mkdirSync(join(h, '.omp', 'agent'), { recursive: true });
    writeFileSync(join(h, '.omp', 'agent', 'valorbrain-bridge-state.json'), JSON.stringify({ install_id: 'a'.repeat(32) }));
    writeCreds(h, { api: 'https://api.example', token: 'vbm_x', harness: 'omp' });
    assert.equal(clientHeaders(h, 'omp')['x-valorbrain-install'], 'a'.repeat(32));
    const headers = clientHeaders(h, 'claude-code');
    assert.equal(headers['x-valorbrain-install'], undefined, 'no entry, no id');
    assert.equal(headers['x-valorbrain-client'], `connect/${CLIENT_VERSION}`);
});

test('runHook passes the cue\'s client_pin to onPinHint', async () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_x', harness: 'claude-code' });
    const pins = [];
    const seen = [];
    await runHook(['prompt', '--harness=claude-code'], {
        env: {}, home: h, payload: JSON.parse(PAYLOAD), out: () => {}, err: () => {},
        fetchImpl: async (u, init) => { seen.push(init.headers); return Response.json({ context: 'c', client_pin: { version: NEXT, data_scope: 1 } }); },
        onPinHint: (p) => pins.push(p),
    });
    assert.deepEqual(pins, [{ version: NEXT, data_scope: 1 }]);
    assert.equal(seen[0]['x-valorbrain-client'], `connect/${CLIENT_VERSION}`);
});

// ── status, GC, remove ──────────────────────────────────────────────────────

test('--status shows the launcher, the version it runs, the pin and a held update', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    let r = await cli(h, url, ['--status', '--harness', 'claude-code']);
    assert.match(r.stdout, new RegExp(`client: launcher → ${CLIENT_VERSION.replace(/\./g, '\\.')}`));
    assert.match(r.stdout, new RegExp(`launcher ~/\\.valorbrain/bin/connect/launcher\\.mjs → ${CLIENT_VERSION.replace(/\./g, '\\.')} \\(pin ${CLIENT_VERSION.replace(/\./g, '\\.')}\\)`));
    state.pin = NEXT;
    state.scope = 2;
    await launch(h, url, ['heal', '--harness=claude-code']);
    r = await cli(h, url, ['--status', '--harness', 'claude-code']);
    server.close();
    assert.match(r.stdout, /pin 0\.11\.9 — behind, the next heal updates it; update held: the engine's data_scope 2 is above what was consented \(1\)/);
});

test('GC: an old version goes 24 h after nothing runs it; current.json\'s and the launcher stay', () => {
    const h = home();
    const root = join(h, '.valorbrain', 'bin', 'connect');
    for (const v of ['0.11.0', '0.11.1', '0.11.2']) mkdirSync(join(root, v), { recursive: true });
    writeFileSync(join(root, 'launcher.mjs'), '');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '0.11.2' }));
    writeHealState(h, { hook_clients: { 'claude-code': { '/h/.claude/settings.json': ['launcher'] }, codex: { '/h/.codex/hooks.json': ['0.11.0'] } } });
    const t = Date.now();
    assert.deepEqual(gcClientVersions(h, { now: t }), []);
    assert.deepEqual(gcClientVersions(h, { now: t + 25 * 3600_000 }), ['0.11.1']);
    for (const f of ['0.11.0', '0.11.2', 'launcher.mjs', 'current.json']) assert.ok(existsSync(join(root, f)), f);
});

test('--remove: the launcher goes only when no harness runs it', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    assert.equal((await install(h, url, 'codex')).code, 0);
    assert.equal((await cli(h, url, ['--remove', '--harness', 'claude-code'])).code, 0);
    assert.ok(existsSync(launcherPath(h)), 'codex still runs it');
    const r = await cli(h, url, ['--remove', '--harness', 'codex']);
    server.close();
    assert.match(r.stdout, /delete the hook launcher/);
    assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false);
});

test('the launcher and the hook path import only node built-ins (and their siblings)', () => {
    for (const name of ['launcher.mjs', 'hook.mjs', 'manifest-signature.mjs']) {
        const src = readFileSync(join(PKG, name), 'utf-8');
        for (const [, spec] of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
            assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${name} imports ${spec}`);
        }
    }
});

// ── omp bridge and Hermes plugin (heal invoked by the launcher) ─────────────

function pluginEngine() {
    const state = { bytes: 'v1', pin: CLIENT_VERSION };
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        req.resume();
        req.on('end', () => {
            if (u.pathname === '/setup/artifacts') {
                const harness = u.searchParams.get('agent');
                const artifacts = harness === 'hermes'
                    ? [{ kind: 'plugin', path: '~/.hermes/plugins/valorbrain/__init__.py', label: 'MemoryProvider plugin', strategy: 'write', best_effort: false, contents: `_CONTRACT_VERSION = "7"\n# plugin ${state.bytes}\n` }]
                    : [{ kind: 'hooks', path: '~/.omp/agent/hooks/pre/valorbrain.ts', label: 'hosted bridge', strategy: 'write', best_effort: false, contents: `// @valorbrain/connect bridge ${state.bytes}\n` }];
                const text = JSON.stringify({ name: harness, harness, contract_version: '7', hooks_available: harness === 'omp', notes: [], hook_protocol: 2, artifacts,
                    hook_client: 'launcher', hook_client_version: state.pin, hook_client_integrity: 'sha512-AAAA', hook_client_tarball: 'https://x', hook_client_placeholder: PH, data_scope: 1 });
                res.writeHead(200, { 'content-type': 'application/json', ...signedManifestHeaders(text) });
                return res.end(text);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('`launcher heal --harness=omp|hermes`: bridge and plugin files follow the signed bytes; hand edits stay; Hermes needs no token', async () => {
    const { server, state, url } = await pluginEngine();
    const h = home();
    assert.equal((await install(h, url, 'omp')).code, 0);
    const bridge = join(h, '.omp', 'agent', 'hooks', 'pre', 'valorbrain.ts');
    assert.equal(readFileSync(bridge, 'utf-8'), '// @valorbrain/connect bridge v1\n');
    assert.ok(existsSync(launcherPath(h)), 'an omp-only machine gets the launcher');
    const plugin = join(h, '.hermes', 'plugins', 'valorbrain', '__init__.py');
    mkdirSync(dirname(plugin), { recursive: true });
    writeFileSync(plugin, '_CONTRACT_VERSION = "7"\n# plugin v0\n');
    state.bytes = 'v2';
    for (const harness of ['omp', 'hermes']) assert.equal((await launch(h, url, ['heal', `--harness=${harness}`], { stdin: '' })).code, 0);
    assert.equal(readFileSync(bridge, 'utf-8'), '// @valorbrain/connect bridge v2\n');
    assert.equal(readFileSync(plugin, 'utf-8'), '_CONTRACT_VERSION = "7"\n# plugin v2\n');
    // A hand edit of the bridge survives the next update.
    writeFileSync(bridge, '// @valorbrain/connect bridge v2\n// mine\n');
    state.bytes = 'v3';
    await launch(h, url, ['heal', '--harness=omp']);
    server.close();
    assert.equal(readFileSync(bridge, 'utf-8'), '// @valorbrain/connect bridge v2\n// mine\n');
    assert.match(readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8'), /valorbrain\.ts: edited by hand/);
});
