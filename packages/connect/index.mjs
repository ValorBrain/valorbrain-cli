#!/usr/bin/env node
/**
 * @valorbrain/connect — wire a CLI agent harness to hosted ValorBrain.
 *
 * A customer has an MCP endpoint and a `vbm_` token. They do not have the engine,
 * so `valorbrain setup harness` is not available to them. This is the client half:
 * it asks the engine for the rendered artifacts and writes them.
 *
 * Node built-ins only — no dependencies, nothing to audit, runs anywhere the
 * harnesses already run.
 *
 *   npx @valorbrain/connect --token vbm_xxx            # detect and wire everything
 *   npx @valorbrain/connect --token vbm_xxx --harness kiro
 *   npx @valorbrain/connect --token vbm_xxx --dry-run
 *   npx @valorbrain/connect --status
 *   npx @valorbrain/connect --token vbm_xxx --remove
 *
 * The engine is the source of truth for what gets written: update the contract
 * server-side and the next run of this installer picks it up. Nothing here needs
 * republishing when the rules text changes.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";

const DEFAULT_API = process.env.VALORBRAIN_API_URL || "https://valorbrain-api.valor.digital";
const BLOCK_BEGIN = "<!-- valorbrain:begin -->";
const BLOCK_END = "<!-- valorbrain:end -->";
const TOKEN_PLACEHOLDER = "vbm_<YOUR_TOKEN>";

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", green: "", yellow: "", red: "", bold: "", off: "" };

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { harnesses: [], dryRun: false, remove: false, status: false, api: DEFAULT_API, token: null, noBackup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--remove") out.remove = true;
    else if (a === "--status") out.status = true;
    else if (a === "--no-backup") out.noBackup = true;
    else if (a === "--token") out.token = argv[++i];
    else if (a.startsWith("--token=")) out.token = a.slice(8);
    else if (a === "--harness") out.harnesses.push(argv[++i]);
    else if (a.startsWith("--harness=")) out.harnesses.push(a.slice(10));
    else if (a === "--api") out.api = argv[++i];
    else if (a.startsWith("--api=")) out.api = a.slice(6);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.harnesses.push(a);
  }
  return out;
}

const HELP = `
${C.bold}@valorbrain/connect${C.off} — wire a CLI agent harness to hosted ValorBrain

  npx @valorbrain/connect --token vbm_xxx                 detect installed harnesses and wire them
  npx @valorbrain/connect --token vbm_xxx --harness kiro   wire one
  npx @valorbrain/connect --token vbm_xxx --dry-run        show the plan, write nothing
  npx @valorbrain/connect --status                         what is wired right now
  npx @valorbrain/connect --token vbm_xxx --remove         undo

Options
  --token vbm_…     MCP token (Settings → MCP Tokens in the app). Or set VALORBRAIN_TOKEN.
  --api URL         engine base URL (default ${DEFAULT_API})
  --no-backup       skip .valorbrain-bak copies

Writes two things per harness: the MCP server entry (so the tools exist) and an
instructions file (so the agent knows to consult memory before answering). Files
you own are edited between ${BLOCK_BEGIN} markers; everything else is preserved.
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
      existing[root].valorbrain = rendered[root].valorbrain;
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
 * TOML: replace only our `[mcp_servers.valorbrain]` table. Line-based, because a
 * regex that stops at the first `[` corrupts inline arrays like `args = [ "mcp",]`.
 */
function mergeToml(existingRaw, renderedRaw, remove) {
  const header = "[mcp_servers.valorbrain]";
  const lines = (existingRaw || "").split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  let end = lines.length;
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
  }
  const block = renderedRaw.trimEnd().split("\n");
  if (remove) {
    if (start === -1) return existingRaw;
    lines.splice(start, end - start);
    return lines.join("\n");
  }
  if (start !== -1) {
    lines.splice(start, end - start, ...block, "");
    return lines.join("\n");
  }
  const base = existingRaw || "";
  const sep = base.length === 0 ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return base + sep + block.join("\n") + "\n";
}

// ── plan / apply ────────────────────────────────────────────────────────────

