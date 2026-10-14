// connect 0.10.1 — opt-in transcript upload from the Stop hook (decision 18).
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_TRANSCRIPT_BYTES, claimTranscriptUpload, readTranscriptCapped, runHook, setPrivacy, transcriptSharing, uploadTranscript, writeCreds } from '../hook.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T12:00:00Z');
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-transcript-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** A home with a claude-code credential, a transcript file, and (optionally) the opt-in. */
function setup({ optIn = true } = {}) {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_secret', harness: 'claude-code' });
    if (optIn) setPrivacy(h, 'claude-code', { send_transcript: true });
    const transcript = join(h, 'session-1.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    return { h, transcript };
}

/** One Stop through runHook; returns the spawns it asked for. */
async function stop(h, transcript, { now, env = {}, payload = {}, harness = 'claude-code' } = {}) {
    const spawned = [];
    await runHook(['stop', `--harness=${harness}`], {
        env: { VALORBRAIN_CHECKPOINT: 'off', ...env }, home: h, now,
        payload: { hook_event_name: 'Stop', session_id: 'sess-1', transcript_path: transcript, cwd: '/work/proj', stop_hook_active: false, ...payload },
        fetchImpl: async () => new Response('{}'),
        out: () => {}, err: () => {},
        spawnImpl: (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; },
        self: '/x/hook.mjs',
    });
    return spawned;
}
const grow = (path) => appendFileSync(path, '{"type":"assistant","message":{"role":"assistant","content":"ok"}}\n');

test('the switch: off by default; connect.json turns it on; VALORBRAIN_SEND_TRANSCRIPT wins both ways', () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_x', harness: 'claude-code' });
    assert.equal(transcriptSharing(h, 'claude-code', {}), false);
    setPrivacy(h, 'claude-code', { send_transcript: true });
    assert.equal(transcriptSharing(h, 'claude-code', {}), true);
    assert.equal(transcriptSharing(h, 'claude-code', { VALORBRAIN_SEND_TRANSCRIPT: 'off' }), false);
    assert.equal(transcriptSharing(h, 'codex', {}), false, 'per harness');
    setPrivacy(h, 'claude-code', { send_transcript: false });
    assert.equal(transcriptSharing(h, 'claude-code', { VALORBRAIN_SEND_TRANSCRIPT: 'on' }), true);
});

test('off: nothing is uploaded, however many turns', async () => {
    const { h, transcript } = setup({ optIn: false });
    for (let i = 0; i < 6; i++) {
        grow(transcript);
        assert.deepEqual(await stop(h, transcript, { now: T0 + i * 20 * MIN }), []);
    }
    assert.equal(existsSync(join(h, '.valorbrain', 'state', 'hooks', 'transcript-claude-code.json')), false);
});

test('on: first upload after 3 Stops, then only when grown AND 10 min passed; detached, token never on argv', async () => {
    const { h, transcript } = setup();
    assert.deepEqual(await stop(h, transcript, { now: T0 }), []);
    assert.deepEqual(await stop(h, transcript, { now: T0 + MIN }), []);
    const third = await stop(h, transcript, { now: T0 + 2 * MIN });
    assert.deepEqual(third, [[process.execPath, '/x/hook.mjs', 'transcript-upload', '--harness=claude-code', '--session=sess-1', `--transcript=${transcript}`, '--cwd=/work/proj']]);
    assert.ok(!JSON.stringify(third).includes('vbm_'));
    // Grown, but only 5 min later: no. Not grown, 11 min later: no. Grown and 11 min: yes.
    grow(transcript);
    assert.deepEqual(await stop(h, transcript, { now: T0 + 7 * MIN }), []);
    const same = await stop(h, transcript, { now: T0 + 2 * MIN + 11 * MIN, payload: { transcript_path: transcript } });
    assert.equal(same.length, 1, 'grew since the last upload (the 5-min Stop did not upload)');
    assert.deepEqual(await stop(h, transcript, { now: T0 + 2 * MIN + 30 * MIN }), [], 'no growth since the last upload');
});

