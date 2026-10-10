/**
 * `add` / `search` / `list` / `forget` — the memory round-trip.
 *
 * add → POST /documents; search → POST /search; list → GET /collections;
 * forget → POST /documents/:docid/forget. The engine preserves text verbatim —
 * pt-BR stays pt-BR — which is a deliberate difference from competitors that
 * translate on write.
 *
 * Identity: (collection, path) is the document. `add --key <name>` gives a
 * memory a stable path (cli/key/<slug>), so adding it again revises the same
 * document (action "updated", revision_count + 1) instead of creating a
 * sibling. Without --key the path is a hash of the text, as before.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { api } from "./api.js";
import { loadConfig, resolveBaseUrl, requireApiKey } from "./config.js";
import { usage } from "./errors.js";

/** REST context for a parsed command: credential + base URL from flags/env/config. */
export function restContext(globals) {
  if (globals["--api-key"] && globals["--key"]) {
    throw usage("pass the REST key once: --api-key or --key, not both", "duplicate_flag", { flag: "--key" });
  }
  const cfg = loadConfig();
  const key = requireApiKey({ keyFlag: globals["--api-key"] ?? globals["--key"], cfg });
  return { cfg, key, baseUrl: resolveBaseUrl({ urlFlag: globals["--url"], cfg }) };
}

/**
 * Stable path for a memory key: lowercase ASCII words joined by dashes.
 * "Deploy key / Produção" → "cli/key/deploy-key-producao".
 */
export function keyPath(key) {
  const slug = key
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/, "");
  if (!slug) throw usage(`--key "${key}" has no letters or digits to build a path from`, "invalid_value", { flag: "--key" });
  return `cli/key/${slug}`;
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw usage(`cannot read --file ${file} (${e.code ?? e.message})`, "file_not_found", { file });
  }
}

const CREDENTIAL = /^(vb_|vbm_|fk_)/;
const DOCID = /^#?[0-9a-f]{6,64}$/i;

export async function cmdAdd({ globals, flags, positionals }, { json }) {
  const inline = positionals.join(" ").trim();
  if (inline && flags["--file"]) throw usage("pass the text or --file, not both", "conflicting_flags");
  const text = inline || (flags["--file"] ? readText(flags["--file"]) : "");
  if (!text.trim()) throw usage("nothing to add — pass text or --file", "missing_argument");

  const memoryKey = flags["--key"];
  if (memoryKey !== undefined && CREDENTIAL.test(memoryKey)) {
    throw usage(
      "on `add`, --key is the memory key (a name like \"deploy-key\"), not a credential. Pass the REST key as --api-key, or put --key before the command.",
      "invalid_value",
      { flag: "--key" }
    );
  }
  if (memoryKey !== undefined && flags["--path"]) throw usage("use --key or --path, not both", "conflicting_flags");

  const { key, baseUrl } = restContext(globals);
  const collection = (flags["--collection"] || "memories").toLowerCase();
  const title = flags["--title"] || text.trim().split("\n")[0].slice(0, 80);
  const path = flags["--path"]
    || (memoryKey !== undefined ? keyPath(memoryKey) : `cli/${createHash("sha256").update(text).digest("hex").slice(0, 16)}`);
  const contentType = flags["--type"] || "note";

  const doc = { collection, path, title, content: text, content_type: contentType };
  if (flags["--sensitivity"]) doc.sensitivity = flags["--sensitivity"];
  const supersedes = flags["--supersedes"];
  if (supersedes?.length) doc.supersedes = supersedes.length === 1 ? supersedes[0] : supersedes;

  const r = await api.addDocument(baseUrl, key, doc);
  const docid = r.docid ?? r.id ?? null;
  const out = {
    ok: true,
    ...r,
    docid,
    collection: r.collection ?? collection,
    path: r.path ?? path,
    key: memoryKey ?? null,
    action: r.action ?? null,
    revision_count: r.revision_count ?? null,
    content_type: r.content_type ?? contentType,
    sensitivity: r.sensitivity ?? null,
  };

  if (json) {
    console.log(JSON.stringify(out));
    return;
  }
  const verb = { created: "added", updated: "revised", unchanged: "unchanged" }[out.action] ?? "added";
  const details = [
    `docid ${docid ? hashed(docid) : "?"}`,
    out.revision_count != null ? `revision ${out.revision_count}` : null,
    out.content_type,
    out.sensitivity,
  ].filter(Boolean).join(", ");
  console.log(`✓ ${verb} ${out.collection}/${out.path} (${details})`);
  if (out.action === "unchanged") console.log("  same content as the current version — nothing new was stored");
  for (const s of Array.isArray(r.supersedes) ? r.supersedes : []) {
    console.log(`  supersedes ${hashed(s.docid)} ${s.path ?? ""}`.trimEnd());
  }
}

