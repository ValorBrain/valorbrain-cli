#!/usr/bin/env node
/**
 * @valorbrain/connect — wire a CLI agent harness to hosted ValorBrain.
 *
 * A customer has an MCP endpoint and a `vbm_` token. They do not have the engine,
 * so `valorbrain setup harness` is not available to them. This is the client half:
 * it asks the engine for the rendered artifacts and writes them.
 *
 * Node built-ins; `yaml` only to merge the Hermes config, loaded lazily: a
 * version copied under ~/.valorbrain/bin/connect/ has no node_modules, and
 * neither its hooks nor its self-heal (which never touches MCP entries) need it.
 *
 *   npx @valorbrain/connect                            # detect, approve in the browser, wire everything
 *   npx @valorbrain/connect --token vbm_xxx            # same, with a token you already have
 *   npx @valorbrain/connect --token vbm_xxx --harness kiro
 *   npx @valorbrain/connect --token vbm_xxx --dry-run
 *   npx @valorbrain/connect --status
 *   npx @valorbrain/connect --token vbm_xxx --remove
 *
 * The engine is the source of truth for what gets written: update the contract
 * server-side and the next run of this installer picks it up. Nothing here needs
 * republishing when the rules text changes.
 */

import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  CLIENT_VERSION, HOOK_PROTOCOL, PRIVACY_KEYS, canonicalHarness, claimHeal, clientHeaders, consentedScope, credsPath, ensureInstallIds, logConnect,
  kiroEngineFromPayload, launcherPin, listCreds, noticePin, readCreds, readHealState, readStdinPayload, removeCreds, resolveCredentials,
  runHook, savedApiForToken, setPrivacy, STOP_TRANSCRIPT_HARNESSES, writeCreds, writeHealState,
} from "./hook.mjs";
import { deviceLabel, deviceLogin, installId, isUnattended, resolveAppUrl } from "./login.mjs";
import { trustedManifestKeys, verifyManifest } from "./manifest-signature.mjs";

// Optional module: a version copied under ~/.valorbrain/bin/connect/ ships no
// node_modules, and only an install merging the Hermes YAML config needs it.
let parseDocument = null;
try { ({ parseDocument } = await import("yaml")); } catch { /* not installed alongside this copy */ }

const DEFAULT_API = process.env.VALORBRAIN_API_URL || "https://valorbrain-api.valor.digital";
const BLOCK_BEGIN = "<!-- valorbrain:begin -->";
const BLOCK_END = "<!-- valorbrain:end -->";
const TOKEN_PLACEHOLDER = "vbm_<YOUR_TOKEN>";
/** Engine's launcher placeholder (contract A): the absolute launcher path, substituted after the signature check. */
const LAUNCHER_PLACEHOLDER = "<VALORBRAIN_HOOK_LAUNCHER>";
/** Any engine path placeholder left in a file would make the hook run nothing. */
const PATH_PLACEHOLDER = /<VALORBRAIN_HOOK_(?:LAUNCHER|CLIENT)>/;

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", green: "", yellow: "", red: "", bold: "", off: "" };
/** Warning marker for stderr, colored only when stderr itself is a terminal. */
const WARN = process.stderr.isTTY && !process.env.NO_COLOR ? "\x1b[33m!\x1b[0m" : "!";

// ── args ────────────────────────────────────────────────────────────────────

/** Flag each saved switch answers to (`--prompt off` → send_prompt). */
const SWITCH_FLAGS = { send_prompt: "prompt", send_transcript: "transcript", checkpoint: "checkpoint" };
/** Harnesses whose transcript `--transcript on` sends: the Hermes plugin, the omp bridge, and every Stop hook that uploads one. */
const TRANSCRIPT_HARNESSES = new Set(["hermes", "omp", ...STOP_TRANSCRIPT_HARNESSES]);

/** Artifacts that act on every turn — what --mcp-only leaves out. */
export const isPerTurn = (artifact) => artifact?.kind === "hooks";

export function parseArgs(argv) {
  const out = { harnesses: [], dryRun: false, remove: false, status: false, mcpOnly: false, api: null, app: null, token: null, noBackup: false, noBrowser: false, relogin: false, scope: null, kiroEngine: "v3", force: false, privacy: {}, unknown: [] };
  const onOff = (v) => (v === "on" ? true : v === "off" ? false : v);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--mcp-only") out.mcpOnly = true;
    // `--mcp-only=true` must never fall through to a full install that sends
    // every prompt: boolean spellings are honoured, anything else is refused.
    else if (a.startsWith("--mcp-only=")) {
      const v = a.slice(11).toLowerCase();
      out.mcpOnly = /^(true|1|yes|on)$/.test(v) ? true : /^(false|0|no|off)$/.test(v) ? false : a.slice(11);
    }
    else if (a === "--prompt") out.privacy.send_prompt = onOff(argv[++i]);
    else if (a.startsWith("--prompt=")) out.privacy.send_prompt = onOff(a.slice(9));
    else if (a === "--transcript") out.privacy.send_transcript = onOff(argv[++i]);
    else if (a.startsWith("--transcript=")) out.privacy.send_transcript = onOff(a.slice(13));
    else if (a === "--checkpoint") out.privacy.checkpoint = onOff(argv[++i]);
    else if (a.startsWith("--checkpoint=")) out.privacy.checkpoint = onOff(a.slice(13));
    else if (a === "--remove") out.remove = true;
    else if (a === "--status") out.status = true;
    else if (a === "--no-backup") out.noBackup = true;
    else if (a === "--no-browser") out.noBrowser = true;
    else if (a === "--relogin") out.relogin = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a.startsWith("--scope=")) out.scope = a.slice(8);
    else if (a === "--kiro-engine") out.kiroEngine = argv[++i];
    else if (a.startsWith("--kiro-engine=")) out.kiroEngine = a.slice(14);
    else if (a === "--token") out.token = argv[++i];
    else if (a.startsWith("--token=")) out.token = a.slice(8);
    else if (a === "--harness") out.harnesses.push(argv[++i]);
    else if (a.startsWith("--harness=")) out.harnesses.push(a.slice(10));
    else if (a === "--api") out.api = argv[++i];
    else if (a.startsWith("--api=")) out.api = a.slice(6);
    else if (a === "--app") out.app = argv[++i];
    else if (a.startsWith("--app=")) out.app = a.slice(6);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.harnesses.push(a);
    // Up to 0.8 an unknown flag was dropped in silence (`--mcp-only` on 0.8.1
    // did a full install). Now it is named on stderr — never an error: scripts
    // and docs in the field pass flags this version may not know.
    else out.unknown.push(a);
  }
  return out;
}

const HELP = `
${C.bold}@valorbrain/connect${C.off} — wire a CLI agent harness to hosted ValorBrain

  npx @valorbrain/connect                                  detect your agents, approve this computer
                                                           in the browser, wire them all
  npx @valorbrain/connect --harness kiro                   wire one
  npx @valorbrain/connect --token vbm_xxx                  use a token you already have (no browser)
  npx @valorbrain/connect --token vbm_xxx --dry-run        show the plan, write nothing
  npx @valorbrain/connect --status                         what is wired right now
  npx @valorbrain/connect --token vbm_xxx --remove         undo

Options
  --token vbm_…     MCP token (Settings → MCP Tokens in the app). Or set VALORBRAIN_MCP_TOKEN.
                    Without one, the mcp_token saved by \`npx -y @valorbrain/cli init --agent\`
                    (~/.valorbrain/config.json) is used for agents not yet connected;
                    without that either, the browser opens so you approve this computer
                    (you create your account there if needed) and it gets one token,
                    shared by the agents on it. Only vbm_ tokens are accepted.
  --no-browser      print the approval link instead of opening it (also:
                    VALORBRAIN_NO_BROWSER=1). Needed to log in from CI or
                    piped output, which otherwise stop and ask for --token;
                    SSH sessions never open a browser.
  --relogin         replace the tokens of agents already connected on this
                    computer (by default a re-run keeps them and only
                    approves the agents that are new)
  --app URL         ValorBrain app for the approval (default https://valorbrain.valor.digital,
                    or VALORBRAIN_APP_URL)
  --api URL         engine base URL (default: the engine of the app that approved
                    this computer, else ${DEFAULT_API})
  --scope what      where harness-local files go: "user" ($HOME, the default)
                    or "workspace" (this project).
  --kiro-engine e   which kiro engine your sessions run. "v3" (default —
                    kiro-cli --v3, and the default of Kiro CLI 3.0): hooks as
                    the standalone file ~/.kiro/hooks/valorbrain.json, firing
                    with no agent setup. "legacy": hooks inside the agent
                    config ~/.kiro/agents/valorbrain.json, which kiro-cli 2.x
                    fires only when the session runs the agent. Installing one
                    mode removes the other's files — the two never fire
                    together (a V3 session running the agent would fire every
                    event twice).
  --mcp-only        wire only the MCP server and the instructions block: no
                    hooks, so no hook sends anything on each turn. On a
                    harness already wired with hooks it removes them (hooks
                    you edited by hand go only with --force or a yes at the
                    prompt). A later run without --mcp-only adds the hooks
                    back. Also --mcp-only=true|false. Not applied together
                    with --prompt/--transcript/--checkpoint, which only save a
                    choice and exit. (Hermes has no hooks: its memory plugin
                    stays and still sends the prompt; use --prompt off there.)
  --no-backup       skip .valorbrain-bak copies
  --force           overwrite files you edited by hand without asking (by
                    default a re-run shows what would change in them and asks;
                    with nobody at the keyboard it keeps your edits)
  --prompt on|off   send each prompt to your memory for recall (default on).
                    Only changes ~/.valorbrain/connect.json for the harnesses
                    named (or every one saved there) and exits.
                    VALORBRAIN_SEND_PROMPT=off does the same for the whole machine.
  --transcript on|off  upload the session transcript for conversation memory
                    (default off). Hermes: its memory plugin. Claude Code,
                    Codex, Gemini CLI, Cursor, Kiro, Grok and OpenCode: the
                    Stop hook, in the background, after 3 turns and then at
                    most every 10 min while the file grows; never for -p/exec/
                    SDK runs or sub-agents. Saved like
                    --prompt; VALORBRAIN_SEND_TRANSCRIPT=off|on wins over it.
  --checkpoint on|off  let the Stop hook ask the agent for a short memory
                    checkpoint every few turns (default on). Saved like
                    --prompt; VALORBRAIN_CHECKPOINT=off|on wins over it. Gemini
                    CLI on a GitHub runner drops env from hooks; there only
                    this switch works.

Unknown flags are named on stderr and ignored.

Writes, per harness: the MCP server entry (so the tools exist), an instructions
file (so the agent knows to consult memory before answering) and, where the
harness has hooks, lifecycle hooks: context at session start and on each prompt,
and every few turns a short memory checkpoint the agent itself records through
MCP. Hooks read the token from ~/.valorbrain/connect.json (0600) — never from
the command line. Files you own are edited between ${BLOCK_BEGIN} markers;
everything else is preserved.

The hooks run one stable command, node "~/.valorbrain/bin/connect/launcher.mjs"
hook …, on every system; updates swap the version it runs under
~/.valorbrain/bin/connect/ (signed pin, sha512-checked tarball) and never
touch the harness files again. An update that would collect more by default
than you installed under waits for you to run this installer.
VALORBRAIN_HOOK_CLIENT=npx keeps the npx command. On Linux and macOS the
launcher refuses to run unless ~/.valorbrain, bin/, connect/ and the version it
runs are yours and not writable by others (sticky directories excepted). An
install refuses a $HOME that is not yours or is world-writable (group write and
sticky are fine; $HOME is never chmodded); once installed, a $HOME problem is
only logged, never a reason to stop the hooks. On Windows only the symlink and
type checks apply (there are no uid or mode bits).

Every manifest the engine sends is checked against the ed25519 key built into
this package before a single file is written; an unsigned or altered one is
refused. Self-heal (run by the hooks, at most every 6h) never rewrites a file
you changed by hand: it logs to ~/.valorbrain/connect.log and leaves it.
What each hook sends: https://docs.valorbrain.com.br/docs/concepts/what-leaves-your-machine
`;

// ── harness detection ───────────────────────────────────────────────────────

const DETECT = {
  "claude-code": ".claude",
  kiro: ".kiro",
  opencode: ".config/opencode",
  codex: ".codex",
  grok: ".grok",
  "gemini-cli": ".gemini",
  cursor: ".cursor",
  omp: ".omp",
  hermes: ".hermes",
};

function detectInstalled(home) {
  return Object.entries(DETECT).filter(([, dir]) => existsSync(join(home, dir))).map(([id]) => id);
}

function expand(p, home) {
  if (p === "-" || !p) return null;
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return resolve(p);
}

// ── managed block editing (mirrors src/harness/contract.ts) ──────────────────

function upsertBlock(existing, block) {
  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length).replace(/^\n/, "");
  }
  const sep = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

function removeBlock(existing) {
  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return existing;
  const before = existing.slice(0, start).replace(/\n+$/, "\n");
  const after = existing.slice(end + BLOCK_END.length).replace(/^\n+/, "");
  return after ? before + after : before;
}

/**
 * The server renders a whole file for `merge` artifacts (it cannot know what the
 * customer already has). Extract just our block so the rest of their file lives.
 */
function extractBlock(rendered) {
  const start = rendered.indexOf(BLOCK_BEGIN);
  const end = rendered.indexOf(BLOCK_END);
  if (start === -1 || end === -1) return null;
  return rendered.slice(start, end + BLOCK_END.length) + "\n";
}

/**
 * Merge our MCP server entry into an existing JSON config instead of replacing
 * the file. A customer with three other MCP servers must keep them.
 */
function mergeJson(existingRaw, renderedRaw, remove) {
  let existing;
  try {
    existing = existingRaw && existingRaw.trim() ? JSON.parse(existingRaw) : {};
  } catch {
    throw new Error("existing config is not valid JSON — refusing to overwrite");
  }
  const rendered = JSON.parse(renderedRaw);

  for (const root of ["mcpServers", "mcp"]) {
    if (!rendered[root]?.valorbrain) continue;
    if (remove) {
      if (existing[root]) delete existing[root].valorbrain;
    } else {
      existing[root] = existing[root] && typeof existing[root] === "object" ? existing[root] : {};
      const entry = rendered[root].valorbrain;
      // A persona the person set on the entry (X-Source-Agent) is theirs and
      // outranks the harness id the engine's render declares: it survives the
      // rewrite. Token, URL and the rest come from the render.
      const own = Object.entries(existing[root].valorbrain?.headers ?? {}).find(([k, v]) => k.toLowerCase() === "x-source-agent" && typeof v === "string" && v.trim());
      existing[root].valorbrain = own && entry.headers && typeof entry.headers === "object"
        ? { ...entry, headers: { ...entry.headers, [own[0]]: own[1] } }
        : entry;
    }
  }
  // OpenCode references its instructions file from config.
  if (Array.isArray(rendered.instructions)) {
    const list = Array.isArray(existing.instructions) ? existing.instructions : [];
    for (const p of rendered.instructions) {
      if (remove) {
        const i = list.indexOf(p);
        if (i !== -1) list.splice(i, 1);
      } else if (!list.includes(p)) {
        list.push(p);
      }
    }
    if (list.length > 0) existing.instructions = list;
    else delete existing.instructions;
  }
  return JSON.stringify(existing, null, 2) + "\n";
}

