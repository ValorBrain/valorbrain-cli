// Token source and manifest path guard (PRD R1/D3). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { resolveInstallToken, manifestTarget, planFor } = await import('../index.mjs');

const homes = [];
function home(cliConfig) {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-tok-'));
    homes.push(h);
    if (cliConfig) {
        mkdirSync(join(h, '.valorbrain'), { recursive: true });
        writeFileSync(join(h, '.valorbrain', 'config.json'), JSON.stringify(cliConfig));
    }
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const VBM = 'vbm_' + 'a'.repeat(40);
const CLI_VBM = 'vbm_' + 'c'.repeat(40);
const REST = 'vb_agent_' + 'r'.repeat(32);

test('no token given: the mcp_token saved by @valorbrain/cli is used, with its engine', () => {
    const h = home({ api_key: REST, mcp_token: CLI_VBM, engine_url: 'https://engine.example/' });
    const r = resolveInstallToken({ flag: null, env: {}, home: h });
    assert.deepEqual([r.token, r.source, r.api, r.error], [CLI_VBM, 'cli', 'https://engine.example', undefined]);
});

test('the CLI config is not used by --status / --remove', () => {
    const h = home({ mcp_token: CLI_VBM });
    assert.equal(resolveInstallToken({ flag: null, env: {}, home: h, install: false }).token, null);
});

test('the CLI REST key is never picked up as the MCP token', () => {
    const h = home({ api_key: REST });
    assert.equal(resolveInstallToken({ flag: null, env: {}, home: h }).token, null);
});

test('--token and VALORBRAIN_MCP_TOKEN win over the CLI config', () => {
    const h = home({ mcp_token: CLI_VBM });
    assert.equal(resolveInstallToken({ flag: VBM, env: { VALORBRAIN_MCP_TOKEN: 'vbm_env' }, home: h }).source, 'flag');
    assert.equal(resolveInstallToken({ flag: null, env: { VALORBRAIN_MCP_TOKEN: VBM }, home: h }).source, 'VALORBRAIN_MCP_TOKEN');
});

test('a token that is not vbm_ is refused with a clear message', () => {
    for (const [flag, env, from] of [[REST, {}, '--token'], [null, { VALORBRAIN_MCP_TOKEN: REST }, 'VALORBRAIN_MCP_TOKEN'], ['fk_x', {}, '--token']]) {
        const r = resolveInstallToken({ flag, env, home: home() });
        assert.equal(r.token, null);
        assert.match(r.error, new RegExp(`${from} must be an MCP token \\(vbm_…\\)`));
        assert.match(r.error, /@valorbrain\/cli init --agent/);
    }
});

test('legacy VALORBRAIN_TOKEN: vbm_ is used with a warning, a REST key is ignored', () => {
    const used = resolveInstallToken({ flag: null, env: { VALORBRAIN_TOKEN: VBM }, home: home() });
    assert.deepEqual([used.token, used.source], [VBM, 'VALORBRAIN_TOKEN']);
    assert.match(used.warnings[0], /deprecated/);
    const ignored = resolveInstallToken({ flag: null, env: { VALORBRAIN_TOKEN: REST }, home: home({ mcp_token: CLI_VBM }) });
    assert.deepEqual([ignored.token, ignored.source, ignored.error], [CLI_VBM, 'cli', undefined]);
    assert.match(ignored.warnings[0], /REST key/);
});

test('manifest paths stay inside the home or the project', () => {
    const h = home();
    const cwd = mkdtempSync(join(tmpdir(), 'vb-connect-proj-'));
    homes.push(cwd);
    assert.equal(manifestTarget('~/.claude/settings.json', h, cwd).path, join(h, '.claude', 'settings.json'));
    assert.equal(manifestTarget(join(cwd, '.kiro', 'hooks', 'x.json'), h, cwd).path, join(cwd, '.kiro', 'hooks', 'x.json'));
    assert.equal(manifestTarget('-', h, cwd).path, null);
    assert.match(manifestTarget('~/../etc/passwd', h, cwd).error, /"\.\."/);
    assert.match(manifestTarget('~/.claude/../../x', h, cwd).error, /"\.\."/);
    assert.match(manifestTarget('/etc/cron.d/valorbrain', h, cwd).error, /outside your home and this project/);
    assert.match(manifestTarget('..\\outside.txt', h, cwd).error, /"\.\."/);
});

test('planFor refuses an unsafe artifact and still plans the safe ones', () => {
    const h = home();
    const manifest = {
        artifacts: [
            { kind: 'rules', path: '/tmp/vb-connect-evil.md', label: 'evil', strategy: 'write', contents: 'pwned' },
            { kind: 'rules', path: '~/.claude/VALORBRAIN.md', label: 'rules', strategy: 'write', contents: 'hello' },
        ],
    };
    const changes = planFor(manifest, VBM, h, false, h);
    assert.match(changes[0].error, /outside your home/);
    assert.equal(changes[0].changed, false);
    assert.equal(changes[1].after, 'hello');
    assert.equal(existsSync('/tmp/vb-connect-evil.md'), false);
});
