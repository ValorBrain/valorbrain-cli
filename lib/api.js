/**
 * API client — zero-dependency fetch wrappers over the ValorBrain REST API.
 *
 * All endpoints take Bearer auth; the vb_agent_ key from `init --agent`
 * resolves the shadow tenant server-side, so no tenant header is needed.
 */

export class ApiError extends Error {
  constructor(status, body) {
    const detail = typeof body === "object" && body !== null
      ? (body.error || body.message || JSON.stringify(body))
      : String(body);
    super(`HTTP ${status}: ${detail}`);
    this.status = status;
    this.body = body;
  }
}

async function request(baseUrl, path, { method = "GET", key, body } = {}) {
  const headers = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* non-JSON body — keep as text */ }

  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

export const api = {
  health: (baseUrl) => request(baseUrl, "/health"),

  agentSignup: (baseUrl, { agent_name, agent_caller }) =>
    request(baseUrl, "/api/v1/agents/signup", { method: "POST", body: { agent_name, agent_caller } }),

  agentIdentify: (baseUrl, key, agent_caller) =>
    request(baseUrl, "/api/v1/agents/identify", { method: "POST", key, body: { agent_caller } }),

  agentClaim: (baseUrl, key, email) =>
    request(baseUrl, "/api/v1/agents/claim", { method: "POST", key, body: { email } }),

  agentClaimVerify: (baseUrl, key, email, otp) =>
    request(baseUrl, "/api/v1/agents/claim/verify", { method: "POST", key, body: { email, otp } }),

  addDocument: (baseUrl, key, doc) =>
    request(baseUrl, "/documents", { method: "POST", key, body: doc }),

  search: (baseUrl, key, query, opts = {}) =>
    request(baseUrl, "/search", { method: "POST", key, body: { query, compact: true, ...opts } }),

  collections: (baseUrl, key) =>
    request(baseUrl, "/collections", { key }),
};