/**
 * Lines of `raw` holding the table `header` (its header line through the line
 * before the next `[` header, `[[` included) — the range every TOML edit here
 * replaces or removes. Null when the header is not there.
 */
function tomlTableRange(raw, header) {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  return { lines, start, end };
}

/** `raw` without the table `header` (same range rule as tomlTableRange). */
function dropTomlTable(raw, header) {
  const table = tomlTableRange(raw, header);
  if (!table) return raw;
  table.lines.splice(table.start, table.end - table.start);
  return table.lines.join("\n");
}

/** A `[mcp_servers.valorbrain]` body that is hosted: a `url`, no `command`. */
function hostedTomlBody(lines) {
  return lines.some((l) => /^\s*url\s*=/.test(l)) && !lines.some((l) => /^\s*command\s*=/.test(l));
}

/**
 * TOML: replace only our `[mcp_servers.valorbrain]` table. Line-based, because a
 * regex that stops at the first `[` corrupts inline arrays like `args = [ "mcp",]`.
 * The table's `env` subtable is the self-hosted command's environment: it goes
 * on remove (same as the engine's remove path) and when a hosted table (`url`)
 * replaces a self-hosted one — codex refuses `env` on a streamable_http server.
 * Other subtables (`tools.*` approvals) are the person's and stay.
 */
function mergeToml(existingRaw, renderedRaw, remove) {
  const ENV = "[mcp_servers.valorbrain.env]";
  const table = tomlTableRange(existingRaw || "", "[mcp_servers.valorbrain]");
  const block = renderedRaw.trimEnd().split("\n");
  if (remove) {
    if (!table) return existingRaw;
    table.lines.splice(table.start, table.end - table.start);
    return dropTomlTable(table.lines.join("\n"), ENV);
  }
  if (table) {
    table.lines.splice(table.start, table.end - table.start, ...block, "");
    const merged = table.lines.join("\n");
    return hostedTomlBody(block) ? dropTomlTable(merged, ENV) : merged;
  }
  const base = existingRaw || "";
  const sep = base.length === 0 ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return base + sep + block.join("\n") + "\n";
}

/** The TOML key each hosted harness reads its Streamable HTTP headers from. */
const TOML_HEADER_KEY = { codex: "http_headers", grok: "headers" };

/**
 * Targeted repair of the hosted auth shape in our `[mcp_servers.valorbrain]`
 * TOML table (codex, grok). connect <= 0.12.0 wrote `url` + `bearer_token`:
 * grok 1.0.46 never reads that key (handshake "Auth required"; its docs name
 * only `headers`), and codex 0.160.0 refuses the whole config.toml at startup
 * ("bearer_token is not supported for streamable_http"). Rewrites ONLY the
 * `bearer_token` key line into the header key the harness reads — same token,
 * byte for byte — and drops the self-hosted `[mcp_servers.valorbrain.env]`
 * subtable a hosted table cannot carry (codex: "env is not supported for
 * streamable_http"). Every other key, subtable (`tools.*` approvals) and
 * server is left alone. A table that needs nothing comes back unchanged
 * (idempotent); a self-hosted table (`command`) is never touched — its `env`
 * is the credential store the local command reads. Agrees with the engine
 * render (hostedTomlBody in agentxagi/valorbrain src/harness/adapters.ts).
 */
export function repairTomlMcp(existingRaw, harness) {
  const headerKey = TOML_HEADER_KEY[harness];
  if (!existingRaw || !headerKey) return existingRaw;
  const table = tomlTableRange(existingRaw, "[mcp_servers.valorbrain]");
  if (!table) return existingRaw;
  const body = table.lines.slice(table.start + 1, table.end);
  if (!hostedTomlBody(body)) return existingRaw;
  const bearerIdx = body.findIndex((l) => /^\s*bearer_token\s*=/.test(l));
  if (bearerIdx !== -1) {
    const hasHeaders = body.some((l) => new RegExp(`^\\s*${headerKey}\\s*=`).test(l));
    // Basic or literal string; anything else (unquoted, multi-line): never
    // guess a credential, leave the file as it is.
    const m = /^\s*bearer_token\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^'"\\]*)')\s*(?:#.*)?$/.exec(body[bearerIdx]);
    if (!m && !hasHeaders) return existingRaw;
    // Headers already there (a hand fix): a second key would be invalid TOML.
    if (hasHeaders) body.splice(bearerIdx, 1);
    else body[bearerIdx] = `${headerKey} = { "Authorization" = "Bearer ${m[1] ?? m[2]}" }`;
  }
  const out = [...table.lines.slice(0, table.start + 1), ...body, ...table.lines.slice(table.end)].join("\n");
  return dropTomlTable(out, "[mcp_servers.valorbrain.env]");
}

/**
 * The heal's half of the repair: every hosted TOML install on this machine
 * (codex AND grok, whichever harness's heal runs — codex cannot start with
 * the broken file, so its own hooks never fire to heal it). In place:
 * backup, then tmp + rename at the real path (a symlinked dotfile stays a
 * symlink) with the file's own mode. Returns the paths repaired. Never throws.
 */
export function repairInstalledTomlMcp(home) {
  const repaired = [];
  for (const [harness, rel] of [["codex", ".codex/config.toml"], ["grok", ".grok/config.toml"]]) {
    try {
      const path = realpathSync(join(home, rel));
      const before = readFileSync(path, "utf-8");
      const after = repairTomlMcp(before, harness);
      if (after === before) continue;
      const mode = statSync(path).mode & 0o7777;
      writeBackup(path, before);
      writeFileAtomic(path, after, mode);
      repaired.push(path);
      logConnect(home, `${path}: repaired the hosted MCP auth (${TOML_HEADER_KEY[harness]}, same token) — valid from the next ${harness} start`);
    } catch {
      /* missing, unreadable or unwritable: the installer still repairs it */
    }
  }
  return repaired;
}

// ── plan / apply ────────────────────────────────────────────────────────────

async function fetchManifest(api, harness, { launcher = false } = {}) {
  // `hooks=2`: this client speaks hook protocol v2 (ADR-058). An engine that
  // predates it ignores the parameter and answers the v1 manifest, which this
  // client still serves (legacy names, `--token=` on the command line).
  // `client=launcher`: hook commands run the stable launcher
  // (LAUNCHER_PLACEHOLDER, substituted in planFor) and the manifest names the
  // version, tarball and sha512 it runs. An engine that predates it answers
  // the npx manifest.
  const url = `${api.replace(/\/$/, "")}/setup/artifacts?agent=${encodeURIComponent(harness)}&hooks=${HOOK_PROTOCOL}${launcher ? "&client=launcher" : ""}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  // Verified before anything is planned, so an unsigned or tampered manifest
  // never reaches planFor — install, --remove, --status and self-heal alike.
  // The placeholders are substituted only after this check.
  const checked = verifyManifest({ body: await res.text(), headers: res.headers, harness, keys: trustedManifestKeys(process.env) });
  if (checked.error) throw new Error(`${api}: ${checked.error}`);
  return checked.manifest;
}

// ── launcher and versioned client (contracts A and C) ──────────────────────
//
// Every hook runs `node "~/.valorbrain/bin/connect/launcher.mjs" hook …`. The
// launcher reads current.json and runs ./<version>/hook.mjs. An update is a
// new ./<version>/ plus a new current.json: the harness config files are
// written once (the human's install) and never again for a version bump.
//
// The code of a version arrives one of two ways:
//   - this very package, when it IS the pinned version (the install by npx);
//   - the npm tarball the SIGNED manifest names (`hook_client_tarball`),
//     checked against its signed sha512 (`hook_client_integrity`), unpacked
//     by the small tar reader below into a temp dir, renamed into place.
// Never a tag, a range, or a version the signed manifest did not name.
//
// VALORBRAIN_HOOK_CLIENT=npx keeps the npx hook command instead.

export function launcherWanted(env = process.env) {
  return env.VALORBRAIN_HOOK_CLIENT !== "npx";
}

export function clientRoot(home) {
  return join(home, ".valorbrain", "bin", "connect");
}

/** The launcher as written into hook commands (forward slashes: node takes them on Windows too). */
export function launcherPath(home) {
  return join(clientRoot(home), "launcher.mjs").replace(/\\/g, "/");
}

export function readCurrent(home) {
  try {
    const c = JSON.parse(readFileSync(join(clientRoot(home), "current.json"), "utf-8"));
    return c && typeof c.version === "string" ? c : null;
  } catch {
    return null;
  }
}

/** What a version directory holds when this package copies itself. */
const SELF_FILES = ["package.json", "manifest-signature.mjs", "login.mjs", "launcher.mjs", "index.mjs", "hook.mjs"];
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

/**
 * Create ~/.valorbrain/bin/connect and make the whole chain ours: every hook
 * runs code from there, so a directory on the way that another user owns or
 * can write to would let them swap `connect/` for their own. `$HOME` itself
 * must be ours and not world-writable; group write is allowed there (homes of
 * 0775/2775 under user private groups are common) and `$HOME` is never
 * chmodded (not ours to change), only refused. A sticky directory (1777, a
 * /tmp home) is not refused for write bits: others cannot rename or remove
 * what we own in it. `.valorbrain` and `bin` lose
 * group/other write, `connect` is 0700; anything not ours, a symlink for
 * `bin` or `connect`, or still writable by others is refused — '' when safe,
 * else the reason. Paths a shell or a JSON string would have to escape are
 * refused too (the launcher path is substituted as plain text).
 * Windows: no uid or mode bits to check (ACLs), only type and symlink.
 */
export function ensureClientRoot(home) {
  if (/["'`$%!\\\r\n]/.test(launcherPath(home))) return "the path needs quoting";
  const posix = process.platform !== "win32" && typeof process.getuid === "function";
  try {
    if (posix) {
      const st = statSync(home);
      if (st.uid !== process.getuid()) return `${home} belongs to another user`;
      if ((st.mode & 0o002) !== 0 && (st.mode & 0o1000) === 0) return `${home} is writable by everyone`;
    }
    const chain = [join(home, ".valorbrain"), join(home, ".valorbrain", "bin"), clientRoot(home)];
    for (const [i, d] of chain.entries()) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      // ~/.valorbrain may be a symlink the person made (dotfiles); its target is checked.
      const st = i === 0 ? statSync(d) : lstatSync(d);
      if (st.isSymbolicLink()) return `${d} is a symlink`;
      if (!st.isDirectory()) return `${d} is not a directory`;
      if (!posix) continue;
      if (st.uid !== process.getuid()) return `${d} belongs to another user`;
      const mode = i === chain.length - 1 ? 0o700 : st.mode & 0o755;
      if ((st.mode & 0o777) !== mode) chmodSync(d, mode);
      const now = statSync(d).mode;
      if ((now & 0o022) !== 0 && (now & 0o1000) === 0) return `${d} is writable by others`;
    }
    return "";
  } catch (err) {
    return err?.code || "not creatable";
  }
}

function writeFileAtomic(path, data, mode = 0o644) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** True when <version>/ is a complete, safe copy of that version. */
function versionInstalled(home, version) {
  const dir = join(clientRoot(home), version);
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) !== 0) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return pkg.version === version && existsSync(join(dir, "hook.mjs")) && existsSync(join(dir, "index.mjs"));
  } catch {
    return false;
  }
}

/**
 * Read a gzipped npm tarball (ustar, with pax and GNU long-name records) into
 * the regular files under `package/`. A reader of our own, not the system
 * `tar`: Windows may have none, a spawned tar would follow the archive's own
 * paths and links, and the archive is small and of one known shape. Links,
 * devices, absolute paths and `..` are never extracted. Throws on anything
 * malformed.
 */
export function untarPackage(gz) {
  const buf = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files = [];
  let longName = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString("utf-8").replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > buf.length) throw new Error("malformed tar entry");
    const type = String.fromCharCode(header[156]);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "L") {
      const text = body.toString("utf-8");
      longName = type === "L" ? text.replace(/\0[\s\S]*$/, "") : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? longName);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type !== "0" && type !== "\0") continue; // dirs are implied; links and devices never extracted
    const rel = name.startsWith("package/") ? name.slice(8) : null;
    if (!rel || rel.includes("\\") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`refusing tar path ${JSON.stringify(name)}`);
    files.push({ name: rel, data: Buffer.from(body) });
    if (files.length > 1000) throw new Error("tarball has too many files");
  }
  return files;
}

/** `sha512-…` from an npm integrity string (which may list several hashes). */
function sha512Of(integrity) {
  return String(integrity ?? "").split(/\s+/).find((h) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(h)) ?? null;
}

/** https, or http to this machine only (a self-hosted or test engine): the signed sha512 is what makes a tarball trusted, not the transport. */
function tarballUrlAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** A lock file under the client root: one placer per version at a time; a lock older than this is a crashed heal. */
const PLACE_LOCK_STALE_MS = 120_000;

/** Errors of a filesystem without hard links (FAT/exFAT, some network mounts). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

/**
 * Create `to` holding `from`'s content, failing (false) when `to` exists. A
 * hard link is atomic and never half-written. Where hard links are not
 * supported, a `wx` create of the same content, then a re-read that it still
 * holds it. `link` is the seam tests use to simulate such a filesystem.
 */
