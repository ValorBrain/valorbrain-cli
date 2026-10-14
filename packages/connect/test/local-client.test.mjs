// connect 0.10 — the local hook client. Run: npm test
//   The hooks run `node "~/.valorbrain/bin/connect/<v>/hook.mjs" hook … || npx
//   -y @valorbrain/connect@<pin> hook …` (engine manifest `client=local`), and
//   the local client never awaits a self-heal: it spawns one detached, pinned
//   by the signed manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_VERSION, claimHeal, healDispatch, healPin, kickLocalHeal, manifestHealPin, readHealState, writeCreds, writeHealState } from '../hook.mjs';
import { SIGNED_ENV, signedManifestHeaders } from './signed-stub.mjs';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { gcLocalClients, hookClientDetail, hookClientVersions, installLocalClient, localClientFile, localClientWanted, planFor } = await import('../index.mjs');

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PKG, 'index.mjs');
const PH = '<VALORBRAIN_HOOK_CLIENT>';
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-010-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** A fake `npx` first on PATH: logs its argv, serves `hook` from stdin, can be slow. */
function fakeNpx() {
    const dir = mkdtempSync(join(tmpdir(), 'vb-fake-npx-'));
    homes.push(dir);
    const log = join(dir, 'npx.log');
    const stdin = join(dir, 'npx.stdin');
    writeFileSync(join(dir, 'npx'), '#!/bin/sh\n[ -n "$FAKE_NPX_SLEEP" ] && sleep "$FAKE_NPX_SLEEP"\necho "$*" >> "$FAKE_NPX_LOG"\nif [ "$3" = "hook" ]; then cat > "$FAKE_NPX_STDIN"; echo FALLBACK; fi\n');
    chmodSync(join(dir, 'npx'), 0o755);
    return { dir, log, stdin, env: { PATH: `${dir}:${process.env.PATH}`, FAKE_NPX_LOG: log, FAKE_NPX_STDIN: stdin } };
}

const rulesBlock = (v) => `<!-- valorbrain:begin -->\n<!-- valorbrain-contract: v${v} harness: claude-code -->\nUse memory v${v}.\n<!-- valorbrain:end -->\n`;

/** What the engine renders for claude-code (src/harness/hosted.ts), npx or client=local. */
function claudeManifest({ pin, local, version = 7 }) {
    const cmd = (ev) => {
        const npx = `npx -y @valorbrain/connect@${pin} hook ${ev} --harness=claude-code`;
        return local ? `node "${PH}" hook ${ev} --harness=claude-code || ${npx}` : npx;
    };
    const entry = (ev) => [{ hooks: [{ type: 'command', command: cmd(ev), timeout: 10 }] }];
    const settings = { hooks: { SessionStart: entry('session-start'), UserPromptSubmit: entry('prompt'), Stop: entry('stop') } };
    return {
        name: 'Claude Code', harness: 'claude-code', contract_version: String(version), hooks_available: true, notes: [], hook_protocol: 2,
        artifacts: [
            { kind: 'rules', path: '~/.claude/CLAUDE.md', label: 'agent instructions (managed block)', strategy: 'merge', best_effort: false, contents: rulesBlock(version) },
            { kind: 'hooks', path: '~/.claude/settings.json', label: 'lifecycle hooks', strategy: 'write', best_effort: false, contents: JSON.stringify(settings, null, 2) },
        ],
        ...(local ? { hook_client: 'local', hook_client_version: pin, hook_client_placeholder: PH } : {}),
    };
}

function stubEngine() {
    const state = { pin: CLIENT_VERSION, supportsLocal: true, version: 7, queries: [], cues: 0 };
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        req.resume();
        req.on('end', () => {
            if (u.pathname === '/setup/artifacts') {
                state.queries.push(u.search);
                const local = state.supportsLocal && u.searchParams.get('client') === 'local' && u.searchParams.get('hooks') === '2';
                const body = JSON.stringify(claudeManifest({ pin: state.pin, local, version: state.version }));
                res.writeHead(200, { 'content-type': 'application/json', ...signedManifestHeaders(body) });
                return res.end(body);
            }
            if (u.pathname === '/api/v1/hooks/cue') state.cues++;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(u.pathname === '/api/v1/hooks/cue' ? { context: '<vault-context>recall</vault-context>' } : { ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(cmd, args, { h, url, stdin = '', env = {} }) {
    const fullEnv = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_API_URL: url, ...SIGNED_ENV, ...env };
    const t0 = performance.now();
    return new Promise((resolve) => {
        const child = execFile(cmd, args, { env: fullEnv, timeout: 30_000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr, ms: performance.now() - t0 });
        });
        child.stdin.end(stdin);
    });
}
const cli = (h, url, args, opts = {}) => run(process.execPath, [CLI, ...args], { h, url, ...opts });
const install = (h, url, extra = [], opts = {}) => cli(h, url, ['--token', 'vbm_test', '--harness', 'claude-code', ...extra], opts);
const settings = (h) => JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf-8'));
const promptCommand = (h) => settings(h).hooks.UserPromptSubmit[0].hooks[0].command;
const PAYLOAD = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'what did we decide?' });

