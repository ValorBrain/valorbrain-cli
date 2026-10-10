import test from "node:test";
import assert from "node:assert/strict";
import { resolveMcpToken, isMcpToken, fingerprint, findApiKey, requireApiKey, resolveBaseUrl } from "../lib/config.js";

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

const cleanAll = { ...clean, VALORBRAIN_API_KEY: undefined, VALORBRAIN_API_TOKEN: undefined, VALORBRAIN_API_URL: undefined, VALORBRAIN_URL: undefined };

test("findApiKey: flag > VALORBRAIN_API_KEY > legacy VALORBRAIN_TOKEN > VALORBRAIN_API_TOKEN > config", () => {
  const cfg = { api_key: "vb_agent_cfg" };
  withEnv({ ...cleanAll, VALORBRAIN_API_KEY: "vb_agent_env", VALORBRAIN_TOKEN: "vb_agent_legacy" }, () => {
    assert.deepEqual(findApiKey({ keyFlag: "vb_agent_flag", cfg }), { key: "vb_agent_flag", source: "flag" });
    assert.deepEqual(findApiKey({ cfg }), { key: "vb_agent_env", source: "VALORBRAIN_API_KEY" });
  });
  withEnv({ ...cleanAll, VALORBRAIN_TOKEN: "vb_agent_legacy", VALORBRAIN_API_TOKEN: "vb_agent_api_token" }, () => {
    assert.equal(findApiKey({ cfg }).source, "VALORBRAIN_TOKEN");
  });
  withEnv({ ...cleanAll, VALORBRAIN_TOKEN: VBM, VALORBRAIN_API_TOKEN: "vb_agent_api_token" }, () => {
    assert.equal(findApiKey({ cfg }).source, "VALORBRAIN_API_TOKEN", "a vbm_ VALORBRAIN_TOKEN is the MCP token, not the REST key");
  });
  withEnv(cleanAll, () => {
    assert.deepEqual(findApiKey({ cfg }), { key: "vb_agent_cfg", source: "config" });
    assert.equal(findApiKey({ cfg: null }), null);
  });
});

test("requireApiKey refuses a vbm_ token for REST and explains where it goes", () => {
  withEnv({ ...cleanAll, VALORBRAIN_API_KEY: VBM }, () => {
    assert.throws(() => requireApiKey({ cfg: null }), (e) => e.code === "wrong_credential_type" && e.exit === 3 && /VALORBRAIN_MCP_TOKEN/.test(e.message));
  });
  withEnv(cleanAll, () => {
    assert.throws(() => requireApiKey({ cfg: null }), (e) => e.code === "no_credential" && e.exit === 3);
  });
});

test("resolveBaseUrl: VALORBRAIN_API_URL, legacy VALORBRAIN_URL, flag wins", () => {
  withEnv({ ...cleanAll, VALORBRAIN_API_URL: "https://a.test/", VALORBRAIN_URL: "https://legacy.test" }, () => {
    assert.equal(resolveBaseUrl({}), "https://a.test");
    assert.equal(resolveBaseUrl({ urlFlag: "https://flag.test" }), "https://flag.test");
  });
  withEnv({ ...cleanAll, VALORBRAIN_URL: "https://legacy.test" }, () => {
    assert.equal(resolveBaseUrl({}), "https://legacy.test");
  });
  withEnv(cleanAll, () => {
    assert.equal(resolveBaseUrl({ cfg: { engine_url: "https://cfg.test" } }), "https://cfg.test");
    assert.equal(resolveBaseUrl({}), "https://valorbrain-api.valor.digital");
  });
});
