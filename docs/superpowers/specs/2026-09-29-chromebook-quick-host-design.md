# Windowcast for Chromebook (quick version) design

Date: 2026-09-29. Status: approved in chat by Alex ("go ahead let's try this"),
with the default answers: personal Chromebook, remote control with a toolbar,
web viewer, PeerJS public broker.

A small side track next to the Mac host. A Chrome extension on a Chromebook
shares one window and keeps the Chromebook awake; a viewer web app on the
Googlebook (or any Chrome) dials into it at any time, shows the window and
controls it.

## Goals

1. Pick one Chromebook window in ChromeOS's share picker; keep it shared until
   Chrome restarts or the window closes. After a restart the picker opens by
   itself at sign-in.
2. Keep the Chromebook awake while a window is shared.
3. Dial in from the Googlebook whenever wanted: the viewer connects on open,
   reconnects by itself, and works on the home network and away from it.
4. Control the shared window's page: mouse, scrolling, typing. A toolbar gives
   back, forward, reload, an address field and a tab list, because the
   browser's own tab strip cannot receive synthetic input.
5. No accounts and no servers of ours.

Non-goals: several windows at once, audio, clipboard sync, controlling
Android or Linux app windows (they stream view-only), a Web Store listing.

## Architecture

```
Chromebook                                       Googlebook (Chrome, installed web app)
+------------------------------------+           +----------------------------------+
| Extension (Manifest V3)            |           | Viewer (GitHub Pages)            |
|  service worker: icon click,       |           |  PeerJS peer (random id)         |
|    startup, opens the host window  |           |  control connection -> auth      |
|  host window (extension page):     |<--broker->|  own RTCPeerConnection: video    |
|    desktopCapture window stream    |  0.peerjs |  toolbar, pointer and key capture|
|    PeerJS peer with fixed host id  |    .com   |  reconnect with backoff          |
|    auth, own RTCPeerConnection     |           |                                  |
|    chrome.debugger input, tabs API |==video===>|                                  |
|    chrome.power keep-awake         |<==input===|                                  |
+------------------------------------+           +----------------------------------+
```

- **Broker.** PeerJS 1.5.5 with its public server `0.peerjs.com`. The host
  registers a fixed id; the viewer connects to it. The broker only relays the
  handshake of the control connection.
- **Control connection.** A PeerJS data connection (reliable, JSON). It carries
  authentication, then the SDP and ICE of a second, plain RTCPeerConnection
  used for video, then input, toolbar commands and state.
- **Video connection.** Created by the host after authentication; its SDP never
  touches the broker, so it cannot be tampered with. ICE servers: Google STUN
  and PeerJS's public TURN, as in PeerJS's defaults. H.264 preferred,
  `contentHint` detail, maintain resolution, 20 Mbps cap, 30 fps; the viewer
  sets `jitterBufferTarget` 0.
- **Pairing.** On install the extension creates a host id `wc-` plus 26
  base32 characters and a 32-byte key. The pairing link is
  `https://kuscher.github.io/windowcast/#h=<id>&k=<key>`; the fragment never
  reaches a server. The viewer stores it and removes it from the address bar.
- **Authentication.** Host sends a nonce; viewer answers with
  HMAC-SHA256(key, "wc1|viewer|" + nonces + host and viewer DTLS
  fingerprints of the control connection); host answers with the matching
  "host" proof. A broker that swapped certificates produces different
  fingerprints on each side, so both proofs fail. Unauthenticated connections
  close after 10 s; the latest authenticated viewer replaces an older one.
- **Input.** The viewer sends coordinates normalized to the video frame. The
  host maps them to the window (allowing for letterboxing), drops clicks in
  the browser's own toolbar area, converts to page CSS pixels with the tab's
  zoom and the page's inner size, and sends Chrome DevTools Protocol
  `Input.dispatchMouseEvent` / `dispatchKeyEvent` through `chrome.debugger` to
  the active tab of the shared window. The debugger attaches only while a
  viewer is connected, so Chrome's "started debugging" bar shows only then.
- **Which window is controlled.** Clicking the extension icon in a window
  nominates it; after the pick the host matches the stream's size against the
  Chrome windows, preferring the nominated one. No match means view-only.
- **Keep awake.** `chrome.power.requestKeepAwake("display")` while a window is
  shared.

## Files

`chromebook/` in the Windowcast repo: `extension/` (manifest, service worker,
host page), `viewer/` (web app with manifest and service worker), `shared/`
(pure modules used by both and by tests: ids, auth, geometry, keys, nav,
protocol), `vendor/peerjs.min.js` (MIT), `build.mjs` (assembles `dist/`),
`test/` (node:test unit tests, a Puppeteer end-to-end test that uses a test
pattern instead of desktop capture), `README.md` (install and use).
GitHub Actions runs the unit tests and deploys `dist/viewer` to GitHub Pages;
the extension ships as a zip on a GitHub Release.

## Who does what

Claude: all code, tests, the Pages deployment, the release zip and the
instructions, and the end-to-end test in Chrome on the Mac. Alex: load the
unpacked extension on the Chromebook, share a window, set the Chromebook's
power settings, open the pairing link on the Googlebook and install the
viewer, and report what the Chromebook does.

## Risks checked on the Chromebook

- Whether the capture keeps running with the lid closed, while minimized, and
  after sleep.
- The exact offset between the captured frame and the window's page area.
- Whether the picker opens by itself at sign-in without a click.
