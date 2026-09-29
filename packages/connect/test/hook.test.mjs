// Hook client, protocol v2 (ADR-058). Run: npm test (node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    acquireLock, detectDialect, fallbackCue, localDecide, readCreds, renderCheckpoint, renderContext,
    renderSilentStop, requestTimeoutMs, resolveCredentials, runHook, sessionKey, writeCreds, DEFAULT_POLICY,
} from '../hook.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-09-29T12:00:00Z');
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** A fake API: records calls, answers per path. */
function api(handlers = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const path = new URL(url).pathname;
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ path, body, headers: init?.headers || {} });
        const h = handlers[path];
        if (!h) return new Response('not found', { status: 404 });
        const r = await h(body);
        return r instanceof Response ? r : Response.json(r);
    };
    return { calls, fetchImpl };
}

function withCreds(h) {
    writeCreds(h, { api: 'https://api.example', token: 'vbm_secret' });
    return h;
}

async function run(argv, { h, payload = {}, env = {}, now = T0, fake }) {
    const out = [];
    const err = [];
    const code = await runHook(argv, {
        env, home: h, payload, now, fetchImpl: fake.fetchImpl,
        out: (s) => out.push(s), err: (s) => err.push(s),
    });
    return { code, out: out.join('\n'), err };
}

// ── dialects ───────────────────────────────────────────────────────────────

test('dialect comes from the payload before the file that invoked us', () => {
    // Cursor loads ~/.claude/settings.json; Grok loads ~/.cursor/hooks.json.
    assert.equal(detectDialect({ hook_event_name: 'stop' }, { CURSOR_VERSION: '2.1' }, 'claude-code'), 'cursor');
    assert.equal(detectDialect({ conversation_id: 'c', generation_id: 'g' }, {}, 'claude-code'), 'cursor');
    assert.equal(detectDialect({ hookEventName: 'stop', stopHookActive: false }, {}, 'cursor'), 'grok');
    assert.equal(detectDialect({ hook_event_name: 'AfterAgent' }, {}, ''), 'gemini');
    assert.equal(detectDialect({}, { GEMINI_SESSION_ID: 's' }, 'claude-code'), 'gemini');
    assert.equal(detectDialect({ hook_event_name: 'agentSpawn' }, {}, ''), 'kiro');
    assert.equal(detectDialect({ hook_event_name: 'stop', assistant_response: 'x' }, {}, ''), 'kiro');
    assert.equal(detectDialect({ hook_event_name: 'Stop' }, {}, 'codex'), 'codex');
    assert.equal(detectDialect({ hook_event_name: 'UserPromptSubmit' }, {}, ''), 'claude');
    assert.equal(detectDialect({ prompt: 'x' }, {}, 'opencode', 'text'), 'text');
});

