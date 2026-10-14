// connect 0.10 — moving a machine from self-hosted hooks (the engine binary)
// to hosted ones. An explicit install replaces the self-hosted ValorBrain
// entries in the files it writes and says so; self-heal never removes them
// (it logs the duplicate); --remove never touches them. Fixtures are the
// shapes found on the engine host (14/10/2026). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_VERSION, readHealState, writeHealState } from '../hook.mjs';
import { SIGNED_ENV, signedManifestHeaders } from './signed-stub.mjs';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { gcLocalClients, isSelfHostedHookCommand, recordHookClients, selfHostedHookCommands } = await import('../index.mjs');

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PKG, 'index.mjs');
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-sh-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// ── fixtures (engine host, 14/10/2026) ──────────────────────────────────────

const SH = (name, harness, extra = '') => `/usr/local/libexec/valorbrain-hook-env hook ${name}${extra} --harness=${harness}`;
const cmd = (command, timeout) => ({ type: 'command', command, ...(timeout ? { timeout } : {}) });

const CLAUDE_THIRD_PARTY = {
    SessionStart: [
        { hooks: [cmd('$HOME/.claude/hooks/codedb-warmup.sh')] },
        { matcher: '^(startup|resume|clear|compact|fork)$', hooks: [cmd("bash '/root/.claude/hooks/herdr-agent-state.sh' session")] },
    ],
    PreToolUse: [
        { matcher: 'Bash', hooks: [cmd('rtk hook claude')] },
        { matcher: 'Bash', hooks: [cmd('$HOME/.claude/hooks/codedb-block-legacy.sh')] },
    ],
};
function claudeSettings() {
    return {
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: {
            UserPromptSubmit: [{ hooks: [cmd(SH('context-surfacing', 'claude-code'), 8)] }],
            SessionStart: [
                CLAUDE_THIRD_PARTY.SessionStart[0],
                CLAUDE_THIRD_PARTY.SessionStart[1],
                { hooks: [cmd(SH('postcompact-inject', 'claude-code'), 5)] },
                { hooks: [cmd(SH('curator-nudge', 'claude-code'), 5)] },
            ],
            PreCompact: [{ hooks: [cmd(SH('precompact-extract', 'claude-code'), 5)] }],
            Stop: ['decision-extractor', 'episode-extractor', 'handoff-generator', 'feedback-loop'].map((n) => ({ hooks: [cmd(SH(n, 'claude-code'), 30)] })),
            PreToolUse: CLAUDE_THIRD_PARTY.PreToolUse,
        },
    };
}
const CODEX_THIRD_PARTY = {
    PostToolUse: [{ matcher: 'apply_patch|Write|Edit|MultiEdit', hooks: [cmd('node "/root/.codex/hooks/graft/graft-hooks.cjs" post-edit', 10000)] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('bash /root/.codex/hooks/rtk-codex-shim.sh', 10)] }],
    SessionStart: [
        { hooks: [cmd("bash '/root/.codex/herdr-agent-state.sh' session", 10)] },
        { matcher: 'startup|resume|compact', hooks: [cmd('node "/root/.codex/hooks/graft/graft-hooks.cjs" session-start', 10000)] },
    ],
    Stop: [{ hooks: [cmd('node "/root/.codex/hooks/graft/graft-hooks.cjs" stop', 10000)] }],
    UserPromptSubmit: [{ hooks: [cmd('node "/root/.codex/hooks/graft/graft-hooks.cjs" prompt', 15000)] }],
};
function codexHooks() {
    return {
        hooks: {
            PostToolUse: CODEX_THIRD_PARTY.PostToolUse,
            PreToolUse: CODEX_THIRD_PARTY.PreToolUse,
            SessionStart: [...CODEX_THIRD_PARTY.SessionStart, { hooks: [cmd(SH('postcompact-inject', 'codex'), 5)] }, { hooks: [cmd(SH('curator-nudge', 'codex'), 5)] }],
            Stop: CODEX_THIRD_PARTY.Stop,
            UserPromptSubmit: [...CODEX_THIRD_PARTY.UserPromptSubmit, { hooks: [cmd(SH('context-surfacing', 'codex'), 8)] }],
        },
    };
}
const KIRO_SELF_HOSTED = {
    version: 'v1',
    hooks: [['context-surfacing', 'UserPromptSubmit'], ['postcompact-inject', 'SessionStart'], ['curator-nudge', 'SessionStart'],
        ['decision-extractor', 'Stop'], ['episode-extractor', 'Stop'], ['handoff-generator', 'Stop'], ['feedback-loop', 'Stop']]
        .map(([n, trigger]) => ({ name: `valorbrain-${n}`, trigger, action: { type: 'command', command: SH(n, 'kiro', ' --format=text') } })),
};
const GROK_SELF_HOSTED = { hooks: { Stop: [{ hooks: ['decision-extractor', 'episode-extractor', 'handoff-generator', 'feedback-loop'].map((n) => cmd(SH(n, 'grok'), 30)) }] } };

