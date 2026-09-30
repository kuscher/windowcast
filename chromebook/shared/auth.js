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

export function normalizeFingerprint(algorithm, value) {
  return typeof algorithm === 'string' && typeof value === 'string' && algorithm && value
    ? `${algorithm.toLowerCase()} ${value.toUpperCase()}`
    : null;
}

/**
 * Fingerprints of the certificates the connected DTLS transport actually uses, from getStats().
 * Returns {local, remote}, or null unless there is exactly one connected transport with both certificates.
 */
export function fingerprintsFromStats(report) {
  const transports = [];
  report.forEach((r) => { if (r.type === 'transport' && r.dtlsState === 'connected') transports.push(r); });
  if (transports.length !== 1) return null;
  const cert = (id) => (id ? report.get(id) : undefined);
  const local = cert(transports[0].localCertificateId);
  const remote = cert(transports[0].remoteCertificateId);
  const l = local && normalizeFingerprint(local.fingerprintAlgorithm, local.fingerprint);
  const r = remote && normalizeFingerprint(remote.fingerprintAlgorithm, remote.fingerprint);
  return l && r ? { local: l, remote: r } : null;
}

/** The connection's fingerprints from its transport; null if missing or if the SDP says otherwise. */
export async function channelFingerprints(pc) {
  const fromStats = fingerprintsFromStats(await pc.getStats());
  if (!fromStats) return null;
  const sdpLocal = extractFingerprint(pc.localDescription && pc.localDescription.sdp);
  const sdpRemote = extractFingerprint(pc.remoteDescription && pc.remoteDescription.sdp);
  if ((sdpLocal && sdpLocal !== fromStats.local) || (sdpRemote && sdpRemote !== fromStats.remote)) return null;
  return fromStats;
}
