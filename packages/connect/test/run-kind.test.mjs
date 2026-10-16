// Run kind (ADR-084): a hook declares `x-run-kind: routine` only when its
// harness says the run is not a person's session. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_POLICY, runHook, uploadTranscript, writeCreds } from '../hook.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-16T12:00:00Z');
const homes = [];
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const HARNESSES = ['claude-code', 'codex', 'kiro', 'gemini-cli', 'cursor', 'omp', 'hermes'];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-run-kind-'));
    homes.push(h);
    for (const harness of HARNESSES) writeCreds(h, { api: 'https://api.example', token: 'vbm_secret', harness });
    return h;
}

function api() {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const path = new URL(url).pathname;
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ path, body, headers: init?.headers || {} });
        if (path === '/api/v1/hooks/cue') {
            return Response.json(body?.event === 'stop'
                ? { ok: true, checkpoint: { text: 'CUE', version: '1' }, policy: DEFAULT_POLICY }
                : { ok: true, context: 'ctx', policy: DEFAULT_POLICY });
        }
        if (path === '/api/v1/hooks/run') return Response.json({ ok: true });
        if (path === '/mcp') return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'legacy' }] } });
        return new Response('not found', { status: 404 });
    };
    return { calls, fetchImpl };
}

async function hook(argv, { h = home(), fake = api(), payload = {}, env = {}, ancestors = [], now = T0 } = {}) {
    await runHook(argv, {
        env, home: h, payload, now, fetchImpl: fake.fetchImpl, ancestors,
        spawnSyncImpl: () => { throw new Error('ps must not run: ancestors are given'); },
        out: () => {}, err: () => {},
    });
    return fake.calls;
}

/** The x-run-kind of the single request a prompt hook made. */
async function promptRunKind(harness, payload, opts = {}) {
    const calls = await hook(['prompt', `--harness=${harness}`], { payload: { session_id: 's', prompt: 'how do we deploy?', ...payload }, ...opts });
    assert.equal(calls.length, 1, `${harness}: one request`);
    return calls[0].headers['x-run-kind'];
}

const claudePrompt = { hook_event_name: 'UserPromptSubmit' };

test('claude code: SDK/MCP and unattended sessions are routine; attended beats the entrypoint; an attended CLI session sends none', async () => {
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }), 'routine');
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }), 'routine');
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'mcp' } }), 'routine');
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '0' } }), 'routine');
    // Hook env (engine rule): whether a person attends beats the entrypoint name.
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SESSION_ATTENDED: '1' } }), undefined);
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1' } }), undefined);
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { CLAUDE_CODE_ENTRYPOINT: 'mcp-server' } }), undefined);
    assert.equal(await promptRunKind('claude-code', claudePrompt), undefined);
    // The same signals forwarded in a payload.
    assert.equal(await promptRunKind('hermes', { session_attended: '0' }), 'routine');
    assert.equal(await promptRunKind('hermes', { entrypoint: 'sdk-py' }), 'routine');
    assert.equal(await promptRunKind('hermes', { session_attended: '1', entrypoint: 'cli' }), undefined);
});

test('omp: a print/json run is routine; a tui session sends no run kind', async () => {
    assert.equal(await promptRunKind('omp', { run_mode: 'print' }), 'routine');
    assert.equal(await promptRunKind('omp', { mode: 'json' }), 'routine');
    assert.equal(await promptRunKind('omp', { runMode: 'tui' }), undefined);
    assert.equal(await promptRunKind('omp', {}), undefined);
});

test('hermes: cron and scheduled/call sources are routine, webhook is pipeline; pieces of another run send none', async () => {
    assert.equal(await promptRunKind('hermes', { agent_context: 'cron' }), 'routine');
    for (const source of ['oneshot', 'cron', 'batch', 'kanban', 'api']) {
        assert.equal(await promptRunKind('hermes', { session_source: source }), 'routine', source);
    }
    assert.equal(await promptRunKind('hermes', { sessionSource: 'batch' }), 'routine');
    assert.equal(await promptRunKind('hermes', { session_source: 'webhook' }), 'pipeline');
    assert.equal(await promptRunKind('hermes', { agent_context: 'cron', session_source: 'webhook' }), 'pipeline');
    for (const context of ['flush', 'subagent']) {
        assert.equal(await promptRunKind('hermes', { agent_context: context }), undefined, context);
    }
    for (const source of ['subagent', 'flush', 'tool', 'a2a']) {
        assert.equal(await promptRunKind('hermes', { session_source: source }), undefined, source);
    }
    assert.equal(await promptRunKind('hermes', { agent_context: 'primary', session_source: 'cli' }), undefined);
});

