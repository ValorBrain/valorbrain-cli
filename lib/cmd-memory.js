/**
 * `add` / `search` / `list` — the memory round-trip.
 *
 * add → POST /documents; search → POST /search; list → GET /collections.
 * The engine preserves text verbatim — pt-BR stays pt-BR — which is a
 * deliberate difference from competitors that translate on write.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { api } from "./api.js";
import { loadConfig, saveConfig, resolveBaseUrl, resolveApiKey } from "./config.js";

function requireKey(opts) {
  const cfg = loadConfig();
  const key = resolveApiKey({ keyFlag: opts.key, cfg });
  if (!key) {
    console.error("error: no API key. Run `valorbrain init --agent` first (or pass --key / set VALORBRAIN_TOKEN).");
    process.exit(1);
  }
  return { cfg, key, baseUrl: resolveBaseUrl({ urlFlag: opts.url, cfg }) };
}

export async function cmdAdd(args, { json }) {
  const flags = looseFlags(args);
  const text = flags._positional.join(" ").trim() || (flags["--file"] ? readFileSync(flags["--file"], "utf8") : "");
  if (!text) {
    console.error(json ? JSON.stringify({ ok: false, error: "nothing to add — pass text or --file" }) : "error: nothing to add — pass text or --file");
    process.exit(1);
  }

  const { cfg, key, baseUrl } = requireKey(flags);
  const collection = (flags["--collection"] || "memories").toLowerCase();
  const title = flags["--title"] || text.split("\n")[0].slice(0, 80);
  const path = flags["--path"] || `cli/${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

  const r = await api.addDocument(baseUrl, key, {
    collection,
    path,
    title,
    content: text,
    content_type: flags["--type"] || "note",
  });

  // init salvou engine_url na época; se o usuário trocou de --url, persiste.
  if (cfg && cfg.engine_url !== baseUrl) saveConfig({ ...cfg, engine_url: baseUrl });

  if (json) {
    console.log(JSON.stringify({ ok: true, docid: r.docid ?? r.id ?? null, collection, path, ...r }));
  } else {
    console.log(`✓ added to "${collection}" as ${path} (docid ${r.docid ?? r.id ?? "?"})`);
  }
}

export async function cmdSearch(args, { json }) {
  const flags = looseFlags(args);
  const query = flags._positional.join(" ").trim();
  if (!query) {
    console.error("error: usage: valorbrain search <query>");
    process.exit(1);
  }

  const { key, baseUrl } = requireKey(flags);
  const body = { query, compact: true };
  if (flags["--collection"]) body.collection = flags["--collection"].toLowerCase();
  if (flags["--mode"]) body.mode = flags["--mode"];

  const r = await api.search(baseUrl, key, query, body);
  const hits = r.results ?? r.hits ?? r.docs ?? [];

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
    console.log(`${where}${h.title ?? h.path ?? h.docid ?? "?"}${score}`);
    if (h.snippet) console.log(`  ${String(h.snippet).replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

export async function cmdList(args, { json }) {
  const flags = looseFlags(args);
  const { key, baseUrl } = requireKey(flags);
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

/** Positionals + --flags (with =value or space value), --key/--url included. */
function looseFlags(args) {
  const out = { _positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out._positional.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) out[a.slice(0, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith("--") && ["--file", "--title", "--path", "--collection", "--type", "--mode", "--key", "--url"].includes(a)) out[a] = args[++i];
      else out[a] = true;
    } else {
      out._positional.push(a);
    }
  }
  return out;
}
