import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFingerprint, computeProof, verifyProof, newNonce } from '../../shared/auth.js';
import { generateKey } from '../../shared/ids.js';

const SDP = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 ab:cd:EF:01',
  'a=setup:actpass', '',
].join('\r\n');

test('extracts and normalizes the sha-256 fingerprint', () => {
  assert.equal(extractFingerprint(SDP), 'sha-256 AB:CD:EF:01');
});

test('returns null when the SDP has no fingerprint', () => {
  assert.equal(extractFingerprint('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'), null);
  assert.equal(extractFingerprint(undefined), null);
});

const params = {
  hostNonce: 'hn', viewerNonce: 'vn',
  hostFingerprint: 'sha-256 AA:BB', viewerFingerprint: 'sha-256 CC:DD',
};

test('a proof verifies with the same key, role and parameters', async () => {
  const key = generateKey();
  const proof = await computeProof(key, 'viewer', params);
  assert.equal(await verifyProof(key, 'viewer', params, proof), true);
});

test('a proof fails with another key', async () => {
  const proof = await computeProof(generateKey(), 'viewer', params);
  assert.equal(await verifyProof(generateKey(), 'viewer', params, proof), false);
});

test('a proof fails when either fingerprint differs, which is what a tampered handshake looks like', async () => {
  const key = generateKey();
  const proof = await computeProof(key, 'viewer', params);
  assert.equal(await verifyProof(key, 'viewer', { ...params, hostFingerprint: 'sha-256 EE:FF' }, proof), false);
  assert.equal(await verifyProof(key, 'viewer', { ...params, viewerFingerprint: 'sha-256 EE:FF' }, proof), false);
});

test("a viewer proof is not accepted as the host's proof", async () => {
  const key = generateKey();
  const proof = await computeProof(key, 'viewer', params);
  assert.equal(await verifyProof(key, 'host', params, proof), false);
});

test('malformed proofs are rejected without throwing', async () => {
  const key = generateKey();
  assert.equal(await verifyProof(key, 'viewer', params, 'not base64 !!'), false);
  assert.equal(await verifyProof(key, 'viewer', params, undefined), false);
});

test('nonces are 16 random bytes in base64url', () => {
  const n = newNonce();
  assert.equal(Buffer.from(n, 'base64url').length, 16);
  assert.notEqual(n, newNonce());
});
