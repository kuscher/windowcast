// Mutual proof of the pairing key, bound to the DTLS fingerprints of the control connection.
// A broker that swaps certificates makes each side see different fingerprints, so both proofs fail.
import { fromBase64Url, randomBytes, toBase64Url } from './ids.js';

const PROOF = /^[A-Za-z0-9_-]{43}$/;

export function extractFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;
  const m = sdp.match(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/m);
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : null;
}

export function newNonce() {
  return toBase64Url(randomBytes(16));
}

/**
 * HMAC-SHA256(key, "wc1|<role>|hostNonce|viewerNonce|hostFingerprint|viewerFingerprint"), base64url.
 * role is "viewer" or "host", so one side's proof can never be replayed as the other's.
 */
export async function computeProof(key, role, { hostNonce, viewerNonce, hostFingerprint, viewerFingerprint }) {
  const hmacKey = await crypto.subtle.importKey('raw', fromBase64Url(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = ['wc1', role, hostNonce, viewerNonce, hostFingerprint, viewerFingerprint].join('|');
  const mac = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(mac));
}

export async function verifyProof(key, role, params, proof) {
  if (typeof proof !== 'string' || !PROOF.test(proof)) return false;
  try {
    const expected = fromBase64Url(await computeProof(key, role, params));
    const given = fromBase64Url(proof);
    if (expected.length !== given.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
    return diff === 0;
  } catch {
    return false;
  }
}
