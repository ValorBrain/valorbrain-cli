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

function runCli(args, h, { cwd, stdin = '' } = {}) {
    // Scrubbed env: no VALORBRAIN_API_URL/VALORBRAIN_TOKEN — resolution must
    // come from the saved credential, not the environment.
    const env = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1' };
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [CLI, ...args], { env, cwd, timeout: 20_000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
        });
        child.stdin.end(stdin); // hook commands read stdin; an unterminated pipe hangs them
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
        action: { type: 'command', command: `${h.action.command} --token=vbm_legacy` },
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
    // Hooks rewired in $HOME (standalone file the V3 engine loads), without
    // the token — and never inside the project the hook ran in (VAL-224).
    const hooks = JSON.parse(readFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), 'utf-8'));
    assert.equal(hooks.version, 'v1');
    assert.deepEqual(hooks.hooks.map((x) => x.trigger).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.match(hooks.hooks[0].action.command, /hook prompt --harness=kiro$/);
    assert.ok(!JSON.stringify(hooks).includes('vbm_legacy'));
    assert.equal(existsSync(join(ws, '.kiro')), false, 'self-heal never writes the project dir');
    assert.ok(paths.includes('GET /setup/artifacts'), 'manifest fetched from the resolved engine');
});

test('self-heal never adds a second loader: no $HOME standalone while the project has an ours kiro hooks file (VAL-224)', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-ws3-'));
    homes.push(ws);
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    writeFileSync(join(h, '.valorbrain', 'config.json'), JSON.stringify({ api_key: 'vbm_cfg', engine_url: url }));
    // A 0.5.1-era (or --scope=workspace legacy) agent config of ours in the
    // PROJECT, empty $HOME: the hook firing here comes from that file (V3 with
    // the agent active, or the legacy engine). The heal must not react by
    // creating the $HOME standalone — the project file keeps firing (the heal
    // never writes to projects), so that would register our hooks under a
    // SECOND loader and every event would fire twice from the next session on.
    mkdirSync(join(ws, '.kiro', 'agents'), { recursive: true });
    const projectAgent = JSON.stringify({
        name: 'valorbrain',
        hooks: { agentSpawn: [{ command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' }] },
    });
    writeFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), projectAgent);

    const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', '--token=vbm_legacy', `--api=${url}`], h, { cwd: ws });
    server.close();
    assert.equal(code, 0, stderr);
    assert.equal(
        existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')),
        false,
        'self-heal must not create the $HOME standalone beside a project kiro hooks file of ours',
    );
    assert.equal(readFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'), projectAgent, 'project file untouched');
});

// ── VAL-224 follow-up: heal × loaders, tabela de decisão ────────────────────
// O hook que dispara é também o payload: o engine V3 manda hook_event_name em
// PascalCase (SessionStart/UserPromptSubmit/Stop), o legado em camelCase
// (agentSpawn/userPromptSubmit/stop) — verificado ao vivo na R2. O opt-in
// legado só vale quando REGISTRADO (`--kiro-engine=legacy` no connect.json):
// a 0.5.1 gravava agent config em $HOME por default, então a existência do
// arquivo não prova nada.

const OUR_AGENT_CONFIG = JSON.stringify({
    name: 'valorbrain',
    hooks: { agentSpawn: [{ command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' }] },
});

const v3Payload = (cwd) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd });
const legacyPayload = (cwd) => JSON.stringify({ hook_event_name: 'userPromptSubmit', session_id: 's', cwd, prompt: 'x' });

/** S1 (argv) e S1b (connect.json): o heal não pode apagar o standalone do V3. */
async function s1Run({ viaCreds, payload }) {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-s1-'));
    homes.push(ws);
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    mkdirSync(join(h, '.kiro', 'agents'), { recursive: true });
    // $HOME com os DOIS arquivos nossos: o standalone (único loader de uma
    // sessão V3 sem agente) e o agent config que a 0.5.1 gravava por default.
    writeFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), kiroV2Manifest().artifacts[0].contents);
    writeFileSync(join(h, '.kiro', 'agents', 'valorbrain.json'), OUR_AGENT_CONFIG);
    const args = ['hook', 'prompt', '--harness=kiro', `--api=${url}`];
    if (!viaCreds) args.push('--token=vbm_legacy');
    else {
        mkdirSync(join(h, '.valorbrain'), { recursive: true });
        writeFileSync(join(h, '.valorbrain', 'connect.json'), JSON.stringify({
            version: 2,
            harnesses: { kiro: { api_url: url, token: 'vbm_c', updated_at: '2026-09-30T00:00:00.000Z' } },
        }));
    }
    const out = await runCli(args, h, { cwd: ws, stdin: payload(ws) });
    server.close();
    return { out, h };
}

