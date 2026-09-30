// Browser login (device flow). Unit tests with injected fetch/sleep, and one
// end-to-end run of the CLI against a stub app + engine: no --token, the stub
// approves on the second poll, and each harness must end up with ITS token in
// its MCP config and in ~/.valorbrain/connect.json.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { acceptableApiUrl, approvalUrl, browserCommand, deviceLabel, deviceLogin, isUnattended, resolveAppUrl } from '../login.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch double: answers /code once, then the queued /token answers in order. */
function fakeApp(tokenAnswers, codeAnswer = null) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url: String(url), body });
        if (String(url).endsWith('/api/v1/cli/device/code')) {
            return codeAnswer ?? jsonResponse(200, {
                device_code: 'dev-raw', user_code: 'ABCD-EFGH',
                verification_uri: 'https://app.test/cli/link',
                verification_uri_complete: 'https://app.test/cli/link?code=ABCD-EFGH',
                expires_in: 900, interval: 3,
            });
        }
        const next = tokenAnswers.shift();
        if (next instanceof Error) throw next;
        return next ?? jsonResponse(400, { error: 'authorization_pending' });
    };
    return { calls, fetchImpl };
}

const quiet = { log: () => {}, sleep: async () => {}, open: () => false };

test('login: asks for a connect code with the harnesses and hands back one token per harness', async () => {
    const { calls, fetchImpl } = fakeApp([
        jsonResponse(400, { error: 'authorization_pending' }),
        new Error('ECONNRESET'), // a network blip mid-wait is not fatal
        jsonResponse(200, { access_token: 'vbm_a', tokens: { 'claude-code': 'vbm_a', kiro: 'vbm_b' }, valorbrain_url: 'https://api.test', tenant_id: 't1' }),
    ]);
    const out = await deviceLogin({ app: 'https://app.test', harnesses: ['claude-code', 'kiro'], label: 'box (Linux)', fetchImpl, ...quiet });
    assert.deepEqual(out, { tokens: { 'claude-code': 'vbm_a', kiro: 'vbm_b' }, accessToken: 'vbm_a', apiUrl: 'https://api.test', tenantId: 't1' });
    assert.deepEqual(calls[0].body, { client: 'connect', harnesses: ['claude-code', 'kiro'], device_label: 'box (Linux)' });
    assert.deepEqual(calls[1].body, { device_code: 'dev-raw' });
});

test('login: denied and expired end with a message for the person, nothing else', async () => {
    const denied = fakeApp([jsonResponse(400, { error: 'access_denied' })]);
    await assert.rejects(
        deviceLogin({ app: 'https://app.test', harnesses: ['codex'], fetchImpl: denied.fetchImpl, ...quiet }),
        /denied in the browser/,
    );
    const expired = fakeApp([jsonResponse(400, { error: 'expired_token' })]);
    await assert.rejects(
        deviceLogin({ app: 'https://app.test', harnesses: ['codex'], fetchImpl: expired.fetchImpl, ...quiet }),
        /expired before it was approved/,
    );
});

test('login: the app refusing the code request is reported with its reason', async () => {
    const { fetchImpl } = fakeApp([], jsonResponse(400, { error: 'invalid_request', error_description: 'harnesses must name at least one of: …' }));
    await assert.rejects(
        deviceLogin({ app: 'https://app.test', harnesses: ['x'], fetchImpl, ...quiet }),
        /refused the login: harnesses must name/,
    );
});

test('login: the wait is bounded by the code lifetime', async () => {
    let t = 0;
    const { fetchImpl } = fakeApp([]); // always pending
    await assert.rejects(
        deviceLogin({
            app: 'https://app.test', harnesses: ['codex'], fetchImpl,
            log: () => {}, open: () => false,
            now: () => t, sleep: async (ms) => { t += ms; },
        }),
        /expired before it was approved/,
    );
    assert.ok(t >= 900_000 && t < 910_000, `waited ${t} ms`);
});

