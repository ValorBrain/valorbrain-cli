// connect 0.12.0 — the Stop-hook transcript upload for Codex, Gemini CLI, Kiro,
// Cursor and OpenCode, and Claude Code's attended signal. Fixtures in
// fixtures/transcripts/ keep the harnesses' real payload and file shapes
// (captured from codex-cli 0.160.0 and kiro-cli 2.20.1 --v3 runs, the
// gemini-cli 0.43.0 and cursor-agent 2026.05.20 bundles, the OpenCode
// plugin's contract), trimmed and with synthetic conversation text.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    STOP_TRANSCRIPT_HARNESSES, ancestorCommands, ancestorsFromTable, cursorProjectSlug, headlessRun,
    runHook, setPrivacy, uploadTranscript, writeCreds,
} from '../hook.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T12:00:00Z');
const FX = new URL('./fixtures/transcripts/', import.meta.url).pathname;
const homes = [];
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** A home where `harness` is connected with the transcript opt-in on. */
function home(harness) {
    const h = mkdtempSync(join(tmpdir(), 'vb-harness-transcript-'));
    homes.push(h);
    writeCreds(h, { api: 'https://api.example', token: 'vbm_secret', harness });
    setPrivacy(h, harness, { send_transcript: true });
    return h;
}

/** A fixture file copied to `dest`. */
function place(name, dest) {
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(join(FX, name), dest);
    return dest;
}

/** A Stop payload fixture with its placeholders filled. */
function payload(name, fill = {}) {
    let text = readFileSync(join(FX, name), 'utf-8');
    for (const [k, v] of Object.entries(fill)) text = text.replaceAll(`<${k}>`, v);
    return JSON.parse(text);
}

// What `ps` shows above the hook, nearest first (the hook's shell, then the harness).
const LAUNCHER = 'node /home/u/.valorbrain/bin/connect/launcher.mjs hook stop';
const GEMINI = 'node --max-old-space-size=8192 /usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js';
const KIRO_ACP = 'node /home/u/.local/share/kiro-cli/kas/2.20.1/node_modules/@kiro/agent/dist/server/acp-server.js';
const CURSOR = '/home/u/.local/share/cursor-agent/versions/2026.05.20-2b5dd59/node --use-system-ca /home/u/.local/share/cursor-agent/versions/2026.05.20-2b5dd59/index.js';
const INTERACTIVE = {
    'gemini-cli': [`${LAUNCHER} --harness=gemini-cli`, `${GEMINI} --approval-mode yolo`, '-bash'],
    kiro: [`${LAUNCHER} --harness=kiro`, KIRO_ACP, 'kiro-cli-chat chat --v3', 'kiro-cli', '-bash'],
    cursor: [`${LAUNCHER} --harness=cursor`, CURSOR, '-bash'],
};

/**
 * Stops through runHook, `stops` times, a minute apart (the transcript grows
 * before each); returns every uploader spawn asked for.
 */
async function stops(h, harness, p, { transcript, env = {}, ancestors = INTERACTIVE[harness] ?? [], count = 3, start = T0 } = {}) {
    const spawned = [];
    for (let i = 0; i < count; i++) {
        if (transcript) appendFileSync(transcript, '\n');
        const stopPayload = typeof p === 'function' ? p(i) : p;
        await runHook(['stop', `--harness=${harness}`], {
            env: { VALORBRAIN_CHECKPOINT: 'off', ...env }, home: h, now: start + i * MIN,
            payload: stopPayload,
            fetchImpl: async () => new Response('{}'),
            out: () => {}, err: () => {},
            spawnImpl: (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; },
            spawnSyncImpl: () => { throw new Error('ps must not run: ancestors are given'); },
            ancestors,
            self: '/x/hook.mjs',
        });
    }
    return spawned;
}