test('continuation Stops, SDK runs, other dialects and missing files never upload', async () => {
    const { h, transcript } = setup();
    for (let i = 0; i < 4; i++) assert.deepEqual(await stop(h, transcript, { now: T0 + i * MIN, payload: { stop_hook_active: true } }), []);
    for (let i = 0; i < 4; i++) assert.deepEqual(await stop(h, transcript, { now: T0 + i * MIN, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }), []);
    // Cursor calling Claude's settings.json is the cursor dialect: no transcript format we read.
    for (let i = 0; i < 4; i++) assert.deepEqual(await stop(h, transcript, { now: T0 + i * MIN, payload: { conversation_id: 'c', generation_id: `g${i}`, status: 'completed', session_id: undefined } }), []);
    for (let i = 0; i < 4; i++) assert.deepEqual(await stop(h, join(h, 'missing.jsonl'), { now: T0 + i * MIN }), []);
    // Only the genuine Stops counted: three of them now upload.
    const s = [];
    for (let i = 0; i < 3; i++) s.push(...await stop(h, transcript, { now: T0 + 10 * MIN + i * MIN }));
    assert.equal(s.length, 1);
});

test('the lock: a Stop that cannot take the harness lock does not upload; the same Stop twice counts once', () => {
    const h = home();
    const dir = join(h, '.valorbrain', 'state', 'hooks');
    mkdirSync(dir, { recursive: true });
    // Another Stop holds the harness lock (fresh): this one neither counts nor uploads.
    writeFileSync(join(dir, 'transcript-claude-code.lock'), '');
    for (let i = 0; i < 4; i++) assert.equal(claimTranscriptUpload(h, { harness: 'claude-code', key: 'k1', size: 10, now: Date.now() }), false);
    assert.equal(existsSync(join(dir, 'k1.transcript.json')), false);
    rmSync(join(dir, 'transcript-claude-code.lock'));
    const granted = [0, 1, 2].map(() => claimTranscriptUpload(h, { harness: 'claude-code', key: 'k1', size: 10, now: Date.now() }));
    assert.deepEqual(granted, [false, false, true]);
    assert.equal(existsSync(join(dir, 'transcript-claude-code.lock')), false, 'released');
    // Same stop id through two hook files (Grok runs Cursor's file too): counted once.
    for (let i = 0; i < 5; i++) claimTranscriptUpload(h, { harness: 'grok', key: 'k2', size: 10, stopId: 'same', now: T0 + i });
    assert.equal(JSON.parse(readFileSync(join(dir, 'k2.transcript.json'), 'utf-8')).stops, 1);
});

test('per-harness cap: at most 8 uploads per 10 min across sessions (16 of the engine\'s 40 hooks/run)', () => {
    const h = home();
    let granted = 0;
    for (let s = 0; s < 12; s++) {
        for (let i = 0; i < 3; i++) if (claimTranscriptUpload(h, { harness: 'claude-code', key: `s${s}`, size: 100, now: T0 + s * 1000 + i })) granted++;
    }
    assert.equal(granted, 8);
    assert.equal(claimTranscriptUpload(h, { harness: 'claude-code', key: 's99', size: 100, now: T0 + 11 * MIN }), false, 'needs 3 Stops first');
    for (let i = 0; i < 3; i++) claimTranscriptUpload(h, { harness: 'claude-code', key: 's100', size: 100, now: T0 + 11 * MIN + i });
    assert.equal(JSON.parse(readFileSync(join(h, '.valorbrain', 'state', 'hooks', 's100.transcript.json'), 'utf-8')).lastAt, T0 + 11 * MIN + 2, 'window rolled over');
});

test('size cap: tail kept, dropped head lines become empty lines (line indexes stay), UTF-8 whole', () => {
    const h = home();
    const p = join(h, 't.jsonl');
    const line = (i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `línea ${i} ${'é'.repeat(50)}` } });
    const lines = Array.from({ length: 400 }, (_, i) => line(i));
    writeFileSync(p, lines.join('\n') + '\n');
    assert.equal(readTranscriptCapped(p), readFileSync(p, 'utf-8'), 'under the cap: verbatim');
    const max = 8 * 1024;
    const out = readTranscriptCapped(p, max);
    assert.ok(Buffer.byteLength(out) <= max, `${Buffer.byteLength(out)} > ${max}`);
    const outLines = out.split('\n');
    assert.equal(outLines.length, lines.length + 1);
    const first = outLines.findIndex((l) => l);
    assert.ok(first > 0);
    for (let i = first; i < lines.length; i++) assert.equal(outLines[i], lines[i], `line ${i} moved`);
    assert.equal(MAX_TRANSCRIPT_BYTES, 8 * 1024 * 1024, 'the engine\'s HOOK_TRANSCRIPT_MAX_BYTES');
});