// ── stub engine: hosted v2 manifests (npx commands), shapes as src/harness/adapters.ts renders them ──

const NPX = (ev, harness) => `npx -y @valorbrain/connect@${CLIENT_VERSION} hook ${ev} --harness=${harness}`;
const rules = (path, harness) => ({ kind: 'rules', path, label: 'agent instructions (managed block)', strategy: 'merge', best_effort: false, contents: `<!-- valorbrain:begin -->\n<!-- valorbrain-contract: v7 harness: ${harness} -->\nUse memory.\n<!-- valorbrain:end -->\n` });
const groups = (harness, events) => ({ hooks: Object.fromEntries(events.map(([event, ev]) => [event, [{ hooks: [cmd(NPX(ev, harness), 10)] }]])) });
const V2 = [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop']];
const MANIFESTS = {
    'claude-code': [rules('~/.claude/CLAUDE.md', 'claude-code'), { kind: 'hooks', path: '~/.claude/settings.json', label: 'lifecycle hooks', strategy: 'write', best_effort: false, contents: JSON.stringify(groups('claude-code', V2), null, 2) }],
    codex: [rules('~/.codex/AGENTS.md', 'codex'), { kind: 'hooks', path: '~/.codex/hooks.json', label: 'lifecycle hooks', strategy: 'write', best_effort: false, contents: JSON.stringify(groups('codex', V2), null, 2) }],
    kiro: [rules('~/.kiro/steering/valorbrain.md', 'kiro'), {
        kind: 'hooks', path: '~/.kiro/hooks/valorbrain.json', label: 'lifecycle hooks', strategy: 'write', best_effort: false,
        contents: JSON.stringify({ version: 'v1', hooks: [['prompt', 'UserPromptSubmit'], ['session-start', 'SessionStart'], ['stop', 'Stop']].map(([ev, trigger]) => ({ name: `valorbrain-${ev}`, trigger, action: { type: 'command', command: NPX(ev, 'kiro') } })) }, null, 2),
    }],
    grok: [{ kind: 'hooks', path: '~/.grok/hooks/valorbrain.json', label: 'lifecycle hooks', strategy: 'write', best_effort: false, contents: JSON.stringify(groups('grok', [['Stop', 'stop']]), null, 2) }],
};

function stubEngine() {
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        req.resume();
        req.on('end', () => {
            if (u.pathname === '/setup/artifacts') {
                const harness = u.searchParams.get('agent');
                const body = JSON.stringify({ name: harness, harness, contract_version: '7', hooks_available: true, notes: [], hook_protocol: 2, artifacts: MANIFESTS[harness] });
                res.writeHead(200, { 'content-type': 'application/json', ...signedManifestHeaders(body) });
                return res.end(body);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(u.pathname === '/api/v1/hooks/cue' ? { context: '' } : { ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function cli(h, url, args, { env = {}, cwd } = {}) {
    const fullEnv = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_API_URL: url, VALORBRAIN_HOOK_CLIENT: 'npx', ...SIGNED_ENV, ...env };
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [CLI, ...args], { env: fullEnv, timeout: 30_000, cwd: cwd ?? h }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
        });
        child.stdin.end('');
    });
}
const install = (h, url, harness, extra = []) => cli(h, url, ['--token', 'vbm_test', '--harness', harness, ...extra]);
const put = (h, rel, obj) => { mkdirSync(dirname(join(h, rel)), { recursive: true }); writeFileSync(join(h, rel), JSON.stringify(obj, null, 2)); };
const read = (h, rel) => JSON.parse(readFileSync(join(h, rel), 'utf-8'));
const commandsIn = (h, rel) => JSON.stringify(read(h, rel)).match(/"command":"(?:[^"\\]|\\.)*"/g).map((s) => JSON.parse(s.slice(10)));

// ── matchers ────────────────────────────────────────────────────────────────

test('self-hosted commands are recognised; connect and third-party ones are not', () => {
    for (const c of [
        '/usr/local/libexec/valorbrain-hook-env hook context-surfacing --harness=claude-code',
        '/home/u/.local/bin/valorbrain hook decision-extractor',
        'valorbrain hook context-surfacing --format=text',
        '"C:\\Program Files\\ValorBrain\\valorbrain.exe" hook stop',
        '/opt/valorbrain/bin/vbhook episode-extractor',
        'clawmem hook context-surfacing',
        '"/home/u/bin/valorbrain" hook prompt',
    ]) assert.equal(isSelfHostedHookCommand(c), true, c);
    for (const c of [
        `npx -y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`,
        'npx -y @valorbrain/connect hook context-surfacing --token=vbm_x',
        `node "/home/u/.valorbrain/bin/connect/${CLIENT_VERSION}/hook.mjs" hook prompt --harness=claude-code || npx -y @valorbrain/connect@${CLIENT_VERSION} hook prompt --harness=claude-code`,
        'valorbrain-connect hook context-surfacing',
        'rtk hook claude',
        "bash '/root/.claude/hooks/herdr-agent-state.sh' session",
        'echo valorbrain is great',
        '/usr/bin/valorbrain mcp',
    ]) assert.equal(isSelfHostedHookCommand(c), false, c);
    assert.equal(selfHostedHookCommands(JSON.stringify(claudeSettings())).length, 8);
    assert.equal(selfHostedHookCommands(JSON.stringify(KIRO_SELF_HOSTED)).length, 7);
    assert.deepEqual(selfHostedHookCommands('not json'), []);
});

// ── explicit install ────────────────────────────────────────────────────────

test('claude-code: install replaces the 8 self-hosted hooks, keeps every third-party hook and setting, says so', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    const original = claudeSettings();
    put(h, '.claude/settings.json', original);
    const dry = await install(h, url, 'claude-code', ['--dry-run']);
    assert.match(dry.stdout, /replaces 8 self-hosted ValorBrain hook\(s\): context-surfacing, postcompact-inject, curator-nudge, precompact-extract, decision-extractor, episode-extractor, handoff-generator, feedback-loop/);
    assert.deepEqual(read(h, '.claude/settings.json'), original, '--dry-run writes nothing');

    const r = await install(h, url, 'claude-code');
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /replaces 8 self-hosted ValorBrain hook\(s\)/);
    const s = read(h, '.claude/settings.json');
    assert.deepEqual(s.permissions, original.permissions);
    assert.equal(s.hooks.PreCompact, undefined, 'PreCompact had only the self-hosted hook');
    assert.deepEqual(s.hooks.PreToolUse, CLAUDE_THIRD_PARTY.PreToolUse);
    assert.deepEqual(s.hooks.SessionStart.slice(0, 2), CLAUDE_THIRD_PARTY.SessionStart);
    const all = commandsIn(h, '.claude/settings.json');
    assert.deepEqual(all.filter((c) => c.includes('@valorbrain/connect')).sort(), V2.map(([, ev]) => NPX(ev, 'claude-code')).sort());
    assert.equal(all.filter(isSelfHostedHookCommand).length, 0);
    assert.equal(all.length, 3 + 4, '3 hosted + 4 third-party');
    // Rollback: the backup is the original file.
    assert.deepEqual(JSON.parse(readFileSync(join(h, '.claude', 'settings.json.valorbrain-bak'), 'utf-8')), original);
});

