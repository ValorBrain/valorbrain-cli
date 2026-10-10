/**
 * `mcp` — stdio ⇄ streamable-HTTP proxy for the ValorBrain MCP endpoint.
 *
 * Lets MCP clients that only speak stdio (most of them) reach the hosted
 * server at mcpbrain.valor.digital/mcp without local setup:
 *
 *   valorbrain mcp                     # mcp_token saved by `init --agent`
 *   valorbrain mcp --token vbm_…       # or VALORBRAIN_MCP_TOKEN in the env
 *
 * The MCP host accepts vbm_ tokens only. The REST key (vb_agent_) is never
 * sent here: the server would answer a generic 401 that reads like an
 * expired credential, and the client would hang on the handshake.
 *
 * Protocol notes (streamable HTTP):
 *   - every stdin line is a JSON-RPC message → one POST
 *   - responses may come as application/json or text/event-stream; both are
 *     unwrapped back into newline-delimited JSON-RPC on stdout
 *   - the server may hand out `mcp-session-id` on initialize; it is echoed
 *     on every subsequent request
 *   - notifications (no `id`) are POSTed and produce no stdout output
 *   - a non-2xx answer that is not itself JSON-RPC becomes a JSON-RPC error
 *     carrying the request id, so the client fails fast instead of waiting
 */
import { readFileSync } from "node:fs";
import { resolveMcpUrl, resolveMcpToken, isMcpToken, loadConfig } from "./config.js";

export async function runMcpProxy(args) {
  const flags = parseFlags(args);
  const cfg = loadConfig();
  const url = resolveMcpUrl({ urlFlag: flags["--url"], cfg });
  const token =
    flags["--token"] ||
    (flags["--token-file"] ? readFileSync(flags["--token-file"], "utf8").trim() : null) ||
    resolveMcpToken({ cfg });

  if (!token) {
    process.stderr.write(
      "valorbrain mcp: no MCP token. Pass --token vbm_…, set VALORBRAIN_MCP_TOKEN, " +
      "or run `valorbrain init --agent` (CLI >= 0.1.2 saves the MCP token as mcp_token in ~/.valorbrain/config.json).\n"
    );
    process.exit(1);
  }
  if (!isMcpToken(token)) {
    process.stderr.write(
      `valorbrain mcp: the MCP endpoint only accepts vbm_ tokens; got a credential starting with "${token.slice(0, 9)}". ` +
      "The REST key (vb_agent_) does not work on MCP. Use the mcp_token from `init --agent` (CLI >= 0.1.2), " +
      "set VALORBRAIN_MCP_TOKEN, or pass --token vbm_…\n"
    );
    process.exit(1);
  }

  let sessionId = null;

  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) void forward(line);
    }
  });
  process.stdin.on("end", () => setTimeout(() => process.exit(0), 250));

  async function forward(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON-RPC — nothing to do with it
    }
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;

      const res = await fetch(url, { method: "POST", headers, body: line });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;

      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sse = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sse += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = sse.indexOf("\n\n")) !== -1) {
            const frame = sse.slice(0, sep);
            sse = sse.slice(sep + 2);
            for (const l of frame.split("\n")) {
              if (l.startsWith("data:")) {
                const data = l.slice(5).trim();
                if (data && data !== "[DONE]") writeOut(data);
              }
            }
          }
        }
      } else if (!res.ok) {
        const text = (await res.text()).trim();
        if (isJsonRpc(text)) {
          writeOut(text); // the server already answered in JSON-RPC
        } else {
          replyError(msg, res.status, text);
        }
      } else if (res.status !== 202 && res.status !== 204) {
        const text = await res.text();
        if (text.trim()) writeOut(text.trim());
      }
    } catch (e) {
      // Reply as JSON-RPC error so the client knows the message was lost.
      if (msg.id !== undefined) {
        writeOut(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: `valorbrain mcp proxy: ${e.message}` },
        }));
      }
      process.stderr.write(`valorbrain mcp: ${e.message}\n`);
    }
  }

  /** Turn an HTTP failure into a JSON-RPC error for the request that caused it. */
  function replyError(msg, status, text) {
    let detail = text;
    try {
      const body = JSON.parse(text);
      detail = body.message || body.error || text;
    } catch { /* keep raw text */ }
    const auth = status === 401 || status === 403;
    const message = auth
      ? `valorbrain mcp: ${status} from the MCP host (${detail}). The MCP endpoint only accepts active vbm_ tokens.`
      : `valorbrain mcp: HTTP ${status} from the MCP host (${detail})`;
    process.stderr.write(message + "\n");
    if (msg.id !== undefined) {
      writeOut(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: auth ? -32001 : -32603, message, data: { status, body: text.slice(0, 2000) } },
      }));
    }
  }

  function writeOut(data) {
    try {
      JSON.parse(data); // only forward valid JSON
      process.stdout.write(data + "\n");
    } catch { /* ignore */ }
  }
}

function isJsonRpc(text) {
  try {
    const v = JSON.parse(text);
    return !!v && typeof v === "object" && v.jsonrpc === "2.0" && ("result" in v || "error" in v);
  } catch {
    return false;
  }
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const eq = args[i].indexOf("=");
    if (eq > -1) out[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) out[args[i]] = args[++i];
    else out[args[i]] = true;
  }
  return out;
}
