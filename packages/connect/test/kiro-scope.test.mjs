// kiro engine modes (VAL-224): the V3 engine (kiro-cli --v3, Kiro CLI 3.0
// default) loads the standalone file ~/.kiro/hooks/valorbrain.json exactly as
// the hosted manifest renders it; the LEGACY engine only fires hooks from an
// agent config (.kiro/agents/*.json). One mode per install — the installer
// removes the other mode's files.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { planFor, scopedManifest, staleKiroFiles, detectKiroMode, kiroProjectHasOurHooks } = await import('../index.mjs');

const HOME = '/home/customer';
const CWD = '/work/proj';

const MANIFEST = (contents) => ({
    name: 'Kiro', harness: 'kiro', contract_version: '2', hook_protocol: 2, hooks_available: true,
    artifacts: [{ kind: 'hooks', path: '~/.kiro/hooks/valorbrain.json', label: 'lifecycle hooks (v1 JSON)', contents }],
});

const STANDALONE = JSON.stringify({
    version: 'v1',
    hooks: [
        { name: 'valorbrain-prompt', trigger: 'UserPromptSubmit', action: { type: 'command', command: 'npx -y @valorbrain/connect hook prompt --harness=kiro' } },
        { name: 'valorbrain-session-start', trigger: 'SessionStart', action: { type: 'command', command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' } },
        { name: 'valorbrain-stop', trigger: 'Stop', action: { type: 'command', command: 'npx -y @valorbrain/connect hook stop --harness=kiro' } },
    ],
});

test('v3 (default): the engine-rendered standalone file passes through untouched', () => {
    for (const scope of [null, 'user', 'global']) {
        const m = scopedManifest(MANIFEST(STANDALONE), { harness: 'kiro', scope, home: HOME, cwd: CWD });
        assert.equal(m.artifacts[0].path, '~/.kiro/hooks/valorbrain.json');
        assert.equal(m.artifacts[0].contents, STANDALONE);
    }
    // Explicit workspace scope moves it into the project — contents still ours.
    const ws = scopedManifest(MANIFEST(STANDALONE), { harness: 'kiro', scope: 'workspace', home: HOME, cwd: CWD });
    assert.equal(ws.artifacts[0].path, `${CWD}/.kiro/hooks/valorbrain.json`);
    assert.equal(ws.artifacts[0].contents, STANDALONE);
});

test('v3 passthrough never parses: even bad contents reach planFor as the server sent them', () => {
    const m = scopedManifest(MANIFEST('not json'), { harness: 'kiro', scope: null, home: HOME, cwd: CWD });
    assert.equal(m.artifacts[0].contents, 'not json');
});

test('legacy opt-in: hooks re-target to the agent config kiro-cli 2.x fires', () => {
    for (const [scope, dir] of [[null, `${HOME}/.kiro/agents`], ['workspace', `${CWD}/.kiro/agents`]]) {
        const m = scopedManifest(MANIFEST(STANDALONE), { harness: 'kiro', scope, home: HOME, cwd: CWD, kiroEngine: 'legacy' });
        const a = m.artifacts[0];
        assert.equal(a.path, `${dir}/valorbrain.json`);
        const agent = JSON.parse(a.contents);
        assert.deepEqual(Object.keys(agent.hooks).sort(), ['agentSpawn', 'stop', 'userPromptSubmit']);
        assert.equal(agent.hooks.agentSpawn[0].command, 'npx -y @valorbrain/connect hook session-start --harness=kiro');
        assert.equal(agent.hooks.stop[0].timeout, 10_000);
        // The agent must not shrink the user's session.
        assert.ok(agent.tools.includes('shell') && agent.tools.includes('read') && agent.tools.includes('write'));
        assert.equal(agent.includeMcpJson, true);
    }
});

test('legacy: unknown triggers are dropped, nothing fireable means nothing is wired, bad contents throw loudly', () => {
    const partial = JSON.stringify({ version: 'v1', hooks: [{ name: 'x', trigger: 'PreToolUse', action: { type: 'command', command: 'nope' } }] });
    const m = scopedManifest(MANIFEST(partial), { harness: 'kiro', scope: null, home: HOME, kiroEngine: 'legacy' });
    assert.deepEqual(m.artifacts, []);

    assert.throws(() => scopedManifest(MANIFEST('not json'), { harness: 'kiro', scope: null, home: HOME, kiroEngine: 'legacy' }), JSON.SyntaxError);
});

test('other harnesses are never remapped', () => {
    const claude = { name: 'Claude Code', harness: 'claude-code', artifacts: [{ kind: 'hooks', path: '~/.claude/settings.json', contents: '{}' }] };
    assert.deepEqual(scopedManifest(claude, { harness: 'claude-code', scope: 'workspace', home: HOME, cwd: CWD }), claude);
});

test('planFor writes the standalone file whole, and --remove deletes it', () => {
    const m = scopedManifest(MANIFEST(STANDALONE), { harness: 'kiro', scope: null, home: HOME, cwd: CWD });
    const changes = planFor(m, 'vbm_real', HOME, false);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, `${HOME}/.kiro/hooks/valorbrain.json`);
    assert.equal(changes[0].before, null);
    assert.equal(JSON.parse(changes[0].after).version, 'v1');

    const removed = planFor(m, 'vbm_real', HOME, true);
    assert.equal(removed[0].after, null);
});

test('self-heal purity: scope null never plans a project-dir path, in either mode', () => {
    for (const kiroEngine of ['v3', 'legacy']) {
        const m = scopedManifest(MANIFEST(STANDALONE), { harness: 'kiro', scope: null, home: HOME, cwd: CWD, kiroEngine });
        for (const c of planFor(m, 'vbm_real', HOME, false)) {
            assert.ok(!c.path.startsWith(`${CWD}/`), `${kiroEngine}: ${c.path}`);
        }
    }
});

test('staleKiroFiles: only OUR files of the other mode, in both roots, deduped', () => {
    const agentConfig = JSON.stringify({ name: 'valorbrain', hooks: { agentSpawn: [{ command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' }] } });
    const foreignAgent = JSON.stringify({ name: 'my-own-agent', hooks: { agentSpawn: [{ command: 'echo hi' }] } });

    // v3 install: stale = legacy agent configs of ours, in $HOME and the project.
    const fs = {
        [`${HOME}/.kiro/agents/valorbrain.json`]: agentConfig,
        [`${CWD}/.kiro/agents/valorbrain.json`]: foreignAgent, // customer's own agent
        [`${CWD}/.kiro/hooks/valorbrain.json`]: STANDALONE,    // same mode → never stale
    };
    const exists = (p) => p in fs;
    const read = (p) => fs[p];
    assert.deepEqual(
        staleKiroFiles({ home: HOME, cwd: CWD, kiroEngine: 'v3', exists, read }),
        [`${HOME}/.kiro/agents/valorbrain.json`],
    );

    // legacy install: stale = standalone hook files of ours.
    assert.deepEqual(
        staleKiroFiles({ home: HOME, cwd: CWD, kiroEngine: 'legacy', exists, read }),
        [`${CWD}/.kiro/hooks/valorbrain.json`],
    );

    // Garbage on the path is not ours — never touched.
    const junk = { [`${HOME}/.kiro/agents/valorbrain.json`]: 'not json' };
    assert.deepEqual(staleKiroFiles({ home: HOME, cwd: CWD, kiroEngine: 'v3', exists: (p) => p in junk, read: (p) => junk[p] }), []);
});

test('detectKiroMode: our agent config on disk means legacy opt-in; anything else is v3', () => {
    const agentConfig = JSON.stringify({ name: 'valorbrain', hooks: { agentSpawn: [{ command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' }] } });
    assert.equal(detectKiroMode(HOME, () => false, () => { throw new Error('no read'); }), 'v3');
    assert.equal(
        detectKiroMode(HOME, (p) => p === `${HOME}/.kiro/agents/valorbrain.json`, () => agentConfig),
        'legacy',
    );
    assert.equal(
        detectKiroMode(HOME, () => true, () => 'not json'),
        'v3',
    );
});

test('kiroProjectHasOurHooks: an ours file of EITHER kind counts; foreign or missing does not', () => {
    const agentConfig = JSON.stringify({ name: 'valorbrain', hooks: { agentSpawn: [{ command: 'npx -y @valorbrain/connect hook session-start --harness=kiro' }] } });
    const fs = {
        [`${HOME}/.kiro/agents/valorbrain.json`]: agentConfig,
        [`${CWD}/.kiro/hooks/valorbrain.json`]: STANDALONE,
        [`${CWD}/.kiro/agents/valorbrain.json`]: JSON.stringify({ name: 'other-agent', hooks: {} }),
    };
    const exists = (p) => p in fs;
    const read = (p) => fs[p];
    assert.equal(kiroProjectHasOurHooks(HOME, { exists, read }), true); // agent config (0.5.1 era)
    assert.equal(kiroProjectHasOurHooks(CWD, { exists, read }), true); // standalone beats the foreign agent config
    assert.equal(kiroProjectHasOurHooks('/elsewhere', { exists, read }), false);
    // Garbage on the exact path is not ours.
    const junk = { [`${CWD}/.kiro/hooks/valorbrain.json`]: 'not json' };
    assert.equal(kiroProjectHasOurHooks(CWD, { exists: (p) => p in junk, read: (p) => junk[p] }), false);
});