test('browser: each platform gets its opener; CI, opt-out and no display get none', () => {
    const url = 'https://app.test/cli/link?code=ABCD-EFGH';
    assert.deepEqual(browserCommand(url, { platform: 'win32', env: {} }), { cmd: 'explorer.exe', args: [url] });
    assert.deepEqual(browserCommand(url, { platform: 'darwin', env: {} }), { cmd: 'open', args: [url] });
    assert.deepEqual(browserCommand(url, { platform: 'linux', env: { DISPLAY: ':0' } }), { cmd: 'xdg-open', args: [url] });
    assert.deepEqual(browserCommand(url, { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), { cmd: 'explorer.exe', args: [url] });
    assert.equal(browserCommand(url, { platform: 'linux', env: {} }), null); // SSH, no display
    assert.equal(browserCommand(url, { platform: 'darwin', env: { CI: 'true' } }), null);
    assert.equal(browserCommand(url, { platform: 'win32', env: { VALORBRAIN_NO_BROWSER: '1' } }), null);
});

test('label and app URL', () => {
    assert.equal(deviceLabel({ host: 'DESKTOP-7', platform: 'win32' }), 'DESKTOP-7 (Windows)');
    assert.equal(deviceLabel({ host: 'mini', platform: 'darwin' }), 'mini (macOS)');
    assert.equal(resolveAppUrl({ flag: 'https://x.test/', env: {} }), 'https://x.test');
    assert.equal(resolveAppUrl({ env: { VALORBRAIN_APP_URL: 'https://y.test' } }), 'https://y.test');
    assert.equal(resolveAppUrl({ env: {} }), 'https://valorbrain.valor.digital');
});

// ── end to end ───────────────────────────────────────────────────────────────

function claudeManifest() {
    return {
        name: 'Claude Code', harness: 'claude-code', contract_version: '6', hooks_available: true, hook_protocol: 2,
        artifacts: [{
            kind: 'mcp', path: '~/.claude.json', strategy: 'write',
            contents: JSON.stringify({ mcpServers: { valorbrain: { type: 'http', url: 'https://mcp.test/mcp', headers: { Authorization: 'Bearer vbm_<YOUR_TOKEN>' } } } }, null, 2) + '\n',
        }],
    };
}

function codexManifest() {
    return {
        name: 'Codex', harness: 'codex', contract_version: '6', hooks_available: false,
        artifacts: [{
            kind: 'mcp', path: '~/.codex/config.toml', strategy: 'merge',
            contents: '[mcp_servers.valorbrain]\nurl = "https://mcp.test/mcp"\nbearer_token = "vbm_<YOUR_TOKEN>"\n',
        }],
    };
}

function stubAppAndEngine() {
    const seen = { code: null, polls: 0, registered: [], round: 0 };
    const server = createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (u.pathname === '/api/v1/cli/device/code') {
                seen.code = body;
                seen.round++;
                seen.polls = 0;
                return send(200, { device_code: 'dev-raw', user_code: 'WXYZ-2345', verification_uri: 'http://stub/cli/link', verification_uri_complete: 'http://stub/cli/link?code=WXYZ-2345', expires_in: 900, interval: 1 });
            }
            if (u.pathname === '/api/v1/cli/device/token') {
                seen.polls++;
                if (seen.polls < 2) return send(400, { error: 'authorization_pending' });
                const sfx = seen.round > 1 ? `_${seen.round}` : '';
                return send(200, { access_token: `vbm_claude${sfx}`, tokens: { 'claude-code': `vbm_claude${sfx}`, codex: `vbm_codex${sfx}` }, tenant_id: 't1', valorbrain_url: `http://127.0.0.1:${server.address().port}` });
            }
            if (u.pathname === '/setup/artifacts') {
                return send(200, u.searchParams.get('agent') === 'codex' ? codexManifest() : claudeManifest());
            }
            if (u.pathname === '/api/v1/runtimes/register') {
                seen.registered.push({ agent: body?.agent_platform, auth: req.headers.authorization });
                return send(200, { ok: true });
            }
            return send(404, { error: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('no --token: the CLI logs in through the browser flow and wires each harness with its own token', async () => {
    const { server, seen, url } = await stubAppAndEngine();
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-login-'));
    try {
        mkdirSync(join(h, '.claude'), { recursive: true });
        mkdirSync(join(h, '.codex'), { recursive: true });
        const env = { PATH: process.env.PATH, HOME: h, USERPROFILE: h, NO_COLOR: '1', VALORBRAIN_APP_URL: url, VALORBRAIN_NO_BROWSER: '1' };
        const { code, stdout, stderr } = await new Promise((resolve) => {
            const child = execFile(process.execPath, [CLI], { env, timeout: 30_000 }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: so, stderr: se }));
            child.stdin.end('');
        });
        assert.equal(code, 0, stderr || stdout);
        assert.deepEqual(seen.code, { client: 'connect', harnesses: ['claude-code', 'codex'], device_label: seen.code.device_label, install_id: seen.code.install_id });
        assert.match(seen.code.install_id, /^[a-f0-9]{16}$/);
        // The same installation keeps its id (a second run sends the same one).
        assert.equal(readFileSync(join(h, '.valorbrain', 'install-id'), 'utf-8').trim(), seen.code.install_id);
        // The stub offered a page on another host: never opened or shown; the app's own page is.
        assert.doesNotMatch(stdout, /http:\/\/stub\//);
        assert.match(stdout, new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cli/link\\?code=WXYZ-2345`));
        assert.match(stdout, /approved — 2 agent\(s\), each with its own token/);

        const claude = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf-8'));
        assert.equal(claude.mcpServers.valorbrain.headers.Authorization, 'Bearer vbm_claude');
        assert.match(readFileSync(join(h, '.codex', 'config.toml'), 'utf-8'), /bearer_token = "vbm_codex"/);

        const creds = JSON.parse(readFileSync(join(h, '.valorbrain', 'connect.json'), 'utf-8'));
        assert.equal(creds.harnesses['claude-code'].token, 'vbm_claude');
        assert.equal(creds.harnesses['claude-code'].api_url, url); // the approving app's engine

        // Each harness declared itself with its own token.
        assert.deepEqual(seen.registered.map((r) => [r.agent, r.auth]).sort(), [['claude-code', 'Bearer vbm_claude'], ['codex', 'Bearer vbm_codex']]);
    } finally {
        server.close();
        rmSync(h, { recursive: true, force: true });
    }
});

test('--dry-run without a token never opens a login', async () => {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-login-'));
    try {
        mkdirSync(join(h, '.claude'), { recursive: true });
        const env = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1', VALORBRAIN_APP_URL: 'http://127.0.0.1:9', VALORBRAIN_NO_BROWSER: '1' };
        const { code, stderr } = await new Promise((resolve) => {
            const child = execFile(process.execPath, [CLI, '--dry-run'], { env, timeout: 20_000 }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: so, stderr: se }));
            child.stdin.end('');
        });
        assert.equal(code, 2);
        assert.match(stderr, /dry run never opens the browser/);
    } finally {
        rmSync(h, { recursive: true, force: true });
    }
});

test('approval URL: only a page of the app itself, https or loopback http', () => {
    assert.equal(approvalUrl('https://app.test/cli/link?code=AB', 'https://app.test'), 'https://app.test/cli/link?code=AB');
    assert.equal(approvalUrl('/cli/link?code=AB', 'https://app.test'), 'https://app.test/cli/link?code=AB');
    assert.equal(approvalUrl('file:///C:/Windows/System32/calc.exe', 'https://app.test'), null);
    assert.equal(approvalUrl('https://evil.test/cli/link', 'https://app.test'), null);
    assert.equal(approvalUrl('http://app.test/cli/link', 'http://app.test'), null); // plain http off loopback
    assert.equal(approvalUrl('http://127.0.0.1:3001/cli/link?code=AB', 'http://127.0.0.1:3001'), 'http://127.0.0.1:3001/cli/link?code=AB');
    assert.equal(approvalUrl(null, 'https://app.test'), 'https://app.test/');
});

test('engine URL from the app: https or loopback only', () => {
    assert.equal(acceptableApiUrl('https://api.test/'), 'https://api.test');
    assert.equal(acceptableApiUrl('http://localhost:7438'), 'http://localhost:7438');
    assert.equal(acceptableApiUrl('http://10.0.0.5:7438'), null);
    assert.equal(acceptableApiUrl('javascript:alert(1)'), null);
    assert.equal(acceptableApiUrl(''), null);
});

test('unattended: CI or piped output', () => {
    assert.equal(isUnattended({ env: { CI: 'true' }, stdoutIsTTY: true }), true);
    assert.equal(isUnattended({ env: {}, stdoutIsTTY: false }), true);
    assert.equal(isUnattended({ env: {}, stdoutIsTTY: true }), false);
});

test('browser: SSH never opens one, on any platform', () => {
    const url = 'https://app.test/cli/link?code=AB';
    assert.equal(browserCommand(url, { platform: 'darwin', env: { SSH_CONNECTION: '1 2 3 4' } }), null);
    assert.equal(browserCommand(url, { platform: 'win32', env: { SSH_TTY: '/dev/pts/1' } }), null);
});

test('login: a 502 or 429 while waiting is retried until the approval arrives', async () => {
    const { calls, fetchImpl } = fakeApp([
        new Response('<html>Bad gateway</html>', { status: 502 }),
        jsonResponse(429, { error: 'rate_limited' }),
        jsonResponse(200, { access_token: 'vbm_a', tokens: { codex: 'vbm_a' } }),
    ]);
    const out = await deviceLogin({ app: 'https://app.test', harnesses: ['codex'], fetchImpl, ...quiet });
    assert.equal(out.accessToken, 'vbm_a');
    assert.equal(calls.length, 4);
});

test('login: an offered page on another host is replaced by the app page', async () => {
    const logs = [];
    const opened = [];
    const { fetchImpl } = fakeApp(
        [jsonResponse(200, { access_token: 'vbm_a', tokens: { codex: 'vbm_a' } })],
        jsonResponse(200, { device_code: 'd', user_code: 'ABCD-EFGH', verification_uri_complete: 'file:///C:/Windows/System32/calc.exe', expires_in: 900, interval: 1 }),
    );
    await deviceLogin({ app: 'https://app.test', harnesses: ['codex'], fetchImpl, sleep: async () => {}, log: (l) => logs.push(l), open: (u) => { opened.push(u); return true; } });
    assert.deepEqual(opened, ['https://app.test/cli/link?code=ABCD-EFGH']);
    assert.ok(!logs.join('\n').includes('calc.exe'));
});

function runCliIn(h, args, extraEnv = {}) {
    const env = { PATH: process.env.PATH, HOME: h, USERPROFILE: h, NO_COLOR: '1', ...extraEnv };
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: so, stderr: se }));
        child.stdin.end('');
    });
}

test('unattended run without a token stops at once instead of printing a link to a log', async () => {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-login-'));
    try {
        mkdirSync(join(h, '.claude'), { recursive: true });
        const { code, stderr, stdout } = await runCliIn(h, [], { CI: 'true', VALORBRAIN_APP_URL: 'http://127.0.0.1:9' });
        assert.equal(code, 2);
        assert.match(stderr, /nobody here to approve/);
        assert.doesNotMatch(stdout, /cli\/link/);
    } finally {
        rmSync(h, { recursive: true, force: true });
    }
});

test('a re-run keeps the agents already connected and only approves the new one', async () => {
    const { server, seen, url } = await stubAppAndEngine();
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-login-'));
    try {
        mkdirSync(join(h, '.claude'), { recursive: true });
        mkdirSync(join(h, '.codex'), { recursive: true });
        const env = { VALORBRAIN_APP_URL: url, VALORBRAIN_NO_BROWSER: '1' };
        const first = await runCliIn(h, ['--harness', 'claude-code'], env);
        assert.equal(first.code, 0, first.stderr);
        assert.deepEqual(seen.code.harnesses, ['claude-code']);

        seen.code = null;
        const second = await runCliIn(h, [], env); // detects claude-code (connected) + codex (new)
        assert.equal(second.code, 0, second.stderr);
        assert.match(second.stdout, /Already connected: claude-code/);
        assert.deepEqual(seen.code.harnesses, ['codex']); // only the new agent is approved
        // The stub answers with tokens for both agents; the connected one keeps its own.
        const claudeCfg = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf-8'));
        assert.equal(claudeCfg.mcpServers.valorbrain.headers.Authorization, 'Bearer vbm_claude');

        seen.code = null;
        const third = await runCliIn(h, [], env); // everything connected: no approval at all
        assert.equal(third.code, 0, third.stderr);
        assert.equal(seen.code, null);
        assert.match(third.stdout, /Already connected: claude-code, codex/);
    } finally {
        server.close();
        rmSync(h, { recursive: true, force: true });
    }
});