async function waitFor(fn, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 50));
    }
    return fn();
}

// ── install ─────────────────────────────────────────────────────────────────

test('a fresh install asks for client=local, installs the local client and wires the hooks to it', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    const r = await install(h, url);
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(state.queries.some((q) => q.includes('hooks=2') && q.includes('client=local')), state.queries.join(' '));
    const file = localClientFile(h);
    assert.equal(file, `${h}/.valorbrain/bin/connect/${CLIENT_VERSION}/hook.mjs`);
    assert.equal(promptCommand(h), `node "${file}" hook prompt --harness=claude-code || npx -y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`);
    // A verbatim copy of this package's hook client and its signature check.
    for (const name of ['hook.mjs', 'manifest-signature.mjs']) {
        const dest = join(dirname(file), name);
        assert.deepEqual(readFileSync(dest), readFileSync(join(PKG, name)));
        assert.equal(statSync(dest).mode & 0o022, 0, `${name} must not be group/world-writable`);
    }
    for (const d of [dirname(file), dirname(dirname(file)), dirname(dirname(dirname(file)))]) {
        assert.equal(statSync(d).mode & 0o777, 0o700, d);
    }
    assert.match(r.stdout, /local hook client 0\.10\.0/);
    assert.deepEqual(readHealState(h).hook_clients, { 'claude-code': [CLIENT_VERSION] });
});

test('an engine without client=local keeps the npx hooks and writes no local client', async () => {
    const { server, state, url } = await stubEngine();
    state.supportsLocal = false;
    const h = home();
    const r = await install(h, url);
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(promptCommand(h), `npx -y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`);
    assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false);
});

test('an engine pinning another version gets the npx hooks of THAT version, never this local client', async () => {
    const { server, state, url } = await stubEngine();
    state.pin = '0.10.9';
    const h = home();
    const r = await install(h, url);
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(promptCommand(h), 'npx -y @valorbrain/connect@0.10.9 hook prompt --harness=claude-code');
    assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false);
    assert.match(r.stdout, /the engine pins 0\.10\.9/);
});

test('VALORBRAIN_HOOK_CLIENT=npx opts out; Windows defaults to npx', async () => {
    assert.equal(localClientWanted({}, 'linux'), true);
    assert.equal(localClientWanted({}, 'darwin'), true);
    assert.equal(localClientWanted({}, 'win32'), false);
    assert.equal(localClientWanted({ VALORBRAIN_HOOK_CLIENT: 'local' }, 'win32'), true);
    assert.equal(localClientWanted({ VALORBRAIN_HOOK_CLIENT: 'npx' }, 'linux'), false);
    const { server, state, url } = await stubEngine();
    const h = home();
    const r = await install(h, url, [], { env: { VALORBRAIN_HOOK_CLIENT: 'npx' } });
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(state.queries.every((q) => !q.includes('client=local')));
    assert.equal(promptCommand(h), `npx -y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`);
});

test('placeholder substitution happens in planFor, after the signature check; never written unsubstituted', () => {
    const h = home();
    const m = claudeManifest({ pin: CLIENT_VERSION, local: true });
    const file = localClientFile(h);
    const [, hooks] = planFor(m, 'vbm_x', h, false, h, file);
    assert.ok(hooks.after.includes(`node \\"${file}\\" hook stop --harness=claude-code ||`));
    assert.ok(!hooks.after.includes(PH));
    const [, refused] = planFor(m, 'vbm_x', h, false, h, null);
    assert.match(refused.error, /local hook client is not installed/);
    assert.equal(refused.changed, false);
});

test('a home path a shell or JSON would have to escape gets no local client', () => {
    for (const bad of ['$x', 'a"b', "it's", 'p%c%', 'back`tick']) {
        const h = join(home(), bad);
        mkdirSync(h, { recursive: true });
        assert.equal(installLocalClient(h), null, bad);
        assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false, bad);
    }
    // Spaces are fine: the path is quoted in the command.
    const spaced = join(home(), 'John Smith');
    mkdirSync(spaced);
    assert.equal(installLocalClient(spaced), localClientFile(spaced));
});