async function fetchManifest(api, harness) {
  const url = `${api.replace(/\/$/, "")}/setup/artifacts?agent=${encodeURIComponent(harness)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function planFor(manifest, token, home, remove) {
  const changes = [];
  for (const artifact of manifest.artifacts) {
    const path = expand(artifact.path, home);
    if (!path) continue;
    const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
    // Substitute the real token, and expand `~` inside file contents too
    // (OpenCode stores an absolute instructions path in its config).
    const rendered = artifact.contents
      .split(TOKEN_PLACEHOLDER).join(token || TOKEN_PLACEHOLDER)
      .split('"~/').join(`"${home}/`);

    let after;
    try {
      if (artifact.kind === "mcp" && path.endsWith(".toml")) {
        after = mergeToml(before, rendered, remove);
      } else if (artifact.kind === "mcp") {
        after = mergeJson(before ?? "{}", rendered, remove);
      } else if (artifact.kind === "hooks" && path.endsWith(".json") && !/valorbrain/i.test(path)) {
        // Arquivo COMPARTILHADO do cliente (ex.: ~/.claude/settings.json):
        // merge por evento, nunca overwrite. Arquivos nossos (valorbrain.json,
        // plugins/valorbrain.ts) seguem o caminho normal (write/delete).
        after = mergeHooksJson(before ?? "", rendered, remove);
      } else if (artifact.strategy === "merge") {
        const block = extractBlock(rendered);
        if (!block) throw new Error("server sent a merge artifact without markers");
        after = remove ? removeBlock(before ?? "") : upsertBlock(before ?? "", block);
      } else {
        after = remove ? null : rendered;
      }
    } catch (err) {
      changes.push({ artifact, path, before, after: before, changed: false, error: err.message });
      continue;
    }
    if (remove && after !== null && after.trim() === "") after = null;
    changes.push({ artifact, path, before, after, changed: after !== before });
  }
  return changes;
}

function apply(changes, { dryRun, noBackup }) {
  let wrote = 0, failed = 0;
  for (const c of changes) {
    const tag = c.artifact.best_effort ? ` ${C.yellow}[delivery unverified]${C.off}` : "";
    if (c.error) {
      console.log(`  ${C.red}✗${C.off} ${c.artifact.label}: ${c.error}`);
      console.log(`    ${C.dim}${c.path}${C.off}`);
      failed++;
      continue;
    }
    if (!c.changed) {
      console.log(`  ${C.dim}=${C.off} ${c.artifact.label} — already current${tag}`);
      continue;
    }
    const verb = c.after === null ? "delete" : c.before === null ? "create" : "update";
    console.log(`  ${C.green}${dryRun ? "→" : "✓"}${C.off} ${verb} ${c.artifact.label}${tag}`);
    console.log(`    ${C.dim}${c.path}${C.off}`);
    if (dryRun) continue;
    try {
      if (c.before !== null && !noBackup) writeFileSync(`${c.path}.valorbrain-bak`, c.before);
      if (c.after === null) {
        if (existsSync(c.path)) unlinkSync(c.path);
      } else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after);
      }
      wrote++;
    } catch (err) {
      console.log(`  ${C.red}✗${C.off} write failed: ${err.message}`);
      failed++;
    }
  }
  return { wrote, failed };
}

/** True when a hook entry was written by us (hosted client or local binary). */
function isOurHookEntry(entry) {
  const s = JSON.stringify(entry ?? "");
  return s.includes("@valorbrain/connect") || s.includes("valorbrain hook");
}

/**
 * Merge our hooks into a JSON file the CUSTOMER owns (ex.:
 * `~/.claude/settings.json`). O servidor renderiza o arquivo a partir de uma
 * base vazia — sobrescrever aqui apagaria hooks e permissões do cliente (bug
 * pego ao planejar o heal do Erick/Evous, 2026-09-21). Preserva tudo; troca
 * apenas as entradas que são nossas, por evento.
 */
