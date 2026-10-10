import test from "node:test";
import assert from "node:assert/strict";
import { resolveMcpToken, isMcpToken, fingerprint } from "../lib/config.js";

const VBM = "vbm_" + "x".repeat(65);
const AGENT = "vb_agent_" + "a".repeat(32);

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const clean = { VALORBRAIN_TOKEN: undefined, VALORBRAIN_MCP_TOKEN: undefined };

test("resolveMcpToken: the flag wins over everything", () => {
  withEnv({ ...clean, VALORBRAIN_MCP_TOKEN: "vbm_env" }, () => {
    assert.equal(resolveMcpToken({ tokenFlag: "vbm_flag", cfg: { mcp_token: "vbm_cfg" } }), "vbm_flag");
  });
});

test("resolveMcpToken: VALORBRAIN_MCP_TOKEN beats the saved config", () => {
  withEnv({ ...clean, VALORBRAIN_MCP_TOKEN: "vbm_env" }, () => {
    assert.equal(resolveMcpToken({ cfg: { mcp_token: "vbm_cfg" } }), "vbm_env");
  });
});

test("resolveMcpToken: VALORBRAIN_TOKEN counts only when it holds a vbm_ token", () => {
  withEnv({ ...clean, VALORBRAIN_TOKEN: VBM }, () => {
    assert.equal(resolveMcpToken({ cfg: { mcp_token: "vbm_cfg" } }), VBM);
  });
  withEnv({ ...clean, VALORBRAIN_TOKEN: AGENT }, () => {
    assert.equal(resolveMcpToken({ cfg: { mcp_token: "vbm_cfg" } }), "vbm_cfg");
  });
});

test("resolveMcpToken: never falls back to the REST key", () => {
  withEnv({ ...clean, VALORBRAIN_TOKEN: AGENT }, () => {
    assert.equal(resolveMcpToken({ cfg: { api_key: AGENT } }), null);
    assert.equal(resolveMcpToken({ cfg: null }), null);
  });
});

test("isMcpToken recognises the vbm_ prefix only", () => {
  assert.equal(isMcpToken(VBM), true);
  assert.equal(isMcpToken(AGENT), false);
  assert.equal(isMcpToken(""), false);
  assert.equal(isMcpToken(undefined), false);
});

test("fingerprint keeps 12 + 4 characters and nothing else", () => {
  assert.equal(fingerprint(AGENT), `${AGENT.slice(0, 12)}…${AGENT.slice(-4)}`);
  assert.equal(fingerprint(null), null);
});
