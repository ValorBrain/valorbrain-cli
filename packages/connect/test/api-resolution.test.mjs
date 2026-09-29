// Qa R1 (VAL-195): --status and --remove fetch the manifest from args.api.
// With --api omitted the engine must come from the same chain the hook uses
// (~/.valorbrain/connect.json api_url), not the public API. Proven end-to-end:
// the spawned CLI must hit THIS stub server, never valorbrain-api.valor.digital.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-api-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** Minimal v2 manifest: status prints its header, planFor iterates nothing. */
function stubApi(handlers = {}) {
    const agents = [];
    const paths = [];
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        paths.push(`${req.method} ${u.pathname}`);
        if (u.pathname === '/setup/artifacts') agents.push(u.searchParams.get('agent'));
        res.writeHead(200, { 'content-type': 'application/json' });
        const h = handlers[u.pathname];
        res.end(JSON.stringify(h ? h(u) : { name: 'Kiro', harness: 'kiro', contract_version: '2', artifacts: [] }));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            server, agents, paths, url: `http://127.0.0.1:${server.address().port}`,
        }));
    });
}

function homeWithCreds(apiUrl) {
    const h = home();
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    // One entry per harness (a hook never borrows another harness's token).
    const entry = (token) => ({ api_url: apiUrl, token, updated_at: '2026-09-29T12:00:00.000Z' });
    writeFileSync(
        join(h, '.valorbrain', 'connect.json'),
        JSON.stringify({ version: 2, harnesses: { kiro: entry('vbm_secret'), codex: entry('vbm_other') } }) + '\n',
        { mode: 0o600 },
    );
    return h;
}

function runCli(args, h, { cwd } = {}) {
    // Scrubbed env: no VALORBRAIN_API_URL/VALORBRAIN_TOKEN — resolution must
    // come from the saved credential, not the environment.
    const env = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1' };
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [CLI, ...args], { env, cwd, timeout: 20_000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
        });
        child.stdin.end(); // hook commands read stdin; an unterminated pipe hangs them
    });
}

test('status: --api omitted → the manifest comes from connect.json api_url', async () => {
    const { server, agents, url } = await stubApi();
    const h = homeWithCreds(url);
    const { code, stdout } = await runCli(['--status', '--harness', 'kiro'], h);
    server.close();
    assert.deepEqual(agents, ['kiro']); // the stub was the engine consulted
    assert.equal(code, 0);
    assert.match(stdout, /Kiro \(kiro, contract v2\)/);
});

test('remove: --api omitted → the removal is planned against connect.json api_url', async () => {
    const { server, agents, url } = await stubApi();
    const h = homeWithCreds(url);
    const { code, stdout } = await runCli(['--remove', '--harness', 'kiro'], h);
    server.close();
    assert.deepEqual(agents, ['kiro']);
    assert.equal(code, 0);
    assert.match(stdout, /Kiro \(kiro, contract v2\)/);
    // Per-harness credentials: kiro's entry leaves with kiro; codex's stays.
    const saved = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8'));
    assert.deepEqual(Object.keys(saved.harnesses), ['codex']);
});

test('self-heal never guesses a harness for a legacy hook without --harness (no cross-wiring)', async () => {
    const { server, url } = await stubApi();
    const h = home();
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    mkdirSync(join(h, '.claude'), { recursive: true });
    const legacy = JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'npx -y @valorbrain/connect hook context-surfacing --token=vbm_C' }] }] } });
    writeFileSync(join(h, '.claude', 'settings.json'), legacy);
    const env = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_API_URL: url };
    await new Promise((resolve) => {
        const child = execFile(process.execPath, [CLI, 'hook', 'context-surfacing', '--token=vbm_C'], { env, timeout: 20_000 }, () => resolve());
        child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'status?' }));
    });
    server.close();
    assert.equal(existsSync(join(h, '.valorbrain', 'connect.json')), false);
    assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf-8'), legacy);
});

// ── v1 migration engine (Qa R2, VAL-195) ────────────────────────────────────