test('context rendering per dialect', () => {
    assert.deepEqual(JSON.parse(renderContext('claude', 'prompt', 'CTX', { hook_event_name: 'UserPromptSubmit' })), {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CTX' },
    });
    // The event name follows the payload, so a mis-wired event still validates.
    assert.equal(JSON.parse(renderContext('codex', 'prompt', 'CTX', { hook_event_name: 'SessionStart' })).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(renderContext('claude', 'prompt', ''), '');
    assert.equal(JSON.parse(renderContext('gemini', 'prompt', 'CTX')).hookSpecificOutput.hookEventName, 'BeforeAgent');
    assert.equal(renderContext('gemini', 'prompt', ''), '{}');
    assert.deepEqual(JSON.parse(renderContext('cursor', 'session_start', 'CTX')), { additional_context: 'CTX' });
    assert.equal(renderContext('cursor', 'prompt', 'CTX'), '{}');
    assert.equal(renderContext('kiro', 'prompt', 'CTX'), 'CTX');
    assert.equal(renderContext('grok', 'session_start', 'CTX'), '');
});

test('checkpoint rendering per dialect', () => {
    assert.deepEqual(JSON.parse(renderCheckpoint('claude', 'CUE')), { decision: 'block', reason: 'CUE' });
    assert.deepEqual(JSON.parse(renderCheckpoint('kiro', 'CUE')), { decision: 'block', reason: 'CUE' });
    assert.deepEqual(JSON.parse(renderCheckpoint('gemini', 'CUE')), { decision: 'deny', reason: 'CUE' });
    assert.deepEqual(JSON.parse(renderCheckpoint('cursor', 'CUE')), { followup_message: 'CUE' });
    assert.equal(renderCheckpoint('text', 'CUE'), '');
    assert.equal(renderSilentStop('gemini'), '{}');
    assert.equal(renderSilentStop('claude'), '');
    assert.match(fallbackCue('mcp_valorbrain_'), /`mcp_valorbrain_memory_store`/);
});

// ── credentials ────────────────────────────────────────────────────────────

test('credentials: file is 0600, precedence argv > env > connect.json > config.json', () => {
    const h = home();
    const path = writeCreds(h, { api: 'https://api.example/mcp', token: 'vbm_file' });
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readCreds(h), { token: 'vbm_file', api: 'https://api.example' });
    assert.equal(resolveCredentials({ argv: [], env: {}, home: h }).source, 'connect');
    assert.equal(resolveCredentials({ argv: [], env: { VALORBRAIN_TOKEN: 'vbm_env' }, home: h }).token, 'vbm_env');
    assert.equal(resolveCredentials({ argv: ['--token=vbm_argv'], env: { VALORBRAIN_TOKEN: 'vbm_env' }, home: h }).source, 'argv');
    const onlyCli = home();
    mkdirSync(join(onlyCli, '.valorbrain'), { recursive: true });
    writeFileSync(join(onlyCli, '.valorbrain', 'config.json'), JSON.stringify({ api_key: 'vb_cli', engine_url: 'https://engine.example/' }));
    assert.deepEqual(resolveCredentials({ argv: [], env: {}, home: onlyCli }), { token: 'vb_cli', api: 'https://engine.example', source: 'config' });
    assert.equal(resolveCredentials({ argv: [], env: {}, home: home() }).token, null);
});

// ── context moments ────────────────────────────────────────────────────────

test('prompt: LLM-free cue, token only in the Authorization header', async () => {
    const h = withCreds(home());
    const fake = api({ '/api/v1/hooks/cue': () => ({ ok: true, context: '<vault-context>x</vault-context>', policy: DEFAULT_POLICY }) });
    const r = await run(['prompt', '--harness=claude-code'], {
        h, fake, payload: { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'how do we deploy?' },
    });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).hookSpecificOutput.additionalContext, '<vault-context>x</vault-context>');
    const call = fake.calls[0];
    assert.equal(call.path, '/api/v1/hooks/cue');
    assert.deepEqual(call.body, { harness: 'claude-code', session_id: 's1', event: 'prompt', prompt: 'how do we deploy?' });
    assert.equal(call.headers.authorization, 'Bearer vbm_secret');
    assert.ok(!JSON.stringify(call.body).includes('vbm_secret'));
});

test('older engine: cue 404 falls back to memory_prepare and is remembered', async () => {
    const h = withCreds(home());
    const fake = api({
        '/mcp': () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'legacy ctx' }] } }),
    });
    const payload = { hook_event_name: 'userPromptSubmit', session_id: 'k1', prompt: 'status?' };
    const a = await run(['prompt', '--harness=kiro'], { h, fake, payload });
    assert.equal(a.out, 'legacy ctx');
    assert.deepEqual(fake.calls.map((c) => c.path), ['/api/v1/hooks/cue', '/mcp']);
    const b = await run(['prompt', '--harness=kiro'], { h, fake, payload, now: T0 + MIN });
    assert.equal(b.out, 'legacy ctx');
    assert.deepEqual(fake.calls.map((c) => c.path), ['/api/v1/hooks/cue', '/mcp', '/mcp']);
});

test('grok and cursor prompts cost no request (they cannot inject)', async () => {
    const h = withCreds(home());
    const fake = api({ '/api/v1/hooks/cue': () => ({ context: 'never' }) });
    await run(['session-start'], { h, fake, payload: { hookEventName: 'session_start', sessionId: 'g' } });
    await run(['prompt'], { h, fake, payload: { conversation_id: 'c', generation_id: 'g1', prompt: 'x' } });
    assert.equal(fake.calls.length, 0);
});