function mergeHooksJson(existingRaw, renderedRaw, remove) {
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
  for (const [event, entries] of Object.entries(renderedHooks)) {
    const kept = Array.isArray(existing.hooks[event])
      ? existing.hooks[event].filter((e) => !isOurHookEntry(e))
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
      rows.push({
        kind: "mcp",
        state: ok ? (tokenSet ? "ok" : "drift") : "missing",
        detail: ok ? (tokenSet ? "registered" : "registered but token is still the placeholder") : "not registered",
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

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }

  const home = homedir();
  const token = args.token || process.env.VALORBRAIN_TOKEN || null;

  let targets = args.harnesses;
  if (targets.length === 0) {
    targets = detectInstalled(home);
    if (targets.length === 0) {
      console.error(`No supported harness found under ${home}. Pass one explicitly: ${Object.keys(DETECT).join(", ")}`);
      return 1;
    }
    console.log(`${C.dim}Detected: ${targets.join(", ")}${C.off}\n`);
  }

  if (!args.status && !args.remove && !token) {
    console.error("A token is required. Get one at Settings → MCP Tokens, then pass --token vbm_… (or set VALORBRAIN_TOKEN).");
    return 2;
  }

  const icon = { ok: `${C.green}●${C.off}`, drift: `${C.yellow}◐${C.off}`, missing: `${C.red}○${C.off}` };
  let failed = 0;

  for (const harness of targets) {
    let manifest;
    try {
      manifest = await fetchManifest(args.api, harness);
    } catch (err) {
      console.error(`${C.red}✗${C.off} ${harness}: ${err.message}`);
      failed++;
      continue;
    }

    console.log(`${C.bold}${manifest.name}${C.off} ${C.dim}(${manifest.harness}, contract v${manifest.contract_version})${C.off}`);

    if (args.status) {
      for (const r of statusFor(manifest, home)) {
        console.log(`  ${icon[r.state] ?? " "} ${r.kind.padEnd(5)} ${r.detail}`);
      }
      console.log();
      continue;
    }

    const changes = planFor(manifest, token, home, args.remove);
    const res = apply(changes, args);
    failed += res.failed;

    // Instalou/atualizou: informa o engine do estado deste harness (fail-open).
    if (!args.remove && !args.dryRun) {
      await declareContract(args.api, token, harness, home, manifest);
    }

    if (!args.remove) {
      if (!manifest.hooks_available) {
        console.log(`  ${C.dim}note: automatic context injection (hooks) needs a self-hosted engine; this install covers tools + instructions${C.off}`);
      }
      for (const n of manifest.notes ?? []) console.log(`  ${C.dim}note: ${n}${C.off}`);
    }
    console.log();
  }

  if (args.dryRun) console.log(`${C.yellow}Dry run — nothing was written.${C.off}`);
  else if (!args.status) console.log(`Restart your agent, then verify with: ${C.bold}npx @valorbrain/connect --status${C.off}`);

  return failed > 0 ? 1 : 0;
}

// Dispatch happens at the very bottom of the file, once the hook client below is
// defined: `connect hook <name>` runs the hook client, anything else installs.


// ─── contrato: self-heal + declaração ───────────────────────────────────────
//
// O arquivo de regras vive na máquina do cliente e envelhece: o servidor publica
// um contrato novo e ninguém roda o install de novo. Aqui o próprio cliente se
// corrige quando o harness o invoca (hooks) ou logo após instalar — no máximo a
// cada 6h — e **declara** ao engine o que tem. Sem isso o servidor não sabe que
// o cliente está velho; é o único canal que fecha o loop sem o cliente rodar
// nada à mão. Tudo fail-open: hook que quebra o prompt é pior que hook inútil.

const CLIENT_VERSION = "0.3.1";
const HEAL_INTERVAL_MS = Number(process.env.VALORBRAIN_HEAL_INTERVAL_MS || 6 * 3600 * 1000);
const DECLARE_TIMEOUT_MS = 2500;
/** Teto do self-heal no caminho do hook: nunca atrasa o prompt além disso. */
const HEAL_HOOK_BUDGET_MS = Number(process.env.VALORBRAIN_HEAL_HOOK_BUDGET_MS || 2500);

function healStatePath(home) {
  return join(home, ".valorbrain", "connect-state.json");
}

function readHealState(home) {
  try {
    return JSON.parse(readFileSync(healStatePath(home), "utf-8"));
  } catch {
    return {};
  }
}

function writeHealState(home, state) {
  try {
    mkdirSync(dirname(healStatePath(home)), { recursive: true });
    writeFileSync(healStatePath(home), JSON.stringify(state));
  } catch {
    /* fail-open */
  }
}

/** Versão do contrato instalada (marker no arquivo de regras do manifesto). */
function installedContractVersion(manifest, home) {
  for (const artifact of manifest?.artifacts || []) {
    if (artifact.kind !== "rules") continue;
    const path = expand(artifact.path, home);
    if (!path || !existsSync(path)) continue;
    try {
      const m = readFileSync(path, "utf-8").match(/valorbrain-contract:\s*v(\d+)/);
      if (m) return m[1];
    } catch {
      /* segue para o próximo */
    }
  }
  return null;
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
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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
  for (const c of changes) {
    if (c.error || !c.changed) continue;
    try {
      if (c.before !== null) writeFileSync(`${c.path}.valorbrain-bak`, c.before);
      if (c.after === null) {
        if (existsSync(c.path)) unlinkSync(c.path);
      } else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after);
      }
      wrote++;
    } catch {
      /* fail-open por arquivo */
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
        if (body.includes("@valorbrain/connect") || body.includes("valorbrain hook")) return id;
      } catch {
        /* segue para o próximo */
      }
    }
  }
  return "";
}