test('uploader: episode-extractor then decision-extractor, the request shape, no content in the log; 429 backs off', async () => {
    const { h, transcript } = setup();
    const calls = [];
    const ok = async (url, init) => { calls.push({ url, ...JSON.parse(init.body), auth: init.headers.authorization }); return new Response('{"ok":true}'); };
    const argv = ['--harness=claude-code', '--session=sess-1', `--transcript=${transcript}`, '--cwd=/work/proj'];
    assert.deepEqual(await uploadTranscript(argv, { env: {}, home: h, fetchImpl: ok, now: T0 }), ['episode-extractor', 'decision-extractor']);
    assert.deepEqual(calls.map((c) => c.hook), ['episode-extractor', 'decision-extractor']);
    assert.equal(calls[0].url, 'https://api.example/api/v1/hooks/run');
    assert.equal(calls[0].auth, 'Bearer vbm_secret');
    assert.deepEqual(calls[0].input, { sessionId: 'sess-1', hookEventName: 'Stop', workingDir: '/work/proj' });
    assert.equal(calls[0].transcript, readFileSync(transcript, 'utf-8'));

    const limited = async () => new Response('{"error":"hook rate limit exceeded"}', { status: 429 });
    assert.deepEqual(await uploadTranscript(argv, { env: {}, home: h, fetchImpl: limited, now: T0 }), []);
    const log = readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8');
    assert.match(log, /transcript claude-code: episode-extractor HTTP 429 — uploads paused 30 min/);
    assert.ok(!log.includes('"role"') && !log.includes('hi'), 'never the content');
    // Paused: a due session does not upload until the backoff ends.
    for (let i = 0; i < 3; i++) assert.equal(claimTranscriptUpload(h, { harness: 'claude-code', key: 'b', size: 5, now: T0 + i }), false);
    assert.equal(claimTranscriptUpload(h, { harness: 'claude-code', key: 'b', size: 5, now: T0 + 31 * MIN }), true);
});

test('uploader: no credential or no transcript does nothing', async () => {
    const h = home();
    const fetchImpl = async () => { throw new Error('must not be called'); };
    assert.deepEqual(await uploadTranscript(['--harness=claude-code', '--session=s', '--transcript=/nope.jsonl'], { env: {}, home: h, fetchImpl }), []);
    const { h: h2 } = setup();
    assert.deepEqual(await uploadTranscript(['--harness=claude-code', '--session=s', '--transcript=/nope.jsonl'], { env: {}, home: h2, fetchImpl }), []);
});

test('end to end: the local client\'s Stop returns at once; the detached uploader reaches the engine later', async () => {
    const { createServer } = await import('node:http');
    const { execFile } = await import('node:child_process');
    const got = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (req.url === '/api/v1/hooks/run') {
                const b = JSON.parse(body);
                got.push({ hook: b.hook, auth: req.headers.authorization, bytes: b.transcript.length, input: b.input });
                // Extraction is slow: answer 1.5 s later.
                return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 1500);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const h = home();
    writeCreds(h, { api, token: 'vbm_e2e', harness: 'claude-code' });
    setPrivacy(h, 'claude-code', { send_transcript: true });
    writeFileSync(join(h, '.valorbrain', 'connect-state.json'), JSON.stringify({ lastHealAt: Date.now() }));
    const transcript = join(h, 'sess-e2e.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"add a test"}}\n{"type":"assistant","message":{"role":"assistant","content":"done"}}\n');
    const hookFile = new URL('../hook.mjs', import.meta.url).pathname;
    const runStop = () => new Promise((resolve) => {
        const t = performance.now();
        const child = execFile(process.execPath, [hookFile, 'hook', 'stop', '--harness=claude-code'], { env: { PATH: process.env.PATH, HOME: h, VALORBRAIN_CHECKPOINT: 'off' } }, (err) => resolve({ code: err ? err.code : 0, ms: performance.now() - t }));
        child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-e2e', transcript_path: transcript, cwd: h, stop_hook_active: false }));
    });
    for (let i = 0; i < 2; i++) await runStop();
    const third = await runStop();
    assert.equal(third.code, 0);
    assert.ok(third.ms < 1000, `the Stop waited ${third.ms} ms`);
    assert.equal(got.length <= 1, true, 'returned before the uploader finished');
    const end = Date.now() + 10_000;
    while (got.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    server.close();
    assert.deepEqual(got.map((g) => g.hook), ['episode-extractor', 'decision-extractor']);
    assert.equal(got[0].auth, 'Bearer vbm_e2e');
    assert.equal(got[0].input.sessionId, 'sess-e2e');
    assert.equal(got[0].bytes, readFileSync(transcript, 'utf-8').length);
});