test('no credentials: silent, one stderr line, exit 0', async () => {
    const fake = api();
    const r = await run(['prompt', '--harness=kiro'], { h: home(), fake, payload: { prompt: 'x' } });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err.length, 1);
    assert.equal(fake.calls.length, 0);
});

// ── stop: the checkpoint ───────────────────────────────────────────────────

function stopApi(over = {}) {
    return api({
        '/api/v1/hooks/cue': (body) => (body.event === 'stop'
            ? { ok: true, checkpoint: { text: 'CUE', version: '1' }, verdict: { fire: true, why: 'due' }, policy: DEFAULT_POLICY, ...over }
            : { ok: true, context: '', policy: DEFAULT_POLICY }),
    });
}

test('kiro: checkpoint after enough work, and its continuation is not checkpointed', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const stop = { hook_event_name: 'stop', session_id: 'k-sess', assistant_response: 'done' };
    await run(['session-start', '--harness=kiro'], { h, fake, payload: { hook_event_name: 'agentSpawn', session_id: 'k-sess' } });
    // Two turns: not enough work, and no request spent deciding that.
    for (const t of [1, 2]) {
        const r = await run(['stop', '--harness=kiro'], { h, fake, payload: stop, now: T0 + t * MIN });
        assert.equal(r.out, '');
    }
    assert.equal(fake.calls.filter((c) => c.body?.event === 'stop').length, 0);
    // Third turn after the interval: due → block with the server's cue.
    const fire = await run(['stop', '--harness=kiro'], { h, fake, payload: stop, now: T0 + 11 * MIN });
    assert.deepEqual(JSON.parse(fire.out), { decision: 'block', reason: 'CUE' });
    const sent = fake.calls.find((c) => c.body?.event === 'stop').body.state;
    assert.equal(sent.turns, 3);
    assert.equal(sent.session_started_at, T0);
    // Kiro has no stop_hook_active: the next Stop is our continuation → silent.
    const cont = await run(['stop', '--harness=kiro'], { h, fake, payload: stop, now: T0 + 12 * MIN });
    assert.equal(cont.out, '');
    // And a fresh stretch of work starts from zero.
    for (const t of [13, 14]) {
        const r = await run(['stop', '--harness=kiro'], { h, fake, payload: stop, now: T0 + t * MIN });
        assert.equal(r.out, '');
    }
});

test('claude: stop_hook_active is never checkpointed, even when due', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const base = { hook_event_name: 'Stop', session_id: 'c-sess' };
    for (const t of [1, 2, 3]) await run(['stop', '--harness=claude-code'], { h, fake, payload: { ...base, stop_hook_active: true }, now: T0 + t * 11 * MIN });
    assert.equal(fake.calls.length, 0);
});

test('a long single turn is enough work', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const s = { session_id: 'long', hook_event_name: 'UserPromptSubmit', prompt: 'refactor everything' };
    await run(['prompt', '--harness=claude-code'], { h, fake, payload: s, now: T0 });
    const r = await run(['stop', '--harness=claude-code'], { h, fake, payload: { session_id: 'long', hook_event_name: 'Stop' }, now: T0 + 12 * MIN });
    assert.deepEqual(JSON.parse(r.out), { decision: 'block', reason: 'CUE' });
});

test('server says the agent already wrote memory: no nudge, counters restart', async () => {
    const h = withCreds(home());
    const fake = stopApi({ checkpoint: null, reset: true, verdict: { fire: false, why: 'recent_writes' } });
    const p = { hook_event_name: 'Stop', session_id: 'w' };
    for (const t of [1, 2]) await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + t * MIN });
    const r = await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + 11 * MIN });
    assert.equal(r.out, '');
    // Reset: the next two stops are not due, so no further stop requests.
    const before = fake.calls.length;
    for (const t of [12, 13]) await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + t * MIN });
    assert.equal(fake.calls.length, before);
});

