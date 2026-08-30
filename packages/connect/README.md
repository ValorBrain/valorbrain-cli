# @valorbrain/connect

Alias package for `valorbrain mcp`: bridges stdio MCP clients to the hosted
ValorBrain MCP server. The name is printed in published documentation as the
recommended way to connect, so it exists and keeps working.

## CLI

```bash
valorbrain-connect --token vbm_…
```

## MCP client config

```json
{
  "mcpServers": {
    "valorbrain": {
      "command": "npx",
      "args": ["-y", "@valorbrain/connect", "--token", "vbm_…"]
    }
  }
}
```

## Programmatic

```js
import { runMcpProxy } from "@valorbrain/connect";
await runMcpProxy(["--token", "vbm_…"]);
```

Reexports from [@valorbrain/cli](https://www.npmjs.com/package/@valorbrain/cli).

MIT.
