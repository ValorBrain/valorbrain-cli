import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// publish.yml publishes @valorbrain/cli and @valorbrain/connect by npm trusted
// publishing (OIDC). npm refuses that from a self-hosted runner with E422
// ("Unsupported GitHub Actions runner environment: self-hosted"), which left
// every release to a local `npm publish` behind the account's security key.

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const runsOn = [...workflow.matchAll(/^\s+runs-on:\s*(.+)$/gm)].map((m) => m[1].trim());

test("publish.yml: every job runs on a GitHub-hosted runner", () => {
  assert.ok(runsOn.length >= 1, "publish.yml declares runs-on");
  for (const r of runsOn) {
    assert.doesNotMatch(r, /self-hosted/, `runs-on: ${r}`);
    assert.match(r, /^(ubuntu|macos|windows)-/, `runs-on: ${r}`);
  }
});

test("publish.yml: the job may mint the OIDC token trusted publishing needs", () => {
  assert.match(workflow, /^\s+id-token:\s*write\b/m);
});
