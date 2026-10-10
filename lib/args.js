/**
 * Strict argv parser — one spec drives parsing, validation and `help --json`.
 *
 * Rules (PRD M4):
 *   - an unknown flag is an error; its value never becomes memory text
 *   - global flags (--json, --api-key/--key, --url, --help) work in any
 *     position, before or after the command
 *   - `--flag value` and `--flag=value`; `--` ends flags (text that starts
 *     with a dash goes after it)
 *   - a value flag without a value, a repeated single-value flag, a bad enum
 *     or integer, and extra positionals are errors
 *
 * `--key` is the REST credential everywhere except after `add`, where it is
 * the memory key (stable path). `--api-key` is the unambiguous credential flag.
 */
import { usage } from "./errors.js";

export const CONTENT_TYPES = ["decision", "observation", "problem", "milestone", "handoff", "lesson", "note"];
export const SENSITIVITIES = ["public", "internal", "private", "company_confidential"];
export const SEARCH_MODES = ["auto", "keyword", "semantic", "hybrid"];

/** Flags accepted in any position by every command. */
export const GLOBAL_FLAGS = {
  "--json": { type: "bool", description: "machine-readable single-object output; errors too" },
  "--api-key": { type: "string", value: "vb_…", description: "REST API key (vb_agent_… or vb_…) override" },
  "--key": { type: "string", value: "vb_…", description: "alias of --api-key (on `add`, after the command, --key is the memory key)" },
  "--url": { type: "string", value: "url", description: "REST base URL override (on `mcp`: the MCP URL)" },
  "--agent": { type: "bool", description: "init only: create an agent account" },
  "--help": { type: "bool", aliases: ["-h"], description: "this help" },
  "--version": { type: "bool", aliases: ["-V"], description: "print the version" },
};

/**
 * Command specs. `positionals`: "none" | "one" | "rest".
 * Flag types: bool | string | int (min/max) | enum (values); `multiple` collects repeats.
 */
export const COMMANDS = {
  init: {
    usage: "init --agent [--agent-caller <platform>] [--name <n>] [--force] | init --email <address> [--otp <code>]",
    description: "create an agent account (REST key + MCP token) or claim it with an email",
    positionals: "none",
    flags: {
      "--agent-caller": { type: "string", value: "platform", description: "which agent is signing up (self-declared)" },
      "--name": { type: "string", value: "name", description: "agent name" },
      "--force": { type: "bool", description: "replace an existing config (a backup is written first)" },
      "--email": { type: "string", value: "address", description: "claim the account with this email (OTP)" },
      "--otp": { type: "string", value: "code", description: "the OTP from the email (verifies without sending a new one)" },
    },
  },
  identify: {
    usage: "identify <platform>",
    description: "set which agent is calling (idempotent)",
    positionals: "one",
    flags: {},
  },
  add: {
    usage: "add <text> | --file <path> [--key <name>] [--collection <c>] [--title <t>] [--type <t>] [--supersedes <docid|path>] [--sensitivity <s>]",
    description: "store a memory; --key gives it a stable identity, so adding again is a revision",
    positionals: "rest",
    flags: {
      "--file": { type: "string", value: "path", description: "read the text from a file" },
      "--key": { type: "string", value: "name", description: "memory key: stable path cli/key/<slug>; re-adding it revises the same memory" },
      "--path": { type: "string", value: "path", description: "explicit document path (instead of --key)" },
      "--collection": { type: "string", value: "name", description: "collection (default: memories)" },
      "--title": { type: "string", value: "title", description: "title (default: first line)" },
      "--type": { type: "enum", values: CONTENT_TYPES, description: "content type (default: note)" },
      "--supersedes": { type: "string", value: "docid|path", multiple: true, description: "mark an older memory as superseded by this one (repeatable)" },
      "--sensitivity": { type: "enum", values: SENSITIVITIES, description: "sensitivity (default: the server's)" },
    },
  },
  search: {
    usage: "search <query> [--collection <c>] [--mode <m>] [--limit <n>]",
    description: "search memories",
    positionals: "rest",
    flags: {
      "--collection": { type: "string", value: "name", description: "only this collection" },
      "--mode": { type: "enum", values: SEARCH_MODES, description: "retrieval mode (default: auto)" },
      "--limit": { type: "int", min: 1, max: 100, description: "maximum results (1-100)" },
    },
  },
  forget: {
    usage: "forget <docid>",
    description: "forget a memory (soft delete; it stops appearing in search)",
    positionals: "one",
    flags: {},
  },
  list: {
    usage: "list",
    description: "list collections",
    positionals: "none",
    flags: {},
  },
  status: {
    usage: "status",
    description: "local config + remote health",
    positionals: "none",
    flags: {},
  },
  mcp: {
    usage: "mcp [--token vbm_…] [--token-file <path>] [--url <mcp-url>]",
    description: "bridge stdio MCP clients to the hosted MCP server (uses the saved mcp_token)",
    positionals: "none",
    flags: {
      "--token": { type: "string", value: "vbm_…", description: "MCP token override" },
      "--token-file": { type: "string", value: "path", description: "read the MCP token from a file" },
    },
  },
  help: {
    usage: "help [--json]",
    description: "this surface, machine-readable with --json",
    positionals: "none",
    flags: {},
  },
  version: {
    usage: "version",
    description: "print the version",
    positionals: "none",
    flags: {},
  },
};

