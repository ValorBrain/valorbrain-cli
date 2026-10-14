#!/usr/bin/env node
/**
 * launcher.mjs — the stable entry every hosted hook command runs (connect ≥ 0.11,
 * contract A). Lives at ~/.valorbrain/bin/connect/launcher.mjs; the hooks say
 *
 *   node "<that path>" hook <event> --harness=<id>
 *
 * forever: no version and no `||` in the command, so a version update never
 * touches a harness config file (and the command parses in sh, cmd and both
 * PowerShells). The version lives in current.json next to this file:
 *
 *   { "version": "0.11.0", "integrity": "sha512-…", "data_scope": 1, "installed_at": "…" }
 *
 * and the code in ./<version>/, a self-contained copy of the package that runs
 * with plain node or Bun. The launcher points process.argv[1] at
 * ./<version>/hook.mjs (index.mjs for `heal`) and imports it: that file runs
 * its own entry point with the same argv and stdin.
 *
 * Built-ins only, and small on purpose: it is updated in place (tmp + rename)
 * but runs on every hook event. Silence is the contract: when current.json or
 * the version directory is missing, unreadable or unsafe it writes one line to
 * stderr, prints the harness's empty answer and exits 0.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const [command] = process.argv.slice(2);
const harness = (process.argv.find((a) => a.startsWith('--harness=')) || '').slice(10);

/** A directory or file only this user can change (not a symlink, our uid, not group/world-writable). */
function safe(path, kind) {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return `${path} is a symlink`;
    if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return `${path} is not a ${kind === 'dir' ? 'directory' : 'file'}`;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `${path} belongs to another user`;
    if (process.platform !== 'win32' && (st.mode & 0o022) !== 0) return `${path} is writable by others`;
    return '';
}

/** The entry file for this command, or a reason it cannot run. */
function resolveEntry() {
    let current;
    try {
        current = JSON.parse(readFileSync(join(root, 'current.json'), 'utf-8'));
    } catch {
        return { error: 'no current.json — run: npx -y @valorbrain/connect' };
    }
    const version = String(current?.version ?? '');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return { error: 'current.json names no valid version' };
    const dir = join(root, version);
    const entry = join(dir, command === 'heal' ? 'index.mjs' : 'hook.mjs');
    try {
        const reason = safe(root, 'dir') || safe(dir, 'dir') || safe(entry, 'file');
        if (reason) return { error: `refusing to run ${version}: ${reason}` };
    } catch {
        return { error: `version ${version} is not installed` };
    }
    return { entry };
}

/** The harness's "nothing to add" answer: Gemini and Cursor parse stdout as JSON. */
function emptyAnswer() {
    return command === 'hook' && (harness === 'gemini-cli' || harness === 'gemini' || harness === 'cursor') ? '{}' : '';
}

if (!['hook', 'heal', 'transcript-upload'].includes(command)) {
    process.stderr.write('usage: launcher.mjs hook <event> --harness=<id> | heal --harness=<id>\n');
    process.exitCode = 2;
} else {
    const { entry, error } = resolveEntry();
    if (error) {
        process.stderr.write(`[valorbrain] launcher: ${error}\n`);
        const out = emptyAnswer();
        if (out) process.stdout.write(out + '\n');
        process.exitCode = 0;
    } else {
        process.argv[1] = entry;
        import(pathToFileURL(entry).href).catch((e) => {
            process.stderr.write(`[valorbrain] launcher: ${e?.code || e?.message || 'load failed'}\n`);
            const out = emptyAnswer();
            if (out) process.stdout.write(out + '\n');
            process.exit(0);
        });
    }
}