const upload = (harness, session, transcript, cwd = '/work/proj', extra = []) =>
    [process.execPath, '/x/hook.mjs', 'transcript-upload', `--harness=${harness}`, `--session=${session}`, `--transcript=${transcript}`, `--cwd=${cwd}`, ...extra];

test('--transcript is accepted for every harness whose Stop now uploads', () => {
    assert.deepEqual([...STOP_TRANSCRIPT_HARNESSES].sort(), ['claude-code', 'codex', 'cursor', 'gemini-cli', 'grok', 'kiro', 'opencode']);
});

// ── Codex ────────────────────────────────────────────────────────────────────

test('codex: a due Stop of an interactive session (rollout source "cli") spawns the uploader', async () => {
    const h = home('codex');
    const rollout = place('codex-rollout-cli.jsonl', join(h, '.codex', 'sessions', '2026', '09', '20', 'rollout-cli.jsonl'));
    const p = (i) => ({ ...payload('codex-stop.json', { TRANSCRIPT: rollout }), turn_id: `turn-${i}` });
    assert.deepEqual(await stops(h, 'codex', p, { transcript: rollout }), [upload('codex', '01a13b7a-ea47-74f3-bd31-6d6df60189fe', rollout)]);
});

test('codex: `codex exec`, sub-agent threads and SDK clients never upload', async () => {
    for (const [name, rewrite] of [
        ['codex-rollout-exec.jsonl', null],
        ['codex-rollout-subagent.jsonl', null],
        // The app-server driven by an SDK (Multica's agent SDK, the Codex SDK's originator).
        ['codex-rollout-cli.jsonl', (m) => ({ ...m, payload: { ...m.payload, source: 'vscode', originator: 'multica-agent-sdk' } })],
        // A file that does not start with session_meta is not classified as a person's session.
        ['codex-rollout-cli.jsonl', () => ({ type: 'response_item', payload: {} })],
    ]) {
        const h = home('codex');
        const rollout = place(name, join(h, 'rollout.jsonl'));
        if (rewrite) {
            const [first, ...rest] = readFileSync(rollout, 'utf-8').split('\n');
            writeFileSync(rollout, [JSON.stringify(rewrite(JSON.parse(first))), ...rest].join('\n'));
        }
        const p = (i) => ({ ...payload('codex-stop.json', { TRANSCRIPT: rollout }), turn_id: `turn-${i}` });
        assert.deepEqual(await stops(h, 'codex', p, { transcript: rollout, count: 5 }), [], name);
        // Control: the same home and payload over a person's rollout uploads.
        const person = place('codex-rollout-cli.jsonl', join(h, 'rollout-person.jsonl'));
        const q = (i) => ({ ...payload('codex-stop.json', { TRANSCRIPT: person }), session_id: 'person', turn_id: `person-${i}` });
        assert.equal((await stops(h, 'codex', q, { transcript: person })).length, 1, `${name}: control`);
    }
});

// ── Gemini CLI ───────────────────────────────────────────────────────────────

test('gemini: a due AfterAgent of an interactive session spawns the uploader', async () => {
    const h = home('gemini-cli');
    const session = place('gemini-session-main.jsonl', join(h, '.gemini', 'tmp', 'proj', 'chats', 'session-2026-10-14T17-36-52e7a217.jsonl'));
    const p = payload('gemini-after-agent.json', { TRANSCRIPT: session });
    assert.deepEqual(await stops(h, 'gemini-cli', p, { transcript: session }), [upload('gemini-cli', p.session_id, session)]);
    // `-i "query"` is interactive too.
    const h2 = home('gemini-cli');
    const s2 = place('gemini-session-main.jsonl', join(h2, 'session.jsonl'));
    const withQuery = [`${LAUNCHER} --harness=gemini-cli`, `${GEMINI} -i rename the helper`];
    assert.equal((await stops(h2, 'gemini-cli', payload('gemini-after-agent.json', { TRANSCRIPT: s2 }), { transcript: s2, ancestors: withQuery })).length, 1);
});