test('gemini in CI, kiro --no-interactive and cursor -p are routine; their interactive runs send none', async () => {
    const gemini = { hook_event_name: 'BeforeAgent' };
    assert.equal(await promptRunKind('gemini-cli', gemini, { env: { CI: 'true' } }), 'routine');
    assert.equal(await promptRunKind('gemini-cli', gemini, { ancestors: ['/usr/bin/node /opt/gemini -p rename'] }), 'routine');
    assert.equal(await promptRunKind('gemini-cli', gemini, { ancestors: ['/usr/bin/node /opt/gemini'] }), undefined);
    const kiro = { hook_event_name: 'userPromptSubmit' };
    assert.equal(await promptRunKind('kiro', kiro, { ancestors: ['kiro-cli chat --no-interactive fix it'] }), 'routine');
    assert.equal(await promptRunKind('kiro', kiro, { ancestors: ['kiro-cli chat'] }), undefined);
    // Cursor injects at session start only.
    const cursorStart = async (ancestors) => {
        const calls = await hook(['session-start', '--harness=cursor'], { payload: { hook_event_name: 'sessionStart', conversation_id: 'c' }, ancestors });
        assert.equal(calls.length, 1);
        return calls[0].headers['x-run-kind'];
    };
    assert.equal(await cursorStart(['/home/u/.local/bin/cursor-agent -p --output-format json rename']), 'routine');
    assert.equal(await cursorStart(['/home/u/.local/bin/cursor-agent']), undefined);
});

test('codex: an exec/SDK rollout is routine; an interactive one or a sub-agent thread sends none', async () => {
    const h = home();
    const rollout = (name, meta) => {
        const p = join(h, `${name}.jsonl`);
        writeFileSync(p, `${JSON.stringify({ type: 'session_meta', payload: meta })}\n`);
        return p;
    };
    const codex = (transcript_path) => promptRunKind('codex', { hook_event_name: 'UserPromptSubmit', transcript_path }, { h });
    assert.equal(await codex(rollout('exec', { source: 'exec', originator: 'codex_exec' })), 'routine');
    assert.equal(await codex(rollout('sdk', { source: 'vscode', originator: 'codex_sdk_ts' })), 'routine');
    assert.equal(await codex(rollout('tui', { source: 'cli', originator: 'codex_cli_rs' })), undefined);
    assert.equal(await codex(rollout('sub', { source: { subagent: { thread_spawn: {} } }, originator: 'codex_exec' })), undefined);
    assert.equal(await codex(join(h, 'missing.jsonl')), undefined);
});

test('VALORBRAIN_RUN_KIND wins over inference; an invalid value is ignored', async () => {
    const sdk = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { ...sdk, VALORBRAIN_RUN_KIND: 'pipeline' } }), 'pipeline');
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { ...sdk, VALORBRAIN_RUN_KIND: 'conversation' } }), 'conversation');
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { VALORBRAIN_RUN_KIND: ' Routine ' } }), 'routine');
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { VALORBRAIN_RUN_KIND: 'cron' } }), undefined);
    assert.equal(await promptRunKind('claude-code', claudePrompt, { env: { ...sdk, VALORBRAIN_RUN_KIND: 'cron' } }), 'routine');
});

