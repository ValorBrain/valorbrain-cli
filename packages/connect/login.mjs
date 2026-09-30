/**
 * Browser login for @valorbrain/connect: no token to copy by hand.
 *
 * RFC 8628 device flow served by the ValorBrain app. The CLI asks the app for
 * a code naming the harnesses it found, opens the approval page
 * (/cli/link?code=…) and polls until the person approves this computer there.
 * The approval creates one MCP token per harness (attributed to that harness,
 * revocable on its own in Settings → MCP Tokens) and the app hands them over
 * exactly once. A person without an account creates it on the way: the
 * approval page sends them through sign-up and back.
 *
 * Node built-ins only; everything that touches the network or spawns a
 * process can be injected, so the tests run offline.
 */

import { spawn } from "node:child_process";
import { hostname, platform as osPlatform } from "node:os";

export const DEFAULT_APP = "https://valorbrain.valor.digital";

const OS_NAMES = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function resolveAppUrl({ flag = null, env = process.env } = {}) {
  const norm = (u) => String(u).trim().replace(/\/+$/, "");
  if (flag) return norm(flag);
  if (env.VALORBRAIN_APP_URL) return norm(env.VALORBRAIN_APP_URL);
  return DEFAULT_APP;
}

function safeHostname() {
  try {
    return hostname() || "computer";
  } catch {
    return "computer";
  }
}

/** "DESKTOP-7 (Windows)" — how this computer shows on the approval page and in token names. */
export function deviceLabel({ host = safeHostname(), platform = osPlatform() } = {}) {
  return `${host} (${OS_NAMES[platform] ?? platform})`.slice(0, 80);
}

/**
 * How to open a URL in the default browser here, or null when there is no
 * browser to open (CI, SSH without a display, opted out).
 */
export function browserCommand(url, { platform = osPlatform(), env = process.env } = {}) {
  if (env.VALORBRAIN_NO_BROWSER === "1" || env.CI) return null;
  if (platform === "win32") return { cmd: "explorer.exe", args: [url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // WSL: the browser lives on the Windows side.
  if (env.WSL_DISTRO_NAME) return { cmd: "explorer.exe", args: [url] };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { cmd: "xdg-open", args: [url] };
}

/** Best effort: a browser that does not open is not an error, the URL is on screen. */
export function openBrowser(url, opts = {}) {
  const command = browserCommand(url, opts);
  if (!command) return false;
  try {
    const child = spawn(command.cmd, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

class LoginError extends Error {}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Runs the whole login. Resolves with the tokens the app handed over:
 * `{ tokens: { <harness>: vbm_… } | null, accessToken, apiUrl, tenantId }`.
 * Rejects with a message meant for the person (denied, expired, app down).
 */
export async function deviceLogin({
  app,
  harnesses,
  label = deviceLabel(),
  browser = true,
  fetchImpl = fetch,
  sleep = sleepFor,
  now = Date.now,
  log = (line) => console.log(line),
  open = openBrowser,
  style = { bold: "", dim: "", off: "" },
}) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  let res;
  try {
    res = await fetchImpl(`${app}/api/v1/cli/device/code`, {
      method: "POST",
      headers,
      body: JSON.stringify({ client: "connect", harnesses, device_label: label }),
    });
  } catch (err) {
    throw new LoginError(`Could not reach ${app} (${err?.message ?? err}). Check your connection and try again.`);
  }
  const code = await readJson(res);
  if (!res.ok || !code.device_code || !code.user_code) {
    throw new LoginError(
      code.error_description || code.error
        ? `The app refused the login: ${code.error_description || code.error}`
        : `The app refused the login (HTTP ${res.status}).`,
    );
  }

  const url = code.verification_uri_complete || `${code.verification_uri}?code=${encodeURIComponent(code.user_code)}`;
  log("");
  log(`${style.bold}Approve this computer in your browser${style.off}`);
  log(`  ${url}`);
  log(`  code ${style.bold}${code.user_code}${style.off} ${style.dim}(check it matches the page)${style.off}`);
  const opened = browser ? open(url) : false;
  log(`${style.dim}${opened ? "Opened your browser. " : "Open the link above. "}No account yet? You create it there. Waiting…${style.off}`);

  const deadline = now() + Math.max(60, Number(code.expires_in) || 900) * 1000;
  let interval = Math.max(1, Number(code.interval) || 3) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    let poll;
    try {
      poll = await fetchImpl(`${app}/api/v1/cli/device/token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ device_code: code.device_code }),
      });
    } catch {
      continue; // network blip: the code is still valid, keep waiting
    }
    const body = await readJson(poll);
    if (poll.ok && body.access_token) {
      const tokens = body.tokens && typeof body.tokens === "object" ? body.tokens : null;
      return {
        tokens,
        accessToken: body.access_token,
        apiUrl: typeof body.valorbrain_url === "string" ? body.valorbrain_url : null,
        tenantId: body.tenant_id ?? null,
      };
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (body.error === "access_denied") throw new LoginError("The request was denied in the browser. Nothing was changed.");
    if (body.error === "expired_token") throw new LoginError("The code expired before it was approved. Run the command again.");
    throw new LoginError(`Unexpected answer from the app (HTTP ${poll.status}${body.error ? `: ${body.error}` : ""}).`);
  }
  throw new LoginError("The code expired before it was approved. Run the command again.");
}