export async function cmdSearch({ globals, flags, positionals }, { json }) {
  const query = positionals.join(" ").trim();
  if (!query) throw usage("usage: valorbrain search <query>", "missing_argument");

  const { key, baseUrl } = restContext(globals);
  const body = { query };
  if (flags["--collection"]) body.collection = flags["--collection"].toLowerCase();
  if (flags["--mode"]) body.mode = flags["--mode"];
  if (flags["--limit"] !== undefined) body.limit = flags["--limit"];

  const r = await api.search(baseUrl, key, body);
  let hits = r.results ?? r.hits ?? r.docs ?? [];
  // Older engines ignore `limit` on some paths; the flag is a promise to the caller.
  if (body.limit !== undefined) hits = hits.slice(0, body.limit);

  if (json) {
    console.log(JSON.stringify({ ok: true, query, count: hits.length, results: hits }));
    return;
  }
  if (hits.length === 0) {
    console.log("no results");
    return;
  }
  for (const h of hits) {
    const where = h.collection ? `[${h.collection}] ` : "";
    const score = typeof h.score === "number" ? ` (${h.score.toFixed(3)})` : "";
    const id = h.docid ? ` ${hashed(h.docid)}` : "";
    console.log(`${where}${h.title ?? h.path ?? h.docid ?? "?"}${score}${id}`);
    if (h.superseded_by) console.log(`  superseded by ${hashed(h.superseded_by.docid)} ${h.superseded_by.path ?? ""}`.trimEnd());
    if (h.snippet) console.log(`  ${String(h.snippet).replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

export async function cmdList({ globals }, { json }) {
  const { key, baseUrl } = restContext(globals);
  const r = await api.collections(baseUrl, key);
  const cols = r.collections ?? r ?? [];

  if (json) {
    console.log(JSON.stringify({ ok: true, collections: cols }));
    return;
  }
  if (!Array.isArray(cols) || cols.length === 0) {
    console.log("no collections yet — `valorbrain add` creates the first one");
    return;
  }
  for (const c of cols) {
    console.log(typeof c === "string" ? c : `${c.name ?? c.collection ?? "?"}${c.count != null ? `  (${c.count})` : ""}`);
  }
}

export async function cmdForget({ globals, positionals }, { json }) {
  const raw = positionals[0];
  if (!raw) throw usage("usage: valorbrain forget <docid>", "missing_argument");
  if (!DOCID.test(raw)) {
    throw usage(`"${raw}" is not a docid (6+ hex characters, e.g. #a1b2c3 — \`add\` and \`search\` print it)`, "invalid_value");
  }
  const docid = raw.replace(/^#/, "").toLowerCase();
  const { key, baseUrl } = restContext(globals);
  const r = await api.forget(baseUrl, key, docid);
  if (json) {
    console.log(JSON.stringify({ ok: true, docid, forgotten: r.forgotten ?? true }));
    return;
  }
  console.log(`✓ forgot ${hashed(docid)} — it no longer appears in search`);
}

function hashed(docid) {
  const s = String(docid);
  return s.startsWith("#") ? s : `#${s}`;
}