// ── the hook, local ─────────────────────────────────────────────────────────

test('the local client serves the hook with node alone; the missing-file fallback still gets stdin', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() }); // no heal in this test
    const npx = fakeNpx();
    const cmd = promptCommand(h);
    const ok = await run('/bin/sh', ['-c', cmd], { h, url, stdin: PAYLOAD, env: npx.env });
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /recall/);
    assert.equal(state.cues, 1);
    assert.equal(existsSync(npx.log), false, 'npx must not run when the local client exists');

    rmSync(dirname(localClientFile(h)), { recursive: true });
    const fb = await run('/bin/sh', ['-c', cmd], { h, url, stdin: PAYLOAD, env: npx.env });
    server.close();
    assert.equal(fb.code, 0);
    assert.match(fb.stdout, /FALLBACK/);
    assert.equal(readFileSync(npx.stdin, 'utf-8'), PAYLOAD, 'node must not consume the payload before failing');
    assert.match(readFileSync(npx.log, 'utf-8'), new RegExp(`-y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`));
});

test('a due heal is spawned detached: the hook returns before it finishes, pinned by the signed manifest', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    writeHealState(h, { ...readHealState(h), lastHealAt: 0 }); // due
    state.pin = '0.10.7'; // the engine bumped the pin
    const npx = fakeNpx();
    const r = await run(process.execPath, [localClientFile(h), 'hook', 'prompt', '--harness=claude-code'], {
        h, url, stdin: PAYLOAD, env: { ...npx.env, FAKE_NPX_SLEEP: '2' },
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /recall/);
    assert.equal(existsSync(npx.log), false, 'the hook must not wait for the heal');
    assert.ok(r.ms < 1500, `hook took ${r.ms}ms`);
    const logged = await waitFor(() => existsSync(npx.log) && readFileSync(npx.log, 'utf-8'));
    server.close();
    assert.equal(logged.trim(), '-y @valorbrain/connect@0.10.7 heal --harness=claude-code');
    // The throttle was claimed by the hook itself.
    assert.ok(Date.now() - readHealState(h).lastHealAt < 30_000);
});

test('the throttle holds: a heal claimed less than 6h ago spawns nothing', () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_x', harness: 'claude-code' });
    const spawned = [];
    const spawnImpl = (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; };
    const deps = { env: { HOME: h }, home: h, spawnImpl, self: '/x/hook.mjs' };
    assert.equal(kickLocalHeal(['prompt', '--harness=claude-code'], { hook_event_name: 'UserPromptSubmit' }, deps), true);
    assert.equal(kickLocalHeal(['prompt', '--harness=claude-code'], {}, deps), false);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].slice(1), ['/x/hook.mjs', 'heal-dispatch', '--harness=claude-code']);
    // Kiro passes the calling engine on, for the second-loader guards.
    const k = home();
    writeCreds(k, { api: 'https://api.example', token: 'vbm_x', harness: 'kiro' });
    kickLocalHeal(['stop', '--harness=kiro'], { hook_event_name: 'Stop' }, { ...deps, env: { HOME: k }, home: k });
    assert.deepEqual(spawned[1].slice(1), ['/x/hook.mjs', 'heal-dispatch', '--harness=kiro', '--caller-engine=v3']);
    // No credentials: nothing to heal with.
    assert.equal(kickLocalHeal(['prompt', '--harness=claude-code'], {}, { ...deps, env: { HOME: home() }, home: undefined }), false);
    assert.equal(claimHeal(h, { env: { VALORBRAIN_HEAL_INTERVAL_MS: '1' }, now: Date.now() + 10 }), true);
});