test('a self-hosted command sharing a group with a third-party one: only the self-hosted command goes', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.claude/settings.json', { hooks: { Stop: [{ hooks: [cmd('rtk stop-hook'), cmd(SH('decision-extractor', 'claude-code'))] }] } });
    assert.equal((await install(h, url, 'claude-code')).code, 0);
    server.close();
    const stop = read(h, '.claude/settings.json').hooks.Stop;
    assert.deepEqual(stop[0], { hooks: [cmd('rtk stop-hook')] });
    assert.equal(stop.length, 2);
});

test('codex: install replaces the 3 self-hosted hooks, graft/rtk/herdr untouched', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.codex/hooks.json', codexHooks());
    const r = await install(h, url, 'codex');
    server.close();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /replaces 3 self-hosted ValorBrain hook\(s\): postcompact-inject, curator-nudge, context-surfacing/);
    const hooks = read(h, '.codex/hooks.json').hooks;
    assert.deepEqual(hooks.PostToolUse, CODEX_THIRD_PARTY.PostToolUse);
    assert.deepEqual(hooks.PreToolUse, CODEX_THIRD_PARTY.PreToolUse);
    assert.deepEqual(hooks.SessionStart.slice(0, 2), CODEX_THIRD_PARTY.SessionStart);
    assert.deepEqual(hooks.Stop[0], CODEX_THIRD_PARTY.Stop[0]);
    assert.deepEqual(hooks.UserPromptSubmit[0], CODEX_THIRD_PARTY.UserPromptSubmit[0]);
    assert.equal(commandsIn(h, '.codex/hooks.json').filter(isSelfHostedHookCommand).length, 0);
});

