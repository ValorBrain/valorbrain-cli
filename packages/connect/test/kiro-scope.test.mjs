// kiro scope (VAL-195): the engine renders a v1 hooks FILE (~/.kiro/hooks/…);
// kiro-cli only ever loads hooks from an AGENT config (.kiro/agents/*.json).
// scopedManifest re-targets the artifact and re-shapes the contents.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { planFor, scopedManifest } = await import('../index.mjs');

const HOME = '/home/customer';

const MANIFEST = (contents) => ({
    name: 'Kiro', harness: 'kiro', contract_version: '2', hook_protocol: 2, hooks_available: true,
    artifacts: [{ kind: 'hooks', path: '~/.kiro/hooks/valorbrain.json', label: 'lifecycle hooks (v1 JSON)', contents }],
});

const V1 = (commands = true) => JSON.stringify({
    version: 'v1',
    hooks: [
        { name: 'valorbrain-prompt', trigger: 'UserPromptSubmit', action: { type: 'command', command: commands ? 'npx -y @valorbrain/connect hook prompt --harness=kiro' : '' } },
        { name: 'valorbrain-session-start', trigger: 'SessionStart', action: { type: 'command', command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' } },
        { name: 'valorbrain-stop', trigger: 'Stop', action: { type: 'command', command: 'npx -y @valorbrain/connect hook stop --harness=kiro' } },
    ],
});

test('kiro default scope is workspace: the artifact becomes <cwd>/.kiro/agents/valorbrain.json', () => {
    for (const scope of [null, 'workspace']) {
        const m = scopedManifest(MANIFEST(V1()), { harness: 'kiro', scope, home: HOME, cwd: '/work/proj' });
        const a = m.artifacts[0];
        assert.equal(a.path, '/work/proj/.kiro/agents/valorbrain.json');
        const agent = JSON.parse(a.contents);
        assert.deepEqual(Object.keys(agent.hooks).sort(), ['agentSpawn', 'stop', 'userPromptSubmit']);
        assert.equal(agent.hooks.agentSpawn[0].command, 'npx -y @valorbrain/connect hook session-start --harness=kiro');
        assert.equal(agent.hooks.stop[0].timeout, 10_000);
        // The agent must not shrink the user's session.
        assert.ok(agent.tools.includes('shell') && agent.tools.includes('read') && agent.tools.includes('write'));
        assert.equal(agent.includeMcpJson, true);
    }
});

test('--scope=user keeps kiro hooks global; other harnesses are never remapped', () => {
    const m = scopedManifest(MANIFEST(V1()), { harness: 'kiro', scope: 'user', home: HOME, cwd: '/work/proj' });
    assert.equal(m.artifacts[0].path, `${HOME}/.kiro/agents/valorbrain.json`);

    const claude = { name: 'Claude Code', harness: 'claude-code', artifacts: [{ kind: 'hooks', path: '~/.claude/settings.json', contents: '{}' }] };
    assert.deepEqual(scopedManifest(claude, { harness: 'claude-code', scope: 'workspace', home: HOME, cwd: '/work/proj' }), claude);
});

test('unknown triggers are dropped; nothing fireable means nothing is wired; bad contents throw loudly', () => {
    const partial = JSON.stringify({ version: 'v1', hooks: [{ name: 'x', trigger: 'PreToolUse', action: { type: 'command', command: 'nope' } }] });
    assert.deepEqual(scopedManifest(MANIFEST(partial), { harness: 'kiro', scope: null, home: HOME }).artifacts, []);

    assert.throws(() => scopedManifest(MANIFEST('not json'), { harness: 'kiro', scope: null, home: HOME }), JSON.SyntaxError);
});

test('planFor writes the mapped agent config whole, and --remove deletes it', () => {
    const m = scopedManifest(MANIFEST(V1()), { harness: 'kiro', scope: null, home: HOME, cwd: '/work/proj' });
    const changes = planFor(m, 'vbm_real', HOME, false);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, '/work/proj/.kiro/agents/valorbrain.json');
    assert.equal(changes[0].before, null);
    assert.equal(JSON.parse(changes[0].after).name, 'valorbrain');

    const removed = planFor(m, 'vbm_real', HOME, true);
    assert.equal(removed[0].after, null);
});
