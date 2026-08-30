/**
 * @valorbrain/connect — programmatic alias for `valorbrain mcp`.
 *
 * The name is printed in already-published documentation as the recommended
 * way to connect, so it must keep working. It reexports the MCP proxy from
 * @valorbrain/cli instead of forking it.
 */
export { runMcpProxy } from "@valorbrain/cli/lib/mcp-proxy.js";
export { resolveMcpUrl } from "@valorbrain/cli/lib/config.js";