test('S1: caller is V3 (argv) — the 0.5.1-era $HOME agent config goes, the standalone stays', async () => {
    const { out, h } = await s1Run({ viaCreds: false, payload: v3Payload });
    assert.equal(out.code, 0, out.stderr);
    const sa = JSON.parse(readFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), 'utf-8'));
    assert.equal(sa.version, 'v1');
    assert.equal(sa.hooks.length, 3, 'the V3 loader survives');
    assert.equal(existsSync(join(h, '.kiro', 'agents', 'valorbrain.json')), false, '0.5.1 debris pruned only because the caller is proven V3');
});

test('S1b: caller is V3 (connect.json, the real v2 path) — same outcome as S1', async () => {
    const { out, h } = await s1Run({ viaCreds: true, payload: v3Payload });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')), true, 'the V3 loader survives');
    assert.equal(existsSync(join(h, '.kiro', 'agents', 'valorbrain.json')), false);
});

test('S1-legacy-call: a legacy caller may rely on the $HOME agent config — the heal prunes nothing', async () => {
    const { out, h } = await s1Run({ viaCreds: true, payload: legacyPayload });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')), true, 'standalone untouched');
    assert.equal(existsSync(join(h, '.kiro', 'agents', 'valorbrain.json')), true, 'may be the legacy caller\u2019s only loader');
});

test('S1-marker: explicit legacy opt-in — the standalone is the declared-stale file and goes', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-s1m-'));
    homes.push(ws);
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    mkdirSync(join(h, '.kiro', 'agents'), { recursive: true });
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    writeFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), kiroV2Manifest().artifacts[0].contents);
    writeFileSync(join(h, '.kiro', 'agents', 'valorbrain.json'), OUR_AGENT_CONFIG);
    writeFileSync(join(h, '.valorbrain', 'connect.json'), JSON.stringify({
        version: 2,
        harnesses: { kiro: { api_url: url, token: 'vbm_c', kiro_engine: 'legacy', updated_at: '2026-09-30T00:00:00.000Z' } },
    }));
    const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', `--api=${url}`], h, { cwd: ws, stdin: v3Payload(ws) });
    server.close();
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')), false, 'the opt-in declares the standalone stale');
    const agent = JSON.parse(readFileSync(join(h, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'));
    assert.equal(agent.name, 'valorbrain', 'the legacy loader is kept and maintained');
});

test('S2: $HOME is not a project — the v1→v2 migration still runs when the session starts from $HOME', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    writeFileSync(join(h, '.valorbrain', 'config.json'), JSON.stringify({ api_key: 'vbm_cfg', engine_url: url }));
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), kiroV1DiskFile());

    const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', '--token=vbm_legacy', `--api=${url}`], h, {
        cwd: h, // ← the point: the session (and the hook) start from $HOME itself
        stdin: v3Payload(h),
    });
    server.close();
    assert.equal(code, 0, stderr);
    const sa = readFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), 'utf-8');
    assert.ok(!sa.includes('vbm_legacy'), 'migrated off the argv token');
    assert.match(sa, /hook prompt --harness=kiro"/);
    assert.equal(existsSync(join(h, '.valorbrain', 'connect.json')), true, 'credential saved before the hooks were rewritten');
});

