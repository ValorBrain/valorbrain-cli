// Test signing key for stub engines (decision 17). The spawned CLI trusts it
// through VALORBRAIN_MANIFEST_PUBLIC_KEYS — the same door a self-hosted engine
// uses; the production key is never involved.
import { generateKeyPairSync, sign } from 'node:crypto';
import { MANIFEST_SIGNATURE_DOMAIN, manifestKeyId } from '../manifest-signature.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

export const TEST_MANIFEST_PUBLIC_KEY = raw.toString('base64');
export const TEST_MANIFEST_KID = manifestKeyId(raw);
export const SIGNED_ENV = { VALORBRAIN_MANIFEST_PUBLIC_KEYS: TEST_MANIFEST_PUBLIC_KEY };

/** Response headers the engine sends with a signed manifest body (src/harness/manifest-signing.ts). */
export function signedManifestHeaders(body, issuedAt = new Date().toISOString()) {
    return {
        'x-valorbrain-manifest-key-id': TEST_MANIFEST_KID,
        'x-valorbrain-manifest-issued-at': issuedAt,
        'x-valorbrain-manifest-signature': sign(null, Buffer.from(`${MANIFEST_SIGNATURE_DOMAIN}\n${issuedAt}\n${body}`, 'utf8'), privateKey).toString('base64'),
    };
}
