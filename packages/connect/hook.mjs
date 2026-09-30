/**
 * hook.mjs — the ValorBrain hook client, protocol v2 (ADR-058). Built-ins only.
 *
 * Every harness with file-configured hooks runs this for three moments:
 *
 *   session-start → context for the session (POST /api/v1/hooks/cue, no LLM)
 *   prompt        → context for this prompt (same endpoint, no LLM)
 *   stop          → every few turns, a short memory checkpoint handed to the
 *                   harness's OWN model through the harness's continuation
 *                   mechanism; the model records through MCP (or records nothing)
 *
 * Nothing here uploads a transcript or asks the server to run a model.
 *
 * Rules this file keeps:
 *   - The token never travels on argv. It comes from `~/.valorbrain/connect.json`
 *     (0600, written by the installer, one entry PER HARNESS — two harnesses on
 *     one machine may belong to two tenants), `VALORBRAIN_TOKEN`, or — for
 *     installs that predate v2 — a legacy `--token=` argument, which self-heal
 *     then migrates into this harness's entry.
 *   - The dialect comes from the payload, not from the file that invoked us:
 *     Grok loads ~/.cursor/hooks.json unchanged and Cursor loads Claude's
 *     settings.json, so the same command is called by different harnesses.
 *   - Stop never loops. The harness's own re-entry flag wins
 *     (`stop_hook_active` / `stopHookActive`); where there is none (Kiro,
 *     Cursor's per-conversation `loop_count`), an `awaiting` flag marks the
 *     Stop that follows our own continuation.
 *   - Silence is the failure mode: every error path exits 0 with the dialect's
 *     empty answer and at most one line on stderr. A hook that breaks a prompt
 *     is worse than a hook that adds nothing.
 */