test('gemini: -p, a query argument, CI and sub-agent sessions never upload', async () => {
    const cases = [
        ['-p', { ancestors: [`${LAUNCHER} --harness=gemini-cli`, `${GEMINI} -p rename the helper`] }],
        ['--prompt=', { ancestors: [`${LAUNCHER} --harness=gemini-cli`, `${GEMINI} --prompt=rename`] }],
        ['query argument', { ancestors: [`${LAUNCHER} --harness=gemini-cli`, `${GEMINI} -m gemini-3-pro rename the helper`] }],
        ['CI', { env: { CI: 'true' } }],
        ['GitHub Actions', { env: { GITHUB_ACTIONS: 'true' } }],
        ['sub-agent', { file: 'gemini-session-subagent.jsonl' }],
    ];
    for (const [label, { ancestors = INTERACTIVE['gemini-cli'], env = {}, file = 'gemini-session-main.jsonl' }] of cases) {
        const h = home('gemini-cli');
        const session = place(file, join(h, 'session.jsonl'));
        const p = payload('gemini-after-agent.json', { TRANSCRIPT: session });
        assert.deepEqual(await stops(h, 'gemini-cli', p, { transcript: session, ancestors, env, count: 5 }), [], label);
        const person = place('gemini-session-main.jsonl', join(h, 'person.jsonl'));
        const q = { ...payload('gemini-after-agent.json', { TRANSCRIPT: person }), session_id: 'person' };
        assert.equal((await stops(h, 'gemini-cli', q, { transcript: person })).length, 1, `${label}: control`);
    }
});

