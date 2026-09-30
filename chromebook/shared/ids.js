// Host ids, keys and pairing links. Pure functions over Web Crypto, shared by extension, viewer and tests.

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const HOST_ID = /^wc-[a-z2-7]{26}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export function randomBytes(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** `wc-` plus 26 base32 characters (130 random bits); valid as a PeerJS id. */
export function generateHostId() {
  let id = 'wc-';
  for (const b of randomBytes(26)) id += BASE32[b & 31];
  return id;
}

/** 32 random bytes, base64url without padding. */
export function generateKey() {
  return toBase64Url(randomBytes(32));
}

export function isValidHostId(id) {
  return typeof id === 'string' && HOST_ID.test(id);
}

export function isValidKey(key) {
  return typeof key === 'string' && KEY.test(key);
}

/** The secret travels in the fragment, which browsers never send to servers. */
export function pairingLink(baseUrl, hostId, key) {
  return `${baseUrl}#h=${hostId}&k=${key}`;
}

export function parsePairingFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const hostId = params.get('h');
  const key = params.get('k');
  return isValidHostId(hostId) && isValidKey(key) ? { hostId, key } : null;
}
