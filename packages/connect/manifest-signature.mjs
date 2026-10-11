/**
 * manifest-signature.mjs — verify the ed25519 signature of a /setup/artifacts
 * manifest before any file is written from it (PRD "rumo a 10", decision 17).
 * Built-ins only.
 *
 * The engine signs "valorbrain-manifest-v1\n" + issued_at + "\n" + <exact body>
 * (src/harness/manifest-signing.ts) and sends three headers:
 *   X-ValorBrain-Manifest-Key-Id     sha256(raw public key), first 16 hex chars
 *   X-ValorBrain-Manifest-Issued-At  ISO-8601
 *   X-ValorBrain-Manifest-Signature  base64
 * Only the keys below (and, for a self-hosted engine, the ones in
 * VALORBRAIN_MANIFEST_PUBLIC_KEYS) are trusted. Nothing is fetched to decide
 * trust: a key served by the same host that serves the manifest proves nothing.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Production signing keys: kid → raw 32-byte ed25519 public key, base64.
 * The ACTIVE key's private half lives only on the engine host
 * (VALORBRAIN_MANIFEST_SIGNING_KEY_FILE); its public half is also served at
 * GET /setup/manifest-keys and quoted in the docs. The RESERVE key's private
 * half is kept offline by the owner: if the active key is lost or leaks, the
 * engine switches to the reserve and every client already trusting it keeps
 * self-healing — the next release then drops the old key and adds a new
 * reserve. `npm publish` refuses fewer than two keys (prepublishOnly): a
 * release with one key cannot rotate without stranding installed clients.
 */
export const MANIFEST_PUBLIC_KEYS = Object.freeze({
    // Active engine key, generated on 11/10/2026 (/etc/valorbrain/manifest-signing.key on the engine host).
    '7a0a5e59c978f3f0': '4rKgPFpEgSudUlG1OT079j4mjmnJRxun7kCRvc6/c6Q=',
    // Reserve key, generated on 11/10/2026; private half kept offline by the owner, never on a server.
    '740a7527ff9447c2': 'kRXTTSwGPyBSYc0FugoKyRAE/QaNagJYp16akbY6sXo=',
});

export const MANIFEST_SIGNATURE_DOMAIN = 'valorbrain-manifest-v1';
const KEY_ID_HEADER = 'x-valorbrain-manifest-key-id';
const ISSUED_AT_HEADER = 'x-valorbrain-manifest-issued-at';
const SIGNATURE_HEADER = 'x-valorbrain-manifest-signature';

/** A signature older than this is a replay, not today's manifest (the engine signs every response). */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Clock skew tolerated for a signature "from the future". */
const MAX_FUTURE_MS = 24 * 3600 * 1000;

/** ed25519 SubjectPublicKeyInfo prefix; the raw key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function manifestKeyId(rawPublicKey) {
    return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

/**
 * Keys this run trusts: the compiled-in set plus, for a self-hosted engine,
 * VALORBRAIN_MANIFEST_PUBLIC_KEYS (comma-separated base64 raw keys, as
 * GET /setup/manifest-keys prints them). Malformed entries are ignored.
 */
export function trustedManifestKeys(env = {}) {
    const keys = { ...MANIFEST_PUBLIC_KEYS };
    for (const item of String(env.VALORBRAIN_MANIFEST_PUBLIC_KEYS || '').split(',')) {
        const raw = Buffer.from(item.trim(), 'base64');
        if (raw.length === 32) keys[manifestKeyId(raw)] = raw.toString('base64');
    }
    return keys;
}

/**
 * `{ manifest }` when the body is signed by a trusted key, fresh, and for the
 * harness asked for; `{ error }` otherwise. `headers` is a fetch Headers (or
 * anything with a case-insensitive `get`).
 */
export function verifyManifest({ body, headers, harness, keys, now = Date.now() }) {
    const kid = headers.get(KEY_ID_HEADER);
    const issuedAt = headers.get(ISSUED_AT_HEADER);
    const signature = headers.get(SIGNATURE_HEADER);
    if (!kid || !issuedAt || !signature) {
        return { error: 'the manifest is not signed — refusing to write files from it (an engine without a signing key; self-hosted: see VALORBRAIN_MANIFEST_SIGNING_KEY_FILE)' };
    }
    const key = keys[kid];
    if (!key) return { error: `the manifest is signed by a key this connect does not trust (${kid}) — refusing it` };
    const at = Date.parse(issuedAt);
    if (!Number.isFinite(at)) return { error: 'the manifest signature has no valid date — refusing it' };
    if (at - now > MAX_FUTURE_MS || now - at > MAX_AGE_MS) {
        return { error: `the manifest was signed at ${issuedAt}, too far from this computer's clock — refusing it (check the clock)` };
    }
    let valid = false;
    try {
        const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key, 'base64')]), format: 'der', type: 'spki' });
        valid = verify(null, Buffer.from(`${MANIFEST_SIGNATURE_DOMAIN}\n${issuedAt}\n${body}`, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
    } catch {
        valid = false;
    }
    if (!valid) return { error: 'the manifest signature does not match its content — refusing to write files from it' };
    let manifest;
    try {
        manifest = JSON.parse(body);
    } catch {
        return { error: 'the signed manifest is not JSON' };
    }
    if (harness && manifest?.harness !== harness) {
        return { error: `the signed manifest is for "${manifest?.harness}", not "${harness}" — refusing it` };
    }
    return { manifest };
}
