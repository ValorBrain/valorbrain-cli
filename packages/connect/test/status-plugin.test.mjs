// Hermes plugin status: o plugin (kind "plugin") não tem arquivo de regras —
// o contrato é declarado no próprio código, em `_CONTRACT_VERSION`. O --status
// procurava o marker `valorbrain-contract: vN`, que só existe em arquivo de
// regras, e reportava "no valorbrain block" num plugin instalado e correto.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VALORBRAIN_CONNECT_NO_MAIN = '1';
const { statusFor } = await import('../index.mjs');

const homes = [];
function home() {
    const h = mkdtempSync(join(tmpdir(), 'vb-connect-status-'));
    homes.push(h);
    return h;
}
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const PLUGIN_REL = join('.hermes', 'plugins', 'valorbrain', '__init__.py');

function writePlugin(h, body) {
    mkdirSync(join(h, '.hermes', 'plugins', 'valorbrain'), { recursive: true });
    writeFileSync(join(h, PLUGIN_REL), body);
}

const PLUGIN = (version) => `# memory provider do Hermes\n_CONTRACT_VERSION = "${version}"\n\nclass MemoryProvider:\n    pass\n`;

function manifest(kind, contractVersion = '8') {
    return {
        name: kind === 'plugin' ? 'Hermes Agent' : 'Some Harness',
        harness: kind === 'plugin' ? 'hermes' : 'some-harness',
        contract_version: contractVersion,
        artifacts: [{
            kind,
            path: kind === 'plugin' ? '~/.hermes/plugins/valorbrain/__init__.py' : '~/AGENTS.md',
            label: 'artifact',
        }],
    };
}

test('plugin: `_CONTRACT_VERSION` matching the manifest is ok — no rules marker needed', () => {
    const h = home();
    writePlugin(h, PLUGIN('8'));
    const rows = statusFor(manifest('plugin'), h);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { kind: 'plugin', state: 'ok', detail: 'contract v8' });
});

test('plugin: an older contract is drift and says which one is current', () => {
    const h = home();
    writePlugin(h, PLUGIN('7'));
    assert.deepEqual(statusFor(manifest('plugin'), h), [
        { kind: 'plugin', state: 'drift', detail: 'contract v7 (current is v8)' },
    ]);
});

test('plugin: a file without `_CONTRACT_VERSION` is drift, not "no valorbrain block"', () => {
    const h = home();
    writePlugin(h, 'def unrelated():\n    pass\n');
    assert.deepEqual(statusFor(manifest('plugin'), h), [
        { kind: 'plugin', state: 'drift', detail: 'plugin without a contract version — reinstall it' },
    ]);
});

test('plugin: an absent file is still missing', () => {
    const h = home();
    assert.deepEqual(statusFor(manifest('plugin'), h), [
        { kind: 'plugin', state: 'missing', detail: 'file absent' },
    ]);
});

test('rules: the `valorbrain-contract` marker keeps deciding, as before', () => {
    const h = home();
    const rules = (version) => `<!-- valorbrain-contract: v${version} harness: some-harness -->\n\n# rules\n`;
    writeFileSync(join(h, 'AGENTS.md'), rules('8'));
    assert.deepEqual(statusFor(manifest('rules'), h), [
        { kind: 'rules', state: 'ok', detail: 'contract v8' },
    ]);

    writeFileSync(join(h, 'AGENTS.md'), rules('6'));
    assert.deepEqual(statusFor(manifest('rules'), h), [
        { kind: 'rules', state: 'drift', detail: 'contract v6 (current is v8)' },
    ]);

    writeFileSync(join(h, 'AGENTS.md'), '# rules sem bloco\n');
    assert.deepEqual(statusFor(manifest('rules'), h), [
        { kind: 'rules', state: 'missing', detail: 'no valorbrain block' },
    ]);
});