test('heal-dispatch runs only a pin the signed manifest names (≥ 0.10.0, exact)', async () => {
    assert.equal(healPin('0.10.0'), '0.10.0');
    assert.equal(healPin('1.0.0-rc.1'), '1.0.0-rc.1');
    for (const bad of ['latest', '^0.10.0', '0.9.0', '0.10', '', null, '0.10.0 && rm -rf ~']) assert.equal(healPin(bad), null, String(bad));
    // From an engine that stopped serving the local client: the npx command's pin.
    assert.equal(manifestHealPin(claudeManifest({ pin: '0.11.2', local: false })), '0.11.2');
    assert.equal(manifestHealPin(claudeManifest({ pin: '0.9.0', local: false })), null);

    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_x', harness: 'claude-code' });
    const spawned = [];
    const spawnImpl = (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; };
    const serve = (manifest, signed = true) => async (u) => {
        assert.match(u, /\/setup\/artifacts\?agent=claude-code&hooks=2&client=local$/);
        const body = JSON.stringify(manifest);
        return new Response(body, { headers: signed ? signedManifestHeaders(body) : {} });
    };
    const deps = (fetchImpl) => ({ env: { HOME: h, ...SIGNED_ENV }, home: h, fetchImpl, spawnImpl });
    assert.equal(await healDispatch(['--harness=claude-code', '--caller-engine=v3'], deps(serve(claudeManifest({ pin: '0.10.4', local: true })))), '0.10.4');
    assert.deepEqual(spawned.pop(), ['npx', '-y', '@valorbrain/connect@0.10.4', 'heal', '--harness=claude-code', '--caller-engine=v3']);
    // Unsigned, a tag, or no harness: nothing runs.
    assert.equal(await healDispatch(['--harness=claude-code'], deps(serve(claudeManifest({ pin: '0.10.4', local: true }), false))), null);
    assert.equal(await healDispatch(['--harness=claude-code'], deps(serve({ ...claudeManifest({ pin: 'latest', local: true }), artifacts: [] }))), null);
    assert.equal(await healDispatch([], deps(serve(claudeManifest({ pin: '0.10.4', local: true })))), null);
    assert.equal(spawned.length, 0);
    assert.match(readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8'), /not signed/);
});

// ── heal ────────────────────────────────────────────────────────────────────

test('migration: an npx install moves to the local client at the first 0.10 hook, even inside the 6h throttle', async () => {
    const { server, state, url } = await stubEngine();
    state.supportsLocal = false;
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    assert.match(promptCommand(h), /^npx -y/);
    // The engine now serves client=local; a heal ran 1 minute ago.
    state.supportsLocal = true;
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() - 60_000 });
    const hookRun = () => cli(h, url, ['hook', 'prompt', '--harness=claude-code'], { stdin: PAYLOAD });
    const r = await hookRun();
    assert.equal(r.code, 0);
    assert.equal(promptCommand(h), `node "${localClientFile(h)}" hook prompt --harness=claude-code || npx -y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`);
    assert.ok(existsSync(localClientFile(h)));
    // Once per version: with the client gone, the throttle holds again.
    rmSync(join(h, '.valorbrain', 'bin'), { recursive: true });
    const before = state.queries.length;
    await hookRun();
    server.close();
    assert.equal(state.queries.length, before, 'no second forced heal');
});

test('`heal` installs the pinned local client and rewrites hooks; another pin is handed off, never run here', async () => {
    const { server, state, url } = await stubEngine();
    state.supportsLocal = false;
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    state.supportsLocal = true;
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() }); // the caller claimed it
    const healed = await cli(h, url, ['heal', '--harness=claude-code']);
    assert.equal(healed.code, 0);
    assert.equal(healed.stdout, '');
    assert.match(promptCommand(h), /^node ".*\/\.valorbrain\/bin\/connect\/0\.10\.0\/hook\.mjs" hook prompt/);

    state.pin = '0.10.5';
    const npx = fakeNpx();
    const before = readFileSync(join(h, '.claude', 'settings.json'), 'utf-8');
    await cli(h, url, ['heal', '--harness=claude-code'], { env: npx.env });
    const logged = await waitFor(() => existsSync(npx.log) && readFileSync(npx.log, 'utf-8'));
    server.close();
    assert.equal(logged.trim(), '-y @valorbrain/connect@0.10.5 heal --harness=claude-code');
    assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf-8'), before, '0.10.0 writes nothing for a 0.10.5 pin');
});

test('`heal` keeps a hand-edited hook file (decision 17) and logs it', async () => {
    const { server, state, url } = await stubEngine();
    state.supportsLocal = false;
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    const path = join(h, '.claude', 'settings.json');
    const edited = readFileSync(path, 'utf-8').replace('"timeout": 10', '"timeout": 30');
    writeFileSync(path, edited);
    state.supportsLocal = true;
    await cli(h, url, ['heal', '--harness=claude-code']);
    server.close();
    assert.equal(readFileSync(path, 'utf-8'), edited);
    assert.match(readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8'), /edited by hand — self-heal left it as is/);
    // The kept file runs npx: no harness references a local client.
    assert.deepEqual(readHealState(h).hook_clients ?? {}, {});
});

test('`heal` of an --mcp-only install installs no client and brings no hooks back', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url, ['--mcp-only'])).code, 0);
    await cli(h, url, ['heal', '--harness=claude-code']);
    server.close();
    assert.equal(existsSync(join(h, '.claude', 'settings.json')), false);
    assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false);
});