import { createHash } from 'node:crypto';
import {
    chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
    readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const HOOK_PROTOCOL = 2;
export const DEFAULT_API = 'https://valorbrain-api.valor.digital';

/** Mirrors DEFAULT_CHECKPOINT_POLICY in the engine; the server's answer wins. */
export const DEFAULT_POLICY = Object.freeze({
    min_turns: 3,
    long_turn_ms: 8 * 60_000,
    min_interval_ms: 10 * 60_000,
    max_per_session: 6,
});

const MIN = 60_000;
const STATE_TTL_MS = 12 * 60 * MIN;      // a session idle this long starts over
const AWAITING_TTL_MS = 30 * MIN;        // our continuation must arrive by then
const MAX_TURN_MS = 2 * 60 * MIN;        // one turn never counts for more than this
const LOCK_STALE_MS = 20_000;
const CUE_UNSUPPORTED_TTL_MS = 6 * 60 * MIN;
const STATE_GC_MS = 7 * 24 * 60 * MIN;

// ─── request budget ──────────────────────────────────────────────────────────
// Harnesses cut a hook at 10s (src/harness/adapters.ts in the engine) and a
// cold `npx -y` costs ~3.4s (Qa, VAL-195): the old 7s context budget summed to
// 10.4s, the process got killed mid-request, and the prompt's saved state died
// with it. Both moments now share the 4s stop ceiling — ~2.5s of margin — and
// VALORBRAIN_HOOK_TIMEOUT_MS still overrides for slow private networks.
const CONTEXT_TIMEOUT_MS = 4000;
const STOP_TIMEOUT_MS = 4000;

/** Network budget for one hook moment (postCue and its legacy fallback). */
export function requestTimeoutMs(event, env = {}) {
    return Number(env.VALORBRAIN_HOOK_TIMEOUT_MS) || (event === 'stop' ? STOP_TIMEOUT_MS : CONTEXT_TIMEOUT_MS);
}

// ─── credentials ─────────────────────────────────────────────────────────────

export function credsPath(home) {
    return join(home, '.valorbrain', 'connect.json');
}

function readJson(path) {
    try {
        const v = JSON.parse(readFileSync(path, 'utf-8'));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Engine adapter aliases (src/harness/adapters.ts) → canonical id. Credentials are keyed by the canonical id. */
const HARNESS_ALIASES = { claude: 'claude-code', 'kiro-cli': 'kiro', gemini: 'gemini-cli', 'oh-my-pi': 'omp', ohmypi: 'omp', 'hermes-agent': 'hermes' };
export function canonicalHarness(name) {
    const n = str(name).toLowerCase();
    return HARNESS_ALIASES[n] ?? n;
}
const normalizeApi = (url) => str(url).replace(/\/+$/, '').replace(/\/mcp$/, '');

function readCredsFile(home) {
    // A pre-0.5.0 file ({version:1, api_url, token}, single credential) was only
    // ever written by unpublished builds of this PR and reads as empty on
    // purpose: v1 keyed no harness, and borrowing one harness's token pulled
    // recall from the wrong tenant. Run the installer again to be re-keyed.
    const c = readJson(credsPath(home));
    return c && c.version === 2 && c.harnesses && typeof c.harnesses === 'object' ? c : { version: 2, harnesses: {} };
}

/** This harness's credential, or null. Never another harness's. */
export function readCreds(home, harness) {
    if (!harness) return null;
    const e = readCredsFile(home).harnesses[canonicalHarness(harness)];
    const token = str(e?.token);
    if (!token) return null;
    const creds = { token, api: normalizeApi(e?.api_url) || null };
    if (e?.kiro_engine === 'legacy') creds.kiro_engine = 'legacy';
    return creds;
}

/**
 * The API base a token was saved with, from any harness's entry. A base
 * belongs to its token, not to a harness: installing a second harness with the
 * same token reuses the engine the first one was pointed at.
 */
export function savedApiForToken(home, token) {
    if (!token) return null;
    for (const e of Object.values(readCredsFile(home).harnesses)) {
        if (str(e?.token) === token && normalizeApi(e?.api_url)) return normalizeApi(e.api_url);
    }
    return null;
}

/** Every stored entry (for --status). */
export function listCreds(home) {
    const out = {};
    for (const [h, e] of Object.entries(readCredsFile(home).harnesses)) {
        if (str(e?.token)) out[h] = { api: normalizeApi(e?.api_url) || null };
    }
    return out;
}

/**
 * Serialize read-modify-write of connect.json across processes (two harnesses
 * migrating at the same moment must not drop each other's entry). Sync, short,
 * with a stale-lock breaker — a crashed writer never wedges the file.
 */
function withCredsLock(home, fn) {
    const lock = `${credsPath(home)}.lock`;
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const nap = new Int32Array(new SharedArrayBuffer(4));
    let held = false;
    for (let i = 0; i < 40 && !held; i++) {
        try {
            closeSync(openSync(lock, 'wx'));
            held = true;
        } catch {
            try { if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock); } catch { /* gone */ }
            Atomics.wait(nap, 0, 0, 25);
        }
    }
    try {
        return fn();
    } finally {
        if (held) { try { unlinkSync(lock); } catch { /* already gone */ } }
    }
}

function writeCredsFile(home, data) {
    const path = credsPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* not supported on this fs */ }
    return path;
}

/** Atomic read-modify-write of this harness's entry; 0600 file in a 0700 dir. */
export function writeCreds(home, { api, token, harness, kiroEngine }) {
    if (!harness) throw new Error('writeCreds needs the harness id');
    const id = canonicalHarness(harness);
    return withCredsLock(home, () => {
        const data = readCredsFile(home); // re-read under the lock
        const entry = { api_url: normalizeApi(api) || DEFAULT_API, token, updated_at: new Date().toISOString() };
        // The engine opt-in is the ONLY record that "agent config in $HOME"
        // means legacy: connect 0.5.1 wrote that file BY DEFAULT, so its
        // existence proves nothing (VAL-224 S1). The default (v3) clears it.
        if (kiroEngine === 'legacy') entry.kiro_engine = 'legacy';
        data.harnesses[id] = entry;
        return writeCredsFile(home, data);
    });
}

/** Drop one harness's entry (or all); the file goes when nothing is left. */
export function removeCreds(home, harness) {
    try {
        if (!harness) {
            unlinkSync(credsPath(home));
            return true;
        }
        const id = canonicalHarness(harness);
        return withCredsLock(home, () => {
            const data = readCredsFile(home);
            if (!data.harnesses[id]) return false;
            delete data.harnesses[id];
            if (Object.keys(data.harnesses).length === 0) unlinkSync(credsPath(home));
            else writeCredsFile(home, data);
            return true;
        });
    } catch {
        return false;
    }
}

/**
 * Precedence: legacy `--token=` (argv) > VALORBRAIN_TOKEN > this harness's
 * connect.json entry > the CLI's ~/.valorbrain/config.json (`api_key`). The
 * API base follows the token: an explicit --api / VALORBRAIN_API_URL wins;
 * then a base saved with THIS token (a base belongs to its token, never to
 * another credential's); then — argv/env tokens only — the machine's own
 * `config.json` engine_url, the local engine CLI's file and the only local
 * evidence of a non-public engine: v1 hooks installed from it carry the token
 * on argv, and dropping this step migrated self-hosted v1 clients to the
 * public API in silence. A connect.json base of a DIFFERENT token never
 * pairs. Public default last.
 */
export function resolveCredentials({ argv = [], env = {}, home, harness = '' }) {
    const arg = (p) => argv.find((a) => a.startsWith(p))?.slice(p.length) || '';
    const cli = home ? readJson(join(home, '.valorbrain', 'config.json')) : null;
    const explicit = normalizeApi(arg('--api=')) || normalizeApi(env.VALORBRAIN_API_URL);
    const local = (token) => savedApiForToken(home, token) || normalizeApi(cli?.engine_url) || DEFAULT_API;
    if (arg('--token=')) return { token: arg('--token='), api: explicit || local(arg('--token=')), source: 'argv' };
    if (str(env.VALORBRAIN_TOKEN)) return { token: str(env.VALORBRAIN_TOKEN), api: explicit || local(str(env.VALORBRAIN_TOKEN)), source: 'env' };
    const saved = home ? readCreds(home, harness) : null;
    if (saved?.token) return { token: saved.token, api: explicit || saved.api || DEFAULT_API, source: 'connect' };
    if (str(cli?.api_key)) return { token: str(cli.api_key), api: explicit || normalizeApi(cli?.engine_url) || DEFAULT_API, source: 'config' };
    return { token: null, api: explicit || DEFAULT_API, source: null };
}

// ─── events and dialects ─────────────────────────────────────────────────────

const EVENT_ALIASES = {
    'session-start': 'session_start',
    'session-bootstrap': 'session_start',
    'postcompact-inject': 'session_start',
    prompt: 'prompt',
    'context-surfacing': 'prompt',
    'memory-prepare': 'prompt',
    stop: 'stop',
};

/** Legacy extraction hooks: served only when wired explicitly (they upload a transcript). */
export const EXTRACTION_HOOKS = new Set([
    'decision-extractor', 'episode-extractor', 'handoff-generator',
    'feedback-loop', 'precompact-extract', 'staleness-check',
]);

export function normalizeEvent(name) {
    return EVENT_ALIASES[String(name || '').toLowerCase()] || null;
}

const DIALECT_BY_HARNESS = {
    'claude-code': 'claude', claude: 'claude',
    codex: 'codex',
    kiro: 'kiro', 'kiro-cli': 'kiro',
    'gemini-cli': 'gemini', gemini: 'gemini',
    cursor: 'cursor',
    grok: 'grok',
    opencode: 'text', omp: 'text', hermes: 'text',
};

const GEMINI_EVENTS = /^(BeforeAgent|AfterAgent|BeforeModel|AfterModel|BeforeTool|AfterTool|BeforeToolSelection|PreCompress|SessionEnd|Notification)$/;

/**
 * Which harness is calling. Structured signals only (fields, env), checked in
 * the order that disambiguates shared files: Cursor and Grok first because they
 * read other harnesses' files, then Gemini and Kiro by their event vocabulary,
 * then the `--harness` the installer wrote.
 */
export function detectDialect(payload, env = {}, harness = '', format = '') {
    const p = payload && typeof payload === 'object' ? payload : {};
    const ev = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
    if (env.CURSOR_VERSION || typeof p.cursor_version === 'string' || (p.conversation_id && p.generation_id)) return 'cursor';
    if (typeof p.hookEventName === 'string' || 'stopHookActive' in p || 'workspaceRoot' in p) return 'grok';
    if (env.GEMINI_SESSION_ID || env.GEMINI_PROJECT_DIR || GEMINI_EVENTS.test(ev)) return 'gemini';
    if (ev === 'agentSpawn' || ev === 'userPromptSubmit' || 'assistant_response' in p) return 'kiro';
    const byHarness = DIALECT_BY_HARNESS[String(harness || '').toLowerCase()];
    if (byHarness) return byHarness;
    if (format === 'json') return 'claude';
    if (format === 'text') return 'text';
    return /^[A-Z]/.test(ev) ? 'claude' : 'text';
}

/** How each harness names MCP tools — mirrors the adapters' `toolPrefix`. */
export function toolPrefixFor(dialect) {
    return dialect === 'kiro' ? 'mcp_valorbrain_' : dialect === 'codex' ? 'valorbrain__' : '';
}

const CLAUDE_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

/** stdout for a context event. '' means print nothing. */
export function renderContext(dialect, event, context, payload = {}) {
    const has = typeof context === 'string' && context.trim().length > 0;
    switch (dialect) {
        case 'claude':
        case 'codex': {
            if (!has) return '';
            const fromPayload = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : '';
            const hookEventName = CLAUDE_CONTEXT_EVENTS.has(fromPayload)
                ? fromPayload
                : event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart';
            return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } });
        }
        case 'gemini': {
            // Gemini parses stdout as JSON on exit 0: always print an object.
            if (!has) return '{}';
            const hookEventName = event === 'prompt' ? 'BeforeAgent' : 'SessionStart';
            return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } });
        }
        case 'cursor':
            // Only sessionStart can add context in Cursor.
            return has && event === 'session_start' ? JSON.stringify({ additional_context: context }) : '{}';
        case 'grok':
            return ''; // passive stdout is discarded
        default: // kiro, text
            return has ? context : '';
    }
}

