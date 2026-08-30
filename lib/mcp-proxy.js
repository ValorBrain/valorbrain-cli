/**
 * `mcp` — stdio ⇄ streamable-HTTP proxy for the ValorBrain MCP endpoint.
 *
 * Lets MCP clients that only speak stdio (most of them) reach the hosted
 * server at mcpbrain.valor.digital/mcp without local setup:
 *
 *   valorbrain mcp --token vbm_…       # or VALORBRAIN_TOKEN in the env
 *
 * Protocol notes (streamable HTTP):
 *   - every stdin line is a JSON-RPC message → one POST
 *   - responses may come as application/json or text/event-stream; both are
 *     unwrapped back into newline-delimited JSON-RPC on stdout
 *   - the server may hand out `mcp-session-id` on initialize; it is echoed
 *     on every subsequent request
 *   - notifications (no `id`) are POSTed and produce no stdout output
 */
import { resolveMcpUrl, resolveApiKey, loadConfig } from "./config.js";

export async function runMcpProxy(args) {
  const flags = parseFlags(args);
  const cfg = loadConfig();
  const url = resolveMcpUrl({ urlFlag: flags["--url"], cfg });
  const token =
    flags["--token"] ||
    (flags["--token-file"] ? (await import("node:fs")).readFileSync(flags["--token-file"], "utf8").trim() : null) ||
    resolveApiKey({ cfg });

  if (!token) {
    process.stderr.write("valorbrain mcp: no token. Pass --token, set VALORBRAIN_TOKEN, or run `valorbrain init` first.\n");
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

  function writeOut(data) {
    try {
      JSON.parse(data); // only forward valid JSON-RPC
      process.stdout.write(data + "\n");
    } catch { /* ignore */ }
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