async function maybeSelfHeal(api, token, harness, home) {
  if (!token) return;
  const id = harness || detectHarness(home);
  if (!id) return;
  try {
    const state = readHealState(home);
    if (state.lastHealAt && Date.now() - state.lastHealAt < HEAL_INTERVAL_MS) return;
    state.lastHealAt = Date.now();
    writeHealState(home, state); // throttle mesmo em falha: hook roda a cada prompt
    const manifest = await fetchManifest(api, id);
    const installed = installedContractVersion(manifest, home);
    const expected = String(manifest?.contract_version || "");
    if (expected && installed !== expected) {
      const changes = planFor(manifest, token, home, false).filter(
        (c) => c.changed && !c.error && c.artifact.kind !== "mcp",
      );
      if (changes.length > 0) {
        const wrote = applyQuiet(changes);
        if (wrote > 0) {
          console.error(
            `[valorbrain] contrato v${installed ?? "?"} -> v${expected} (${wrote} arquivo(s)) — vale no próximo carregamento`,
          );
        }
      }
    }
    await declareContract(api, token, id, home, manifest);
  } catch {
    /* fail-open */
  }
}

// ─── hook client ─────────────────────────────────────────────────────────────
//
// ADR-009 layer 3 (automatic context injection) required a local engine binary:
// hooks shell out to `valorbrain hook <name>`. Hosted customers have no binary,
// so they got layers 1 and 2 and nothing else — the agent had to remember to ask.
// Measured consequence of relying on that: 3% declared utilisation.
//
// This is layer 3 over HTTP. The harness invokes this file as a hook, it reads the
// harness's JSON payload on stdin, asks the hosted engine to assemble context for
// that prompt, and writes it back in the dialect the harness expects.
//
// It stays deliberately dumb: one request, a hard timeout, and silence on any
// failure. A hook that breaks a prompt is worse than a hook that adds nothing, so
// every error path exits 0 with empty output.

const HOOK_TIMEOUT_MS = Number(process.env.VALORBRAIN_HOOK_TIMEOUT_MS || 8000);

/** Prompt text, under whichever key the calling harness uses. */
function readPromptFrom(payload) {
    if (!payload || typeof payload !== 'object') return '';
    for (const key of ['prompt', 'user_prompt', 'userPrompt', 'message', 'query', 'text']) {
        const v = payload[key];
        if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
}

async function readStdin() {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return '';
    try {
        return JSON.parse(raw);
    } catch {
        return '';
    }
}

/**
 * Call one MCP tool over Streamable HTTP without an SDK.
 *
 * The 2026-07-28 wire makes this possible in a dependency-free script: there is no
 * `initialize` handshake to perform and no session to keep, so a single POST
 * carrying the `_meta` envelope is a complete exchange. The same call on the 2025
 * wire would have needed a handshake first.
 */
async function callTool(api, token, name, args, signal) {
    const url = `${api.replace(/\/$/, '')}/mcp`;
    const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name,
            arguments: args,
            _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: process.env.VALORBRAIN_HOOK_CLIENT || 'valorbrain-connect', version: '0.1.0' },
                'io.modelcontextprotocol/clientCapabilities': {}
            }
        }
    };
    const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            // SEP-2243 standard headers. `Mcp-Name` carries the tool name on a
            // tools/call — the server rejects a mismatch with -32020, which is how
            // a malformed caller finds out immediately instead of silently.
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': name
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    // The endpoint answers plain JSON for modern exchanges, but accept SSE framing
    // too rather than depending on which one a given deployment emits.
    const payload = text.startsWith('{')
        ? text
        : (text.split('\n').find((l) => l.startsWith('data:')) || '').slice(5).trim();
    if (!payload) throw new Error('empty response');
    const parsed = JSON.parse(payload);
    if (parsed.error) throw new Error(parsed.error.message || 'tool error');
    return parsed.result;
}