test('gemini: a whole-file JSON session over the 8 MiB cap is not cut, so not sent', async () => {
    const h = home('gemini-cli');
    const session = join(h, 'session-legacy.json');
    writeFileSync(session, JSON.stringify({ sessionId: 's', projectHash: 'p', kind: 'main', messages: [{ type: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] }, null, 2));
    const p = payload('gemini-after-agent.json', { TRANSCRIPT: session });
    assert.deepEqual(await stops(h, 'gemini-cli', p, { transcript: session, count: 4 }), []);
    const small = join(h, 'session-small.json');
    writeFileSync(small, JSON.stringify({ sessionId: 's2', projectHash: 'p', kind: 'main', messages: [{ type: 'user', content: 'x' }] }, null, 2));
    const q = { ...payload('gemini-after-agent.json', { TRANSCRIPT: small }), session_id: 's2' };
    assert.equal((await stops(h, 'gemini-cli', q, { transcript: small })).length, 1, 'control: under the cap, sent whole');
});

// ── Kiro ─────────────────────────────────────────────────────────────────────

test('kiro (v3): the Stop names only the session; its messages.jsonl is found and uploaded', async () => {
    const h = home('kiro');
    const p = payload('kiro-v3-stop.json');
    const dir = createHash('sha256').update(p.cwd).digest('hex').slice(0, 16);
    const messages = place('kiro-v3-messages.jsonl', join(h, '.kiro', 'sessions', dir, p.session_id, 'messages.jsonl'));
    assert.deepEqual(await stops(h, 'kiro', p, { transcript: messages }), [upload('kiro', p.session_id, messages)]);
    // Session started in another directory than the Stop's cwd: still found.
    const h2 = home('kiro');
    const elsewhere = place('kiro-v3-messages.jsonl', join(h2, '.kiro', 'sessions', '0123456789abcdef', p.session_id, 'messages.jsonl'));
    assert.deepEqual(await stops(h2, 'kiro', p, { transcript: elsewhere }), [upload('kiro', p.session_id, elsewhere)]);
});

test('kiro (legacy engine): ~/.kiro/sessions/cli/<id>.jsonl is uploaded; ACP-client sessions are not', async () => {
    const p = payload('kiro-legacy-stop.json');
    const h = home('kiro');
    const session = place('kiro-legacy-session.jsonl', join(h, '.kiro', 'sessions', 'cli', `${p.session_id}.jsonl`));
    writeFileSync(join(h, '.kiro', 'sessions', 'cli', `${p.session_id}.json`), JSON.stringify({ session_id: p.session_id, cwd: p.cwd, session_created_reason: null }));
    const legacyAncestors = [`${LAUNCHER} --harness=kiro`, 'kiro-cli-chat chat --agent valorbrain', 'kiro-cli chat --agent valorbrain'];
    assert.deepEqual(await stops(h, 'kiro', p, { transcript: session, ancestors: legacyAncestors }), [upload('kiro', p.session_id, session)]);

    const h2 = home('kiro');
    const sub = place('kiro-legacy-session.jsonl', join(h2, '.kiro', 'sessions', 'cli', `${p.session_id}.jsonl`));
    writeFileSync(join(h2, '.kiro', 'sessions', 'cli', `${p.session_id}.json`), JSON.stringify({ session_id: p.session_id, session_created_reason: 'subagent' }));
    assert.deepEqual(await stops(h2, 'kiro', p, { transcript: sub, ancestors: legacyAncestors, count: 5 }), []);
});

test('kiro: --no-interactive runs, unknown sessions and unsafe ids never upload', async () => {
    const p = payload('kiro-v3-stop.json');
    const dir = createHash('sha256').update(p.cwd).digest('hex').slice(0, 16);
    const h = home('kiro');
    const messages = place('kiro-v3-messages.jsonl', join(h, '.kiro', 'sessions', dir, p.session_id, 'messages.jsonl'));
    const scripted = [`${LAUNCHER} --harness=kiro`, KIRO_ACP, 'kiro-cli-chat chat --v3 --no-interactive rename the helper', 'kiro-cli chat --v3 --no-interactive rename the helper'];
    assert.deepEqual(await stops(h, 'kiro', p, { transcript: messages, ancestors: scripted, count: 5 }), [], '--no-interactive');
    assert.deepEqual(await stops(h, 'kiro', { ...p, session_id: 'sess_not-on-disk' }, { count: 5 }), [], 'no such session');
    assert.deepEqual(await stops(h, 'kiro', { ...p, session_id: '../../etc/passwd' }, { count: 5 }), [], 'not an id');
    assert.deepEqual(await stops(h, 'kiro', p, { transcript: messages, start: T0 + 60 * MIN }), [upload('kiro', p.session_id, messages)], 'control: interactive');
});

// ── Cursor ───────────────────────────────────────────────────────────────────

test('cursor: a due stop spawns the uploader, from transcript_path or found by conversation_id', async () => {
    const h = home('cursor');
    const base = payload('cursor-stop.json', { TRANSCRIPT: 'unused' });
    const dir = join(h, '.cursor', 'projects', cursorProjectSlug(base.workspace_roots[0]), 'agent-transcripts');
    assert.equal(cursorProjectSlug('/work/proj'), 'work-proj');
    const given = place('cursor-transcript.jsonl', join(dir, `${base.conversation_id}.jsonl`));
    const p = (i) => payload('cursor-stop.json', { TRANSCRIPT: given, GENERATION: `gen-${i}` });
    assert.deepEqual(await stops(h, 'cursor', p, { transcript: given }), [upload('cursor', base.conversation_id, given)]);
    // The CLI may leave transcript_path null: the nested layout is found by id.
    const h2 = home('cursor');
    const nested = place('cursor-transcript.jsonl', join(h2, '.cursor', 'projects', 'work-proj', 'agent-transcripts', base.conversation_id, `${base.conversation_id}.jsonl`));
    const noPath = (i) => ({ ...payload('cursor-stop.json', { GENERATION: `gen-${i}` }), transcript_path: null });
    assert.deepEqual(await stops(h2, 'cursor', noPath, { transcript: nested }), [upload('cursor', base.conversation_id, nested)]);
});

test('cursor: cursor-agent -p, aborted turns and the legacy .txt transcript never upload', async () => {
    const h = home('cursor');
    const t = place('cursor-transcript.jsonl', join(h, 'c.jsonl'));
    const p = (i) => payload('cursor-stop.json', { TRANSCRIPT: t, GENERATION: `gen-${i}` });
    assert.deepEqual(await stops(h, 'cursor', p, { transcript: t, ancestors: [`${LAUNCHER} --harness=cursor`, `${CURSOR} -p --output-format stream-json rename`], count: 5 }), [], '-p');
    assert.deepEqual(await stops(h, 'cursor', (i) => ({ ...p(i + 10), status: 'aborted' }), { transcript: t, count: 5 }), [], 'aborted');
    const txt = place('cursor-transcript.jsonl', join(h, 'c.txt'));
    assert.deepEqual(await stops(h, 'cursor', (i) => payload('cursor-stop.json', { TRANSCRIPT: txt, GENERATION: `txt-${i}` }), { transcript: txt, count: 5 }), [], '.txt');
    assert.equal((await stops(h, 'cursor', (i) => payload('cursor-stop.json', { TRANSCRIPT: t, GENERATION: `ok-${i}` }), { transcript: t, start: T0 + 60 * MIN })).length, 1, 'control');
});

// ── OpenCode ─────────────────────────────────────────────────────────────────

test('opencode: the plugin\'s Claude-format Stop spawns the uploader; aborted/error turns do not', async () => {
    const h = home('opencode');
    const t = place('opencode-session.jsonl', join(h, '.valorbrain', 'state', 'opencode', 'ses_3f2a9c1e7ffeAbCdEf012345.jsonl'));
    const p = (i) => ({ ...payload('opencode-stop.json', { TRANSCRIPT: t }), turn_id: `msg_${i}` });
    assert.deepEqual(await stops(h, 'opencode', p, { transcript: t }), [upload('opencode', 'ses_3f2a9c1e7ffeAbCdEf012345', t)]);
    const h2 = home('opencode');
    const t2 = place('opencode-session.jsonl', join(h2, 's.jsonl'));
    for (const status of ['aborted', 'error']) {
        const bad = (i) => ({ ...payload('opencode-stop.json', { TRANSCRIPT: t2 }), turn_id: `${status}_${i}`, status });
        assert.deepEqual(await stops(h2, 'opencode', bad, { transcript: t2, count: 4 }), [], status);
    }
    const good = (i) => ({ ...payload('opencode-stop.json', { TRANSCRIPT: t2 }), turn_id: `ok_${i}` });
    assert.equal((await stops(h2, 'opencode', good, { transcript: t2, start: T0 + 60 * MIN })).length, 1, 'control: completed');
});

test('a Stop reaching another harness\'s hook file uploads only through its own', async () => {
    // Cursor runs Claude Code's settings.json: the cursor dialect under --harness=claude-code.
    const h = home('claude-code');
    const t = place('cursor-transcript.jsonl', join(h, 'c.jsonl'));
    const p = (i) => payload('cursor-stop.json', { TRANSCRIPT: t, GENERATION: `gen-${i}` });
    assert.deepEqual(await stops(h, 'claude-code', p, { transcript: t, count: 4 }), []);
    // The same Stop through Cursor's own hooks.json uploads.
    writeCreds(h, { api: 'https://api.example', token: 'vbm_secret', harness: 'cursor' });
    setPrivacy(h, 'cursor', { send_transcript: true });
    const own = (i) => payload('cursor-stop.json', { TRANSCRIPT: t, GENERATION: `own-${i}` });
    assert.equal((await stops(h, 'cursor', own, { transcript: t, start: T0 + 60 * MIN })).length, 1);
});

// ── Claude Code: attended ────────────────────────────────────────────────────

test('claude-code: CLAUDE_CODE_SESSION_ATTENDED=1 goes to the uploader; =0 does not upload; absent adds nothing', async () => {
    const claudeStop = (t) => (i) => ({ hook_event_name: 'Stop', session_id: 'sess-a', transcript_path: t, cwd: '/work/proj', stop_hook_active: false, n: i });
    const h = home('claude-code');
    const t = place('opencode-session.jsonl', join(h, 'claude.jsonl'));
    assert.deepEqual(await stops(h, 'claude-code', claudeStop(t), { transcript: t, env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } }),
        [upload('claude-code', 'sess-a', t, '/work/proj', ['--attended=1'])]);
    const h2 = home('claude-code');
    const t2 = place('opencode-session.jsonl', join(h2, 'claude.jsonl'));
    assert.deepEqual(await stops(h2, 'claude-code', claudeStop(t2), { transcript: t2, env: { CLAUDE_CODE_SESSION_ATTENDED: '0' }, count: 5 }), []);
    const h3 = home('claude-code');
    const t3 = place('opencode-session.jsonl', join(h3, 'claude.jsonl'));
    assert.deepEqual(await stops(h3, 'claude-code', claudeStop(t3), { transcript: t3 }), [upload('claude-code', 'sess-a', t3)]);
});

