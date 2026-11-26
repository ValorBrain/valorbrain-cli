import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MCP_URL } from "../lib/config.js";

// server.json is what the official MCP Registry lists
// (registry.modelcontextprotocol.io). These checks keep it in step with the
// package and with the endpoint the CLI really talks to.

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const server = read("../server.json");
const pkg = read("../package.json");

test("server.json: the registry name is the package's mcpName", () => {
  // The registry refuses an npm package whose published package.json does not
  // carry the server name as `mcpName`.
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.ValorBrain\/[a-zA-Z0-9._-]+$/);
});

test("server.json: the description fits the registry's 100 characters", () => {
  assert.ok(server.description.length >= 1 && server.description.length <= 100, `${server.description.length} chars`);
});

test("server.json: the remote is the hosted MCP server the CLI uses", () => {
  assert.ok(Array.isArray(server.remotes) && server.remotes.length >= 1);
  const remote = server.remotes[0];
  assert.equal(remote.type, "streamable-http");
  assert.equal(remote.url, DEFAULT_MCP_URL);
  const auth = remote.headers.find((h) => h.name === "Authorization");
  assert.ok(auth, "Authorization header is described");
  assert.equal(auth.isSecret, true);
});

test("server.json: an npm package entry names this package at this version", () => {
  for (const p of server.packages ?? []) {
    if (p.registryType !== "npm") continue;
    assert.equal(p.identifier, pkg.name);
    assert.equal(p.version, pkg.version);
  }
});

test("server.json: the stdio bridge is listed as the npm package", () => {
  // The registry lists `packages` next to `remotes`: clients that only speak
  // stdio run `npx -y @valorbrain/cli mcp`, which proxies to the same endpoint.
  const npm = (server.packages ?? []).filter((p) => p.registryType === "npm");
  assert.equal(npm.length, 1, "exactly one npm package entry");
  const [p] = npm;
  assert.equal(p.transport?.type, "stdio");
  assert.deepEqual(p.packageArguments, [{ type: "positional", value: "mcp" }]);
  const env = (p.environmentVariables ?? []).find((e) => e.name === "VALORBRAIN_MCP_TOKEN");
  assert.ok(env, "VALORBRAIN_MCP_TOKEN is described");
  assert.equal(env.isSecret, true);
  // Optional: `init --agent` saves mcp_token in the config file instead.
  assert.equal(env.isRequired, false);
});

test("server.json: the registry version follows the CLI version", () => {
  // A version in the registry is immutable; it moves with each npm release.
  assert.equal(server.version, pkg.version);
});