function linkNew(from, to, link = linkSync) {
  try {
    link(from, to);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    if (!NO_HARD_LINKS.has(err?.code)) throw err;
  }
  const content = readFileSync(from, "utf-8");
  try {
    writeFileSync(to, content, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
  return readOrNull(to) === content;
}

function readOrNull(path) {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

/**
 * Take the lock at `path`: the token written into it, or null when someone
 * else holds it. The lock is created by hard-linking a file that already holds
 * our unique token (atomic, no half-written lock; `wx` + re-check where there
 * are no hard links). A stale lock is broken by RENAMING it away and checking
 * that what moved is the stale one we read: two breakers can never both win,
 * because the second rename either finds nothing or moves the first one's
 * fresh lock — which it puts back and gives up.
 * Seams for tests: `onStale` runs between seeing a stale lock and breaking it;
 * `link` replaces fs.linkSync.
 */
export function tryLock(path, { staleMs = PLACE_LOCK_STALE_MS, now = () => Date.now(), onStale, link = linkSync } = {}) {
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const mine = `${path}.own-${token}`;
  writeFileSync(mine, token, { mode: 0o600, flag: "wx" });
  try {
    if (linkNew(mine, path, link)) return token;
    let seen;
    try {
      if (now() - statSync(path).mtimeMs <= staleMs) return null;
      seen = readFileSync(path, "utf-8");
    } catch {
      return linkNew(mine, path, link) ? token : null; // released meanwhile
    }
    onStale?.();
    const moved = `${path}.break-${token}`;
    try {
      renameSync(path, moved);
    } catch {
      return linkNew(mine, path, link) ? token : null; // someone else broke it first
    }
    if (readOrNull(moved) !== seen) {
      // We moved a live lock that replaced the stale one: put it back, it is theirs.
      try { linkNew(moved, path, link); } catch { /* fail-safe: we do not hold it */ }
      try { unlinkSync(moved); } catch { /* gone */ }
      return null;
    }
    unlinkSync(moved);
    return linkNew(mine, path, link) ? token : null;
  } finally {
    try { unlinkSync(mine); } catch { /* gone */ }
  }
}

/** Drop the lock only while it is still ours (a stale break may have given it to someone else). */
export function releaseLock(path, token) {
  if (token && readOrNull(path) === token) {
    try { unlinkSync(path); } catch { /* gone */ }
  }
}

/**
 * Fill a temp dir and move it into <version>/, under a per-version lock: two
 * heals racing never remove what the other placed. Whoever finds the version
 * already complete under the lock stops there (same pin, same signed bytes);
 * a broken <version>/ is replaced only by the lock holder. current.json is
 * written only after this returns with the version complete, so it never
 * names a missing directory. `onChecked` (tests) is awaited after the
 * "already installed?" check, before anything is filled or renamed.
 */
export async function placeVersion(home, version, fill, { waitMs = 90_000, onChecked } = {}) {
  const lock = join(clientRoot(home), `.lock-${version}`);
  const until = Date.now() + waitMs;
  let token;
  while (!(token = tryLock(lock))) {
    if (Date.now() > until) throw new Error(`another heal holds ${version}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const dest = join(clientRoot(home), version);
  const tmp = join(clientRoot(home), `.tmp-${version}-${process.pid}-${Date.now()}`);
  try {
    if (versionInstalled(home, version)) return;
    await onChecked?.();
    mkdirSync(tmp, { mode: 0o700 });
    fill(tmp);
    chmodSync(tmp, 0o700);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); // incomplete or unsafe; only the lock holder gets here
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    releaseLock(lock, token);
  }
}

/**
 * The tarball body, at most `maxBytes`: refused up front by Content-Length and
 * aborted mid-stream as soon as it grows past the cap, so a hostile or broken
 * server can never make a heal hold more than that in memory.
 */
async function readCapped(res, maxBytes, abort) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort();
    throw new Error("tarball too large");
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      abort();
      throw new Error("tarball too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Download one exact version from `tarball`, check it against `integrity`
 * (sha512, npm `dist.integrity`) before unpacking anything, and place it at
 * <version>/. Throws with a short reason; writes nothing on any mismatch.
 */
export async function downloadClientVersion(home, { version, tarball, integrity }, { fetchImpl = (u, i) => fetch(u, i), maxBytes = MAX_TARBALL_BYTES } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) throw new Error("no exact version");
  const expected = sha512Of(integrity);
  if (!expected) throw new Error("no sha512 integrity");
  if (!tarballUrlAllowed(tarball)) throw new Error("tarball URL is not https");
  const unsafe = ensureClientRoot(home);
  if (unsafe) throw new Error(`unsafe client directory: ${unsafe}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let gz;
  try {
    const res = await fetchImpl(tarball, { signal: controller.signal });
    if (!res.ok) throw new Error(`tarball HTTP ${res.status}`);
    gz = await readCapped(res, maxBytes, () => controller.abort());
  } finally {
    clearTimeout(timer);
  }
  const got = `sha512-${createHash("sha512").update(gz).digest("base64")}`;
  if (got !== expected) throw new Error("tarball integrity mismatch");
  const files = untarPackage(gz);
  const pkg = JSON.parse(files.find((f) => f.name === "package.json")?.data.toString("utf-8") ?? "{}");
  if (pkg.name !== "@valorbrain/connect" || pkg.version !== version) throw new Error(`tarball is ${pkg.name}@${pkg.version}, not @valorbrain/connect@${version}`);
  await placeVersion(home, version, (tmp) => {
    for (const f of files) {
      const dest = join(tmp, ...f.name.split("/"));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, f.data, { mode: 0o644 });
      chmodSync(dest, 0o644);
    }
  });
  if (!versionInstalled(home, version)) throw new Error("unpacked version is incomplete");
}

/** current.json names this pin and integrity, its directory is complete, and the launcher is the one it ships. */
function isCurrent(home, version, integrity) {
  const current = readCurrent(home);
  if (current?.version !== version || current?.integrity !== integrity || !versionInstalled(home, version)) return false;
  try {
    const shipped = join(clientRoot(home), version, "launcher.mjs");
    return !existsSync(shipped) || readFileSync(shipped).equals(readFileSync(join(clientRoot(home), "launcher.mjs")));
  } catch {
    return false;
  }
}

/**
 * Make the pinned version of a `client=launcher` manifest runnable: its
 * directory, current.json and the launcher itself. Returns the launcher path,
 * or `{ error }`. When the pin is this package, it copies itself; otherwise it
 * downloads the signed tarball.
 */
export async function ensureLauncher(home, manifest, { fetchImpl, selfDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  const version = launcherPin(manifest?.hook_client_version);
  if (manifest?.hook_client !== "launcher" || !version) return { error: "the manifest names no launcher version" };
  // Already running this pin with this launcher: nothing to write, so nothing
  // to check — a heal never turns a working install off over the directory
  // rules (those apply when something is written: installs and updates).
  if (isCurrent(home, version, manifest.hook_client_integrity ?? null)) return { launcher: launcherPath(home), version };
  const unsafe = ensureClientRoot(home);
  if (unsafe) return { error: `unsafe client directory: ${unsafe}` };
  try {
    if (!versionInstalled(home, version)) {
      if (version === CLIENT_VERSION) {
        await placeVersion(home, version, (tmp) => {
          for (const name of SELF_FILES) writeFileSync(join(tmp, name), readFileSync(join(selfDir, name)), { mode: 0o644 });
        });
        if (!versionInstalled(home, version)) return { error: "could not copy this package" };
      } else {
        await downloadClientVersion(home, { version, tarball: manifest.hook_client_tarball, integrity: manifest.hook_client_integrity }, { fetchImpl });
      }
    }
    // The launcher itself: the newest one a verified version ships, same path.
    const shipped = join(clientRoot(home), version, "launcher.mjs");
    const target = join(clientRoot(home), "launcher.mjs");
    if (existsSync(shipped)) {
      const src = readFileSync(shipped);
      let same = false;
      try { same = readFileSync(target).equals(src); } catch { /* absent */ }
      if (!same) writeFileAtomic(target, src);
    }
    if (!existsSync(target)) return { error: `version ${version} ships no launcher` };
    const current = readCurrent(home);
    if (current?.version !== version || current?.integrity !== (manifest.hook_client_integrity ?? null)) {
      writeFileAtomic(join(clientRoot(home), "current.json"), JSON.stringify({
        version,
        integrity: manifest.hook_client_integrity ?? null,
        data_scope: Number.isInteger(manifest.data_scope) ? manifest.data_scope : 1,
        installed_at: new Date().toISOString(),
      }) + "\n");
    }
    return { launcher: launcherPath(home), version };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/** Versions of the 0.10 local client a hook file runs (`…/connect/<v>/hook.mjs`). */
export function hookClientVersions(text) {
  return [...String(text ?? "").matchAll(/\.valorbrain[\\/]+bin[\\/]+connect[\\/]+([^\\/"'\s]+)[\\/]+hook\.mjs/g)].map((m) => m[1]);
}

/** True when a hook file runs the 0.11 launcher. */
export function launcherReferenced(text) {
  return /\.valorbrain[\\/]+bin[\\/]+connect[\\/]+launcher\.mjs/.test(String(text ?? ""));
}

/**
 * Record what each of this harness's hook files runs (read back from disk: a
 * hand edit the heal kept counts), in connect-state.json
 * `hook_clients: { <harness>: { <path>: [versions | "launcher"] } }`. Only the
 * paths given change: the same harness installed in another scope keeps its
 * record. A path running neither (removed, npx) is dropped.
 */
export function recordHookClients(home, harness, paths) {
  const state = readHealState(home);
  const byPath = { ...(state.hook_clients?.[harness] || {}) };
  for (const p of paths) {
    let uses = [];
    try {
      const text = readFileSync(p, "utf-8");
      uses = [...new Set(hookClientVersions(text)), ...(launcherReferenced(text) ? ["launcher"] : [])];
    } catch { /* absent */ }
    if (uses.length > 0) byPath[p] = uses;
    else delete byPath[p];
  }
  const clients = { ...(state.hook_clients || {}) };
  if (Object.keys(byPath).length > 0) clients[harness] = byPath;
  else delete clients[harness];
  writeHealState(home, { ...state, hook_clients: clients });
}

/** A version nothing runs any more is deleted this long after it was first seen unused: a running Claude Code session keeps the hook commands it started with. */
const CLIENT_GRACE_MS = 24 * 3600 * 1000;

/**
 * Delete client versions nothing runs: not current.json's, not `keep`, not one
 * a hook file still names (a Codex hook still on 0.10's local copy). Leftover
 * temp dirs go too. `graceMs: 0` (--remove) deletes at once and, when no hook
 * file runs the launcher and no omp/Hermes entry (whose bridge and plugin call
 * it) remains, the launcher and current.json as well. Returns what it deleted.
 */
export function gcClientVersions(home, { now = Date.now(), graceMs = CLIENT_GRACE_MS, keep = null } = {}) {
  const root = clientRoot(home);
  let entries = [];
  try { entries = readdirSync(root); } catch { return []; }
  const state = readHealState(home);
  const uses = new Set(Object.values(state.hook_clients || {}).flatMap((byPath) => Object.values(byPath || {}).flat()));
  const launcherUsed = uses.has("launcher") || ["omp", "hermes"].some((h) => readCreds(home, h));
  const used = new Set(uses);
  if (keep) used.add(keep);
  const current = readCurrent(home)?.version;
  if (current && (launcherUsed || graceMs > 0)) used.add(current);
  const unused = { ...(state.hook_clients_unused_since || {}) };
  const deleted = [];
  for (const v of entries) {
    const path = join(root, v);
    if (v.startsWith(".tmp-")) {
      try { if (graceMs === 0 || now - statSync(path).mtimeMs > 3600 * 1000) rmSync(path, { recursive: true, force: true }); } catch { /* gone */ }
      continue;
    }
    if (/^\.lock-.+\.(?:own|break)-/.test(v)) {
      // Left by a heal that crashed between creating and removing them; never the lock itself.
      try { if (graceMs === 0 || now - statSync(path).mtimeMs > PLACE_LOCK_STALE_MS) unlinkSync(path); } catch { /* gone */ }
      continue;
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) continue; // launcher.mjs, current.json
    if (used.has(v)) { delete unused[v]; continue; }
    const since = unused[v] ?? now;
    if (graceMs > 0 && now - since < graceMs) { unused[v] = since; continue; }
    try {
      rmSync(path, { recursive: true, force: true });
      deleted.push(v);
      delete unused[v];
    } catch { unused[v] = since; }
  }
  for (const v of Object.keys(unused)) if (!entries.includes(v)) delete unused[v];
  writeHealState(home, { ...readHealState(home), hook_clients_unused_since: unused });
  if (graceMs === 0 && !launcherUsed) {
    for (const f of ["launcher.mjs", "current.json"]) {
      try { if (existsSync(join(root, f))) { unlinkSync(join(root, f)); deleted.push(f); } } catch { /* fail-open */ }
    }
    try { unlinkSync(join(root, ".home-warning")); } catch { /* absent */ }
    for (const d of [root, dirname(root)]) {
      try { if (readdirSync(d).length === 0) rmSync(d, { recursive: true }); } catch { /* absent or not empty */ }
    }
  }
  return deleted;
}

// ── scope: where harness-local files land ───────────────────────────────────

/** Scope names accepted by --scope ("global" is an alias of "user"). */
const SCOPES = new Set(["workspace", "user", "global"]);

/**
 * kiro loads lifecycle hooks from exactly one of two places, depending on the
 * ENGINE that runs the session — never from both (VAL-224):
 *
 *   - V3 (`kiro-cli --v3`, the default of Kiro CLI 3.0) loads STANDALONE hook
 *     files from `~/.kiro/hooks/` and `<workspace>/.kiro/hooks/` (verified live
 *     in the 2.20.1 bundle: acp-server.js logs "v2 hooks loaded N standalone
 *     hooks from .kiro/hooks/" and registers them as "standalone-file"). The
 *     schema it validates is exactly the v1 file the hosted manifest already
 *     renders: {version:"v1", hooks:[{name, trigger, action, timeout?}]}.
 *   - The LEGACY engine never reads those files; it fires hooks from the
 *     `hooks` key of an AGENT config (`.kiro/agents/*.json`), and only when
 *     the session runs that agent (`--agent valorbrain` / `agent set-default`;
 *     verified live against kiro-cli 2.20.1, VAL-195).
 *
 * `--kiro-engine` picks which artifact the installer writes; the default
 * follows where kiro is going (v3). Installing one mode must remove the
 * other's files: in a V3 session running the agent, standalone-file and
 * agent-profile hooks BOTH register, and every event fires twice.
 */
export function scopedManifest(manifest, { harness, scope, home, cwd = process.cwd(), kiroEngine = "v3" }) {
  if (harness !== "kiro") return manifest;
  if (kiroEngine !== "legacy") {
    // Standalone: the engine-rendered file already matches the V3 loader's
    // schema — pass it through untouched. Only an explicit workspace scope
    // moves it into the project.
    if (scope !== "workspace") return manifest;
    return {
      ...manifest,
      artifacts: (manifest.artifacts || []).map((a) =>
        a.kind === "hooks" && String(a.path).startsWith("~/.kiro/")
          ? { ...a, path: join(cwd, String(a.path).slice(2)) }
          : a),
    };
  }
  const dir = scope === "workspace" ? join(cwd, ".kiro", "agents") : join(home, ".kiro", "agents");
  const artifacts = (manifest.artifacts || []).flatMap((a) => {
    if (a.kind !== "hooks" || !String(a.path).startsWith("~/.kiro/")) return [a];
    const v1 = JSON.parse(a.contents);
    const hooks = {};
    for (const h of v1?.hooks ?? []) {
      const event = KIRO_HOOK_EVENTS[h?.trigger];
      const command = h?.action?.command;
      if (!event || !command) continue;
      (hooks[event] ??= []).push({ command, timeout: 10_000 });
    }
    if (Object.keys(hooks).length === 0) return []; // nothing kiro would fire — wire nothing
    return [{
      ...a,
      path: join(dir, "valorbrain.json"),
      label: "lifecycle hooks (kiro agent config)",
      contents: JSON.stringify({
        name: "valorbrain",
        description: "ValorBrain memory — context at session start and on each prompt; a short checkpoint every few turns.",
        mcpServers: {},
        tools: KIRO_AGENT_TOOLS,
        allowedTools: [],
        resources: [],
        hooks,
        includeMcpJson: true,
      }, null, 2) + "\n",
    }];
  });
  return { ...manifest, artifacts };
}

/** v1 hook trigger → kiro agent-config hook event (verified on kiro-cli 2.20.1). */
const KIRO_HOOK_EVENTS = { SessionStart: "agentSpawn", UserPromptSubmit: "userPromptSubmit", Stop: "stop" };

/** Full built-in toolset (agent_config.json.example) — our agent must not shrink the user's session. */
const KIRO_AGENT_TOOLS = ["read", "write", "shell", "aws", "report", "introspect", "knowledge", "thinking", "todo", "delegate", "grep", "glob"];

/** The exact file of the OTHER engine mode: installing one must remove it. */
const KIRO_OTHER_MODE_FILES = {
  v3: [".kiro/agents/valorbrain.json"],   // legacy agent config
  legacy: [".kiro/hooks/valorbrain.json"], // v3 standalone file
};

/** A connect hook command in a kiro file: npx, the 0.10 local copy or the 0.11 launcher. */
function runsConnect(text) {
  return text.includes("@valorbrain/connect") || hookClientVersions(text).length > 0 || launcherReferenced(text);
}

function isOurStandaloneHooks(raw) {
  try {
    const j = JSON.parse(raw);
    return j?.version === "v1" && Array.isArray(j.hooks) && runsConnect(JSON.stringify(j));
  } catch {
    return false;
  }
}

function isOurAgentConfig(raw) {
  try {
    const j = JSON.parse(raw);
    return j?.name === "valorbrain" && runsConnect(JSON.stringify(j));
  } catch {
    return false;
  }
}

/**
 * Files of the OTHER kiro mode that are OURS and would keep firing beside the
 * mode being installed. Only the two exact paths we manage, in $HOME and the
 * project — a customer's own file (or a foreign file that happens to sit on
 * the path) is never touched.
 */
export function staleKiroFiles({ home, cwd = process.cwd(), kiroEngine = "v3", exists = existsSync, read = (p) => readFileSync(p, "utf-8") }) {
  const ours = kiroEngine === "legacy" ? isOurStandaloneHooks : isOurAgentConfig;
  const out = new Set();
  for (const base of KIRO_OTHER_MODE_FILES[kiroEngine] ?? []) {
    for (const root of new Set([home, cwd])) {
      const p = join(root, base);
      try {
        if (exists(p) && ours(read(p))) out.add(p);
      } catch { /* unreadable → not ours */ }
    }
  }
  return [...out];
}

/**
 * Which kiro mode the customer chose — ONLY the explicit opt-in record counts:
 * `--kiro-engine=legacy` stores it in the harness's credential entry. An agent
 * config in $HOME proves NOTHING: connect 0.5.1 wrote that file BY DEFAULT,
 * so its existence cannot mean legacy (VAL-224 S1). Everything not opted in
 * is v3, where the standalone in $HOME is the loader.
 */
export function detectKiroMode(saved) {
  return saved?.kiro_engine === "legacy" ? "legacy" : "v3";
}

/**
 * True when a kiro hooks file of OURS — either engine kind — sits under this
 * root. The self-heal checks the project root before creating anything in
 * $HOME: a project file keeps firing (the heal never writes to projects), so
 * adding the standalone would register our hooks under a SECOND loader in a
 * V3 session and every event would fire twice (VAL-224 follow-up).
 */
export function kiroProjectHasOurHooks(root, { exists = existsSync, read = (p) => readFileSync(p, "utf-8") } = {}) {
  for (const base of [".kiro/agents/valorbrain.json", ".kiro/hooks/valorbrain.json"]) {
    const p = join(root, base);
    try {
      if (!exists(p)) continue;
      const raw = read(p);
      if (isOurAgentConfig(raw) || isOurStandaloneHooks(raw)) return true;
    } catch { /* unreadable → not ours */ }
  }
  return false;
}

/**
 * Merge do config YAML do Hermes (`~/.hermes/config.yaml`). O arquivo é do
 * cliente (modelo, providers, tokens) — nada de sobrescrever: copiamos só os
 * caminhos que são nossos (`mcp_servers.valorbrain`, `memory.provider` e as
 * chaves de `env` que o manifest trouxer), preservando comentários e o resto.
 */
function mergeYaml(existingRaw, renderedRaw, remove) {
  if (!parseDocument) throw new Error("the yaml module is not installed here — run: npx -y @valorbrain/connect");
  const existing = parseDocument(existingRaw ?? "");
  if (existing.errors.length > 0) {
    throw new Error("existing config is not valid YAML — refusing to overwrite");
  }
  const rendered = parseDocument(renderedRaw ?? "");
  if (rendered.errors.length > 0) throw new Error("server sent invalid YAML");
  const server = rendered.toJS() ?? {};
  const serverEntry = server?.mcp_servers?.valorbrain;
  const serverProvider = server?.memory?.provider;
  const serverEnv = server?.env && typeof server.env === "object" ? server.env : {};

  if (remove) {
    existing.deleteIn(["mcp_servers", "valorbrain"]);
    if (existing.getIn(["memory", "provider"]) === "valorbrain") {
      existing.deleteIn(["memory", "provider"]);
    }
    for (const key of Object.keys(serverEnv)) existing.deleteIn(["env", key]);
    return existing.toString({ lineWidth: 0 });
  }

  if (serverEntry !== undefined) {
    existing.setIn(["mcp_servers", "valorbrain"], serverEntry);
  }
  // Provider: não rouba o slot de quem já escolheu outro.
  const currentProvider = existing.getIn(["memory", "provider"]);
  if (
    serverProvider !== undefined &&
    (currentProvider === undefined || currentProvider === null || currentProvider === "" || currentProvider === "valorbrain")
  ) {
    existing.setIn(["memory", "provider"], serverProvider);
  }
  for (const [key, value] of Object.entries(serverEnv)) {
    existing.setIn(["env", key], value);
  }
  return existing.toString({ lineWidth: 0 });
}

/**
 * Where a manifest artifact may write: inside the user's home or the current
 * project, nowhere else. The manifest comes from the network; a path with a
 * `..` segment, or an absolute path outside both roots, is refused instead of
 * written (it would let a bad manifest edit any file the user can write).
 */
export function manifestTarget(rawPath, home, cwd = process.cwd()) {
  const raw = String(rawPath ?? "");
  if (raw.split(/[\\/]+/).includes("..")) return { error: `refusing manifest path with "..": ${raw}` };
  const path = expand(raw, home);
  if (!path) return { path: null };
  const inside = (root) => {
    const rel = relative(resolve(root), path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (!inside(home) && !inside(cwd)) return { error: `refusing manifest path outside your home and this project: ${raw}` };
  return { path };
}

/**
 * `remove`: true takes every artifact out (--remove); a function picks the
 * artifacts to take out and keeps the rest (--mcp-only drops the per-turn
 * ones). A picked artifact with no file on disk is skipped, never created.
 * `launcher`: the installed launcher path, substituted for
 * LAUNCHER_PLACEHOLDER (client=launcher manifests only).
 * `migrateSelfHosted` (explicit install only): self-hosted ValorBrain hook
 * entries in the same hook files are replaced, and listed in the change's
 * `replacesSelfHosted`. Without it (self-heal) they are never touched: a
 * whole hook file of ours holding them is left as is (`selfHostedKept`).
 */
function planFor(manifest, token, home, remove, cwd = process.cwd(), { launcher = null, migrateSelfHosted = false } = {}) {
  const changes = [];
  // Two artifacts can share a file (Gemini keeps MCP servers and hooks in
  // settings.json): each must build on what the previous one will write, or
  // the second write reverts the first.
  const planned = new Map();
  for (const artifact of manifest.artifacts) {
    const target = manifestTarget(artifact.path, home, cwd);
    if (target.error) {
      changes.push({ artifact, path: String(artifact.path), before: null, after: null, changed: false, error: target.error });
      continue;
    }
    const path = target.path;
    if (!path) continue;
    const before = planned.has(path) ? planned.get(path) : existsSync(path) ? readFileSync(path, "utf-8") : null;
    const rm = typeof remove === "function" ? Boolean(remove(artifact)) : remove;
    if (rm && before === null && remove !== true) continue;
    // Substitute the real token, and expand `~` inside file contents too
    // (OpenCode stores an absolute instructions path in its config).
    const rendered = artifact.contents
      .split(TOKEN_PLACEHOLDER).join(token || TOKEN_PLACEHOLDER)
      .split(LAUNCHER_PLACEHOLDER).join(launcher || LAUNCHER_PLACEHOLDER)
      .split('"~/').join(`"${home}/`);

    let after;
    let selfHostedKept = false;
    try {
      // A hook that names a path placeholder would run nothing at all.
      if (!rm && PATH_PLACEHOLDER.test(rendered)) throw new Error("the launcher is not installed — refusing to write its placeholder");
      if (artifact.kind === "mcp" && /\.ya?ml$/.test(path)) {
        // Hermes: config.yaml é do cliente; mescla por chave, nunca overwrite.
        after = mergeYaml(before, rendered, rm);
      } else if (artifact.kind === "mcp" && path.endsWith(".toml")) {
        // Repair AFTER the merge: even against an engine that still renders
        // `bearer_token`, what lands on disk is the shape the harness reads.
        after = rm ? mergeToml(before, rendered, true) : repairTomlMcp(mergeToml(before, rendered, false), String(manifest.harness || ""));
      } else if (artifact.kind === "mcp") {
        after = mergeJson(before ?? "{}", rendered, rm);
      } else if (artifact.kind === "hooks" && path.endsWith(".json") && !/valorbrain/i.test(path)) {
        // Arquivo COMPARTILHADO do cliente (ex.: ~/.claude/settings.json):
        // merge por evento, nunca overwrite. Arquivos nossos (valorbrain.json,
        // plugins/valorbrain.ts) seguem o caminho normal (write/delete).
        after = mergeHooksJson(before ?? "", rendered, rm, { migrate: migrateSelfHosted });
      } else if (artifact.strategy === "merge") {
        const block = extractBlock(rendered);
        if (!block) throw new Error("server sent a merge artifact without markers");
        after = rm ? removeBlock(before ?? "") : upsertBlock(before ?? "", block);
      } else if (artifact.kind === "hooks" && before !== null && selfHostedHookCommands(before).length > 0 && (rm ? !isConnectHookEntry(before) : !migrateSelfHosted)) {
        // A ValorBrain hook file the self-hosted engine wrote: never replaced by
        // a heal, never deleted by --remove/--mcp-only (it is not connect's).
        after = before;
        selfHostedKept = true;
      } else {
        after = rm ? null : rendered;
      }
    } catch (err) {
      changes.push({ artifact, path, before, after: before, changed: false, error: err.message });
      continue;
    }
    if (rm && after !== null && after.trim() === "") after = null;
    // --mcp-only on a file holding none of our hook entries (Gemini keeps the
    // MCP entry in the same settings.json): reformatting is not a change.
    if (rm && remove !== true && before !== null && after !== null && !hookEntriesChanged({ before, after })) after = before;
    const replacesSelfHosted = artifact.kind === "hooks" && !rm
      ? selfHostedHookCommands(before).filter((c) => !selfHostedHookCommands(after).includes(c)).map(selfHostedHookName)
      : [];
    changes.push({ artifact, path, before, after, changed: after !== before, ...(replacesSelfHosted.length ? { replacesSelfHosted } : {}), ...(selfHostedKept ? { selfHostedKept } : {}) });
    planned.set(path, after);
  }
  return changes;
}

function apply(changes, { dryRun, noBackup }) {
  let wrote = 0, failed = 0;
  const backedUp = new Set();
  for (const c of changes) {
    const tag = c.artifact.best_effort ? ` ${C.yellow}[delivery unverified]${C.off}` : "";
    if (c.error) {
      console.log(`  ${C.red}✗${C.off} ${c.artifact.label}: ${c.error}`);
      console.log(`    ${C.dim}${c.path}${C.off}`);
      failed++;
      continue;
    }
    if (c.kept) {
      console.log(`  ${C.yellow}=${C.off} ${c.artifact.label} — kept your edits`);
      console.log(`    ${C.dim}${c.path}${C.off}`);
      continue;
    }
    if (!c.changed) {
      console.log(c.selfHostedKept
        ? `  ${C.yellow}=${C.off} ${c.artifact.label} — self-hosted ValorBrain hooks, left as they are\n    ${C.dim}${c.path}${C.off}`
        : `  ${C.dim}=${C.off} ${c.artifact.label} — already current${tag}`);
      continue;
    }
    const verb = c.after === null ? "delete" : c.before === null ? "create" : "update";
    console.log(`  ${C.green}${dryRun ? "→" : "✓"}${C.off} ${verb} ${c.artifact.label}${tag}`);
    console.log(`    ${C.dim}${c.path}${C.off}`);
    if (c.replacesSelfHosted) {
      console.log(`    ${C.yellow}replaces ${c.replacesSelfHosted.length} self-hosted ValorBrain hook(s): ${c.replacesSelfHosted.join(", ")}${C.off}${noBackup ? "" : ` ${C.dim}(backup: ${c.path}.valorbrain-bak)${C.off}`}`);
    }
    if (dryRun) continue;
    try {
      // Once per file: a chained change's `before` is the previous change's
      // output, and backing that up would overwrite the copy of the original.
      if (c.before !== null && !noBackup && !backedUp.has(c.path)) {
        writeBackup(c.path, c.before);
        backedUp.add(c.path);
      }
      if (c.after === null) {
        if (existsSync(c.path)) unlinkSync(c.path);
      } else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after);
      }
      wrote++;
    } catch (err) {
      console.log(`  ${C.red}✗${C.off} write failed: ${err.message}`);
      c.failed = true;
      failed++;
    }
  }
  return { wrote, failed };
}

/**
 * The MCP token this run installs, and where it came from:
 *   --token > VALORBRAIN_MCP_TOKEN > VALORBRAIN_TOKEN (deprecated; only a vbm_
 *   value — anything else is the REST key) > [installing only] the mcp_token
 *   @valorbrain/cli saved in ~/.valorbrain/config.json.
 * An explicit token that is not vbm_ is an error: the MCP host accepts nothing
 * else, and a REST key wired into a harness fails later with a generic 401.
 */
export function resolveInstallToken({ flag, env = {}, home, install = true }) {
  const warnings = [];
  const notMcp = (from, value) => ({
    token: null, source: null, warnings,
    error: `${from} must be an MCP token (vbm_…); got one starting with "${String(value).slice(0, 9)}". ` +
      "vb_agent_… / vb_… is the REST key. Use the mcp_token from `npx -y @valorbrain/cli init --agent` or Settings → MCP Tokens in the app.",
  });
  if (flag != null) {
    if (!isMcpToken(flag)) return notMcp("--token", flag);
    return { token: flag, source: "flag", warnings };
  }
  if (env.VALORBRAIN_MCP_TOKEN) {
    if (!isMcpToken(env.VALORBRAIN_MCP_TOKEN)) return notMcp("VALORBRAIN_MCP_TOKEN", env.VALORBRAIN_MCP_TOKEN);
    return { token: env.VALORBRAIN_MCP_TOKEN, source: "VALORBRAIN_MCP_TOKEN", warnings };
  }
  if (env.VALORBRAIN_TOKEN) {
    if (isMcpToken(env.VALORBRAIN_TOKEN)) {
      warnings.push("VALORBRAIN_TOKEN is deprecated — use VALORBRAIN_MCP_TOKEN for the MCP token (vbm_)");
      return { token: env.VALORBRAIN_TOKEN, source: "VALORBRAIN_TOKEN", warnings };
    }
    warnings.push("VALORBRAIN_TOKEN holds a REST key, not an MCP token (vbm_) — ignored here");
  }
  if (install && home) {
    let cfg = null;
    try {
      cfg = JSON.parse(readFileSync(join(home, ".valorbrain", "config.json"), "utf-8"));
    } catch { /* no CLI config */ }
    if (isMcpToken(cfg?.mcp_token)) {
      const api = typeof cfg.engine_url === "string" && cfg.engine_url ? cfg.engine_url.replace(/\/+$/, "") : null;
      return { token: cfg.mcp_token, source: "cli", api, warnings };
    }
  }
  return { token: null, source: null, warnings };
}

function isMcpToken(value) {
  return typeof value === "string" && value.startsWith("vbm_");
}

/**
 * Which engine this command talks to for one harness, and why — printed by the
 * installer, because "which API did that token go to?" must never be a guess.
 *
 *   --api > VALORBRAIN_API_URL > the base saved with THIS token (any harness)
 *   > [no token given] this harness's saved base, then the CLI's config.json
 *   > public default.
 *
 * A new token never inherits the base saved for a different token: that base
 * belongs to another engine, possibly another tenant.
 */
export function resolveInstallApi({ flag, env = {}, home, harness, token }) {
  const norm = (u) => String(u).trim().replace(/\/+$/, "").replace(/\/mcp$/, "");
  if (flag) return { api: norm(flag), from: "--api" };
  if (env.VALORBRAIN_API_URL) return { api: norm(env.VALORBRAIN_API_URL), from: "VALORBRAIN_API_URL" };
  if (token) {
    const saved = savedApiForToken(home, token);
    return saved ? { api: saved, from: "saved with this token" } : { api: "https://valorbrain-api.valor.digital", from: "default" };
  }
  const r = resolveCredentials({ argv: [], env, home, harness });
  const from = r.source === "connect" ? "saved credentials" : r.source === "config" ? "CLI config.json" : "default";
  return { api: r.api, from };
}

/**
 * Backups are private: a v1 hook file carries the token on its command line,
 * and a harness config carries it in its MCP entry.
 */
function writeBackup(path, contents) {
  const bak = `${path}.valorbrain-bak`;
  writeFileSync(bak, contents, { mode: 0o600 });
  try { chmodSync(bak, 0o600); } catch { /* not supported on this fs */ }
}

/**
 * True when a hook entry was written by us (hosted client or local binary).
 * Defines the part of a shared file that is "ours" for hand-edit hashes
 * (decision 17) and harness detection; which entries a merge REPLACES is
 * isConnectHookEntry (+ isSelfHostedHookCommand on an explicit install).
 */
function isOurHookEntry(entry) {
  const s = JSON.stringify(entry ?? "");
  return s.includes("@valorbrain/connect") || s.includes("valorbrain hook") || s.includes("valorbrain-connect hook") || hookClientVersions(s).length > 0 || launcherReferenced(s);
}

/** A hook entry connect wrote: npx @valorbrain/connect, the 0.1.x bin, the 0.10 local client or the 0.11 launcher. */
function isConnectHookEntry(entry) {
  const s = JSON.stringify(entry ?? "");
  return s.includes("@valorbrain/connect") || s.includes("valorbrain-connect hook") || hookClientVersions(s).length > 0 || launcherReferenced(s);
}

/**
 * Self-hosted ValorBrain hook commands, as the engine's self-hosted adapters
 * render them (`<bin> hook <name>`, with `hookBinPath` the host wrapper) plus
 * the older wrappers: `…/valorbrain[.exe] hook <name>`,
 * `…/valorbrain-hook-env hook <name>`, `…/vbhook <name>`, `clawmem hook <name>`.
 */
const SELF_HOSTED_HOOK_RE = /(?:^|[\s"'/\\])(?:(?:valorbrain|clawmem)(?:\.exe)?|valorbrain-hook-env)["']?\s+hook\s+([\w-]+)|(?:^|[\s"'/\\])vbhook(?:\.exe)?["']?\s+([\w-]+)/;

export function isSelfHostedHookCommand(command) {
  return typeof command === "string" && SELF_HOSTED_HOOK_RE.test(command) && !isConnectHookEntry(command);
}

/** Every `command` string in a hooks file (Claude/Codex/Gemini groups, Cursor's flat list, Kiro v1 `action`). */
function hookCommands(value, out = []) {
  if (Array.isArray(value)) for (const v of value) hookCommands(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "command" && typeof v === "string") out.push(v);
      else hookCommands(v, out);
    }
  }
  return out;
}

/** The self-hosted ValorBrain hook commands in a hooks file (not JSON → none). */
export function selfHostedHookCommands(raw) {
  if (raw == null) return [];
  try {
    return hookCommands(JSON.parse(raw)).filter(isSelfHostedHookCommand);
  } catch {
    return [];
  }
}

/** `context-surfacing` from `/usr/local/libexec/valorbrain-hook-env hook context-surfacing --harness=…`. */
function selfHostedHookName(command) {
  const m = SELF_HOSTED_HOOK_RE.exec(command);
  return m?.[1] || m?.[2] || command;
}

/** Drop self-hosted commands from one event's entries; a group left empty goes, third-party commands stay. */
function withoutSelfHosted(entries) {
  return entries.flatMap((e) => {
    if (typeof e?.command === "string") return isSelfHostedHookCommand(e.command) ? [] : [e];
    if (!Array.isArray(e?.hooks)) return [e];
    const hooks = e.hooks.filter((h) => !isSelfHostedHookCommand(h?.command));
    if (hooks.length === e.hooks.length) return [e];
    return hooks.length > 0 ? [{ ...e, hooks }] : [];
  });
}

/**
 * Kiro standalone hook files (`.kiro/hooks/valorbrain.json` under each root)
 * holding only self-hosted hooks — a legacy-engine install replaces them.
 */
export function selfHostedKiroStandalones({ home, cwd = home }) {
  const found = [];
  for (const root of new Set([home, cwd])) {
    const path = join(root, ".kiro", "hooks", "valorbrain.json");
    try {
      const raw = readFileSync(path, "utf-8");
      const all = hookCommands(JSON.parse(raw));
      const selfHosted = all.filter(isSelfHostedHookCommand);
      if (selfHosted.length > 0 && selfHosted.length === all.length) found.push({ path, names: selfHosted.map(selfHostedHookName) });
    } catch { /* absent or not JSON */ }
  }
  return found;
}

/**
 * Merge our hooks into a JSON file the CUSTOMER owns (ex.:
 * `~/.claude/settings.json`). O servidor renderiza o arquivo a partir de uma
 * base vazia — sobrescrever aqui apagaria hooks e permissões do cliente (bug
 * pego ao planejar o heal do Erick/Evous, 2026-09-21). Preserva tudo; troca
 * apenas as entradas que são nossas, por evento.
 */
function mergeHooksJson(existingRaw, renderedRaw, remove, { migrate = false } = {}) {
  let existing;
  try {
    existing = existingRaw && existingRaw.trim() ? JSON.parse(existingRaw) : {};
  } catch {
    throw new Error("existing config is not valid JSON — refusing to overwrite");
  }
  const rendered = JSON.parse(renderedRaw);
  const renderedHooks = rendered?.hooks;
  if (!renderedHooks || typeof renderedHooks !== "object") {
    return JSON.stringify(rendered, null, 2);
  }
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
  // Explicit install from a self-hosted setup: its entries go from every event
  // (PreCompact included, which hosted does not wire), or the prompt would get
  // context twice and Stop would run both extractors and the checkpoint.
  if (migrate && !remove) {
    for (const [event, entries] of Object.entries(existing.hooks)) {
      if (!Array.isArray(entries)) continue;
      const kept = withoutSelfHosted(entries);
      if (kept.length > 0) existing.hooks[event] = kept;
      else delete existing.hooks[event];
    }
  }
  // Top-level keys the harness schema requires (Cursor's `version: 1`) come
  // with the rendered file; never overwrite the customer's own value.
  if (!remove) {
    for (const [k, v] of Object.entries(rendered)) {
      if (k !== "hooks" && !(k in existing)) existing[k] = v;
    }
  }
  for (const [event, entries] of Object.entries(renderedHooks)) {
    const kept = Array.isArray(existing.hooks[event])
      ? existing.hooks[event].filter((e) => !isConnectHookEntry(e))
      : [];
    if (remove) {
      if (kept.length > 0) existing.hooks[event] = kept;
      else delete existing.hooks[event];
      continue;
    }
    existing.hooks[event] = [...kept, ...(Array.isArray(entries) ? entries : [])];
  }
  if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
  return JSON.stringify(existing, null, 2);
}

function statusFor(manifest, home) {
  const rows = [];
  for (const artifact of manifest.artifacts) {
    const path = expand(artifact.path, home);
    if (!path) continue;
    if (!existsSync(path)) {
      rows.push({ kind: artifact.kind, state: "missing", detail: "file absent" });
      continue;
    }
    const body = readFileSync(path, "utf-8");
    if (artifact.kind === "mcp") {
      const ok = body.includes("valorbrain");
      const tokenSet = !body.includes(TOKEN_PLACEHOLDER);
      // codex/grok: the hosted table connect <= 0.12.0 wrote (`bearer_token`,
      // maybe a stale `env` subtable) — codex 0.160 refuses the whole file,
      // grok never authenticates. Drift until the heal or the installer repairs it.
      const legacyAuth = path.endsWith(".toml") && repairTomlMcp(body, String(manifest.harness || "")) !== body;
      rows.push({
        kind: "mcp",
        state: !ok ? "missing" : legacyAuth ? "drift" : tokenSet ? "ok" : "drift",
        detail: !ok
          ? "not registered"
          : legacyAuth
            ? `hosted auth in the old shape (\`bearer_token\` / \`env\`) this harness cannot use — the next heal repairs it, or run: npx -y @valorbrain/connect --harness ${manifest.harness}`
            : tokenSet ? "registered" : "registered but token is still the placeholder",
      });
    } else if (artifact.kind === "hooks") {
      const ours = body.includes("@valorbrain/connect") || body.includes("valorbrain-connect") || hookClientVersions(body).length > 0 || launcherReferenced(body);
      const legacy = /--token=/.test(body);
      rows.push({
        kind: "hooks",
        state: !ours ? "missing" : legacy ? "drift" : "ok",
        detail: !ours
          ? "no valorbrain hooks"
          : legacy
            ? "hook protocol v1 (token on the command line) — run the installer again to migrate"
            : `hook protocol v2 — ${hookClientDetail(body, home)}`,
      });
    } else {
      const m = body.match(/valorbrain-contract:\s*v(\d+)/);
      rows.push({
        kind: artifact.kind,
        state: !m ? "missing" : m[1] === manifest.contract_version ? "ok" : "drift",
        detail: !m ? "no valorbrain block" : `contract v${m[1]}${m[1] === manifest.contract_version ? "" : ` (current is v${manifest.contract_version})`}`,
      });
    }
  }
  return rows;
}

/** Which client a hook file runs, for --status: the launcher (and the version it runs), a 0.10 local copy, or npx. */
export function hookClientDetail(body, home) {
  if (launcherReferenced(body)) {
    const current = readCurrent(home)?.version;
    if (!existsSync(join(clientRoot(home), "launcher.mjs"))) return "client: launcher (missing — those hooks stay silent until the next install)";
    return current ? `client: launcher → ${current}` : "client: launcher (no current.json — silent until the next heal)";
  }
  const local = [...new Set(hookClientVersions(body))];
  if (local.length > 0) {
    const missing = local.filter((v) => !existsSync(join(clientRoot(home), v, "hook.mjs")));
    return `client: local ${local.join(", ")}${missing.length ? ` (missing: ${missing.join(", ")} — those hooks fall back to npx)` : ""}`;
  }
  const pinned = [...new Set([...String(body).matchAll(/@valorbrain\/connect@([^\s"'\\]+)/g)].map((m) => m[1]))];
  return pinned.length > 0 ? `client: npx ${pinned.join(", ")}` : "client: npx (unpinned)";
}

// ── hand edits: never overwritten in silence (decision 17) ───────────────────

/** Our hook entries in a hooks JSON file, as a stable string. Throws when the file is not JSON. */
function ourHookEntries(raw) {
  const cfg = JSON.parse(raw);
  const hooks = cfg?.hooks;
  if (Array.isArray(hooks)) return JSON.stringify(hooks.filter(isOurHookEntry)); // Kiro v1 file
  if (!hooks || typeof hooks !== "object") return "";
  const out = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const mine = Array.isArray(entries) ? entries.filter(isOurHookEntry) : [];
    if (mine.length) out[event] = mine;
  }
  return JSON.stringify(out);
}

/**
 * Hash of the part of a file that is ours: our hook entries in a hooks JSON the
 * customer shares with other tools, our marker block in a merged text file,
 * the whole file when the file is ours. MCP entries are not tracked — they
 * carry the token and self-heal never touches them. null = untracked or absent.
 */
function managedHash(artifact, path, raw) {
  if (artifact.kind === "mcp" || raw === null) return null;
  let view = raw;
  if (artifact.kind === "hooks" && path.endsWith(".json") && !/valorbrain/i.test(path)) {
    try { view = ourHookEntries(raw); } catch { view = raw; }
  } else if (artifact.strategy === "merge") {
    view = extractBlock(raw) ?? "";
  }
  return createHash("sha256").update(view).digest("hex");
}

/**
 * True when applying `change` would overwrite a hand edit: the part of the file
 * we manage is no longer what we last wrote there, or the file we wrote is
 * gone. A file with no record (written before connect 0.8) is not flagged: the
 * next write records it.
 */
export function handEdited(change, written) {
  if (change.error || !change.changed || change.artifact.kind === "mcp") return false;
  const recorded = written?.[change.path];
  return Boolean(recorded) && managedHash(change.artifact, change.path, change.before) !== recorded;
}

/** Remember what we left in each managed file (connect-state.json `written`); `forget` after --remove. */
function recordWritten(home, changes, { forget = false } = {}) {
  const state = readHealState(home);
  const written = { ...(state.written || {}) };
  for (const c of changes) {
    if (c.error || c.kept || c.failed || c.artifact.kind === "mcp") continue;
    const hash = forget ? null : managedHash(c.artifact, c.path, c.after);
    if (hash) written[c.path] = hash;
    else delete written[c.path];
  }
  writeHealState(home, { ...state, written });
}

/** Changed lines between two texts (LCS on lines), as "- old" / "+ new". */
export function lineDiff(before, after) {
  const a = (before ?? "").split("\n");
  const b = (after ?? "").split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const x = a.slice(s, ea), y = b.slice(s, eb);
  if (x.length * y.length > 4_000_000) return [...x.map((l) => `- ${l}`), ...y.map((l) => `+ ${l}`)];
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  return out;
}

/**
 * Before an explicit install overwrites a hand edit: show what changes and ask.
 * With nobody at the keyboard the edit stays (rerun with --force). Declined
 * changes are marked `kept`; apply() skips them.
 */
async function confirmHandEdits(changes, home, { force, dryRun }) {
  const written = readHealState(home).written || {};
  const edited = changes.filter((c) => handEdited(c, written));
  if (edited.length === 0 || force) return;
  const rl = !dryRun && !isUnattended() && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    for (const c of edited) {
      console.log(`  ${C.yellow}!${C.off} ${c.path} was edited by hand; this update changes it:`);
      const diff = lineDiff(c.before, c.after);
      for (const line of diff.slice(0, 60)) console.log(`    ${C.dim}${line.replace(/vbm_[A-Za-z0-9_-]+/g, "vbm_…")}${C.off}`);
      if (diff.length > 60) console.log(`    ${C.dim}… ${diff.length - 60} more line(s)${C.off}`);
      if (dryRun) continue;
      const yes = rl ? /^y(es)?$/i.test((await rl.question("    Overwrite your changes? [y/N] ")).trim()) : false;
      if (!yes) {
        c.kept = true;
        if (!rl) console.log(`    ${C.dim}nobody here to confirm — kept; rerun with --force to overwrite${C.off}`);
      }
    }
  } finally {
    rl?.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`${WARN} warning: ignoring unknown flag(s): ${args.unknown.join(" ")} — this is @valorbrain/connect ${CLIENT_VERSION}; see --help`);
  }
  if (args.help) { console.log(HELP); return 0; }

  if (typeof args.mcpOnly !== "boolean") {
    console.error(`--mcp-only takes no value, or one of true|false (got "${args.mcpOnly}")`);
    return 2;
  }
  if (args.scope != null && !SCOPES.has(args.scope)) {
    console.error(`--scope must be one of: ${[...SCOPES].join(", ")}`);
    return 2;
  }
  if (args.kiroEngine !== "v3" && args.kiroEngine !== "legacy") {
    console.error(`--kiro-engine must be "v3" or "legacy"`);
    return 2;
  }

  const home = homedir();

  // --prompt / --transcript / --checkpoint only record a choice in
  // connect.json and exit: no token, no network, no file other than that one.
  const privacy = PRIVACY_KEYS.filter((k) => k in args.privacy);
  if (privacy.length > 0) {
    for (const k of privacy) {
      if (typeof args.privacy[k] !== "boolean") {
        console.error(`--${SWITCH_FLAGS[k]} must be "on" or "off"`);
        return 2;
      }
    }
    const ids = args.harnesses.length > 0 ? args.harnesses.map(canonicalHarness) : Object.keys(listCreds(home));
    if (ids.length === 0) {
      console.error("No connected agent in ~/.valorbrain/connect.json — name one: --harness claude-code|codex|gemini-cli|kiro|cursor|grok|opencode|hermes");
      return 2;
    }
    for (const id of ids) {
      setPrivacy(home, id, args.privacy);
      const what = privacy.map((k) => `${SWITCH_FLAGS[k]} ${args.privacy[k] ? "on" : "off"}`).join(", ");
      console.log(`${C.green}✓${C.off} ${id}: ${what} ${C.dim}(${credsPath(home).replace(home, "~")})${C.off}`);
      if ("send_transcript" in args.privacy && !TRANSCRIPT_HARNESSES.has(id)) {
        console.log(`  ${C.dim}note: ${id} has no transcript ValorBrain can read — nothing is sent (works for: ${[...TRANSCRIPT_HARNESSES].join(", ")})${C.off}`);
      }
    }
    // The switches exit before any install: an --mcp-only next to them is not
    // applied, and saying so beats a silent drop.
    if (args.mcpOnly) {
      console.error(`${WARN} --mcp-only was not applied: --${privacy.map((k) => SWITCH_FLAGS[k]).join("/--")} only record a choice and exit. Run the install with --mcp-only on its own.`);
    }
    return 0;
  }

  const resolved = resolveInstallToken({ flag: args.token, env: process.env, home, install: !args.status && !args.remove });
  if (resolved.error) {
    console.error(`${C.red}✗${C.off} ${resolved.error}`);
    return 2;
  }
  for (const w of resolved.warnings) console.error(`${C.yellow}!${C.off} ${w}`);
  let token = resolved.token;
  if (resolved.source === "cli") console.log(`${C.dim}Using the MCP token saved by @valorbrain/cli (~/.valorbrain/config.json)${C.off}`);
  // Filled by the browser login: the computer's token under each harness it
  // approved (one token per computer, shared by the agents on it), and the
  // engine URL the app that approved the computer belongs to. Agents already
  // connected on this computer keep the token saved in ~/.valorbrain/connect.json.
  let loginTokens = null;
  let loginApi = null;
  let savedTokens = {};
  const tokenFor = (harness) => {
    if (loginTokens && loginTokens[harness]) return loginTokens[harness];
    if (savedTokens[harness]) return savedTokens[harness];
    // After a login, an agent the app issued nothing for gets nothing (never
    // another agent's token).
    return loginTokens ? null : token;
  };
  let failed = 0;

  // Qa R1 (VAL-195): --status and --remove fetch the manifest from the API,
  // whose blind default was the public one — ignoring the api_url that this
  // same --status prints from ~/.valorbrain/connect.json. With --api omitted,
  // each harness follows the chain its own hook resolves (resolveCredentials,
  // per harness): VALORBRAIN_API_URL > that harness's connect.json api_url >
  // CLI config.json engine_url > public default. After a browser login the
  // approving app's engine comes right after --api and VALORBRAIN_API_URL.
  const installApi = (harness) => {
    const fromLogin = !args.api && !process.env.VALORBRAIN_API_URL && loginApi;
    // The CLI's token belongs to the engine the CLI signed up on.
    const fromCli = !args.api && !process.env.VALORBRAIN_API_URL && !fromLogin
      && resolved.source === "cli" && resolved.api && tokenFor(harness) === token ? resolved.api : null;
    const r = resolveInstallApi({
      flag: args.api || fromLogin || fromCli || null,
      env: process.env,
      home,
      harness,
      token: tokenFor(harness),
    });
    if (fromLogin) return { ...r, from: "the app that approved this computer" };
    return fromCli ? { ...r, from: "CLI config.json" } : r;
  };
  const apiFor = (harness) => installApi(harness).api;

  // The manifest needs no token. Fetched once per (engine, harness), and
  // before any login, so a harness the engine cannot serve never costs an
  // approval or a token.
  const manifestCache = new Map();
  // Installs and --status ask for the launcher manifest (it names the pin);
  // --remove and --mcp-only read the npx one (they only need the artifact paths).
  const wantLauncher = !args.remove && !args.mcpOnly && launcherWanted(process.env);
  const loadManifest = (harness, local = wantLauncher) => {
    const api = apiFor(harness);
    const key = `${api}|${harness}|${local}`;
    if (!manifestCache.has(key)) {
      const pending = fetchManifest(api, harness, { launcher: local });
      pending.catch(() => {}); // awaited by the caller; never an unhandled rejection
      manifestCache.set(key, pending);
    }
    return manifestCache.get(key);
  };
  const unusable = new Set();

  // Canonical ids everywhere (the engine renders hook commands with them, and
  // credentials are keyed by them): `--harness gemini` must store the entry
  // the `--harness=gemini-cli` hook will read.
  let targets = args.harnesses.map(canonicalHarness);
  if (targets.length === 0) {
    targets = detectInstalled(home);
    if (targets.length === 0) {
      console.error(`No supported agent found under ${home}. Install one first (Claude Code, Codex, Cursor, Gemini CLI, Kiro, OpenCode, …) or name it: --harness ${Object.keys(DETECT).join("|")}`);
      return 1;
    }
    console.log(`${C.dim}Detected: ${targets.join(", ")}${C.off}\n`);
  }

  // The CLI's token is a fallback for agents that have none of their own: an
  // agent already connected on this computer keeps its saved token.
  if (resolved.source === "cli" && !args.relogin) {
    for (const harness of targets) {
      const saved = readCreds(home, harness);
      if (saved?.token) savedTokens[harness] = saved.token;
    }
  }

  if (!args.status && !args.remove && !token) {
    if (args.dryRun) {
      console.error("A dry run never opens the browser: pass --token vbm_… (Settings → MCP Tokens), set VALORBRAIN_MCP_TOKEN, or run `npx -y @valorbrain/cli init --agent` first.");
      return 2;
    }
    // Nobody at the keyboard (CI, piped output): an approval link in a log is
    // an invitation for whoever reads the log to wire this machine to their
    // own workspace. Fail fast, as 0.5 did, unless asked to print the link.
    if (isUnattended() && !args.noBrowser && process.env.VALORBRAIN_NO_BROWSER !== "1") {
      console.error("No token, and nobody here to approve in a browser (CI or piped output). Pass --token vbm_… (Settings → MCP Tokens), set VALORBRAIN_MCP_TOKEN, run `npx -y @valorbrain/cli init --agent` first, or add --no-browser to print the approval link anyway.");
      return 2;
    }

    // Agents already connected on this computer keep their token (a re-run
    // updates their files); only the others need an approval. --relogin
    // replaces them all.
    const connected = [];
    const pending = [];
    for (const harness of targets) {
      const saved = args.relogin ? null : readCreds(home, harness);
      if (saved?.token) {
        savedTokens[harness] = saved.token;
        connected.push(harness);
      } else {
        pending.push(harness);
      }
    }
    if (connected.length > 0) {
      console.log(`${C.dim}Already connected: ${connected.join(", ")} (--relogin replaces their tokens)${C.off}`);
    }

    const resolvable = [];
    for (const harness of pending) {
      try {
        await loadManifest(harness);
        resolvable.push(harness);
      } catch (err) {
        console.error(`${C.red}✗${C.off} ${harness}: ${err.message}`);
        unusable.add(harness);
        failed++;
      }
    }

    if (resolvable.length > 0) {
      try {
        const login = await deviceLogin({
          app: resolveAppUrl({ flag: args.app, env: process.env }),
          harnesses: resolvable,
          label: deviceLabel(),
          install: installId(home),
          browser: !args.noBrowser,
          style: C,
        });
        // Only the agents this login asked for: an agent already connected
        // keeps its saved token even if the app answered with more.
        const answered = login.tokens ?? (resolvable.length === 1 ? { [resolvable[0]]: login.accessToken } : {});
        loginTokens = Object.fromEntries(resolvable.filter((h) => answered[h]).map((h) => [h, answered[h]]));
        loginApi = login.apiUrl;
        const got = resolvable.filter((h) => loginTokens[h]);
        console.log(`${C.green}✓${C.off} approved — ${got.length} agent(s), sharing one token for this computer\n`);
        const override = args.api || process.env.VALORBRAIN_API_URL;
        if (loginApi && override && override.replace(/\/+$/, "") !== loginApi) {
          console.log(`${C.yellow}!${C.off} the tokens were issued for ${loginApi}, but ${args.api ? "--api" : "VALORBRAIN_API_URL"} points the agents to ${override.replace(/\/+$/, "")}. They will fail there unless it is the same engine.\n`);
        }
      } catch (err) {
        console.error(`${C.red}✗${C.off} ${err?.message ?? err}`);
        return 1;
      }
    }
  }

  // 0.11 migration: every saved harness gets its install id and consented scope.
  if (!args.status && !args.dryRun) {
    try { ensureInstallIds(home); } catch { /* fail-open */ }
  }
  const icon = { ok: `${C.green}●${C.off}`, drift: `${C.yellow}◐${C.off}`, missing: `${C.red}○${C.off}` };
  const credsLabel = credsPath(home).replace(home, "~");

  for (const harness of targets) {
    if (unusable.has(harness)) continue; // already reported before the login
    if (!args.status && !args.remove && !tokenFor(harness)) {
      console.error(`${C.red}✗${C.off} ${harness}: the app issued no token for this agent — nothing changed for it`);
      failed++;
      continue;
    }
    let manifest;
    try {
      manifest = scopedManifest(await loadManifest(harness), { harness, scope: args.scope, home, kiroEngine: args.kiroEngine });
    } catch (err) {
      console.error(`${C.red}✗${C.off} ${harness}: ${err.message}`);
      failed++;
      continue;
    }

    console.log(`${C.bold}${manifest.name}${C.off} ${C.dim}(${manifest.harness}, contract v${manifest.contract_version})${C.off}`);
    {
      const r = installApi(harness);
      console.log(`  ${C.dim}engine ${r.api} (${r.from})${C.off}`);
    }

    if (args.status) {
      if (harness === "kiro") {
        const mode = detectKiroMode(readCreds(home, harness));
        console.log(`  ${C.dim}on disk: ${mode === "legacy" ? "legacy (agent config)" : "v3 (standalone ~/.kiro/hooks)"} — switch with --kiro-engine=${mode === "legacy" ? "v3" : "legacy"}${C.off}`);
      }
      const saved = readCreds(home, harness);
      const mcpOnly = saved?.mode === "mcp-only";
      const raw = statusFor(manifest, home);
      const hooked = raw.some((r) => r.kind === "hooks" && r.state !== "missing");
      const rows = raw.map((r) => (mcpOnly && r.kind === "hooks" && r.state === "missing"
        ? { ...r, state: "ok", detail: "none — installed with --mcp-only" }
        : r));
      if (manifest.artifacts.some(isPerTurn)) {
        const mode = !mcpOnly
          ? (hooked ? "hooks" : "hooks not installed")
          : hooked
            ? "mcp-only recorded, but valorbrain hooks are on disk and still send on each turn — run with --mcp-only --force to remove them (hooks you edited by hand go only with --force or a yes at the prompt)"
            : "mcp-only — MCP tools + instructions, no hooks (nothing sent per turn); run again without --mcp-only to add them";
        console.log(`  mode: ${mode}`);
      }
      for (const r of rows) {
        console.log(`  ${icon[r.state] ?? " "} ${r.kind.padEnd(5)} ${r.detail}`);
      }
      if (manifest.hooks_available) {
        console.log(saved
          ? `  ${icon.ok} creds ${credsLabel} (${saved.api ?? "default API"})`
          : `  ${icon.missing} creds none for ${harness} in ${credsLabel} — hooks stay silent until you run npx -y @valorbrain/connect`);
      }
      {
        // The launcher, the version it runs, the engine's pin, and why an update is held.
        const current = readCurrent(home);
        const pin = manifest.hook_client === "launcher" ? manifest.hook_client_version : null;
        const state = readHealState(home);
        const blocked = state.update_blocked?.[harness];
        const notes = [
          pin ? `pin ${pin}${current?.version && current.version !== pin ? " — behind, the next heal updates it" : ""}` : null,
          blocked ? `update held: the engine's data_scope ${blocked.scope} is above what was consented (${consentedScope(home, harness)}); run the installer to review` : null,
          state.needs_reinstall?.[harness] ? `needs reinstall: run npx -y @valorbrain/connect --harness ${harness} (then trust the new hook command once)` : null,
        ].filter(Boolean);
        if (existsSync(join(clientRoot(home), "launcher.mjs")) || pin) {
          console.log(`  ${existsSync(join(clientRoot(home), "launcher.mjs")) ? icon.ok : icon.missing} launcher ${launcherPath(home).replace(home, "~")} → ${current?.version ?? "none"}${notes.length ? ` (${notes.join("; ")})` : ""}`);
        }
      }
      console.log();
      continue;
    }

    // --remove wins over --mcp-only: both take the hooks out.
    const mcpOnly = args.mcpOnly && !args.remove;

    // Hooks read the token from this harness's entry (ADR-058), written before
    // any hook artifact so a freshly wired hook never runs without it. One
    // entry per harness: two harnesses may belong to two tenants.
    // Also saved for agents without hooks when the token came from a browser
    // login: a re-run then finds the agent connected and needs no approval.
    if (!args.remove && tokenFor(harness) && (manifest.hooks_available || (loginTokens && loginTokens[harness]))) {
      // With --mcp-only no hook reads it: kept so --status knows the mode and
      // a later plain run finds the agent connected (and adds the hooks).
      const what = mcpOnly ? "credentials, mcp-only" : "hook credentials";
      if (args.dryRun) {
        console.log(`  ${C.green}→${C.off} write ${what} ${C.dim}${credsLabel} [${harness}] (0600)${C.off}`);
      } else {
        try {
          // The person is here: what this install collects is what they consented to (contract C).
          writeCreds(home, { api: apiFor(harness), token: tokenFor(harness), harness, kiroEngine: args.kiroEngine, mcpOnly, ...(Number.isInteger(manifest.data_scope) ? { consentedScope: manifest.data_scope } : {}) });
          console.log(`  ${C.green}✓${C.off} ${what} ${C.dim}${credsLabel} [${harness}] (0600)${C.off}`);
        } catch (err) {
          console.log(`  ${C.red}✗${C.off} hook credentials: ${err.message}`);
          failed++;
          continue; // never wire hooks that would have nothing to read
        }
      }
    }

    // client=launcher: the hooks run the stable launcher, which runs the
    // pinned version under ~/.valorbrain/bin/connect/. When the pin cannot be
    // installed (no launcher in the manifest, unsafe directory, a download
    // that failed its check) the npx manifest is installed instead.
    let launcher = null;
    if (!args.remove && !mcpOnly && manifest.hook_client === "launcher") {
      const pin = manifest.hook_client_version;
      const r = args.dryRun
        ? (launcherPin(pin) ? { launcher: launcherPath(home), version: pin } : { error: `the engine pins ${pin}, which has no launcher` })
        : await ensureLauncher(home, manifest);
      if (r.launcher) {
        launcher = r.launcher;
        console.log(`  ${C.green}${args.dryRun ? "→" : "✓"}${C.off} hook launcher → ${r.version} ${C.dim}${launcher.replace(home, "~")} (updates never touch the files below again)${C.off}`);
      } else {
        try {
          manifest = scopedManifest(await loadManifest(harness, false), { harness, scope: args.scope, home, kiroEngine: args.kiroEngine });
        } catch (err) {
          console.error(`${C.red}✗${C.off} ${harness}: ${err.message}`);
          failed++;
          continue;
        }
        console.log(`  ${C.dim}note: hooks run npx @valorbrain/connect@${pin} — ${r.error}${C.off}`);
      }
    }
    // An explicit install replaces self-hosted ValorBrain hooks in the same
    // files (listed in the plan); --mcp-only and --remove never touch them.
    const changes = planFor(manifest, tokenFor(harness), home, mcpOnly ? isPerTurn : args.remove, process.cwd(), { launcher, migrateSelfHosted: !args.remove && !mcpOnly });
    if (!args.remove) await confirmHandEdits(changes, home, args);
    const res = apply(changes, args);
    if (!args.dryRun) recordWritten(home, changes, { forget: args.remove });
    failed += res.failed;
    // kiro fires hooks from exactly one file kind per engine (scopedManifest
    // doc): a file of the other mode left on disk double-fires every event in
    // a V3 session running the agent. Only OUR files go; paths planFor just
    // handled (this mode's artifact, or --remove's whole manifest) are not
    // reported twice.
    const pruned = [];
    if (harness === "kiro") {
      const handled = new Set(changes.map((c) => c.path));
      const stale = args.remove || mcpOnly
        ? [...staleKiroFiles({ home, kiroEngine: "v3" }), ...staleKiroFiles({ home, kiroEngine: "legacy" })]
        : staleKiroFiles({ home, kiroEngine: args.kiroEngine });
      // Installing the legacy engine's agent config: a self-hosted standalone
      // (`valorbrain hook …` in ~/.kiro/hooks/valorbrain.json) would keep firing
      // beside it in V3 sessions. An explicit install replaces it, as the v3
      // install replaces it by writing the same path.
      const selfHosted = !args.remove && !mcpOnly && args.kiroEngine === "legacy"
        ? selfHostedKiroStandalones({ home, cwd: args.scope === "workspace" ? process.cwd() : home })
        : [];
      for (const p of new Set([...stale, ...selfHosted.map((s) => s.path)])) {
        if (handled.has(p)) continue;
        const replaced = selfHosted.find((s) => s.path === p);
        const what = replaced
          ? `delete self-hosted kiro hook file — replaces ${replaced.names.length} self-hosted hook(s): ${replaced.names.join(", ")}`
          : "delete stale kiro hook file (the other engine mode must not stay active)";
        if (args.dryRun) {
          console.log(`  ${C.green}→${C.off} ${what}`);
          console.log(`    ${C.dim}${p}${C.off}`);
          continue;
        }
        try {
          if (replaced && !args.noBackup) writeBackup(p, readFileSync(p, "utf-8"));
          unlinkSync(p);
          pruned.push(p);
          console.log(`  ${C.green}✓${C.off} ${what}`);
          console.log(`    ${C.dim}${p}${C.off}`);
        } catch { /* fail-open */ }
      }
    }
    if (args.remove && !args.dryRun && removeCreds(home, harness)) {
      console.log(`  ${C.green}✓${C.off} delete hook credentials ${C.dim}${credsLabel} [${harness}]${C.off}`);
    }
    if (!args.dryRun) {
      // What this harness now runs; versions nothing runs go (--remove: at
      // once, and the launcher too once no harness runs it).
      recordHookClients(home, harness, [...changes.filter((c) => isPerTurn(c.artifact)).map((c) => c.path), ...pruned]);
      const gone = gcClientVersions(home, args.remove ? { graceMs: 0 } : {});
      if (args.remove && gone.includes("launcher.mjs")) console.log(`  ${C.green}✓${C.off} delete the hook launcher ${C.dim}${launcherPath(home).replace(home, "~")} (no harness runs it any more)${C.off}`);
      // A person ran the installer: a held update (scope) and a Codex reinstall are settled.
      const st = readHealState(home);
      if (st.update_blocked?.[harness] || st.needs_reinstall?.[harness]) {
        const blocked = { ...(st.update_blocked || {}) };
        const reinstall = { ...(st.needs_reinstall || {}) };
        delete blocked[harness];
        if (!changes.some((c) => c.kept && isPerTurn(c.artifact))) delete reinstall[harness];
        writeHealState(home, { ...st, update_blocked: blocked, needs_reinstall: reinstall });
      }
    }

    // Instalou/atualizou: informa o engine do estado deste harness (fail-open).
    if (!args.remove && !args.dryRun) {
      await declareContract(apiFor(harness), tokenFor(harness), harness, home, manifest);
    }

    if (!args.remove) {
      if (!manifest.hooks_available) {
        console.log(`  ${C.dim}note: automatic context injection (hooks) needs a self-hosted engine; this install covers tools + instructions${C.off}`);
      }
      if (mcpOnly && !manifest.artifacts.some(isPerTurn)) {
        console.log(`  ${C.dim}note: ${harness} gets no hooks from this engine — --mcp-only changes nothing here${harness === "hermes" ? "; the Hermes memory plugin stays installed and still sends the prompt of each turn (--prompt off stops that)" : ""}${C.off}`);
      }
      // Notes about hooks describe what --mcp-only just left out.
      for (const n of manifest.notes ?? []) if (!(mcpOnly && /hook/i.test(n))) console.log(`  ${C.dim}note: ${n}${C.off}`);
      if (mcpOnly && manifest.artifacts.some(isPerTurn)) {
        // A hook file edited by hand that nobody confirmed overwriting stays —
        // and keeps sending: say so instead of promising "nothing is sent".
        const keptHooks = changes.filter((c) => c.kept && isPerTurn(c.artifact));
        console.log(keptHooks.length > 0
          ? `  ${C.yellow}!${C.off} --mcp-only: your hand-edited hooks were kept (${keptHooks.map((c) => c.path).join(", ")}) and still send on each turn. Run again with --mcp-only --force to remove them.`
          : `  ${C.dim}note: --mcp-only — no hooks, so nothing is sent on each turn; the agent reaches memory through the MCP tools. Run again without --mcp-only to add the hooks.${C.off}`);
      }
      if (!mcpOnly && manifest.hooks_available && harness === "kiro") {
        const sub = args.kiroEngine === "legacy" ? "agents" : "hooks";
        const where = args.scope === "workspace"
          ? join(process.cwd(), ".kiro", sub, "valorbrain.json")
          : join(home, ".kiro", sub, "valorbrain.json");
        console.log(args.kiroEngine === "legacy"
          ? `  ${C.dim}note: legacy engine — hooks fire only when the session runs the agent: "kiro-cli chat --agent valorbrain" or "kiro-cli agent set-default valorbrain" (${where})${C.off}`
          : `  ${C.dim}note: V3 engine — hooks fire in "kiro-cli --v3" and Kiro CLI 3.0 sessions with no agent setup (${where}); sessions on the legacy engine need --kiro-engine=legacy${C.off}`);
      }
    }
    console.log();
  }

  // Full uninstall (targets were detected, not named): the credential file goes
  // too, including entries of harnesses no longer on this machine.
  if (args.remove && !args.dryRun && args.harnesses.length === 0 && removeCreds(home)) {
    console.log(`${C.green}✓${C.off} delete hook credentials ${C.dim}${credsLabel}${C.off}`);
  }
  if (args.dryRun) console.log(`${C.yellow}Dry run — nothing was written.${C.off}`);
  else if (!args.status && !args.remove) {
    console.log(`Restart your agent, then verify with: ${C.bold}npx @valorbrain/connect --status${C.off}`);
    console.log(`${C.dim}First thing to try in the agent:${C.off} "Use ValorBrain: what do you already know about this project? Then save a summary of what we are doing now."`);
  }

  return failed > 0 ? 1 : 0;
}

// Dispatch happens at the very bottom of the file: `connect hook <name>` runs the
// hook client (hook.mjs), anything else installs.


// ─── contrato: self-heal + declaração ───────────────────────────────────────
//
// O arquivo de regras vive na máquina do cliente e envelhece: o servidor publica
// um contrato novo e ninguém roda o install de novo. Aqui o próprio cliente se
// corrige quando o harness o invoca (hooks) ou logo após instalar — no máximo a
// cada 6h — e **declara** ao engine o que tem. Sem isso o servidor não sabe que
// o cliente está velho; é o único canal que fecha o loop sem o cliente rodar
// nada à mão. Tudo fail-open: hook que quebra o prompt é pior que hook inútil.

const DECLARE_TIMEOUT_MS = 2500;
/** Teto do self-heal no caminho do hook: nunca atrasa o prompt além disso. */
const HEAL_HOOK_BUDGET_MS = Number(process.env.VALORBRAIN_HEAL_HOOK_BUDGET_MS || 2500);

/**
 * Versão do contrato REALMENTE instalada: lê de volta o arquivo que o apply
 * acabou de escrever. Regras trazem o marker `valorbrain-contract: vN`; o
 * plugin do Hermes (que não tem arquivo de regras) traz `_CONTRACT_VERSION`.
 * Sem leitura possível devolve null — declarar o que não está no disco
 * inflaria a medição de adoção.
 */
function installedContractVersion(manifest, home) {
  for (const artifact of manifest?.artifacts || []) {
    if (artifact.kind !== "rules" && artifact.kind !== "plugin") continue;
    const path = expand(artifact.path, home);
    if (!path || !existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf-8");
      const m = artifact.kind === "rules"
        ? text.match(/valorbrain-contract:\s*v(\d+)/)
        : text.match(/_CONTRACT_VERSION\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch {
      /* segue para o próximo */
    }
  }
  return null;
}

/** Protocolo de hook do manifesto instalado: 2 só quando o engine atendeu `hooks=2`. */
function manifestHookProtocol(manifest) {
  return Number(manifest?.hook_protocol) === 2 ? 2 : 1;
}

/** Declara no engine o que este harness tem. Fail-open; sem token não faz nada. */
async function declareContract(api, token, harness, home, manifest) {
  if (!token || !harness) return;
  try {
    const m = manifest ?? (await fetchManifest(api, harness));
    const host = (() => {
      try {
        return hostname();
      } catch {
        return "host";
      }
    })();
    await fetch(`${api.replace(/\/$/, "")}/api/v1/runtimes/register`, {
      method: "POST",
      headers: { ...clientHeaders(home, harness), "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        runtime_key: `${harness}:${host}:${home}`,
        agent_platform: harness,
        display_name: `connect (${harness})`,
        hostname: host,
        plugin_version: CLIENT_VERSION,
        capabilities: {
          harness,
          contract_version: installedContractVersion(m, home),
          connector: "connect",
          self_heal: true,
          hook_protocol: manifestHookProtocol(m),
        },
      }),
      signal: AbortSignal.timeout(DECLARE_TIMEOUT_MS),
    });
  } catch {
    /* fail-open */
  }
}

/** Aplica mudanças sem imprimir nada (no hook, stdout é o canal de contexto). */
function applyQuiet(changes) {
  let wrote = 0;
  const backedUp = new Set();
  for (const c of changes) {
    if (c.error || !c.changed) continue;
    try {
      if (c.before !== null && !backedUp.has(c.path)) {
        writeBackup(c.path, c.before);
        backedUp.add(c.path);
      }
      if (c.after === null) {
        if (existsSync(c.path)) unlinkSync(c.path);
      } else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after);
      }
      wrote++;
    } catch {
      c.failed = true; // fail-open por arquivo; não entra no registro de escrita
    }
  }
  return wrote;
}

/**
 * Instalações antigas não têm `--harness` no comando de hook. Inferimos o
 * harness pelo arquivo que invoca este cliente — é o bootstrap que faz o
 * primeiro hook depois do update consertar a própria config (adicionando o
 * `--harness` e o contrato novo).
 */
const HARNESS_HOOK_FILES = [
  ["claude-code", [".claude/settings.json"]],
  ["kiro", [".kiro/hooks/valorbrain.json"]],
  ["grok", [".grok/hooks/valorbrain.json"]],
  ["omp", [".omp/agent/hooks/pre/valorbrain.ts"]],
  ["opencode", [".config/opencode/plugins/valorbrain.ts"]],
];

function detectHarness(home) {
  for (const [id, files] of HARNESS_HOOK_FILES) {
    for (const f of files) {
      const p = join(home, f);
      if (!existsSync(p)) continue;
      try {
        const body = readFileSync(p, "utf-8");
        if (body.includes("@valorbrain/connect") || body.includes("valorbrain hook") || hookClientVersions(body).length > 0 || launcherReferenced(body)) return id;
      } catch {
        /* segue para o próximo */
      }
    }
  }
  return "";
}

/**
 * `force` skips the 6h throttle (still recorded): the `heal` subcommand
 * (spawned by a hook that already claimed it, or by the omp bridge / Hermes
 * plugin through the launcher), and the npx hook of a version that never
 * tried the launcher. Never throws.
 */
async function maybeSelfHeal(api, token, harness, home, credsSource = null, engineHint = null, { force = false } = {}) {
  const id = harness || detectHarness(home);
  // Hermes keeps its token in its own config: its plugin heals without one.
  if (!id || (!token && id !== "hermes")) return;
  try {
    // Migração v1 → v2 (ADR-058): o hook v1 recebe o token pelo argv; a entrada
    // DESTE harness no connect.json é gravada ANTES de os hooks serem
    // reescritos sem token — nunca existe hook v2 sem de onde ler a credencial.
    // Token vindo de env não é persistido (quem usa env escolheu env), e uma
    // entrada existente com OUTRO token nunca é sobrescrita: aí não se migra.
    let canMigrateHooks = true;
    if (credsSource === "argv" && !harness) {
      // Hook commands from before `--harness` existed: the harness would be a
      // guess (detectHarness), and writing this token under a guessed id
      // cross-wires tenants. No credential write, no hook migration.
      canMigrateHooks = false;
    } else if (credsSource === "argv") {
      const saved = readCreds(home, id);
      if (!saved) {
        try {
          writeCreds(home, { api, token, harness: id });
        } catch {
          canMigrateHooks = false;
        }
      } else if (saved.token !== token) {
        canMigrateHooks = false;
      }
    } else if (credsSource !== "connect") {
      canMigrateHooks = false; // env/config: nada garante que o hook v2 terá credencial
    }
    // Instalado com --mcp-only: o heal nunca traz hooks de volta (nem launcher).
    const mcpOnly = readCreds(home, id)?.mode === "mcp-only";
    const wantLauncher = !mcpOnly && launcherWanted(process.env);
    // throttle mesmo em falha: hook roda a cada prompt. `launcher_tried`
    // bounds the npx hook's first-event heal to once per version.
    if (!claimHeal(home, { env: process.env, force, patch: { launcher_tried: CLIENT_VERSION } })) return;
    // 0.11 migration: install ids and consented scope on every saved harness.
    try { ensureInstallIds(home); } catch { /* fail-open */ }
    // Hosted MCP auth repair (codex/grok TOML): before the manifest fetch, so
    // neither an engine outage nor a held update keeps a broken file broken.
    // The plan below never carries `mcp` artifacts (a table the person chose is
    // theirs), but `bearer_token` under a hosted valorbrain table is the shape
    // only connect <= 0.12.0 wrote, and it cannot authenticate.
    for (const path of repairInstalledTomlMcp(home)) console.error(`[valorbrain] ${path}: hosted MCP auth repaired — vale no próximo carregamento`);
    const state = readHealState(home);
    // Modo: SÓ o opt-in registrado (--kiro-engine=legacy no connect.json)
    // decide legado. Agent config nosso em $HOME não prova nada — a 0.5.1
    // gravava esse arquivo POR DEFAULT (S1), e tratá-lo como opt-in apagava o
    // standalone, único loader de uma sessão V3 sem agente.
    const kiroMode = id === "kiro" ? detectKiroMode(readCreds(home, id)) : "v3";
    const homeIsCwd = resolve(process.cwd()) === resolve(home);
    // Criação — nunca construir o standalone de $HOME quando já existe arquivo
    // nosso de hooks em jogo: agent config nosso no PRÓPRIO $HOME (uma sessão
    // V3 com o agente ativo dispararia pelos dois), ou no cwd do hook quando
    // ele é um projeto (o heal não escreve em projeto — o arquivo de lá
    // continua e viraria segundo loader). $HOME não é projeto: com
    // cwd = $HOME o standalone de lá é o MESMO arquivo do plano — atualizar é
    // migração (S2), não segundo loader. Vale também sob contractDrift; as
    // regras seguem normalmente. Estado duplo que JÁ existe só sai com um
    // install explícito, que faz a poda do modo escolhido.
    const homeAgentOurs = id === "kiro" && kiroMode === "v3" ? staleKiroFiles({ home, cwd: home, kiroEngine: "v3" }) : [];
    const kiroSecondLoaderRisk = id === "kiro" && kiroMode === "v3" &&
      (homeAgentOurs.length > 0 || (!homeIsCwd && kiroProjectHasOurHooks(process.cwd())));
    let manifest = scopedManifest(await fetchManifest(api, id, { launcher: wantLauncher }), { harness: id, scope: null, home, kiroEngine: kiroMode });
    // Scope guard (contract C): an update that would collect more by default
    // than this person consented to is held — nothing installed, no file
    // touched — until they run the installer. One log line per held scope.
    const scope = Number.isInteger(manifest.data_scope) ? manifest.data_scope : 1;
    {
      const st = readHealState(home);
      const blocked = { ...(st.update_blocked || {}) };
      if (scope > consentedScope(home, id)) {
        if (blocked[id]?.scope !== scope) {
          logConnect(home, `${id}: update held — the engine's data_scope ${scope} is above the consented ${consentedScope(home, id)}; review with: npx -y @valorbrain/connect --harness ${id}`);
          blocked[id] = { scope, at: new Date().toISOString() };
          writeHealState(home, { ...st, update_blocked: blocked });
        }
        await declareContract(api, token, id, home, manifest);
        return;
      }
      if (blocked[id]) {
        delete blocked[id];
        writeHealState(home, { ...st, update_blocked: blocked });
      }
    }
    // The pinned version under ~/.valorbrain/bin/connect/: already there, this
    // package, or the signed tarball. A failed update keeps the launcher on
    // the version it runs (the harness files stay as they are); with no
    // launcher at all the hooks stay on npx.
    let launcher = null;
    if (manifest.hook_client === "launcher") {
      const r = await ensureLauncher(home, manifest);
      if (r.launcher) launcher = r.launcher;
      else {
        // Declined (unsafe $HOME, bad download…): the running version keeps
        // running, and the reason is logged once per pin and reason, not per heal.
        const st = readHealState(home);
        const note = `${manifest.hook_client_version}|${r.error}`;
        if (st.update_declined?.[id] !== note) {
          logConnect(home, `${id}: update to ${manifest.hook_client_version} not applied — ${r.error}; the current version keeps running`);
          writeHealState(home, { ...st, update_declined: { ...(st.update_declined || {}), [id]: note } });
        }
        launcher = existsSync(join(clientRoot(home), "launcher.mjs")) && readCurrent(home) ? launcherPath(home) : null;
      }
      if (!launcher) manifest = scopedManifest(await fetchManifest(api, id), { harness: id, scope: null, home, kiroEngine: kiroMode });
    }
    const installed = installedContractVersion(manifest, home);
    const expected = String(manifest?.contract_version || "");
    const contractDrift = Boolean(expected && installed !== expected);
    // Plano SEM os artefatos de MCP: com o planejamento encadeado, um arquivo
    // compartilhado (settings.json do Gemini) carregaria a entrada MCP — e o
    // token do heal — para dentro da mudança de hooks.
    const plan = planFor({ ...manifest, artifacts: (manifest.artifacts || []).filter((a) => a.kind !== "mcp" && !(mcpOnly && isPerTurn(a))) }, token, home, false, process.cwd(), { launcher })
      .filter((c) => !c.error);
    const planned = plan.filter((c) => c.changed);
    // A guarda de segundo loader barra só a CRIAÇÃO do standalone em $HOME
    // (`before === null`): atualizar um standalone NOSSO que já existe é
    // migração, não segundo loader — o arquivo já é um loader; torná-lo v2
    // devolve o checkpoint do Stop e tira o token do argv (célula SA v1 + AC
    // no projeto, herança 0.4.x→0.5.1). Arquivo de terceiro no caminho
    // continua fora do plano.
    const guarded = kiroSecondLoaderRisk
      ? planned.filter((c) => c.artifact.kind !== "hooks" || (c.before !== null && isOurStandaloneHooks(c.before)))
      : planned;
    // Contrato em drift: reaplica regras + hooks. Sem drift de contrato, só hooks
    // cujas ENTRADAS mudaram (ex.: v1 → v2) — reformatação de JSON não conta — e
    // os arquivos do plugin do Hermes cujos bytes mudaram.
    // O Codex nunca migra sozinho: comando novo exige re-trust manual em
    // /hooks, e migrar sozinho desligaria o recall em silêncio.
    const relevant = contractDrift
      ? guarded
      : guarded.filter((c) => (c.artifact.kind === "hooks" && hookEntriesChanged(c)) || c.artifact.kind === "plugin");
    const codexNeedsReinstall = id === "codex" && relevant.some((c) => c.artifact.kind === "hooks" && launcherReferenced(c.after) && !launcherReferenced(c.before));
    const changes = relevant
      .filter((c) => c.artifact.kind !== "hooks" || (canMigrateHooks && id !== "codex"))
      // Without a token (a Hermes heal), a file that would carry the placeholder is never written.
      .filter((c) => token || !String(c.after ?? "").includes(TOKEN_PLACEHOLDER));
    // Decision 17: a file the person edited by hand is never rewritten from
    // here — the hook has nobody to ask. Logged; a re-run of the installer
    // shows the diff and asks.
    const kept = changes.filter((c) => handEdited(c, state.written));
    for (const c of kept) {
      const msg = `[valorbrain] ${c.path}: edited by hand — self-heal left it as is; review with: npx -y @valorbrain/connect --harness ${id}`;
      console.error(msg);
      try { appendFileSync(join(home, ".valorbrain", "connect.log"), `${new Date().toISOString()} ${msg}\n`); } catch { /* fail-open */ }
    }
    const safe = changes.filter((c) => !kept.includes(c));
    if (safe.length > 0) {
      const wrote = applyQuiet(safe);
      if (wrote > 0) {
        console.error(
          contractDrift
            ? `[valorbrain] contrato v${installed ?? "?"} -> v${expected} (${wrote} arquivo(s)) — vale no próximo carregamento`
            : `[valorbrain] hooks atualizados (protocolo v${manifest?.hook_protocol ?? 1}, ${wrote} arquivo(s)) — vale no próximo carregamento`,
        );
      }
    }
    // Files already current are recorded too: from now on an edit to them is
    // detected even if this install predates the record.
    recordWritten(home, [...plan.filter((c) => !c.changed), ...safe]);
    // Read back from disk: a hook file kept (hand edit, Codex) still runs what it ran.
    recordHookClients(home, id, plan.filter((c) => isPerTurn(c.artifact)).map((c) => c.path));
    gcClientVersions(home);
    // Codex: a hook command it was not told about stays off until someone
    // trusts it in /hooks, so the move to the launcher is the installer's job
    // (a human present). Reported in the request headers until then.
    if (id === "codex") {
      const st = readHealState(home);
      const flags = { ...(st.needs_reinstall || {}) };
      if (codexNeedsReinstall) flags.codex = true;
      else delete flags.codex;
      writeHealState(home, { ...st, needs_reinstall: flags });
    }
    // Hosted and self-hosted hooks in one file both fire on every event. The
    // heal never removes the self-hosted ones (nobody to ask); it says so once
    // per heal, in the log, with the command that replaces them.
    for (const c of plan.filter((c) => isPerTurn(c.artifact))) {
      let commands = [];
      try { commands = hookCommands(JSON.parse(readFileSync(c.path, "utf-8"))); } catch { continue; }
      const selfHosted = commands.filter(isSelfHostedHookCommand);
      if (selfHosted.length === 0 || !commands.some(isConnectHookEntry)) continue;
      const msg = `[valorbrain] ${c.path}: hosted hooks run beside ${selfHosted.length} self-hosted ValorBrain hook(s) (${selfHosted.map(selfHostedHookName).join(", ")}) — both fire on every event; replace them with: npx -y @valorbrain/connect --harness ${id}`;
      try { appendFileSync(join(home, ".valorbrain", "connect.log"), `${new Date().toISOString()} ${msg}\n`); } catch { /* fail-open */ }
    }
    // Poda em $HOME (cwd:home dedupa as raízes — projeto nunca é tocado),
    // consciente do engine que CHAMOU o hook — o heal nunca
    // remove o loader que pode ser o único do chamador:
    //  - opt-in legado (marker): o standalone foi declarado obsoleto — pode ir;
    //  - chamada V3 (payload PascalCase) e o standalone existe: é o loader do
    //    chamador e fica; agent config nosso em $HOME é lixo da 0.5.1 — pode
    //    ir (sem standalone não poda: o agent config pode ser o único loader);
    //  - chamada legado (camelCase) ou sem sinal: qualquer um dos dois pode
    //    ser o único loader de alguma sessão desta máquina — não poda nada;
    //    um install explícito resolve.
    let pruneKiroKind = null;
    if (id === "kiro") {
      if (kiroMode === "legacy") pruneKiroKind = "legacy";
      else if (engineHint === "v3" && staleKiroFiles({ home, cwd: home, kiroEngine: "legacy" }).length > 0) pruneKiroKind = "v3";
    }
    if (pruneKiroKind) {
      for (const p of staleKiroFiles({ home, cwd: home, kiroEngine: pruneKiroKind })) {
        try { unlinkSync(p); } catch { /* fail-open */ }
      }
    }
    await declareContract(api, token, id, home, manifest);
  } catch {
    /* fail-open */
  }
}

/** Did our hook entries change, as opposed to the file's formatting? */
function hookEntriesChanged(change) {
  if (change.before === null || change.after === null) return change.before !== change.after;
  try {
    return ourHookEntries(change.before) !== ourHookEntries(change.after);
  } catch {
    // Not JSON (OpenCode plugin source): the file is ours, compare bytes.
    return change.before !== change.after;
  }
}

// Pure pieces the tests exercise (node --test test/). Importing this module for
// them sets VALORBRAIN_CONNECT_NO_MAIN so the dispatch below does not run.
export { hookEntriesChanged, mergeHooksJson, planFor };

// ─── dispatch ────────────────────────────────────────────────────────────────

if (process.env.VALORBRAIN_CONNECT_NO_MAIN === '1') {
    // imported by the test suite
} else if (process.argv[2] === 'hook') {
    // The hook client lives in hook.mjs (protocol v2, ADR-058); this file lends
    // it the self-heal, which needs the installer's planning code. Run through
    // npx, the heal stays in-process (≤2.5s); under the launcher it never does.
    // An npx hook of a version that never tried the launcher heals now, not
    // in 6h: that is how an npx install moves to the launcher at its first
    // event. A cue naming another pin heals at once, detached.
    const argv = process.argv.slice(3);
    readStdinPayload()
        .then((payload) => runHook(argv, {
            payload,
            clientVersion: CLIENT_VERSION,
            onPinHint: (pin) => noticePin(pin, argv, payload),
            heal: ({ api, token, harness, home, credsSource }) =>
                maybeSelfHeal(api, token, harness, home, credsSource, kiroEngineFromPayload(payload), {
                    force: launcherWanted(process.env) && !existsSync(join(clientRoot(home), "launcher.mjs")) && readHealState(home).launcher_tried !== CLIENT_VERSION,
                }),
        }))
        .then((code) => process.exit(code))
        .catch(() => process.exit(0));
} else if (process.argv[2] === 'heal') {
    // `<launcher> heal --harness=<id>` (the hook's detached heal, the omp
    // bridge, the Hermes plugin) or `npx -y @valorbrain/connect@<pin> heal`
    // (a 0.10 local client). The caller already claimed the throttle.
    // Silent, exit 0, every guard of the in-hook heal applies; no stdin.
    const argv = process.argv.slice(3);
    const harness = canonicalHarness(argv.find((a) => a.startsWith('--harness='))?.slice(10) || '');
    const engine = argv.find((a) => /^--caller-engine=(v3|legacy)$/.test(a))?.slice(16) || null;
    const home = homedir();
    const creds = harness ? resolveCredentials({ argv: [], env: process.env, home, harness }) : {};
    (creds.token || harness === 'hermes' ? maybeSelfHeal(creds.api, creds.token ?? null, harness, home, creds.source ?? null, engine, { force: true }) : Promise.resolve())
        .catch(() => {})
        .finally(() => process.exit(0));
} else if (process.argv[2] === 'mcp') {
    // 0.1.x compat: `valorbrain-connect --token …` used to BE the MCP proxy.
    // The installer is the default surface; the proxy lives in @valorbrain/cli
    // (`npx -y @valorbrain/cli mcp`), which this subcommand runs as-is.
    const child = spawn('npx', ['-y', '@valorbrain/cli', 'mcp', ...process.argv.slice(3)], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
        console.error(`valorbrain-connect mcp: could not start \`npx -y @valorbrain/cli mcp\` (${err.message}). Run it directly.`);
        process.exit(1);
    });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
} else {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error(`connect failed: ${err?.stack || err}`);
        process.exit(1);
    });
}