/** stdout that makes the harness continue with `cue` as the next instruction. */
export function renderCheckpoint(dialect, cue) {
    switch (dialect) {
        case 'cursor':
            return JSON.stringify({ followup_message: cue });
        case 'gemini':
            return JSON.stringify({ decision: 'deny', reason: cue });
        case 'text':
            return ''; // no continuation mechanism (OpenCode plugin, legacy text)
        default: // claude, codex, kiro, grok
            return JSON.stringify({ decision: 'block', reason: cue });
    }
}

/** stdout for "let the turn end". */
export function renderSilentStop(dialect) {
    return dialect === 'gemini' || dialect === 'cursor' ? '{}' : '';
}

/**
 * Same text as the engine's `renderCheckpointCue` v1 — used only when the
 * engine predates the cue endpoint. Keep the two in step.
 */
export function fallbackCue(toolPrefix = '') {
    const t = (name) => `\`${toolPrefix}${name}\``;
    return [
        'ValorBrain memory checkpoint v1 (automatic, at most once every few turns; not an error).',
        "Before you finish, take one short step: review the work since the last checkpoint and record only what a future session (yours or a teammate's) would need.",
        `- a decision (what was chosen, why, what was rejected) → ${t('memory_store')} type="decision"`,
        `- a root cause → type="problem"; a reusable takeaway → type="lesson" or ${t('record_lesson')}`,
        `- progress on long work → ${t('task_state')} action="progress"; work someone else must pick up → ${t('team_handoff')}`,
        `- memories you actually relied on → ${t('memory_used')} with their docids and a one-line note`,
        'One call per durable item. Skip what is already stored, trivial, or secret (credentials belong in the vault, never in memory).',
        'If nothing qualifies, call nothing. Then end your turn with one line, e.g. "checkpoint: 2 saved" or "checkpoint: nothing durable". Do not resume the previous task.',
    ].join('\n');
}