/** Hooks that produce context, and the tool that produces it for each. */
const CONTEXT_HOOKS = new Set(['context-surfacing', 'session-bootstrap', 'memory-prepare']);

async function runHook(argv) {
    const name = argv.find((a) => !a.startsWith('-')) || 'context-surfacing';
    const format = argv.find((a) => a.startsWith('--format='))?.slice(9) || 'text';
    const api = argv.find((a) => a.startsWith('--api='))?.slice(6) || DEFAULT_API;
    const token = argv.find((a) => a.startsWith('--token='))?.slice(8) || process.env.VALORBRAIN_TOKEN;
    const harness = argv.find((a) => a.startsWith('--harness='))?.slice(10) || process.env.VALORBRAIN_HARNESS || '';

    const emit = (context) => {
        if (!context) return 0;
        if (format === 'json') {
            process.stdout.write(JSON.stringify({
                continue: true,
                suppressOutput: false,
                hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context }
            }) + '\n');
        } else {
            process.stdout.write(context + '\n');
        }
        return 0;
    };

    // No token, unknown hook, or a hook with no context to produce: stay silent.
    if (!token || !CONTEXT_HOOKS.has(name)) return emit('');

    const payload = await readStdin();
    const prompt = readPromptFrom(payload);
    // Session start carries no prompt; ask for the stable context instead.
    const message = prompt || (name === 'session-bootstrap' ? 'session start' : '');
    if (!message) return emit('');

    // Self-heal + declaração em paralelo com o contexto e com teto de tempo:
    // throttled a 6h, então quase sempre é um no-op; quando roda, nunca atrasa o
    // prompt além do orçamento. Nada aqui imprime em stdout (o canal é o contexto).
    const heal = Promise.race([
        maybeSelfHeal(api, token, harness, homedir()),
        new Promise((r) => setTimeout(r, HEAL_HOOK_BUDGET_MS)),
    ]).catch(() => {});

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
    try {
        const [result] = await Promise.all([callTool(api, token, 'memory_prepare', {
            message,
            // The hook runs on the critical path of every prompt, so it takes the
            // cheap path: recall still covers documents by category, the funnel's
            // embedding + hybrid search is skipped.
            fast_mode: true
        }, controller.signal), heal]);
        const context = (result?.content || []).map((c) => c?.text).filter(Boolean).join('\n').trim();
        return emit(context);
    } catch {
        // Silence is the contract. A hook that breaks a prompt is worse than one
        // that adds nothing.
        return emit('');
    } finally {
        clearTimeout(timer);
    }
}

// ─── dispatch ────────────────────────────────────────────────────────────────

if (process.argv[2] === 'hook') {
    runHook(process.argv.slice(3))
        .then((code) => process.exit(code))
        .catch(() => process.exit(0));
} else if (process.argv[2] === 'mcp') {
    // 0.1.x compat: `valorbrain-connect --token …` used to BE the MCP proxy
    // (same as `valorbrain mcp`). The installer is the new default surface;
    // the proxy survives as an explicit subcommand, served by @valorbrain/cli
    // when it is installed alongside.
    import('@valorbrain/cli/lib/mcp-proxy.js')
        .then((m) => m.runMcpProxy(process.argv.slice(3)))
        .catch(() => {
            console.error('valorbrain-connect mcp needs @valorbrain/cli installed (npm i -g @valorbrain/cli), or use: valorbrain mcp');
            process.exit(1);
        });
} else {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error(`connect failed: ${err?.stack || err}`);
        process.exit(1);
    });
}
