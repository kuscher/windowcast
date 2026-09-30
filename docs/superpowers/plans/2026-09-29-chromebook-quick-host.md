# Windowcast for Chromebook (quick version) implementation plan

> Executed natively in the session right after approval. Code lives in the
> commits; this plan records tasks, interfaces and tests.

**Goal:** the extension and viewer described in
`docs/superpowers/specs/2026-09-29-chromebook-quick-host-design.md`.

**Tech stack:** Manifest V3 extension (plain ES modules), static web app,
PeerJS 1.5.5, WebRTC, Chrome DevTools Protocol through `chrome.debugger`,
node:test, Puppeteer with Chrome for Testing for the end-to-end test.

## Global constraints

- No build tooling beyond `build.mjs` (copies files). No frameworks.
- The key never appears in logs, URLs sent to servers, or error messages.
- Viewer URL: `https://kuscher.github.io/windowcast/`.
- Host id format: `^wc-[a-z2-7]{26}$`; key: 32 random bytes, base64url.

## Review focus

1. A viewer with a wrong key must never receive video or send input
   (unit test for proofs, end-to-end test with a bad link).
2. Clicks in the Chromebook's own toolbar area must be dropped, not sent to
   the page at a shifted position (geometry unit test).
3. A letterboxed frame must still map clicks onto the right spot (geometry
   unit test).
4. Ctrl or Meta shortcuts must not type their letter into the page (keys unit
   test).
5. The viewer must keep retrying while the Chromebook is offline and stop on
   an authentication failure (end-to-end test covers retry after host restart).

## Tasks

1. **Scaffold:** `chromebook/` tree, `package.json` (type module, scripts),
   vendored PeerJS with its license, generated icons, `build.mjs`, ignore
   rules. Test: `npm run build` produces `dist/extension` and `dist/viewer`.
2. **Shared modules, test first:** `ids.js` (generateHostId, generateKey,
   isValidHostId, parsePairingFragment, pairingLink), `auth.js`
   (extractFingerprint, proof, verifyProof), `geometry.js` (videoContentRect,
   normalizePointer, mapToPage), `keys.js` (modifiersOf, toCdpKeyEvents),
   `nav.js` (toUrlOrSearch), `protocol.js` (message type constants, version).
3. **Extension:** manifest, service worker (icon click, startup, install),
   host page (picker, capture, PeerJS host, auth, video connection, input via
   debugger, tabs and navigation, keep-awake, pairing link, diagnostics, test
   pattern mode for automated tests).
4. **Viewer:** installable web app (manifest, service worker), pairing
   storage, PeerJS client, auth, video, pointer and keyboard capture,
   toolbar, full screen with keyboard lock, states and reconnect.
5. **End-to-end test on the Mac:** Chrome for Testing with the unpacked
   extension; host in test-pattern mode sharing a local test page's window;
   viewer page connects through the real broker; checks frames arrive, a click
   and typing land in the test page, the toolbar navigates, a wrong key is
   rejected, and the viewer reconnects after the host page reloads.
6. **Ship:** GitHub Actions workflow (tests, Pages deploy, release zip on
   tags), enable Pages, first release, README with install steps.