// ─── per-session state ───────────────────────────────────────────────────────

function stateDir(home) {
    return join(home, '.valorbrain', 'state', 'hooks');
}

export function sessionKey(dialect, payload, env = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const sid = str(p.session_id) || str(p.sessionId) || str(p.conversation_id) || str(env.GEMINI_SESSION_ID);
    const where = sid || `cwd:${str(p.cwd) || str(p.workspaceRoot) || str(env.CURSOR_PROJECT_DIR) || process.cwd()}`;
    return createHash('sha256').update(`${dialect}\n${where}`).digest('hex').slice(0, 24);
}

function freshState(now) {
    return {
        v: 1, createdAt: now, updatedAt: now,
        turns: 0, busyMs: 0, turnStartedAt: null,
        checkpoints: 0, lastCheckpointAt: null,
        awaiting: false, awaitingAt: null,
        contextAt: null,
        lastStopId: null,
    };
}

export function loadState(home, key, now = Date.now()) {
    const s = readJson(join(stateDir(home), `${key}.json`));
    if (!s || s.v !== 1 || typeof s.updatedAt !== 'number' || now - s.updatedAt > STATE_TTL_MS) return freshState(now);
    return { ...freshState(now), ...s };
}

export function saveState(home, key, state, now = Date.now()) {
    try {
        const dir = stateDir(home);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${key}.json`);
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: now }), { mode: 0o600 });
        renameSync(tmp, path);
    } catch { /* state is an optimisation; never fail the hook for it */ }
}

/** One decider per session at a time — the same Stop can arrive through two files. */
export function acquireLock(home, key, now = Date.now()) {
    const path = join(stateDir(home), `${key}.lock`);
    try {
        mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
        closeSync(openSync(path, 'wx'));
        return path;
    } catch {
        try {
            if (now - statSync(path).mtimeMs > LOCK_STALE_MS) {
                unlinkSync(path);
                closeSync(openSync(path, 'wx'));
                return path;
            }
        } catch { /* lost the race */ }
        return null;
    }
}

export function releaseLock(path) {
    if (!path) return;
    try { unlinkSync(path); } catch { /* already gone */ }
}

/** Drop state files nobody touched in a week (called at session start). */
export function gcState(home, now = Date.now()) {
    try {
        const dir = stateDir(home);
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            try { if (now - statSync(p).mtimeMs > STATE_GC_MS) unlinkSync(p); } catch { /* next */ }
        }
    } catch { /* no dir yet */ }
}

/** This Stop follows a block (ours or anyone's) — never checkpoint it. */
export function isContinuation(payload, state, now = Date.now()) {
    const p = payload || {};
    if (p.stop_hook_active === true || p.stopHookActive === true) return true;
    return !!(state?.awaiting && typeof state.awaitingAt === 'number' && now - state.awaitingAt < AWAITING_TTL_MS);
}

/** Only a turn that really completed is work worth a checkpoint. */
export function isGenuineCompletion(dialect, payload) {
    const p = payload || {};
    if (dialect === 'cursor' && typeof p.status === 'string') return p.status === 'completed';
    if (dialect === 'grok' && typeof p.reason === 'string' && p.reason) return p.reason === 'end_turn';
    return true;
}

/**
 * Local mirror of the engine's decideCheckpoint — saves a request when nothing
 * is due. Same floors as the engine: never on the first turn (a one-shot
 * `-p`/SDK/exec run is not a session) and never less than a minute apart.
 */
export function localDecide(state, policy = DEFAULT_POLICY, now = Date.now()) {
    const pol = { ...DEFAULT_POLICY, ...(policy || {}) };
    if (!(pol.max_per_session > 0)) return false;
    if (state.checkpoints >= pol.max_per_session) return false;
    const anchor = state.lastCheckpointAt ?? state.createdAt ?? null;
    if (anchor !== null && now - anchor < Math.max(60_000, pol.min_interval_ms)) return false;
    const minTurns = Math.max(2, pol.min_turns);
    return state.turns >= minTurns || (state.turns >= 2 && state.busyMs >= pol.long_turn_ms);
}

// ─── capability / policy cache (per API) ─────────────────────────────────────

function capsPath(home) {
    return join(home, '.valorbrain', 'state', 'caps.json');
}

function readCaps(home, api) {
    return readJson(capsPath(home))?.[api] || {};
}

function writeCaps(home, api, patch) {
    try {
        const all = readJson(capsPath(home)) || {};
        all[api] = { ...(all[api] || {}), ...patch };
        mkdirSync(dirname(capsPath(home)), { recursive: true, mode: 0o700 });
        writeFileSync(capsPath(home), JSON.stringify(all), { mode: 0o600 });
    } catch { /* cache only */ }
}

// ─── network ─────────────────────────────────────────────────────────────────

async function postCue(api, token, body, timeoutMs, fetchImpl) {
    const res = await fetchImpl(`${api}/api/v1/hooks/cue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json };
}

