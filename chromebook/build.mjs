// Assembles dist/extension (load unpacked on the Chromebook) and dist/viewer (published to GitHub Pages).
// Each gets its own copy of shared/ and the vendored PeerJS bundle; nothing is transpiled.
import { cp, rm, mkdir } from 'node:fs/promises';

const here = new URL('.', import.meta.url);
const dist = new URL('dist/', here);

await rm(dist, { recursive: true, force: true });
for (const target of ['extension', 'viewer']) {
  const out = new URL(`${target}/`, dist);
  await cp(new URL(`${target}/`, here), out, { recursive: true });
  await cp(new URL('shared/', here), new URL('shared/', out), { recursive: true });
  await mkdir(new URL('lib/', out), { recursive: true });
  await cp(new URL('vendor/peerjs.min.js', here), new URL('lib/peerjs.min.js', out));
  await cp(new URL('vendor/PEERJS-LICENSE', here), new URL('lib/PEERJS-LICENSE', out));
}
console.log('built dist/extension and dist/viewer');