const kiroV2Manifest = () => ({
    name: 'Kiro', harness: 'kiro', contract_version: '2', hook_protocol: 2, hooks_available: true,
    artifacts: [{
        kind: 'hooks', path: '~/.kiro/hooks/valorbrain.json', label: 'lifecycle hooks (v1 JSON)',
        contents: JSON.stringify({
            version: 'v1',
            hooks: [
                { name: 'valorbrain-prompt', trigger: 'UserPromptSubmit', action: { type: 'command', command: 'npx -y @valorbrain/connect hook prompt --harness=kiro' } },
                { name: 'valorbrain-session-start', trigger: 'SessionStart', action: { type: 'command', command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' } },
                { name: 'valorbrain-stop', trigger: 'Stop', action: { type: 'command', command: 'npx -y @valorbrain/connect hook stop --harness=kiro' } },
            ],
        }),
    }],
});

const kiroV1DiskFile = () => JSON.stringify({
    version: 'v1',
    hooks: JSON.parse(kiroV2Manifest().artifacts[0].contents).hooks.map((h) => ({
        name: h.name, trigger: h.trigger,
        action: { type: 'command', command: `${h.command} --token=vbm_legacy` },
    })),
});

test('v1 migration: argv token is saved against the config.json engine, never the public default', async () => {
    const { server, paths, url } = await stubApi({
        '/setup/artifacts': kiroV2Manifest,
        '/api/v1/hooks/cue': () => ({ context: '' }),
    });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-ws-'));
    homes.push(ws);
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    // The engine CLI's own login: a self-hosted engine on a non-public base.
    writeFileSync(join(h, '.valorbrain', 'config.json'), JSON.stringify({ api_key: 'vbm_cfg', engine_url: url }));
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), kiroV1DiskFile());

    const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', '--token=vbm_legacy'], h, { cwd: ws });
    server.close();
    assert.equal(code, 0, stderr);
    // The credential carries the engine config.json pointed at — the public
    // default would migrate a self-hosted v1 client off its own engine.
    const saved = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8'));
    assert.equal(saved.harnesses.kiro.api_url, url);
    assert.equal(saved.harnesses.kiro.token, 'vbm_legacy');
    // Hooks rewired where kiro loads them (agent config), without the token.
    const agent = JSON.parse(readFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'));
    assert.deepEqual(Object.keys(agent.hooks).sort(), ['agentSpawn', 'stop', 'userPromptSubmit']);
    assert.match(agent.hooks.userPromptSubmit[0].command, /hook prompt --harness=kiro$/);
    assert.ok(!JSON.stringify(agent).includes('vbm_legacy'));
    assert.ok(paths.includes('GET /setup/artifacts'), 'manifest fetched from the resolved engine');
});

test('install: kiro hooks land in the workspace agent config by default; --scope=user keeps them global', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-ws2-'));
    homes.push(ws);
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    writeFileSync(join(h, '.valorbrain', 'config.json'), JSON.stringify({ api_key: 'vbm_cfg', engine_url: url }));

    // --api pins the engine to the stub: a fresh token with no --api goes to
    // the public default by design (case b) — never to config.json's base.
    const { code, stdout } = await runCli(['--token', 'vbm_x', '--api', url, '--harness', 'kiro'], h, { cwd: ws });
    assert.equal(code, 0, stdout);
    const agent = JSON.parse(readFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'));
    assert.equal(agent.name, 'valorbrain');
    assert.deepEqual(Object.keys(agent.hooks).sort(), ['agentSpawn', 'stop', 'userPromptSubmit']);
    assert.equal(existsSync(join(ws, '.kiro', 'hooks', 'valorbrain.json')), false, 'no dead hooks file in the workspace');
    assert.equal(existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')), false, 'no dead hooks file in $HOME');
    assert.match(stdout, /agent set-default valorbrain/); // the firing condition is printed

    const { code: code2 } = await runCli(['--token', 'vbm_x', '--api', url, '--harness', 'kiro', '--scope=user'], h, { cwd: ws });
    assert.equal(code2, 0);
    const globalAgent = JSON.parse(readFileSync(join(h, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'));
    assert.equal(globalAgent.hooks.userPromptSubmit[0].command.includes('--harness=kiro'), true);
    server.close();
});
