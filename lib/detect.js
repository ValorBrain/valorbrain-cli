/**
 * Agent platform detection — advisory only.
 *
 * Copied deliberately from mem0's design: the environment sniff NEVER decides
 * identity. `--agent-caller` is the only source of truth for the metric
 * "which agent brings usage" — inferring it from env vars would make that
 * number a guess. Detection exists only to suggest a value when the caller
 * omits the flag.
 */
const DETECT_ENV = [
  ["claude-code", ["CLAUDECODE", "CLAUDE_CODE"]],
  ["cursor", ["CURSOR_AGENT"]],
  ["codex", ["CODEX_SANDBOX", "OPENAI_CODEX"]],
  ["cline", ["CLINE"]],
  ["continue", ["CONTINUE_SESSION_ID"]],
  ["aider", ["AIDER_MODEL"]],
  ["goose", ["GOOSE_PROVIDER"]],
  ["windsurf", ["WINDSURF_AGENT"]],
  ["kiro", ["KIRO"]],
  ["opencode", ["OPENCODE"]],
  ["hermes", ["HERMES_PROFILE", "HERMES_SESSION"]],
  ["zcode", ["ZCODE_SESSION_ID", "ZCODE"]],
];

export function detectPlatform() {
  for (const [id, vars] of DETECT_ENV) {
    for (const v of vars) {
      if (process.env[v]) return { id, env: v };
    }
  }
  return null;
}
