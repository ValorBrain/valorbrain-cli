#!/usr/bin/env node
/**
 * valorbrain-connect — bridge a stdio MCP client to the hosted ValorBrain MCP
 * server. Same thing as `valorbrain mcp`, under the name the docs printed.
 *
 *   valorbrain-connect --token vbm_…
 */
import { runMcpProxy } from "../index.js";

runMcpProxy(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`valorbrain-connect: ${e.message}\n`);
  process.exit(1);
});
