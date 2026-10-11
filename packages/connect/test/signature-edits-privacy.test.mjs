// connect 0.8 — PRD "rumo a 10", owner decisions 17 and 18. Run: npm test
//   17: the manifest must carry a valid ed25519 signature before a file is
//       written; self-heal never rewrites a file edited by hand (logs instead),
//       and an explicit re-run asks first (keeps the edit with nobody to ask).
//   18: the prompt goes to memory by default, with a per-harness off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_PUBLIC_KEYS, trustedManifestKeys, verifyManifest } from '../manifest-signature.mjs';
import { promptSharing, readCreds, runHook, setPrivacy, writeCreds } from '../hook.mjs';
import { SIGNED_ENV, TEST_MANIFEST_KID, TEST_MANIFEST_PUBLIC_KEY, signedManifestHeaders } from './signed-stub.mjs';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { lineDiff } = await import('../index.mjs');

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');
const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-08-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// ── signature ───────────────────────────────────────────────────────────────

const keys = trustedManifestKeys(SIGNED_ENV);
const BODY = JSON.stringify({ harness: 'claude-code', contract_version: '7', artifacts: [] });
const AT = '2026-10-11T12:00:00.000Z';
const NOW = Date.parse(AT) + 60_000;

test('a manifest signed by a trusted key verifies and comes back parsed', () => {
    assert.equal(keys[TEST_MANIFEST_KID], TEST_MANIFEST_PUBLIC_KEY);
    const r = verifyManifest({ body: BODY, headers: new Headers(signedManifestHeaders(BODY, AT)), harness: 'claude-code', keys, now: NOW });
    assert.equal(r.error, undefined);
    assert.equal(r.manifest.contract_version, '7');
});

test('refused: unsigned, unknown key, altered body, another harness, stale or future signature', () => {
    const check = (over) => verifyManifest({ body: BODY, headers: new Headers(signedManifestHeaders(BODY, AT)), harness: 'claude-code', keys, now: NOW, ...over }).error;
    assert.match(check({ headers: new Headers() }), /not signed/);
    assert.match(check({ keys: { ...MANIFEST_PUBLIC_KEYS } }), /does not trust/);
    assert.match(check({ body: BODY.replace('"7"', '"8"') }), /does not match/);
    assert.match(check({ harness: 'codex' }), /for "claude-code", not "codex"/);
    assert.match(check({ now: Date.parse(AT) + 8 * 24 * 3600 * 1000 }), /too far from this computer's clock/);
    assert.match(check({ now: Date.parse(AT) - 2 * 24 * 3600 * 1000 }), /too far/);
    // The signature binds the instant: the same signature with another date fails.
    const h = signedManifestHeaders(BODY, AT);
    h['x-valorbrain-manifest-issued-at'] = '2026-10-11T12:00:01.000Z';
    assert.match(check({ headers: new Headers(h) }), /does not match/);
});

test('a malformed VALORBRAIN_MANIFEST_PUBLIC_KEYS entry adds no key', () => {
    assert.deepEqual(trustedManifestKeys({ VALORBRAIN_MANIFEST_PUBLIC_KEYS: 'abc, ,zz==' }), { ...MANIFEST_PUBLIC_KEYS });
});

test('lineDiff lists only the changed lines', () => {
    assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n'), ['- b', '+ B', '+ d']);
    assert.deepEqual(lineDiff(null, 'x'), ['- ', '+ x']);
});

// ── end to end against a stub engine ────────────────────────────────────────

const block = (v, extra = '') => `<!-- valorbrain:begin -->\n<!-- valorbrain-contract: v${v} harness: claude-code -->\nUse memory v${v}.${extra}\n<!-- valorbrain:end -->\n`;
const claude = (v) => ({
    name: 'Claude Code', harness: 'claude-code', contract_version: String(v), hooks_available: false, notes: [],
    artifacts: [{ kind: 'rules', path: '~/.claude/CLAUDE.md', label: 'agent instructions (managed block)', strategy: 'merge', best_effort: false, contents: block(v) }],
});

function stubEngine() {
    const state = { version: 7, signed: true, manifests: 0 };
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        req.resume();
        req.on('end', () => {
            if (u.pathname === '/setup/artifacts') {
                state.manifests++;
                const body = JSON.stringify(claude(state.version));
                res.writeHead(200, { 'content-type': 'application/json', ...(state.signed ? signedManifestHeaders(body) : {}) });
                return res.end(body);
            }
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
const hook = (h, url) => cli(h, url, ['hook', 'context-surfacing', '--harness=claude-code'], {
    env: { VALORBRAIN_TOKEN: 'vbm_test' },
    stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'what did we decide?' }),
});
const rules = (h) => join(h, '.claude', 'CLAUDE.md');

test('an unsigned manifest is refused and nothing is written', async () => {
    const { server, state, url } = await stubEngine();
    state.signed = false;
    const h = home();
    const r = await install(h, url);
    server.close();
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /not signed/);
    assert.equal(existsSync(rules(h)), false);
});

test('self-heal updates an untouched file from a signed manifest, never from an unsigned one', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    assert.equal(readFileSync(rules(h), 'utf-8'), block(7));
    state.version = 8;
    await hook(h, url);
    assert.equal(readFileSync(rules(h), 'utf-8'), block(8));
    state.version = 9;
    state.signed = false;
    await hook(h, url);
    server.close();
    assert.equal(readFileSync(rules(h), 'utf-8'), block(8));
});