test('kiro v3: the self-hosted standalone file is replaced whole (7 hooks listed); legacy install deletes it beside the agent config', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.kiro/hooks/valorbrain.json', KIRO_SELF_HOSTED);
    const r = await install(h, url, 'kiro');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /replaces 7 self-hosted ValorBrain hook\(s\)/);
    const kiro = read(h, '.kiro/hooks/valorbrain.json');
    assert.equal(kiro.hooks.length, 3);
    assert.ok(kiro.hooks.every((x) => x.action.command.includes('@valorbrain/connect')));

    const l = home();
    put(l, '.kiro/hooks/valorbrain.json', KIRO_SELF_HOSTED);
    const legacy = await install(l, url, 'kiro', ['--kiro-engine=legacy']);
    server.close();
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.match(legacy.stdout, /delete self-hosted kiro hook file — replaces 7 self-hosted hook\(s\)/);
    assert.equal(existsSync(join(l, '.kiro', 'hooks', 'valorbrain.json')), false, 'no second loader beside the agent config');
    assert.deepEqual(JSON.parse(readFileSync(join(l, '.kiro', 'hooks', 'valorbrain.json.valorbrain-bak'), 'utf-8')), KIRO_SELF_HOSTED);
    assert.ok(existsSync(join(l, '.kiro', 'agents', 'valorbrain.json')));
});

test('grok: the self-hosted file is replaced on install; --remove of a never-migrated one leaves it', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.grok/hooks/valorbrain.json', GROK_SELF_HOSTED);
    const r = await install(h, url, 'grok');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /replaces 4 self-hosted ValorBrain hook\(s\): decision-extractor, episode-extractor, handoff-generator, feedback-loop/);
    assert.deepEqual(commandsIn(h, '.grok/hooks/valorbrain.json'), [NPX('stop', 'grok')]);

    const k = home();
    put(k, '.grok/hooks/valorbrain.json', GROK_SELF_HOSTED);
    const rm = await cli(k, url, ['--remove', '--harness', 'grok']);
    server.close();
    assert.equal(rm.code, 0, rm.stderr);
    assert.deepEqual(read(k, '.grok/hooks/valorbrain.json'), GROK_SELF_HOSTED, 'not connect\'s file — --remove leaves it');
});

test('hand-edited connect entries are never overwritten: the self-hosted ones stay with them until --force', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url, 'claude-code')).code, 0);
    const s = read(h, '.claude/settings.json');
    s.hooks.Stop[0].hooks[0].timeout = 45; // hand edit of OUR entry
    s.hooks.PreCompact = [{ hooks: [cmd(SH('precompact-extract', 'claude-code'))] }];
    put(h, '.claude/settings.json', s);
    const r = await install(h, url, 'claude-code');
    assert.match(r.stdout, /kept your edits/);
    assert.deepEqual(read(h, '.claude/settings.json'), s);
    const forced = await install(h, url, 'claude-code', ['--force']);
    server.close();
    assert.match(forced.stdout, /replaces 1 self-hosted ValorBrain hook\(s\): precompact-extract/);
    assert.equal(read(h, '.claude/settings.json').hooks.PreCompact, undefined);
});

test('--remove after a migration removes only the hosted entries; nothing self-hosted comes back', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    put(h, '.claude/settings.json', claudeSettings());
    assert.equal((await install(h, url, 'claude-code')).code, 0);
    assert.equal((await cli(h, url, ['--remove', '--harness', 'claude-code'])).code, 0);
    server.close();
    const all = commandsIn(h, '.claude/settings.json');
    assert.equal(all.length, 4);
    assert.equal(all.some((c) => c.includes('valorbrain')), false);
});

// ── self-heal ───────────────────────────────────────────────────────────────

