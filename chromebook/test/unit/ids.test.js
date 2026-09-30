import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHostId, generateKey, isValidHostId, isValidKey, pairingLink, parsePairingFragment } from '../../shared/ids.js';

test('host ids are wc- plus 26 base32 characters and differ between calls', () => {
  const a = generateHostId();
  const b = generateHostId();
  assert.match(a, /^wc-[a-z2-7]{26}$/);
  assert.notEqual(a, b);
  assert.ok(isValidHostId(a));
});

test('host id validation rejects other shapes', () => {
  assert.equal(isValidHostId('wc-abc'), false);
  assert.equal(isValidHostId('WC-' + 'a'.repeat(26)), false);
  assert.equal(isValidHostId('wc-' + '1'.repeat(26)), false);  // 1 is not base32
  assert.equal(isValidHostId(undefined), false);
});

test('keys are 32 random bytes in base64url', () => {
  const k = generateKey();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(k, 'base64url').length, 32);
  assert.ok(isValidKey(k));
  assert.notEqual(k, generateKey());
});

test('a pairing link round-trips through its fragment', () => {
  const id = generateHostId();
  const key = generateKey();
  const link = pairingLink('https://windowcast-viewer.vercel.app/', id, key);
  assert.equal(link, `https://windowcast-viewer.vercel.app/#h=${id}&k=${key}`);
  assert.deepEqual(parsePairingFragment(new URL(link).hash), { hostId: id, key });
});

test('fragment parsing rejects missing or malformed values', () => {
  const id = generateHostId();
  const key = generateKey();
  assert.equal(parsePairingFragment(''), null);
  assert.equal(parsePairingFragment(`#h=${id}`), null);
  assert.equal(parsePairingFragment(`#h=nope&k=${key}`), null);
  assert.equal(parsePairingFragment(`#h=${id}&k=short`), null);
  assert.deepEqual(parsePairingFragment(`h=${id}&x=1&k=${key}`), { hostId: id, key });
});