test('no second loader: the heal does not create the $HOME standalone while an ours agent config sits in $HOME', async () => {
    for (const payload of [v3Payload, legacyPayload]) {
        const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
        const h = home();
        const ws = mkdtempSync(join(tmpdir(), 'vb-connect-nosl-'));
        homes.push(ws);
        mkdirSync(join(h, '.kiro', 'agents'), { recursive: true });
        writeFileSync(join(h, '.kiro', 'agents', 'valorbrain.json'), OUR_AGENT_CONFIG);
        const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', '--token=vbm_legacy', `--api=${url}`], h, { cwd: ws, stdin: payload(ws) });
        server.close();
        assert.equal(code, 0, stderr);
        assert.equal(existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')), false, `no $HOME standalone created (payload ${JSON.parse(payload(ws)).hook_event_name})`);
        assert.equal(existsSync(join(h, '.kiro', 'agents', 'valorbrain.json')), true, 'the caller\u2019s loader is untouched');
    }
});

// ── 0.5.3: a guarda barra só a CRIAÇÃO do standalone, nunca a atualização ───
// O SA v1 que o manifesto v1 de produção renderizava (era 0.4.x): 2 hooks
// (context-surfacing / session-bootstrap), --format=text, token no argv, SEM
// Stop. O AC no formato que o heal da 0.5.1 grava.

const SA_V1_PRODUCTION = JSON.stringify({
    version: 'v1',
    hooks: [
        { name: 'valorbrain-context-surfacing', trigger: 'UserPromptSubmit', action: { type: 'command', command: 'npx -y @valorbrain/connect hook context-surfacing --format=text --token=vbm_04x --harness=kiro' } },
        { name: 'valorbrain-session-bootstrap', trigger: 'SessionStart', action: { type: 'command', command: 'npx -y @valorbrain/connect hook session-bootstrap --format=text --token=vbm_04x --harness=kiro' } },
    ],
});

test('guard cell (0.5.3): an existing OURS standalone is migrated even beside a project agent config', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-cell-'));
    homes.push(ws);
    // A herança da 0.4.x→0.5.1: SA v1 real (sem Stop, token no argv) em $HOME
    // e agent config nosso no projeto — e a chamada V3 sai desse projeto.
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), SA_V1_PRODUCTION);
    mkdirSync(join(ws, '.kiro', 'agents'), { recursive: true });
    writeFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), OUR_AGENT_CONFIG);

    const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', '--token=vbm_04x', `--api=${url}`], h, { cwd: ws, stdin: v3Payload(ws) });
    server.close();
    assert.equal(code, 0, stderr);
    const sa = readFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), 'utf-8');
    assert.ok(!sa.includes('vbm_04x'), 'token off the command line');
    assert.ok(!sa.includes('--format=text'), 'protocol v2 needs no format flag');
    assert.ok(sa.includes('hook stop --harness=kiro'), 'the Stop checkpoint is back');
    assert.deepEqual(
        JSON.parse(sa).hooks.map((x) => x.trigger).sort(),
        ['SessionStart', 'Stop', 'UserPromptSubmit'],
    );
    assert.equal(readFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'), OUR_AGENT_CONFIG, 'project untouched');
});

test('guard cell (0.5.3): a foreign file at the standalone path stays out of the plan', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-cellf-'));
    homes.push(ws);
    // v1 shape but NOT ours (no connect marker): the guard must not touch it.
    const foreign = JSON.stringify({ version: 'v1', hooks: [{ name: 'mine', trigger: 'UserPromptSubmit', action: { type: 'command', command: 'echo mine --token=vbm_mine' } }] });
    mkdirSync(join(h, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), foreign);
    mkdirSync(join(ws, '.kiro', 'agents'), { recursive: true });
    writeFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), OUR_AGENT_CONFIG);

    const { code, stderr } = await runCli(['hook', 'prompt', '--harness=kiro', '--token=vbm_04x', `--api=${url}`], h, { cwd: ws, stdin: v3Payload(ws) });
    server.close();
    assert.equal(code, 0, stderr);
    assert.equal(readFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), 'utf-8'), foreign, 'foreign file untouched');
});