/**
 * One MCP tool call over Streamable HTTP without an SDK (2026-07-28 wire: no
 * initialize handshake, a single POST with the `_meta` envelope). Fallback for
 * engines that predate the cue endpoint.
 */
export async function callTool(api, token, name, args, timeoutMs, fetchImpl, clientVersion = '0.5.3') {
    const res = await fetchImpl(`${api}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': name,
        },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: {
                name, arguments: args,
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': { name: 'valorbrain-connect', version: clientVersion },
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            },
        }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const payload = text.startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) || '').slice(5).trim();
    if (!payload) throw new Error('empty response');
    const parsed = JSON.parse(payload);
    if (parsed.error) throw new Error(parsed.error.message || 'tool error');
    return parsed.result;
}

async function legacyContext(api, token, message, timeoutMs, fetchImpl, clientVersion) {
    const result = await callTool(api, token, 'memory_prepare', { message, fast_mode: true }, timeoutMs, fetchImpl, clientVersion);
    return (result?.content || []).map((c) => c?.text).filter(Boolean).join('\n').trim();
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** Legacy explicit extraction hooks (uploads the transcript to /api/v1/hooks/run). */
async function runExtraction(api, token, name, payload, fetchImpl) {
    const input = {
        sessionId: payload?.session_id || payload?.sessionId,
        prompt: payload?.prompt,
        hookEventName: payload?.hook_event_name || payload?.hookEventName,
        workingDir: payload?.cwd || payload?.working_dir || payload?.workingDir,
        lastAssistantMessage: payload?.last_assistant_message || payload?.lastAssistantMessage,
    };
    let transcript = '';
    const tp = payload?.transcript_path || payload?.transcriptPath;
    if (tp && existsSync(tp)) {
        try { transcript = readFileSync(tp, 'utf-8').slice(0, MAX_TRANSCRIPT_BYTES); } catch { transcript = ''; }
    }
    const res = await fetchImpl(`${api}/api/v1/hooks/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ hook: name, input, transcript }),
        signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
}

