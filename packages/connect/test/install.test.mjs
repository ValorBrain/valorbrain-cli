// Installer pieces touched by hook protocol v2 (ADR-058). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { planFor, mergeHooksJson, hookEntriesChanged } = await import('../index.mjs');
const { clientHeaders, runHeaders } = await import('../hook.mjs');

const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-install-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const HOOK = 'npx -y @valorbrain/connect hook';

test('two artifacts in one file build on each other (Gemini settings.json)', () => {
    const h = home();
    mkdirSync(join(h, '.gemini'), { recursive: true });
    writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const manifest = {
        artifacts: [
            {
                kind: 'mcp', path: '~/.gemini/settings.json', label: 'MCP server entry', strategy: 'write',
                contents: JSON.stringify({ mcpServers: { valorbrain: { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer vbm_<YOUR_TOKEN>' } } } }),
            },
            {
                kind: 'hooks', path: '~/.gemini/settings.json', label: 'lifecycle hooks (settings.json)', strategy: 'write',
                contents: JSON.stringify({ hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: `${HOOK} stop --harness=gemini-cli`, timeout: 10000 }] }] } }),
            },
        ],
    };
    const changes = planFor(manifest, 'vbm_real', h, false);
    const final = JSON.parse(changes[1].after);
    assert.equal(final.theme, 'dark');
    assert.equal(final.mcpServers.valorbrain.headers.Authorization, 'Bearer vbm_real');
    assert.match(final.hooks.AfterAgent[0].hooks[0].command, /hook stop/);
    // The second change starts from the first one's output, not from disk.
    assert.equal(changes[1].before, changes[0].after);
});

