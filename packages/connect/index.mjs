#!/usr/bin/env node
/**
 * @valorbrain/connect — wire a CLI agent harness to hosted ValorBrain.
 *
 * A customer has an MCP endpoint and a `vbm_` token. They do not have the engine,
 * so `valorbrain setup harness` is not available to them. This is the client half:
 * it asks the engine for the rendered artifacts and writes them.
 *
 * Node built-ins + `yaml` (o config do Hermes é YAML; preservamos o arquivo do
 * cliente e só mesclamos as chaves nossas).
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

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { parseDocument } from "yaml";
import { HOOK_PROTOCOL, credsPath, readCreds, readStdinPayload, removeCreds, resolveCredentials, runHook, writeCreds } from "./hook.mjs";

const DEFAULT_API = process.env.VALORBRAIN_API_URL || "https://valorbrain-api.valor.digital";
const BLOCK_BEGIN = "<!-- valorbrain:begin -->";
const BLOCK_END = "<!-- valorbrain:end -->";
const TOKEN_PLACEHOLDER = "vbm_<YOUR_TOKEN>";

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", green: "", yellow: "", red: "", bold: "", off: "" };

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { harnesses: [], dryRun: false, remove: false, status: false, api: null, token: null, noBackup: false };
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

Writes, per harness: the MCP server entry (so the tools exist), an instructions
file (so the agent knows to consult memory before answering) and, where the
harness has hooks, lifecycle hooks: context at session start and on each prompt,
and every few turns a short memory checkpoint the agent itself records through
MCP. Hooks read the token from ~/.valorbrain/connect.json (0600) — never from
the command line. Files you own are edited between ${BLOCK_BEGIN} markers;
everything else is preserved.
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
  // `hooks=2`: this client speaks hook protocol v2 (ADR-058). An engine that
  // predates it ignores the parameter and answers the v1 manifest, which this
  // client still serves (legacy names, `--token=` on the command line).
  const url = `${api.replace(/\/$/, "")}/setup/artifacts?agent=${encodeURIComponent(harness)}&hooks=${HOOK_PROTOCOL}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Merge do config YAML do Hermes (`~/.hermes/config.yaml`). O arquivo é do
 * cliente (modelo, providers, tokens) — nada de sobrescrever: copiamos só os
 * caminhos que são nossos (`mcp_servers.valorbrain`, `memory.provider` e as
 * chaves de `env` que o manifest trouxer), preservando comentários e o resto.
 */