// ─── main ────────────────────────────────────────────────────────────────────

function readPrompt(p) {
    for (const k of ['prompt', 'user_prompt', 'userPrompt', 'message', 'query', 'text']) {
        if (typeof p?.[k] === 'string' && p[k].trim()) return p[k];
    }
    return '';
}

/**
 * Run one hook. Returns the exit code (always 0 — silence is the failure mode).
 *
 * `deps` makes it testable and lets the installer plug in its self-heal:
 *   env, home, payload (parsed stdin), fetchImpl, now, heal, out, err, clientVersion
 */
export async function runHook(argv, deps = {}) {
    const env = deps.env ?? process.env;
    const home = deps.home ?? env.HOME ?? '';
    const now = deps.now ?? Date.now();
    const fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
    const out = deps.out ?? ((s) => process.stdout.write(s + '\n'));
    const err = deps.err ?? ((s) => process.stderr.write(`[valorbrain] ${s}\n`));
    const clientVersion = deps.clientVersion ?? '0.5.3';
    const payload = deps.payload && typeof deps.payload === 'object' ? deps.payload : {};

    const name = argv.find((a) => !a.startsWith('-')) || 'context-surfacing';
    const format = argv.find((a) => a.startsWith('--format='))?.slice(9) || '';
    const harness = canonicalHarness(argv.find((a) => a.startsWith('--harness='))?.slice(10) || str(env.VALORBRAIN_HARNESS));
    const dialect = detectDialect(payload, env, harness, format);
    const emit = (s) => { if (s) out(s); return 0; };

    const creds = resolveCredentials({ argv, env, home, harness });
    const event = normalizeEvent(name);

    if (!creds.token) {
        // Not an error for the harness, but the user should be able to find out.
        if (event || EXTRACTION_HOOKS.has(name)) err(`${name}: no credentials (run: npx @valorbrain/connect --token vbm_…)`);
        return emit(event === 'stop' ? renderSilentStop(dialect) : renderContext(dialect, event, '', payload));
    }

    const heal = typeof deps.heal === 'function'
        ? Promise.race([
            Promise.resolve().then(() => deps.heal({ api: creds.api, token: creds.token, harness, home, credsSource: creds.source })),
            new Promise((r) => setTimeout(r, 2500)),
        ]).catch(() => {})
        : Promise.resolve();

    if (EXTRACTION_HOOKS.has(name)) {
        await Promise.all([runExtraction(creds.api, creds.token, name, payload, fetchImpl).catch(() => false), heal]);
        return 0;
    }
    if (!event) {
        await heal;
        return 0;
    }

    const timeoutMs = requestTimeoutMs(event, env);
    const key = sessionKey(dialect, payload, env);
    const state = loadState(home, key, now);
    const caps = readCaps(home, creds.api);
    const cueKnownMissing = caps.cue === false && typeof caps.cueCheckedAt === 'number' && now - caps.cueCheckedAt < CUE_UNSUPPORTED_TTL_MS;
    const sessionId = str(payload.session_id) || str(payload.sessionId) || str(payload.conversation_id) || str(env.GEMINI_SESSION_ID) || null;
    const base = { harness: harness || dialect, session_id: sessionId };

    // ── context moments ──
    if (event === 'session_start' || event === 'prompt') {
        if (event === 'prompt') {
            state.turnStartedAt = now;
            state.awaiting = false; // a new user prompt ends any pending continuation
        } else {
            gcState(home, now);
        }
        const injectable = dialect !== 'grok' && !(dialect === 'cursor' && event === 'prompt');
        const duplicate = event === 'session_start' && typeof state.contextAt === 'number' && now - state.contextAt < 20_000;
        const prompt = event === 'prompt' ? readPrompt(payload) : '';
        if (!injectable || duplicate || (event === 'prompt' && !prompt.trim())) {
            saveState(home, key, state, now);
            await heal;
            return emit(renderContext(dialect, event, '', payload));
        }
        // The harness may kill us while the request is in flight (its 10s cut
        // minus a cold npx). Persist the turn bookkeeping BEFORE the network:
        // a killed prompt keeps turnStartedAt/awaiting=false on disk, so the
        // Stop that ends the turn still counts it instead of misreading a
        // stale awaiting flag as our continuation.
        saveState(home, key, state, now);
        let context = '';
        let failure = '';
        try {
            let served = false;
            if (!cueKnownMissing) {
                const r = await postCue(creds.api, creds.token, {
                    ...base, event,
                    // The engine keeps 8k chars and caps the body at 64 KB: a
                    // pasted log must not become a 413 and lose recall.
                    ...(event === 'prompt' ? { prompt: prompt.slice(0, 8_000) } : {}),
                    ...(typeof payload.source === 'string' ? { source: payload.source } : {}),
                }, timeoutMs, fetchImpl);
                if (r.status === 404 || r.status === 405) writeCaps(home, creds.api, { cue: false, cueCheckedAt: now });
                else if (r.status === 403) {
                    // An engine that predates the cue treats this POST as a
                    // write and refuses read-scoped tokens: use the legacy path
                    // this once (not cached — on a current engine a 403 is real).
                }
                else if (r.status >= 200 && r.status < 300) {
                    served = true;
                    context = typeof r.json?.context === 'string' ? r.json.context : '';
                    if (r.json?.policy) writeCaps(home, creds.api, { cue: true, policy: r.json.policy, cueCheckedAt: now });
                } else {
                    served = true; // the endpoint exists and refused: do not paper over it
                    failure = `${event}: HTTP ${r.status}`;
                }
            }
            if (!served) {
                context = await legacyContext(creds.api, creds.token, (prompt || 'session start').slice(0, 8_000), timeoutMs, fetchImpl, clientVersion);
            }
        } catch (e) {
            failure = `${event}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message || 'request failed'}`;
        }
        if (failure) err(failure);
        if (event === 'session_start' && context) state.contextAt = now;
        saveState(home, key, state, now);
        await heal;
        return emit(renderContext(dialect, event, context, payload));
    }

    // ── stop ──
    // Serialized per session: the same Stop can reach us through two files
    // (Cursor runs its own hooks.json and Claude's settings.json; Grok runs its
    // own and Cursor's). Whoever holds the lock owns this Stop; the other one
    // stays silent and does not touch the state — counting it would count the
    // same turn twice.
    const silent = renderSilentStop(dialect);
    // Machine-level opt-out (the engine has the same switch for everyone), and
    // headless runs: an SDK-driven Claude Code session's final message is
    // somebody's program output, never a place for a checkpoint.
    if (/^(off|0|false)$/i.test(str(env.VALORBRAIN_CHECKPOINT)) || /^sdk/i.test(str(env.CLAUDE_CODE_ENTRYPOINT))) {
        await heal;
        return emit(silent);
    }
    // Without a session id the state is keyed by directory, and a directory
    // cannot tell one-shot runs (CI, agent daemons reusing a workdir) from a
    // session — so no checkpoint. Every documented dialect sends an id.
    if (!sessionId) {
        await heal;
        return emit(silent);
    }
    const lock = acquireLock(home, key, now);
    if (!lock) {
        await heal;
        return emit(silent);
    }
    let output = silent;
    try {
        const st = loadState(home, key, now); // re-read under the lock
        const stopId = str(payload.generation_id) || str(payload.promptId) || str(payload.turn_id);
        if (stopId && stopId === st.lastStopId) {
            // Same event delivered twice, one after the other.
        } else if (!isGenuineCompletion(dialect, payload)) {
            if (stopId) st.lastStopId = stopId;
            saveState(home, key, st, now);
        } else if (isContinuation(payload, st, now)) {
            st.awaiting = false;
            st.awaitingAt = null;
            if (stopId) st.lastStopId = stopId;
            saveState(home, key, st, now);
        } else {
            if (stopId) st.lastStopId = stopId;
            st.turns += 1;
            if (typeof st.turnStartedAt === 'number') st.busyMs += Math.min(Math.max(0, now - st.turnStartedAt), MAX_TURN_MS);
            st.turnStartedAt = null;
            if (dialect !== 'text' && localDecide(st, caps.policy || DEFAULT_POLICY, now)) {
                output = (await checkpointFor(st)) || silent;
            }
            saveState(home, key, st, now);
        }
    } finally {
        releaseLock(lock);
    }
    await heal;
    return emit(output);

    /** Ask the server (or, on an older engine, use the built-in cue); mutates `st`. */
    async function checkpointFor(st) {
        let cue = null;
        let reset = false;
        if (cueKnownMissing) {
            cue = fallbackCue(toolPrefixFor(dialect));
        } else {
            try {
                const r = await postCue(creds.api, creds.token, {
                    ...base, event: 'stop',
                    state: {
                        turns: st.turns,
                        busy_ms: st.busyMs,
                        checkpoints: st.checkpoints,
                        session_started_at: st.createdAt,
                        last_checkpoint_at: st.lastCheckpointAt,
                    },
                }, timeoutMs, fetchImpl);
                if (r.status === 404 || r.status === 405) {
                    writeCaps(home, creds.api, { cue: false, cueCheckedAt: now });
                    cue = fallbackCue(toolPrefixFor(dialect));
                } else if (r.status === 403) {
                    // Refused: on a current engine that is a real "no" (scope,
                    // VALORBRAIN_CHECKPOINT=off stays server-side) — never
                    // override it with the built-in cue.
                    err('stop: HTTP 403');
                } else if (r.status >= 200 && r.status < 300) {
                    if (r.json?.policy) writeCaps(home, creds.api, { cue: true, policy: r.json.policy, cueCheckedAt: now });
                    cue = typeof r.json?.checkpoint?.text === 'string' ? r.json.checkpoint.text : null;
                    reset = r.json?.reset === true;
                } else {
                    err(`stop: HTTP ${r.status}`);
                }
            } catch (e) {
                err(`stop: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message || 'request failed'}`);
            }
        }
        if (cue) {
            st.checkpoints += 1;
            st.lastCheckpointAt = now;
            st.turns = 0;
            st.busyMs = 0;
            st.awaiting = true;
            st.awaitingAt = now;
            return renderCheckpoint(dialect, cue);
        }
        if (reset) {
            // The agent recorded memory on its own since the last checkpoint:
            // that counts as the checkpoint, without a nudge.
            st.lastCheckpointAt = now;
            st.turns = 0;
            st.busyMs = 0;
        }
        return '';
    }
}

/** Parse the harness payload from stdin ('' or invalid JSON → {}). */
export async function readStdinPayload(stdin = process.stdin) {
    if (stdin.isTTY) return {};
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}
