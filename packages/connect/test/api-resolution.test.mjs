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
function stubApi() {
    const agents = [];
    const server = createServer((req, res) => {
        agents.push(new URL(req.url, 'http://stub').searchParams.get('agent'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'Kiro', harness: 'kiro', contract_version: '2', artifacts: [] }));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            server, agents, url: `http://127.0.0.1:${server.address().port}`,
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

function runCli(args, h) {
    // Scrubbed env: no VALORBRAIN_API_URL/VALORBRAIN_TOKEN — resolution must
    // come from the saved credential, not the environment.
    const env = { PATH: process.env.PATH, HOME: h, NO_COLOR: '1' };
    return new Promise((resolve) => {
        execFile(process.execPath, [CLI, ...args], { env, timeout: 20_000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
        });
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