test('older engine at stop: built-in cue with the harness tool prefix', async () => {
    const h = withCreds(home());
    const fake = api(); // everything 404
    const p = { hook_event_name: 'stop', session_id: 'old', assistant_response: 'x' };
    for (const t of [1, 2]) await run(['stop', '--harness=kiro'], { h, fake, payload: p, now: T0 + t * MIN });
    const r = await run(['stop', '--harness=kiro'], { h, fake, payload: p, now: T0 + 11 * MIN });
    const out = JSON.parse(r.out);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /`mcp_valorbrain_memory_store`/);
});

test('network failure at stop: silent, counters kept for the next stop', async () => {
    const h = withCreds(home());
    let fail = true;
    const fake = api({ '/api/v1/hooks/cue': () => { if (fail) throw new Error('ECONNRESET'); return { checkpoint: { text: 'CUE' }, policy: DEFAULT_POLICY }; } });
    const p = { hook_event_name: 'Stop', session_id: 'net' };
    for (const t of [1, 2]) await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + t * MIN });
    const a = await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + 11 * MIN });
    assert.equal(a.out, '');
    assert.equal(a.err.length, 1);
    fail = false;
    const b = await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + 12 * MIN });
    assert.deepEqual(JSON.parse(b.out), { decision: 'block', reason: 'CUE' });
});

test('cursor: followup_message; aborted turns and duplicate deliveries do not count', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const p = (gen, status = 'completed') => ({ hook_event_name: 'stop', conversation_id: 'conv', generation_id: gen, status, loop_count: 0 });
    await run(['stop'], { h, fake, payload: p('g1'), now: T0 + MIN });
    await run(['stop'], { h, fake, payload: p('g1'), now: T0 + MIN });            // same Stop via Claude's file
    await run(['stop'], { h, fake, payload: p('g2', 'aborted'), now: T0 + 2 * MIN }); // not a completion
    await run(['stop'], { h, fake, payload: p('g3'), now: T0 + 3 * MIN });
    const notYet = await run(['stop'], { h, fake, payload: p('g4'), now: T0 + 4 * MIN });
    assert.equal(notYet.out, '{}'); // 3 genuine turns, but inside the 10 min interval
    const fire = await run(['stop'], { h, fake, payload: p('g5'), now: T0 + 11 * MIN });
    assert.deepEqual(JSON.parse(fire.out), { followup_message: 'CUE' });
});

test('gemini: deny with the cue; silent stop still prints JSON', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const p = { hook_event_name: 'AfterAgent', session_id: 'gem', prompt: 'x', prompt_response: 'y' };
    const first = await run(['stop', '--harness=gemini-cli'], { h, fake, payload: p, now: T0 + MIN });
    assert.equal(first.out, '{}');
    await run(['stop', '--harness=gemini-cli'], { h, fake, payload: p, now: T0 + 2 * MIN });
    const fire = await run(['stop', '--harness=gemini-cli'], { h, fake, payload: p, now: T0 + 11 * MIN });
    assert.deepEqual(JSON.parse(fire.out), { decision: 'deny', reason: 'CUE' });
    const retry = await run(['stop', '--harness=gemini-cli'], { h, fake, payload: { ...p, stop_hook_active: true }, now: T0 + 12 * MIN });
    assert.equal(retry.out, '{}');
});

test('grok: only end_turn stops count; the session-end Stop is ignored', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const p = (reason) => ({ hookEventName: 'stop', sessionId: 'gk', stopHookActive: false, reason });
    for (const t of [1, 2]) await run(['stop'], { h, fake, payload: p('end_turn'), now: T0 + t * MIN });
    const end = await run(['stop'], { h, fake, payload: p('shutdown'), now: T0 + 11 * MIN });
    assert.equal(end.out, '');
    const fire = await run(['stop'], { h, fake, payload: p('end_turn'), now: T0 + 12 * MIN });
    assert.deepEqual(JSON.parse(fire.out), { decision: 'block', reason: 'CUE' });
});