// D1 (15/10/2026): the MCP entry declares the harness; a persona the person set
// on the entry (X-Source-Agent) outranks it and survives every reinstall.
test('MCP entry: the render declares the harness, and the person\'s own X-Source-Agent survives', () => {
    const h = home();
    mkdirSync(join(h, '.claude'), { recursive: true });
    const path = join(h, '.claude.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { valorbrain: { url: 'https://old.example/mcp', headers: { Authorization: 'Bearer vbm_old', 'X-Source-Agent': 'minha-persona' } } } }));
    const manifest = {
        artifacts: [{
            kind: 'mcp', path: '~/.claude.json', label: 'MCP server entry', strategy: 'write',
            contents: JSON.stringify({ mcpServers: { valorbrain: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer vbm_<YOUR_TOKEN>', 'X-ValorBrain-Harness': 'claude-code' } } } }),
        }],
    };
    const entry = JSON.parse(planFor(manifest, 'vbm_real', h, false)[0].after).mcpServers.valorbrain;
    assert.deepEqual(entry.headers, { Authorization: 'Bearer vbm_real', 'X-ValorBrain-Harness': 'claude-code', 'X-Source-Agent': 'minha-persona' });
    assert.equal(entry.url, 'https://mcp.example/mcp');
    // Without a persona of their own, the entry is exactly the render.
    writeFileSync(path, JSON.stringify({ mcpServers: { valorbrain: { url: 'https://old.example/mcp', headers: { Authorization: 'Bearer vbm_old' } } } }));
    const plain = JSON.parse(planFor(manifest, 'vbm_real', h, false)[0].after).mcpServers.valorbrain;
    assert.deepEqual(plain.headers, { Authorization: 'Bearer vbm_real', 'X-ValorBrain-Harness': 'claude-code' });
});

test('hook requests carry the harness contract the person declared in the harness env', () => {
    const h = home();
    const env = {
        VALORBRAIN_SOURCE_AGENT: 'minha-persona',
        VALORBRAIN_AGENT_LANE: 'faixa-a',
        VALORBRAIN_RUN_KIND: 'routine',
        VALORBRAIN_REQUESTED_BY: 'Joana Teste',
        VALORBRAIN_AGENT_TEAM: 'time-a,time-b',
    };
    // What a hook sends: identity (clientHeaders) plus run kind, requester and team (runHeaders).
    const headers = { ...clientHeaders(h, 'codex', '0.0.0', env), ...runHeaders('', env) };
    assert.equal(headers['x-valorbrain-harness'], 'codex');
    assert.equal(headers['x-source-agent'], 'minha-persona');
    assert.equal(headers['x-agent-lane'], 'faixa-a');
    assert.equal(headers['x-run-kind'], 'routine');
    assert.equal(headers['x-requested-by'], 'Joana Teste');
    assert.equal(headers['x-agent-team'], 'time-a,time-b');
    // Run kind, requester and team have one owner: clientHeaders never sends them.
    assert.equal(clientHeaders(h, 'codex', '0.0.0', env)['x-run-kind'], undefined);
    // Nothing declared: only the harness names the writer.
    const bare = clientHeaders(h, 'codex', '0.0.0', {});
    assert.equal(bare['x-source-agent'], undefined);
    assert.equal(bare['x-agent-lane'], undefined);
    // Accents fold to ASCII; a control character drops the value, never sends it mangled.
    assert.equal(clientHeaders(h, 'codex', '0.0.0', { VALORBRAIN_SOURCE_AGENT: 'João' })['x-source-agent'], 'Joao');
    assert.equal(clientHeaders(h, 'codex', '0.0.0', { VALORBRAIN_SOURCE_AGENT: 'quem\npediu' })['x-source-agent'], undefined);
    assert.equal(clientHeaders(h, 'codex', '0.0.0', { VALORBRAIN_SOURCE_AGENT: '😀' })['x-source-agent'], undefined);
});

test('Cursor hooks.json keeps the user hooks and gains the required version key', () => {
    const rendered = JSON.stringify({ version: 1, hooks: { stop: [{ command: `${HOOK} stop --harness=cursor`, timeout: 10 }] } });
    const fresh = JSON.parse(mergeHooksJson('', rendered, false));
    assert.equal(fresh.version, 1);
    const mine = JSON.stringify({ version: 1, hooks: { stop: [{ command: './hooks/audit.sh' }] } });
    const merged = JSON.parse(mergeHooksJson(mine, rendered, false));
    assert.deepEqual(merged.hooks.stop.map((h) => h.command), ['./hooks/audit.sh', `${HOOK} stop --harness=cursor`]);
    const removed = JSON.parse(mergeHooksJson(JSON.stringify(merged), rendered, true));
    assert.deepEqual(removed.hooks.stop.map((h) => h.command), ['./hooks/audit.sh']);
});

test('self-heal rewrites hooks only when OUR entries change, not on reformatting', () => {
    const v1 = { hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `${HOOK} context-surfacing --token=vbm_x --harness=claude-code` }] }], PreToolUse: [{ hooks: [{ command: 'mine' }] }] } };
    const v2 = { hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `${HOOK} prompt --harness=claude-code` }] }], PreToolUse: [{ hooks: [{ command: 'mine' }] }] } };
    assert.equal(hookEntriesChanged({ before: JSON.stringify(v1), after: JSON.stringify(v2, null, 2) }), true);
    assert.equal(hookEntriesChanged({ before: JSON.stringify(v2, null, 4), after: JSON.stringify(v2, null, 2) }), false);
    // Kiro's own file: hooks is an array.
    const k1 = { version: 'v1', hooks: [{ name: 'valorbrain-prompt', trigger: 'UserPromptSubmit', action: { type: 'command', command: `${HOOK} prompt --harness=kiro` } }] };
    assert.equal(hookEntriesChanged({ before: JSON.stringify(k1), after: JSON.stringify(k1, null, 2) }), false);
    // Not JSON (OpenCode plugin source): bytes decide.
    assert.equal(hookEntriesChanged({ before: 'const CMD = 1;', after: 'const CMD = 2;' }), true);
});


test('installer engine resolution: the base travels with its token, never with another', async () => {
    const { resolveInstallApi } = await import('../index.mjs');
    const { writeCreds } = await import('../hook.mjs');
    const h = home();
    writeCreds(h, { api: 'https://private.example', token: 'vbm_A', harness: 'kiro' });
    // (a) same token, second harness, no --api → the engine that token was saved with.
    assert.deepEqual(resolveInstallApi({ env: {}, home: h, harness: 'codex', token: 'vbm_A' }), {
        api: 'https://private.example', from: 'saved with this token',
    });
    // (b) a NEW token with no --api never inherits another token's engine.
    assert.deepEqual(resolveInstallApi({ env: {}, home: h, harness: 'kiro', token: 'vbm_B' }), {
        api: 'https://valorbrain-api.valor.digital', from: 'default',
    });
    // Explicit always wins, and says so.
    assert.equal(resolveInstallApi({ flag: 'https://x.example/mcp', env: {}, home: h, harness: 'kiro', token: 'vbm_B' }).from, '--api');
    assert.equal(resolveInstallApi({ env: { VALORBRAIN_API_URL: 'https://env.example' }, home: h, harness: 'kiro', token: 'vbm_B' }).api, 'https://env.example');
    // --status/--remove (no token): this harness's saved engine.
    assert.deepEqual(resolveInstallApi({ env: {}, home: h, harness: 'kiro', token: null }), {
        api: 'https://private.example', from: 'saved credentials',
    });
});