test('a hand edit survives self-heal (logged) and a non-interactive re-run; --force overwrites it', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    const edited = block(7, ' Also: never touch prod.');
    writeFileSync(rules(h), edited);
    state.version = 8;

    const healed = await hook(h, url);
    assert.equal(readFileSync(rules(h), 'utf-8'), edited);
    assert.match(healed.stderr, /edited by hand — self-heal left it as is/);
    assert.match(readFileSync(join(h, '.valorbrain', 'connect.log'), 'utf-8'), /CLAUDE\.md: edited by hand/);

    const rerun = await install(h, url);
    assert.equal(readFileSync(rules(h), 'utf-8'), edited);
    assert.match(rerun.stdout, /was edited by hand; this update changes it/);
    assert.match(rerun.stdout, /- Use memory v7\. Also: never touch prod\./);
    assert.match(rerun.stdout, /kept your edits/);

    assert.equal((await install(h, url, ['--force'])).code, 0);
    assert.equal(readFileSync(rules(h), 'utf-8'), block(8));
    // From the forced write on, self-heal owns the file again.
    state.version = 9;
    await hook(h, url);
    server.close();
    assert.equal(readFileSync(rules(h), 'utf-8'), block(9));
});

test('a file the person deleted is not recreated by self-heal', async () => {
    const { server, state, url } = await stubEngine();
    const h = home();
    assert.equal((await install(h, url)).code, 0);
    rmSync(rules(h));
    state.version = 8;
    await hook(h, url);
    server.close();
    assert.equal(existsSync(rules(h)), false);
});

// ── decision 18: prompt sharing ─────────────────────────────────────────────

function fakeApi() {
    const calls = [];
    return { calls, fetchImpl: async (url) => { calls.push(new URL(url).pathname); return Response.json({ context: 'ctx' }); } };
}

test('prompt off for one harness: its prompt hook makes no call; others keep sending', async () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_a', harness: 'codex' });
    writeCreds(h, { api: 'https://api.example', token: 'vbm_b', harness: 'claude-code' });
    setPrivacy(h, 'codex', { send_prompt: false });
    // A re-install (new token) keeps the choice.
    writeCreds(h, { api: 'https://api.example', token: 'vbm_c', harness: 'codex' });
    assert.equal(promptSharing(h, 'codex'), false);
    assert.equal(readCreds(h, 'codex').token, 'vbm_c');

    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'segredo do cliente' };
    const off = fakeApi();
    await runHook(['prompt', '--harness=codex'], { env: {}, home: h, payload, fetchImpl: off.fetchImpl, out: () => {}, err: () => {} });
    assert.deepEqual(off.calls, []);

    const on = fakeApi();
    await runHook(['prompt', '--harness=claude-code'], { env: {}, home: h, payload, fetchImpl: on.fetchImpl, out: () => {}, err: () => {} });
    assert.deepEqual(on.calls, ['/api/v1/hooks/cue']);

    // The machine-wide variable wins over the file, both ways.
    assert.equal(promptSharing(h, 'claude-code', { VALORBRAIN_SEND_PROMPT: 'off' }), false);
    assert.equal(promptSharing(h, 'codex', { VALORBRAIN_SEND_PROMPT: 'on' }), true);
});

test('--prompt / --transcript record the choice and touch nothing else', async () => {
    const h = home();
    writeCreds(h, { api: 'https://api.example', token: 'vbm_a', harness: 'codex' });
    const off = await cli(h, 'http://127.0.0.1:9', ['--harness', 'codex', '--prompt', 'off']);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /codex: prompt off/);
    const hermes = await cli(h, 'http://127.0.0.1:9', ['--harness', 'hermes', '--transcript=on']);
    assert.equal(hermes.code, 0, hermes.stderr);
    const saved = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8')).harnesses;
    assert.equal(saved.codex.send_prompt, false);
    assert.equal(saved.codex.token, 'vbm_a');
    assert.deepEqual(saved.hermes, { send_transcript: true });
    assert.equal((await cli(h, 'http://127.0.0.1:9', ['--prompt', 'maybe'])).code, 2);
});