function mergeYaml(existingRaw, renderedRaw, remove) {
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

function planFor(manifest, token, home, remove) {
  const changes = [];
  // Two artifacts can share a file (Gemini keeps MCP servers and hooks in
  // settings.json): each must build on what the previous one will write, or
  // the second write reverts the first.
  const planned = new Map();
  for (const artifact of manifest.artifacts) {
    const path = expand(artifact.path, home);
    if (!path) continue;
    const before = planned.has(path) ? planned.get(path) : existsSync(path) ? readFileSync(path, "utf-8") : null;
    // Substitute the real token, and expand `~` inside file contents too
    // (OpenCode stores an absolute instructions path in its config).
    const rendered = artifact.contents
      .split(TOKEN_PLACEHOLDER).join(token || TOKEN_PLACEHOLDER)
      .split('"~/').join(`"${home}/`);

    let after;
    try {
      if (artifact.kind === "mcp" && /\.ya?ml$/.test(path)) {
        // Hermes: config.yaml é do cliente; mescla por chave, nunca overwrite.
        after = mergeYaml(before, rendered, remove);
      } else if (artifact.kind === "mcp" && path.endsWith(".toml")) {
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
    if (!c.changed) {
      console.log(`  ${C.dim}=${C.off} ${c.artifact.label} — already current${tag}`);
      continue;
    }
    const verb = c.after === null ? "delete" : c.before === null ? "create" : "update";
    console.log(`  ${C.green}${dryRun ? "→" : "✓"}${C.off} ${verb} ${c.artifact.label}${tag}`);
    console.log(`    ${C.dim}${c.path}${C.off}`);
    if (dryRun) continue;
    try {
      // Once per file: a chained change's `before` is the previous change's
      // output, and backing that up would overwrite the copy of the original.
      if (c.before !== null && !noBackup && !backedUp.has(c.path)) {
        writeFileSync(`${c.path}.valorbrain-bak`, c.before);
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
      failed++;
    }
  }
  return { wrote, failed };
}

/** True when a hook entry was written by us (hosted client or local binary). */
function isOurHookEntry(entry) {
  const s = JSON.stringify(entry ?? "");
  return s.includes("@valorbrain/connect") || s.includes("valorbrain hook") || s.includes("valorbrain-connect hook");
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
  // Top-level keys the harness schema requires (Cursor's `version: 1`) come
  // with the rendered file; never overwrite the customer's own value.
  if (!remove) {
    for (const [k, v] of Object.entries(rendered)) {
      if (k !== "hooks" && !(k in existing)) existing[k] = v;
    }
  }
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
    } else if (artifact.kind === "hooks") {
      const ours = body.includes("@valorbrain/connect") || body.includes("valorbrain-connect");
      const legacy = /--token=/.test(body);
      rows.push({
        kind: "hooks",
        state: !ours ? "missing" : legacy ? "drift" : "ok",
        detail: !ours
          ? "no valorbrain hooks"
          : legacy
            ? "hook protocol v1 (token on the command line) — run the installer again to migrate"
            : "hook protocol v2",
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

  // Qa R1 (VAL-195): --status and --remove fetch the manifest from args.api,
  // whose blind default was the public API — ignoring the api_url that this
  // same --status prints from ~/.valorbrain/connect.json. With --api omitted,
  // follow the same chain the hook resolves (resolveCredentials):
  // VALORBRAIN_API_URL > connect.json api_url > engine config.json engine_url
  // > public default.
  if (!args.api) args.api = resolveCredentials({ argv: process.argv.slice(2), env: process.env, home }).api;

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
  const credsLabel = credsPath(home).replace(home, "~");

  // Hooks read the token from this file (ADR-058) — written before any hook
  // artifact, so a freshly wired hook never runs without it.
  if (args.status) {
    const saved = readCreds(home);
    console.log(saved
      ? `${icon.ok} creds ${credsLabel} (${saved.api ?? "default API"})`
      : `${icon.missing} creds ${credsLabel} absent — hooks stay silent until the installer runs with --token`);
    console.log();
  } else if (!args.remove && token) {
    if (args.dryRun) {
      console.log(`${C.green}→${C.off} write hook credentials ${C.dim}${credsLabel} (0600)${C.off}\n`);
    } else {
      try {
        writeCreds(home, { api: args.api, token });
        console.log(`${C.green}✓${C.off} hook credentials ${C.dim}${credsLabel} (0600)${C.off}\n`);
      } catch (err) {
        console.log(`${C.red}✗${C.off} hook credentials: ${err.message}\n`);
        failed++;
      }
    }
  }

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
  else if (args.remove) {
    // Full uninstall (every detected harness): the hook credential goes too.
    // With --harness, other harnesses may still use it.
    if (args.harnesses.length === 0) {
      if (removeCreds(home)) console.log(`${C.green}✓${C.off} delete hook credentials ${C.dim}${credsLabel}${C.off}`);
    } else if (existsSync(credsPath(home))) {
      console.log(`${C.dim}note: hook credentials kept at ${credsLabel} (other harnesses may use them); --remove without --harness deletes them${C.off}`);
    }
  } else if (!args.status) console.log(`Restart your agent, then verify with: ${C.bold}npx @valorbrain/connect --status${C.off}`);

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

const CLIENT_VERSION = "0.5.0";
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
        writeFileSync(`${c.path}.valorbrain-bak`, c.before);
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

async function maybeSelfHeal(api, token, harness, home, credsSource = null) {
  if (!token) return;
  const id = harness || detectHarness(home);
  if (!id) return;
  try {
    // Migração v1 → v2 (ADR-058): quem ainda recebe o token pelo argv (ou env)
    // ganha o arquivo de credencial ANTES de os hooks serem reescritos sem
    // token — nunca existe hook v2 sem de onde ler a credencial.
    if ((credsSource === "argv" || credsSource === "env") && !readCreds(home)) {
      try {
        writeCreds(home, { api, token });
      } catch {
        return; // sem credencial gravada, não migra os hooks
      }
    }
    const state = readHealState(home);
    if (state.lastHealAt && Date.now() - state.lastHealAt < HEAL_INTERVAL_MS) return;
    state.lastHealAt = Date.now();
    writeHealState(home, state); // throttle mesmo em falha: hook roda a cada prompt
    const manifest = await fetchManifest(api, id);
    const installed = installedContractVersion(manifest, home);
    const expected = String(manifest?.contract_version || "");
    const contractDrift = Boolean(expected && installed !== expected);
    const planned = planFor(manifest, token, home, false).filter(
      (c) => c.changed && !c.error && c.artifact.kind !== "mcp",
    );
    // Contrato em drift: reaplica tudo que é nosso (regras + hooks). Sem drift de
    // contrato, só hooks cujas ENTRADAS mudaram (ex.: v1 → v2) — reformatação
    // de JSON não conta, senão o settings.json do cliente seria regravado a cada
    // 6h por causa de indentação.
    const changes = contractDrift ? planned : planned.filter((c) => c.artifact.kind === "hooks" && hookEntriesChanged(c));
    if (changes.length > 0) {
      const wrote = applyQuiet(changes);
      if (wrote > 0) {
        console.error(
          contractDrift
            ? `[valorbrain] contrato v${installed ?? "?"} -> v${expected} (${wrote} arquivo(s)) — vale no próximo carregamento`
            : `[valorbrain] hooks atualizados (protocolo v${manifest?.hook_protocol ?? 1}, ${wrote} arquivo(s)) — vale no próximo carregamento`,
        );
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
    const ours = (raw) => {
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
    };
    return ours(change.before) !== ours(change.after);
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
    // it the self-heal, which needs the installer's planning code.
    readStdinPayload()
        .then((payload) => runHook(process.argv.slice(3), {
            payload,
            clientVersion: CLIENT_VERSION,
            heal: ({ api, token, harness, home, credsSource }) =>
                maybeSelfHeal(api, token, harness, home, credsSource),
        }))
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