test('requester and team come from the env, folded to header-safe ASCII; absent when unset', async () => {
    const calls = await hook(['prompt', '--harness=claude-code'], {
        payload: { ...claudePrompt, session_id: 's', prompt: 'deploy?' },
        env: { VALORBRAIN_REQUESTED_BY: '  Joana Ação  ', VALORBRAIN_AGENT_TEAM: 'ops,growth' },
    });
    assert.equal(calls[0].headers['x-requested-by'], 'Joana Acao');
    assert.equal(calls[0].headers['x-agent-team'], 'ops,growth');
    const long = await hook(['prompt', '--harness=claude-code'], {
        payload: { ...claudePrompt, session_id: 's', prompt: 'deploy?' }, env: { VALORBRAIN_REQUESTED_BY: 'r'.repeat(300) },
    });
    assert.equal(long[0].headers['x-requested-by'], 'r'.repeat(120));
    const none = await hook(['prompt', '--harness=claude-code'], { payload: { ...claudePrompt, session_id: 's', prompt: 'deploy?' } });
    assert.equal('x-requested-by' in none[0].headers, false);
    assert.equal('x-agent-team' in none[0].headers, false);
    assert.equal('x-run-kind' in none[0].headers, false);
});

test('the run kind rides on extraction, the legacy MCP fallback and the stop checkpoint too', async () => {
    const sdk = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    const extraction = await hook(['decision-extractor', '--harness=claude-code'], { payload: { session_id: 's', hook_event_name: 'Stop' }, env: sdk });
    assert.equal(extraction[0].path, '/api/v1/hooks/run');
    assert.equal(extraction[0].headers['x-run-kind'], 'routine');

    // An engine without the cue: the prompt falls back to memory_prepare over /mcp.
    const legacy = api();
    const fetchImpl = legacy.fetchImpl;
    legacy.fetchImpl = async (url, init) => (new URL(url).pathname === '/api/v1/hooks/cue'
        ? (legacy.calls.push({ path: '/api/v1/hooks/cue', headers: init.headers }), new Response('no', { status: 404 }))
        : fetchImpl(url, init));
    const calls = await hook(['prompt', '--harness=omp'], { fake: legacy, payload: { session_id: 's', prompt: 'deploy?', run_mode: 'print' } });
    assert.deepEqual(calls.map((c) => c.path), ['/api/v1/hooks/cue', '/mcp']);
    assert.equal(calls[1].headers['x-run-kind'], 'routine');

    // A due checkpoint of a scripted kiro run.
    const h = home();
    const fake = api();
    const scripted = ['kiro-cli chat --no-interactive fix it'];
    const stop = { hook_event_name: 'stop', session_id: 'k', assistant_response: 'done' };
    await hook(['session-start', '--harness=kiro'], { h, fake, payload: { hook_event_name: 'agentSpawn', session_id: 'k' }, ancestors: scripted });
    for (const t of [1, 2, 11]) await hook(['stop', '--harness=kiro'], { h, fake, payload: stop, ancestors: scripted, now: T0 + t * MIN });
    const checkpoint = fake.calls.find((c) => c.body?.event === 'stop');
    assert.ok(checkpoint, 'the checkpoint was asked for');
    assert.equal(checkpoint.headers['x-run-kind'], 'routine');
});

test('transcript uploader: only the operator env declares the run kind, requester and team', async () => {
    const h = home();
    const transcript = join(h, 't.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const argv = ['--harness=claude-code', '--session=s', `--transcript=${transcript}`];
    const seen = [];
    const fetchImpl = async (_url, init) => { seen.push(init.headers); return new Response('{"ok":true}'); };
    await uploadTranscript(argv, { env: { VALORBRAIN_RUN_KIND: 'pipeline', VALORBRAIN_REQUESTED_BY: 'Ops Bot', VALORBRAIN_AGENT_TEAM: 'ops' }, home: h, fetchImpl, now: T0 });
    assert.equal(seen.length, 2);
    for (const headers of seen) {
        assert.equal(headers['x-run-kind'], 'pipeline');
        assert.equal(headers['x-requested-by'], 'Ops Bot');
        assert.equal(headers['x-agent-team'], 'ops');
    }
    seen.length = 0;
    await uploadTranscript(argv, { env: {}, home: h, fetchImpl, now: T0 });
    for (const headers of seen) assert.equal('x-run-kind' in headers, false);
});