test('a Stop already owned by another process is left alone', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const p = { hook_event_name: 'Stop', session_id: 'locked' };
    const key = sessionKey('claude', p, {});
    assert.ok(acquireLock(h, key, T0));
    const r = await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + MIN });
    assert.equal(r.out, '');
    assert.ok(!existsSync(join(h, '.valorbrain', 'state', 'hooks', `${key}.json`)));
});

test('localDecide mirrors the server policy', () => {
    const s = { turns: 3, busyMs: 0, checkpoints: 0, createdAt: T0, lastCheckpointAt: null };
    assert.equal(localDecide(s, DEFAULT_POLICY, T0 + 11 * MIN), true);
    assert.equal(localDecide(s, DEFAULT_POLICY, T0 + 5 * MIN), false);
    assert.equal(localDecide({ ...s, checkpoints: 6 }, DEFAULT_POLICY, T0 + 11 * MIN), false);
    assert.equal(localDecide(s, { ...DEFAULT_POLICY, max_per_session: 0 }, T0 + 11 * MIN), false);
    assert.equal(localDecide({ ...s, turns: 1, busyMs: 9 * MIN }, DEFAULT_POLICY, T0 + 11 * MIN), true);
});

test('state files are private', async () => {
    if (process.platform === 'win32') return;
    const h = withCreds(home());
    const fake = stopApi();
    const p = { hook_event_name: 'Stop', session_id: 'perm' };
    await run(['stop', '--harness=claude-code'], { h, fake, payload: p, now: T0 + MIN });
    const key = sessionKey('claude', p, {});
    const file = join(h, '.valorbrain', 'state', 'hooks', `${key}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).turns, 1);
});


test('VALORBRAIN_CHECKPOINT=off on the machine: stop is silent and costs nothing', async () => {
    const h = withCreds(home());
    const fake = stopApi();
    const p = { hook_event_name: 'Stop', session_id: 'off' };
    for (const t of [1, 2, 3, 11]) {
        const r = await run(['stop', '--harness=claude-code'], { h, fake, payload: p, env: { VALORBRAIN_CHECKPOINT: 'off' }, now: T0 + t * MIN });
        assert.equal(r.out, '');
    }
    assert.equal(fake.calls.length, 0);
});

// ── request budget (VAL-195, ressalva do Qa) ────────────────────────────────

test('context requests fit the harness 10s cut: cold npx ~3.4s + ≤4s of network', () => {
    assert.equal(requestTimeoutMs('prompt', {}), 4000);
    assert.equal(requestTimeoutMs('session_start', {}), 4000);
    assert.equal(requestTimeoutMs('stop', {}), 4000);
    assert.ok(3_400 + requestTimeoutMs('prompt', {}) < 10_000);
    // escape hatch for slow private networks still wins
    assert.equal(requestTimeoutMs('prompt', { VALORBRAIN_HOOK_TIMEOUT_MS: '9000' }), 9000);
});

test('prompt persists turn bookkeeping before the network call (a killed hook must not lose it)', async () => {
    const h = withCreds(home());
    let fetchSeen;
    let killFetch;
    const seen = new Promise((r) => { fetchSeen = r; });
    // A fetch that never answers while it runs — the window between the call
    // starting and the harness killing us. We settle it by hand afterwards:
    // deterministic, no real-timer dependency.
    const settled = runHook(['prompt', '--harness=kiro'], {
        env: { VALORBRAIN_HOOK_TIMEOUT_MS: '30' },
        home: h,
        payload: { hook_event_name: 'UserPromptSubmit', session_id: 'kill-1', prompt: 'olá' },
        now: T0,
        fetchImpl: () => new Promise((_, reject) => {
            fetchSeen();
            killFetch = () => reject(new Error('killed mid-request'));
        }),
        out: () => {}, err: () => {},
    });
    await seen;
    const key = sessionKey('kiro', { session_id: 'kill-1' }, {});
    const st = JSON.parse(readFileSync(join(h, '.valorbrain', 'state', 'hooks', `${key}.json`), 'utf-8'));
    assert.equal(st.turnStartedAt, T0);
    assert.equal(st.awaiting, false);
    killFetch();
    await settled;
});