test('self-heal never removes self-hosted hooks: a duplicate is logged with the fix; a self-hosted file is left as is', async () => {
    const { server, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url, 'claude-code')).code, 0);
    // The engine CLI re-adds its hooks beside ours (e.g. `valorbrain setup harness` run later).
    const s = read(h, '.claude/settings.json');
    s.hooks.UserPromptSubmit.push({ hooks: [cmd(SH('context-surfacing', 'claude-code'), 8)] });
    s.hooks.PreCompact = [{ hooks: [cmd(SH('precompact-extract', 'claude-code'), 5)] }];
    put(h, '.claude/settings.json', s);
    writeHealState(h, { ...readHealState(h), lastHealAt: Date.now() });
    await cli(h, url, ['heal', '--harness=claude-code']);
    assert.equal(commandsIn(h, '.claude/settings.json').filter(isSelfHostedHookCommand).length, 2, 'heal leaves them');
    const log = readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8').trim().split('\n');
    assert.equal(log.filter((l) => l.includes('hosted hooks run beside')).length, 1);
    assert.match(log.at(-1), /2 self-hosted ValorBrain hook\(s\) \(context-surfacing, precompact-extract\).*npx -y @valorbrain\/connect --harness claude-code/);

    // A grok file of self-hosted hooks only: the heal of a grok credential leaves it.
    put(h, '.grok/hooks/valorbrain.json', GROK_SELF_HOSTED);
    const creds = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8'));
    creds.harnesses.grok = { token: 'vbm_test', api_url: url };
    writeFileSync(join(h, '.valorbrain', 'connect.json'), JSON.stringify(creds));
    await cli(h, url, ['heal', '--harness=grok']);
    server.close();
    assert.deepEqual(read(h, '.grok/hooks/valorbrain.json'), GROK_SELF_HOSTED);
});

// ── connect-state.json (review notes on cli#22) ─────────────────────────────

test('writeHealState is atomic: concurrent claimHeal writers never leave a reader with a torn file', async () => {
    const h = home();
    const clients = { kiro: { '/p/a': ['0.10.0'] } };
    writeHealState(h, { hook_clients: clients, written: { x: 'y' }, pad: 'z'.repeat(64 * 1024) });
    const hookUrl = new URL('../hook.mjs', import.meta.url).href;
    const writer = `const { claimHeal } = await import(${JSON.stringify(hookUrl)}); for (let i = 0; i < 300; i++) claimHeal(${JSON.stringify(h)}, { force: true });`;
    const kids = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', writer], { stdio: 'ignore' }));
    const done = Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
    let reads = 0;
    let finished = false;
    done.then(() => { finished = true; });
    while (!finished) {
        const s = readHealState(h);
        assert.deepEqual(s.hook_clients, clients, `read ${reads} saw a torn or emptied file`);
        reads++;
        await new Promise((r) => setImmediate(r));
    }
    assert.ok(reads > 10);
    assert.deepEqual(readHealState(h).hook_clients, clients);
    assert.deepEqual(readdirSync(join(h, '.valorbrain')).filter((f) => f.endsWith('.tmp')), []);
});

test('hook_clients is kept per harness and path: one scope never erases another, GC keeps both', () => {
    const h = home();
    const user = join(h, 'user-valorbrain.json');
    const project = join(h, 'project-valorbrain.json');
    writeFileSync(user, `node "${h}/.valorbrain/bin/connect/0.10.1/hook.mjs" hook stop`);
    writeFileSync(project, `node "${h}/.valorbrain/bin/connect/0.10.0/hook.mjs" hook stop`);
    for (const v of ['0.10.0', '0.10.1']) { mkdirSync(join(h, '.valorbrain', 'bin', 'connect', v), { recursive: true }); }
    recordHookClients(h, 'kiro', [project]);
    recordHookClients(h, 'kiro', [user]);
    assert.deepEqual(readHealState(h).hook_clients, { kiro: { [project]: ['0.10.0'], [user]: ['0.10.1'] } });
    const t = Date.now();
    gcLocalClients(h, { now: t });
    assert.deepEqual(gcLocalClients(h, { now: t + 48 * 3600_000 }), [], 'both scopes still run their version');
    // The project goes back to npx: only that path's record goes.
    writeFileSync(project, 'npx -y @valorbrain/connect@0.10.0 hook stop');
    recordHookClients(h, 'kiro', [project]);
    assert.deepEqual(readHealState(h).hook_clients, { kiro: { [user]: ['0.10.1'] } });
});