test('install: kiro hooks default to the standalone file in $HOME (v3); legacy is opt-in and mutually exclusive', async () => {
    const { server, url } = await stubApi({ '/setup/artifacts': kiroV2Manifest, '/api/v1/hooks/cue': () => ({ context: '' }) });
    const h = home();
    const ws = mkdtempSync(join(tmpdir(), 'vb-connect-ws2-'));
    homes.push(ws);
    mkdirSync(join(h, '.valorbrain'), { recursive: true });
    writeFileSync(join(h, '.valorbrain', 'config.json'), JSON.stringify({ api_key: 'vbm_cfg', engine_url: url }));
    // A 0.5.1-era agent config of ours in $HOME: installing v3 must remove it,
    // or a V3 session running the agent fires every event twice.
    mkdirSync(join(h, '.kiro', 'agents'), { recursive: true });
    writeFileSync(join(h, '.kiro', 'agents', 'valorbrain.json'), JSON.stringify({
        name: 'valorbrain',
        hooks: { agentSpawn: [{ command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' }] },
    }));

    // --api pins the engine to the stub: a fresh token with no --api goes to
    // the public default by design (case b) — never to config.json's base.
    const { code, stdout } = await runCli(['--token', 'vbm_x', '--api', url, '--harness', 'kiro'], h, { cwd: ws });
    assert.equal(code, 0, stdout);
    const standalone = JSON.parse(readFileSync(join(h, '.kiro', 'hooks', 'valorbrain.json'), 'utf-8'));
    assert.equal(standalone.version, 'v1');
    assert.deepEqual(standalone.hooks.map((x) => x.trigger).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.equal(existsSync(join(ws, '.kiro')), false, 'nothing lands in the project by default');
    assert.equal(existsSync(join(h, '.kiro', 'agents', 'valorbrain.json')), false, 'the other engine mode must not stay active');
    assert.match(stdout, /--kiro-engine=legacy/); // the escape hatch is printed

    // Legacy opt-in: the agent config replaces the standalone file — the two
    // never stay active together. The opt-in is REGISTERED in the credential,
    // so the heal keeps maintaining this mode (an agent config in $HOME alone
    // proves nothing — 0.5.1 wrote it by default).
    const legacy = await runCli(['--token', 'vbm_x', '--api', url, '--harness', 'kiro', '--kiro-engine', 'legacy', '--scope', 'workspace'], h, { cwd: ws });
    assert.equal(legacy.code, 0, legacy.stdout);
    const agent = JSON.parse(readFileSync(join(ws, '.kiro', 'agents', 'valorbrain.json'), 'utf-8'));
    assert.equal(agent.name, 'valorbrain');
    assert.deepEqual(Object.keys(agent.hooks).sort(), ['agentSpawn', 'stop', 'userPromptSubmit']);
    assert.equal(existsSync(join(h, '.kiro', 'hooks', 'valorbrain.json')), false, 'standalone file removed when legacy is chosen');
    const savedCreds = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8'));
    assert.equal(savedCreds.harnesses.kiro.kiro_engine, 'legacy', 'the opt-in is registered, not inferred');

    // Full uninstall leaves none of our kiro files behind, in either mode.
    const rm = await runCli(['--remove', '--api', url, '--harness', 'kiro'], h, { cwd: ws });
    assert.equal(rm.code, 0, rm.stdout);
    assert.equal(existsSync(join(ws, '.kiro', 'agents', 'valorbrain.json')), false);
    assert.equal(existsSync(join(h, '.kiro', 'agents', 'valorbrain.json')), false);
    server.close();
});