test('uploader: --attended=1 becomes input.sessionAttended "1" on both hooks/run calls; absent, no field', async () => {
    const h = home('claude-code');
    const t = place('opencode-session.jsonl', join(h, 'claude.jsonl'));
    const bodies = [];
    const fetchImpl = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response('{"ok":true}'); };
    await uploadTranscript(['--harness=claude-code', '--session=sess-a', `--transcript=${t}`, '--attended=1'], { env: {}, home: h, fetchImpl, now: T0 });
    assert.deepEqual(bodies.map((b) => [b.hook, b.input.sessionAttended]), [['episode-extractor', '1'], ['decision-extractor', '1']]);
    assert.equal('sessionAttended' in bodies[0], false, 'inside input, not top level');
    bodies.length = 0;
    await uploadTranscript(['--harness=claude-code', '--session=sess-a', `--transcript=${t}`], { env: {}, home: h, fetchImpl, now: T0 });
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((b) => !('sessionAttended' in b.input)));
});

// ── the process check ────────────────────────────────────────────────────────

test('ancestors: one ps table, walked from the parent up; Windows and a failing ps give none', () => {
    const table = [
        '    1     0 /sbin/init',
        '  900     1 -bash',
        ' 1200   900 node --max-old-space-size=8192 /usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js -p rename the helper',
        ' 1300  1200 /bin/bash -c node "/home/u/.valorbrain/bin/connect/launcher.mjs" hook stop --harness=gemini-cli',
        ' 1400  1300 node /home/u/.valorbrain/bin/connect/launcher.mjs hook stop --harness=gemini-cli',
        ' 5000     1 node unrelated.js -p',
    ].join('\n');
    const chain = ancestorsFromTable(table, 1300);
    assert.equal(chain.length, 4);
    assert.match(chain[1], /gemini\.js -p/);
    assert.equal(headlessRun('gemini', {}, chain), true);
    const ps = (stdout) => () => ({ stdout });
    assert.deepEqual(ancestorCommands({ pid: 1300, platform: 'linux', spawnSyncImpl: ps(table) }), chain);
    assert.deepEqual(ancestorCommands({ pid: 1300, platform: 'win32', spawnSyncImpl: ps(table) }), []);
    assert.deepEqual(ancestorCommands({ pid: 1300, platform: 'darwin', spawnSyncImpl: () => { throw new Error('no ps'); } }), []);
    // No harness process in sight (ps missing, Windows): not called headless.
    assert.equal(headlessRun('kiro', {}, []), false);
    // Our own launcher's `--harness=gemini-cli` is not the gemini process.
    assert.equal(headlessRun('gemini', {}, ['node launcher.mjs hook stop --harness=gemini-cli -p']), false);
});