const GLOBAL_ALIASES = Object.fromEntries(
  Object.entries(GLOBAL_FLAGS).flatMap(([name, spec]) => (spec.aliases ?? []).map((a) => [a, name]))
);

/**
 * Parse argv into { command, globals, flags, positionals }.
 * Throws a usage CliError (exit 2) on anything it does not recognise.
 */
export function parseArgv(argv) {
  let command = null;
  const globals = {};
  const flags = {};
  const positionals = [];
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (endOfFlags) { positionals.push(tok); continue; }
    if (tok === "--") { endOfFlags = true; continue; }

    if (tok.startsWith("-") && tok.length > 1) {
      const eq = tok.indexOf("=");
      let name = eq > -1 ? tok.slice(0, eq) : tok;
      const inline = eq > -1 ? tok.slice(eq + 1) : undefined;
      name = GLOBAL_ALIASES[name] ?? name;

      // A command's own flag wins over a global of the same name (`add --key`).
      const cmdSpec = command ? COMMANDS[command].flags[name] : undefined;
      const spec = cmdSpec ?? GLOBAL_FLAGS[name];
      if (!spec) throw unknownFlag(name, command);
      const target = cmdSpec ? flags : globals;

      let value;
      if (spec.type === "bool") {
        if (inline !== undefined) throw usage(`${name} takes no value`, "unexpected_value", { flag: name });
        value = true;
      } else {
        if (inline !== undefined) value = inline;
        else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
        else throw usage(`${name} needs a value${spec.value ? ` (${spec.value})` : ""}`, "missing_value", { flag: name });
        value = coerce(name, spec, value);
      }

      if (spec.multiple) {
        (target[name] ??= []).push(value);
      } else {
        if (name in target) throw usage(`${name} given more than once`, "duplicate_flag", { flag: name });
        target[name] = value;
      }
      continue;
    }

    if (command === null) {
      if (!(tok in COMMANDS)) {
        throw usage(`unknown command: ${tok}. Run \`valorbrain help\` for the list.`, "unknown_command", { command: tok });
      }
      command = tok;
      continue;
    }
    positionals.push(tok);
  }

  // Flags seen before the command were checked against the globals only; a
  // command flag given there (e.g. `--collection x add …`) is unknown above.
  if (command) {
    const kind = COMMANDS[command].positionals;
    if (kind === "none" && positionals.length) {
      throw usage(`${command} takes no arguments; got "${positionals[0]}"`, "unexpected_argument", { argument: positionals[0] });
    }
    if (kind === "one" && positionals.length > 1) {
      throw usage(`${command} takes one argument; got ${positionals.length}`, "unexpected_argument", { argument: positionals[1] });
    }
  }
  if (globals["--agent"] && command !== "init") {
    throw usage("--agent only selects agent mode on `init`; for machine-readable output use --json", "unknown_flag", { flag: "--agent" });
  }
  return { command, globals, flags, positionals };
}

function coerce(name, spec, raw) {
  if (spec.type === "int") {
    if (!/^-?\d+$/.test(raw)) throw usage(`${name} must be an integer; got "${raw}"`, "invalid_value", { flag: name });
    const n = Number(raw);
    if ((spec.min != null && n < spec.min) || (spec.max != null && n > spec.max)) {
      throw usage(`${name} must be between ${spec.min} and ${spec.max}; got ${n}`, "invalid_value", { flag: name });
    }
    return n;
  }
  if (spec.type === "enum") {
    const v = raw.toLowerCase();
    if (!spec.values.includes(v)) {
      throw usage(`${name} must be one of: ${spec.values.join(", ")}; got "${raw}"`, "invalid_value", { flag: name, allowed: spec.values });
    }
    return v;
  }
  return raw;
}

function unknownFlag(name, command) {
  const where = command ? ` for \`${command}\`` : "";
  const known = command ? Object.keys(COMMANDS[command].flags) : [];
  const hint = known.length ? ` Known: ${known.join(", ")}.` : "";
  return usage(`unknown flag ${name}${where}.${hint} Text that starts with a dash goes after \`--\`.`, "unknown_flag", { flag: name });
}

/** `help --json` — generated from the same specs the parser enforces. */
export function describeSurface() {
  const flagList = (flags) => Object.entries(flags).map(([flag, s]) => ({
    flag,
    type: s.type,
    ...(s.values ? { values: s.values } : {}),
    ...(s.min != null ? { min: s.min, max: s.max } : {}),
    ...(s.multiple ? { multiple: true } : {}),
    ...(s.aliases ? { aliases: s.aliases } : {}),
    description: s.description,
  }));
  return {
    global_flags: flagList(GLOBAL_FLAGS),
    commands: Object.entries(COMMANDS).map(([name, c]) => ({
      name,
      usage: c.usage,
      description: c.description,
      positionals: c.positionals,
      flags: flagList(c.flags),
    })),
  };
}
