// Installer pieces touched by hook protocol v2 (ADR-058). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { planFor, mergeHooksJson, hookEntriesChanged } = await import('../index.mjs');

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