// ── status, GC, remove ──────────────────────────────────────────────────────

test('--status names the client: local and its version, or npx and its pin', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    const local = await cli(h, url, ['--status', '--harness', 'claude-code']);
    assert.match(local.stdout, /hook protocol v2 — client: local 0\.10\.0/);
    rmSync(dirname(localClientFile(h)), { recursive: true });
    assert.match((await cli(h, url, ['--status', '--harness', 'claude-code'])).stdout, /client: local 0\.10\.0 \(missing: 0\.10\.0 — those hooks fall back to npx/);
    state.supportsLocal = false;
    const n = home();
    assert.equal((await install(n, url)).code, 0);
    assert.match((await cli(n, url, ['--status', '--harness', 'claude-code'])).stdout, /hook protocol v2 — client: npx 0\.10\.0/);
    server.close();
    assert.equal(hookClientDetail('npx -y @valorbrain/connect hook prompt', n), 'client: npx (unpinned)');
    assert.deepEqual(hookClientVersions(JSON.stringify({ command: 'node "/h/.valorbrain/bin/connect/0.10.0/hook.mjs" hook stop' })), ['0.10.0']);
});

test('GC: an unused version goes after a grace period, a used or kept one stays', () => {
    const h = home();
    const root = join(h, '.valorbrain', 'bin', 'connect');
    for (const v of ['0.10.0', '0.10.1', '0.10.2']) {
        mkdirSync(join(root, v), { recursive: true });
        writeFileSync(join(root, v, 'hook.mjs'), '');
    }
    writeHealState(h, { hook_clients: { 'claude-code': ['0.10.1'] } });
    const t = Date.now();
    // First sight of an unused version only starts its clock (a running session may still run it).
    assert.deepEqual(gcLocalClients(h, { now: t, keep: '0.10.2' }), []);
    assert.deepEqual(gcLocalClients(h, { now: t + 23 * 3600_000, keep: '0.10.2' }), []);
    assert.deepEqual(gcLocalClients(h, { now: t + 25 * 3600_000, keep: '0.10.2' }), ['0.10.0']);
    assert.ok(existsSync(join(root, '0.10.1')) && existsSync(join(root, '0.10.2')));
    // --remove: at once, and the empty directories go too.
    writeHealState(h, {});
    assert.deepEqual(gcLocalClients(h, { graceMs: 0 }).sort(), ['0.10.1', '0.10.2']);
    assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false);
});

test('--remove deletes the local client once no harness references it', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    // A second harness running the same version keeps it alive.
    writeHealState(h, { ...readHealState(h), hook_clients: { ...readHealState(h).hook_clients, cursor: [CLIENT_VERSION] } });
    assert.equal((await cli(h, url, ['--remove', '--harness', 'claude-code'])).code, 0);
    assert.ok(existsSync(localClientFile(h)));
    writeHealState(h, { ...readHealState(h), hook_clients: {} });
    assert.equal((await install(h, url)).code, 0);
    assert.equal((await cli(h, url, ['--remove', '--harness', 'claude-code'])).code, 0);
    server.close();
    assert.equal(existsSync(join(h, '.valorbrain', 'bin')), false);
});

test('the local client imports only node built-ins and its sibling', () => {
    for (const name of ['hook.mjs', 'manifest-signature.mjs']) {
        const src = readFileSync(join(PKG, name), 'utf-8');
        for (const [, spec] of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
            assert.ok(spec.startsWith('node:') || spec === './manifest-signature.mjs', `${name} imports ${spec}`);
        }
    }
    // And runs from a directory with nothing else in it.
    const dir = mkdtempSync(join(tmpdir(), 'vb-bare-'));
    homes.push(dir);
    for (const name of ['hook.mjs', 'manifest-signature.mjs']) writeFileSync(join(dir, name), readFileSync(join(PKG, name)));
    const child = spawn(process.execPath, [join(dir, 'hook.mjs'), 'hook', 'prompt', '--harness=claude-code'], { env: { PATH: process.env.PATH, HOME: dir } });
    child.stdin.end('{}');
    return new Promise((resolve) => child.on('exit', (code) => { assert.equal(code, 0); resolve(); }));
});
