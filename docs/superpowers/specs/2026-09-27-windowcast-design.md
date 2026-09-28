# Windowcast design

Date: 2026-09-27. Status: draft for review. Author: Alex Kuscher with Claude.

Windowcast streams one macOS window, or a whole display, from a Mac Studio to a
Googlebook, where it appears as an ordinary resizable Android window that you
control with the Googlebook's keyboard, trackpad and mouse. It is two small
native programs: a Swift menu-bar **host** on the Mac and a Kotlin/Jetpack
Compose **client** on Android, joined by WebRTC on the local network.

## 1. Goals and non-goals

### Goals (v1)

1. Pick, from the Googlebook, any window on the Mac Studio (grouped by app, with
   live thumbnails) or any display, and stream it into one Android window.
2. Control it: mouse, trackpad scrolling, right and middle click, physical
   keyboard including Mac shortcuts, and text clipboard in both directions.
3. Feel local for productivity work: 60 fps, glass-to-glass latency around
   60 ms on home Wi-Fi, text readable at the Googlebook's native pixels.
4. Follow the window: the stream tracks moves and resizes, pauses when the
   window is minimized, and ends cleanly when it closes.
5. Pair once with a PIN, then reconnect with one click. Nothing leaves the LAN.
6. Build and install from the Mac with one helper script; release an APK and a
   host app zip on GitHub.

### Non-goals (v1)

Audio, file transfer, several simultaneous sessions, other host platforms,
internet relay servers, non-US keyboard layouts beyond a text fallback,
remote cursor shapes, HDR, touch-first gestures, unattended access to the
login window, and resizing the Mac window automatically on every Android
resize. Section 13 lists which of these are planned for phase 2.

## 2. Context and constraints

### Devices and environment

| | Mac Studio (host) | HP Googlebook 14 (client) |
|---|---|---|
| Hardware | Apple M4 Max, 64 GB, 5120x2880 Retina display | Snapdragon X, arm64, 1920x1200 at density 180 (1707x1067 dp) |
| OS | macOS 26.6.2 | Googlebook OS, Android 17, SDK 37, desktop windowing, apps run as user 10 |
| Toolchain on the Mac | Xcode 27.0, Swift 6.4, Android Studio 2025.3, SDK platforms 36/36.1, build-tools 37, adb 37, JDK 21, GitHub CLI | Wireless debugging over Wi-Fi from the Mac |

Missing on the Mac today: SDK platform 37, XcodeGen, and a code-signing identity.
The user will sign into Xcode with an Apple ID so a free Personal Team
"Apple Development" certificate exists; without it every rebuild of the host
loses its Screen Recording and Accessibility grants.

### Facts from research that shape the design

- No open-source remote desktop streams a single macOS window with control.
  RustDesk captures displays through the obsoleted CGDisplayStream API and its
  protocol has no window concept. Sunshine's macOS host is experimental with a
  fixed per-session resolution. Both were rejected as bases; section 16 lists the
  prior art examined.
- ScreenCaptureKit's single-window filter (`desktopIndependentWindow`) omits the
  app's menus, popovers, sheets and dialogs. A display filter that includes
  only the target app, cropped with `sourceRect`, keeps them and still renders
  the window when other apps cover it.
- The stream's output size does not follow the source; ScreenCaptureKit scales
  in hardware and reports `contentRect`, `contentScale` and `scaleFactor` per
  frame. libwebrtc recreates its encoder on every output-size change.
- Synthetic clicks land reliably only as HID-tap events on the frontmost
  window; posting to a PID is unreliable in AppKit and Chromium apps. The host
  must raise and activate the target through Accessibility first.
- VideoToolbox has no 4:4:4 profile. H.264 High and HEVC Main are the options;
  sharpness comes from 1:1 pixels and bitrate.
- macOS 15 and later re-ask for Screen Recording periodically for apps that
  capture without the system picker. The host must detect a stopped stream and
  tell both the Mac user and the client.
- The webrtc-sdk builds of libwebrtc (LiveKit fork, version 150.7871.01 on both
  platforms) add VideoToolbox low-latency rate control and HEVC. The
  `WebRTC-ForceSendPlayoutDelay` and `WebRTC-ForcePlayoutDelay` field trials
  turn off the receiver's jitter buffer wait.
- Android 17 at targetSdk 37 needs the runtime `ACCESS_LOCAL_NETWORK`
  permission for any LAN traffic and mDNS. Desktop windowing ignores
  orientation and resizability locks. `setKeyboardCaptureEnabled` with the
  normal permission `CAPTURE_KEYBOARD` lets a window receive Alt+Tab and Meta
  shortcuts. A `connectedDevice` foreground service has no time limit.

## 3. Architecture

```
 Mac Studio                                         Googlebook
 +-----------------------------------------+        +------------------------------------+
 | Windowcast host (menu bar app, Swift)   |        | Windowcast client (Kotlin/Compose) |
 |                                         |        |                                    |
 |  Discovery  Bonjour _windowcast._tcp ---|------->|  NsdManager discovery              |
 |  Control    WSS (TLS, self-signed) <----|--------|  OkHttp WebSocket, pinned cert     |
 |    pairing, catalog, thumbnails,        |        |    Hosts / Pair / Picker screens   |
 |    session control, SDP + ICE, clipboard|        |                                    |
 |                                         |        |                                    |
 |  Capture    ScreenCaptureKit stream     |        |  Session screen                    |
 |    app-filtered display crop / display  |        |    SurfaceViewRenderer (MediaCodec)|
 |  Streaming  libwebrtc video track  =====|=DTLS==>|  libwebrtc PeerConnection          |
 |    VideoToolbox H.264 / HEVC            |        |                                    |
 |  Input      data channels <=============|========|  keyboard, mouse, trackpad capture |
 |    AX raise + CGEvent HID tap           |        |  foreground service (connectedDevice)|
 |  Tracker    CGWindowList poll 10 Hz     |        |                                    |
 +-----------------------------------------+        +------------------------------------+
```

One control connection per client; one session per connection in v1. The host is
the WebRTC offerer and owns the data channels. ICE uses host candidates only
(no STUN or TURN); Tailscale addresses are ordinary host candidates, which is
the intended path to remote use later.

## 4. Mac host

Bundle id `io.github.kuscher.windowcast.host`, name "Windowcast", an agent app
(`LSUIElement`) with a menu-bar item and no Dock icon. Deployment target
macOS 15 so GitHub runners can build it; developed and tested on macOS 26.

### 4.1 App shell and permissions

- SwiftUI `MenuBarExtra` popover with: status line ("Idle" or "Streaming Safari
  to Alex's Googlebook"), two permission rows with green/red dots and buttons
  that open the System Settings panes, the paired devices list with revoke,
  and Settings (host name, port, launch at login via `SMAppService`) and Quit.
  Codec, bitrate and modifier choices are made on the client, per host.
- Screen Recording is requested by calling `SCShareableContent` once;
  Accessibility by `AXIsProcessTrustedWithOptions` with the prompt option.
  Status is polled every 2 s while the popover is open.
- A pairing panel: a floating window showing the six-digit PIN and the
  requesting client's name, dismissed on success, failure or after 60 s. A
  user notification is posted as well.
- While a session runs, the menu-bar icon changes and the first frame posts a
  notification naming the client, so the Mac's user always knows.

### 4.2 Identity, discovery and control server

- First launch generates a host id (16 random bytes, hex) and a self-signed
  ECDSA P-256 TLS certificate valid for ten years, created with
  swift-certificates and swift-crypto and stored in the login keychain so
  Network.framework can use it as a `sec_identity_t`. If the keychain item is
  unreadable the identity is regenerated and the client will re-pair.
- `NWListener` on TCP port 47900 (configurable) with TLS and
  `NWProtocolWebSocket`, bound to all interfaces. The listener advertises
  itself as `_windowcast._tcp` with the computer name and a TXT record
  `v=1 id=<hostId> fp=<first 8 hex of the certificate SHA-256>`.
- Messages are JSON text frames (section 7). Thumbnails are binary frames.
- Unauthenticated connections may only send `hello`, `pairRequest`,
  `pairProof` and `ping`; anything else closes the connection.

### 4.3 Pairing and authentication

1. Client connects, accepts the certificate on first use and records its
   SHA-256 fingerprint F. It sends `hello` with its client id and name, plus a
   token if it has one. The host answers `welcome` with `paired` true or false.
2. Unpaired: client sends `pairRequest`. The host shows a PIN and answers
   `pairChallenge` with a 16-byte salt and the PBKDF2 round count (100000).
3. The user types the PIN on the Googlebook. The client derives
   K = PBKDF2-HMAC-SHA256(pin, salt, rounds, 32 bytes) and sends `pairProof`
   with HMAC-SHA256(K, "windowcast-pair-v1" || clientId || F).
4. The host verifies in constant time. Success returns a 32-byte random token;
   the host stores SHA-256(token) with the client id, name and dates. Three
   failures invalidate the PIN and lock pairing for 60 s.
5. Later connections send the token in `hello`. Tokens can be revoked in the
   host UI. Because F is bound into the proof, a man-in-the-middle during
   pairing causes a failed pairing rather than a compromised one.

### 4.4 Content catalog and thumbnails

- `SCShareableContent` with `onScreenWindowsOnly: false`, filtered to layer 0
  windows at least 100x50 points with a non-nil owning app, excluding the host
  itself and a small system deny-list (Dock, Window Manager, Control Center,
  Notification Center). Windows are grouped by app, apps sorted by name,
  windows by title; each carries `isOnScreen`.
- Displays come from `SCShareableContent.displays` with names from `NSScreen`.
- Thumbnails: `SCScreenshotManager` with a single-window filter (or display
  filter), at most 480 px wide, JPEG quality 0.7. Off-screen windows that
  yield no image fall back to the app icon. App icons (64 px PNG) are sent
  once per app. Thumbnails refresh every 2 s only while a client has
  subscribed; `contentChanged` pushes are throttled to 1 Hz.

### 4.5 Capture engine

Two modes, one `CaptureEngine` class with an `SCStreamOutput` on a dedicated
serial queue.

- Window mode: `SCContentFilter(display: d, including: [owningApp],
  exceptingWindows: [])` where d is the display containing the window's
  center. `sourceRect` is the window frame in that display's point
  coordinates. Child windows are included, so the app's menus, popovers,
  sheets and dialogs appear when they overlap the crop.
- Display mode: `SCContentFilter(display: d, excludingWindows: [])`.
- Configuration: `pixelFormat` 420v (NV12), `colorSpaceName` sRGB,
  `minimumFrameInterval` 1/60 (1/30 when the client asks), `queueDepth` 5,
  `showsCursor` false (the client draws its own pointer), `capturesAudio`
  false, `width`/`height` from the output size policy in section 4.6.
- Frame path: each `CMSampleBuffer` with status `.complete` is wrapped as
  `RTCCVPixelBuffer` and handed to the WebRTC video source with its
  presentation timestamp. Frames are never copied. The engine never holds more
  than one buffer beyond the current one: the last frame is retained and
  re-sent at 2 fps while the source is static so keyframe requests after loss
  can be served.
- Per-frame attachments `contentRect`, `contentScale` and `scaleFactor` are
  published atomically as `FrameGeometry` for the input mapper.
- `stream(_:didStopWithError:)` maps to a session end reason: permission
  revoked (`userDeclined`), system stopped, or unknown; the window-closed case
  is normally detected first by the tracker.

### 4.6 Window tracker and output size policy

- A 100 ms timer reads `CGWindowListCopyWindowInfo` for the target window id:
  bounds, on-screen flag and owner. Missing entry means closed: the session
  ends with reason `windowClosed`.
- Bounds change: update `sourceRect` at once (at most 10 Hz). Display change
  (center moved to another display): rebuild the filter for the new display.
- On-screen false while the app is not hidden: the session enters `paused`
  with reason `minimized`; the client offers Restore, which the host performs
  through Accessibility (`kAXMinimizedAttribute` false) followed by a raise.
  Sessions start by restoring and raising automatically.
- Output size policy: let S be the source size in pixels (window points times
  the display scale factor, or the display's pixel size) and V the client
  viewport in device pixels. Output O = S scaled down uniformly to fit in V,
  never scaled up, rounded to even numbers, at least 64x64. Re-evaluated when
  the viewport changes (client debounces 300 ms) or the source size has been
  stable for 300 ms, and applied through `updateConfiguration` only when a
  dimension changes by more than 2 percent or the aspect ratio changes.
  During a live resize the fixed output shows the content letterboxed for at
  most 300 ms; there is no distortion because `preservesAspectRatio` stays on.

### 4.7 Streaming

- libwebrtc from `webrtc-sdk/Specs` 150.7871.01 via Swift Package Manager.
  Field trial `WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/` is set before
  the factory is created.
- Video source: `videoSourceForScreenCast(true)` so degradation preference is
  maintain-resolution. One send-only transceiver, track id `video0`.
- Encoder factory: a custom `RTCVideoEncoderFactory` that offers H.264 High
  profile level 5.2 first, constrained baseline second, and HEVC Main when the
  session preference allows it. The default factory's level 3.1 would cap
  the frame rate at high resolutions.
- Bitrate: after negotiation, `setBweMinBitrateBps` with min 2 Mbps, start
  15 Mbps, max 40 Mbps; the encoding parameters carry the same bounds and
  `maxFramerate` 60. The client's settings can lower the cap.
- Peer connection: unified plan, `bundlePolicy` max-bundle, no ICE servers,
  continual gathering. The host creates the offer and two data channels:
  `input` (ordered, reliable) and `pointer` (unordered, `maxRetransmits` 0).
  SDP and ICE candidates travel over the control connection.

### 4.8 Input injection

`InputInjector` runs on the main thread. Data-channel bytes are decoded on the
WebRTC thread and dispatched to it.

- Frontmost guarantee: on session start, and on any button-down or key-down
  when a check older than 250 ms shows the target is not frontmost, the host
  sets `kAXFrontmostAttribute` on the app element, performs `kAXRaiseAction`
  on the window element (matched by title and frame among
  `kAXWindowsAttribute`) and sets `kAXMainAttribute`. If Accessibility
  reports failure it falls back to `NSRunningApplication.activate`. Display
  mode skips all of this.
- Mouse: `CGEvent` mouse events posted to the HID tap at the mapped global
  point (section 8). Moves become dragged events while a button is held.
  Click count is computed from `NSEvent.doubleClickInterval` and a 4-point
  radius. Buttons 3 and 4 map to back and forward.
- Scroll: trackpad deltas use pixel units with the continuous flag and
  synthesized phases (began after a 100 ms gap, ended after 100 ms idle);
  mouse wheel notches use line units.
- Keyboard: Android key codes map to macOS virtual key codes through the table
  in section 9, with the modifier policy applied. Every key down and up,
  including modifiers, is posted; the event flags are set from the host's
  tracked modifier state. Repeats set the autorepeat flag. `text` messages
  post a key event with the Unicode string attached, for IME commits and
  characters without a US key.
- `releaseAll` posts key-up for every key and button the host believes is
  down. The client sends it whenever its window loses focus, so no modifier
  sticks on the Mac.
- Clipboard: while a session runs the host polls `NSPasteboard.general`'s
  change count every 500 ms and sends string contents up to 1 MB; incoming
  `setClipboard` writes the pasteboard. A hash of the last value sent or
  received prevents loops.
- `resizeTarget` sets the window's Accessibility size to the requested points
  (clamped to the display), which the tracker then picks up. This backs the
  client's "Match size" button.

### 4.9 Concurrency, errors and persistence

- Swift 6 language mode. `ControlServer`, `ContentCatalog`, `PairingStore` and
  `Session` are actors; `CaptureEngine` and `InputInjector` are classes bound
  to their queues; WebRTC callbacks hop to the owning actor.
- Every session end has a `SessionEndReason` (`clientStopped`,
  `windowClosed`, `permissionRevoked`, `hostStopped`, `transportFailed`,
  `error(String)`) that reaches the client in `sessionState`.
- Errors that need the Mac user (permission revoked, identity regenerated)
  post a notification and show in the popover.
- Paired clients live in `~/Library/Application Support/Windowcast/paired.json`;
  settings in `UserDefaults`; the TLS identity in the keychain. Logs use
  `os.Logger` with subsystem `io.github.kuscher.windowcast.host`.

## 5. Android client

Application id and namespace `io.github.kuscher.windowcast`, name "Windowcast".
Kotlin 2.4.20, AGP 9.4.1, compileSdk and targetSdk 37, minSdk 34, Compose BOM
2026.09.00 with material3 1.4.0 (stable, no Expressive alphas), Kotlin
Serialization, DataStore, OkHttp 5 for WebSocket, and
`io.github.webrtc-sdk:android:150.7871.01`. No dependency injection framework
and no navigation library: a root `Screen` state in the app view model.

### 5.1 Manifest and window behavior

- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_STATE`,
  `CHANGE_WIFI_MULTICAST_STATE`, `ACCESS_LOCAL_NETWORK` (runtime),
  `CAPTURE_KEYBOARD`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS` (runtime,
  optional).
- `uses-feature` `android.hardware.type.pc` and `android.hardware.touchscreen`
  both not required, the former so mouse events arrive untranslated.
- Single activity, `resizeableActivity` true, `configChanges` covering size,
  density, keyboard, navigation and UI mode so a resize never recreates it, and
  a `layout` element with `minWidth` 480 dp, `minHeight` 360 dp,
  `defaultWidth` 1100 dp, `defaultHeight` 720 dp.
- The dev helper enables `ENABLE_FLUID_RESIZING` for the package so live
  resizing shows content instead of a veil.

### 5.2 Screens

- Hosts: saved hosts with an online dot, then "Found on this network", and
  "Add by address" for IP or Tailscale names. A banner explains and requests
  local network access when it is missing.
- Pair: the host name and a six-box PIN field; connects on the sixth digit.
- Picker: a header with host name, search field and refresh; a horizontal
  Displays row of cards; Windows grouped under app icon and name in an
  adaptive grid (minimum 220 dp cells) of 16:10 thumbnail cards with title and
  an "Off screen" badge. Thumbnails refresh every 2 s while visible. Arrow
  keys and Enter work through Compose focus.
- Session: full-bleed video, letterboxed with a dark background. A pill
  toolbar at the top center appears on hover near the top edge or on tap and
  hides after 2 s: window title and host, Match size, Fullscreen, Keyboard
  capture toggle, Stats, Disconnect. Overlays: Connecting, Paused (window
  minimized, Restore), Ended (reason, Back to windows), Reconnecting.
- Settings sheet per host: modifier policy (Mac or Raw), frame rate cap
  (60 or 30), bitrate cap, codec preference (Auto, H.264, HEVC), start in
  fullscreen.

### 5.3 Discovery and connection

- `NsdManager.discoverServices("_windowcast._tcp")` with a multicast lock,
  resolving through `registerServiceInfoCallback`, stopped when the Hosts
  screen leaves. Spurious lost/found flaps are debounced by 2 s.
- `ControlClient` wraps an OkHttp WebSocket over TLS with a trust manager that
  pins the paired fingerprint (or accepts and records it during pairing) and
  disables hostname verification. Requests are correlated by id with a 10 s
  timeout; pushes go to a `SharedFlow`.
- Disconnects during a session show Reconnecting and retry with backoff
  (1, 2, 4, 8 s, up to 30 s) by starting a new session on the same target;
  the host treats the old session as `transportFailed`.

### 5.4 Session engine

- `SessionEngine` owns the `PeerConnectionFactory` (field trial
  `WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/`, hardware decoder factory,
  shared EGL context), the peer connection, the two data channels and stats
  polling (1 Hz: frames decoded, fps, bitrate, RTT, jitter buffer delay).
- Rendering: `SurfaceViewRenderer` in an `AndroidView`, aspect-fit, hardware
  scaler on. The video area's size in device pixels is reported to the host as
  the viewport, debounced 300 ms.
- `WindowcastSessionService` is a `connectedDevice` foreground service started
  when the session starts, with a notification that names the window and host
  and offers Disconnect. It holds the engine so the session survives the
  activity being covered or recreated.
- The engine lives in a process-level `SessionHolder`; the activity attaches
  and detaches its renderer.

### 5.5 Input capture

- Pointer: `pointerInteropFilter` on the video composable receives raw
  `MotionEvent`s. Hover and move become `PointerMove`; `ACTION_BUTTON_PRESS`
  and `RELEASE` become button events with `actionButton`; `ACTION_SCROLL`
  becomes `Scroll` with `AXIS_VSCROLL`/`AXIS_HSCROLL` and a unit derived from
  the source (touchpad: pixels, mouse: notches). Single-finger touch acts as
  the left button. Coordinates are normalized to the fitted video rectangle;
  events outside it are ignored.
- The local pointer stays visible over the video (default arrow) in v1.
- Keyboard: a root `onPreviewKeyEvent` plus the activity's `dispatchKeyEvent`
  forward every key down and up with the Android key code, meta state, repeat
  count and Unicode character. Esc is consumed so it never becomes Back.
  `setKeyboardCaptureEnabled(true)` (API 37 and later) is applied while the
  session view is focused and the toolbar toggle is on (default on), so Alt+Tab and Meta
  shortcuts go to the Mac; the exact Esc behavior with capture on is checked
  in spike S2.
- IME commits arrive through `onCommitText` of a minimal `InputConnection` and
  become `Text` messages.
- Losing window focus sends `ReleaseAll`; regaining focus re-applies keyboard
  capture.

### 5.6 Persistence

- `HostStore` (DataStore, JSON): host id, name, last address and port,
  certificate fingerprint, settings. Tokens are wrapped by an Android Keystore
  AES key and stored beside them.
- Logs use tag prefix `WC/`.

## 6. Cross-cutting: protocol summary

Details live in `protocol/PROTOCOL.md`; this is the contract.

- Transport: WebSocket over TLS, text frames carry JSON objects with a `type`
  field; requests carry `id` and replies carry `re`; pushes carry neither.
  Binary frames carry a 4-byte big-endian header length, a JSON header and a
  payload (used for thumbnails and icons).
- `protocolVersion` 1 in `hello` and `welcome`; a different major is refused
  with `error` code `version`.
- Client to host: `hello`, `pairRequest`, `pairProof`, `listContent`,
  `subscribeContent`, `unsubscribeContent`, `getThumbnail`, `startSession`
  (target kind and id, viewport, preferences), `sdpAnswer`, `ice`,
  `updateViewport`, `restoreWindow`, `resizeTarget`, `setClipboard`,
  `stopSession`, `ping`.
- Host to client: `welcome`, `pairChallenge`, `pairResult`, `content`,
  `contentChanged`, thumbnail and icon binary frames, `sessionStarted`
  (session id, source size and scale, title), `sdpOffer`, `ice`,
  `sessionState` (capturing, paused, ended, with reason), `sourceChanged`,
  `clipboard`, `error`, `pong`.
- Data channels carry big-endian (network order) binary records, first byte the type:
  `0x01 PointerMove` (x, y as float32 in 0..1, buttons mask), `0x02
  ButtonDown` and `0x03 ButtonUp` (button, x, y), `0x04 Scroll` (x, y, dx,
  dy, unit, phase), `0x05 KeyDown` and `0x06 KeyUp` (Android key code, meta
  state, repeat, Unicode code point), `0x07 Text` (length, UTF-8), `0x08
  ReleaseAll`. `PointerMove` and `Scroll` use the `pointer` channel; the rest
  use `input`. Button events carry their own position so channel reordering
  cannot misplace a click.

## 7. Coordinate mapping

For output surface size Wo x Ho pixels and per-frame `contentRect` R (points
within the surface), `contentScale` c and `scaleFactor` s:

1. Client sends (nx, ny) in 0..1 relative to the fitted video rectangle.
2. Surface pixel: (nx * Wo, ny * Ho). Surface point: divide by s.
3. Source point: ((px / s - R.x) / c, (py / s - R.y) / c), clamped to the
   source size in points.
4. Global CG point: displayFrame.origin + sourceRect.origin + source point
   (display mode: sourceRect is the display bounds). CG and ScreenCaptureKit
   share the top-left origin, so no AppKit flip is needed.

Spike S1 confirms the unit of R with a `sourceRect` in place; the mapper's unit
tests use fixtures recorded there, including a secondary display with a
negative origin and a different scale factor.

## 8. Keyboard mapping policy

- A static table maps Android `KeyEvent` codes to macOS virtual key codes for
  the US ANSI layout: letters, digits, punctuation, space, enter, tab,
  backspace, forward delete, escape, arrows, home, end, page up and down,
  F1 to F19, caps lock, both sides of shift, control, alt and meta, and the
  numeric keypad. Keys without an entry fall back to a `Text` message when a
  Unicode character is present, and are dropped otherwise.
- Modifier policy "Mac" (default): Ctrl becomes Command, Meta becomes Control,
  Alt becomes Option, Shift stays. Policy "Raw": Ctrl stays Control, Meta
  becomes Command. The policy is chosen per host in the client and sent in
  `startSession`.
- The client never intercepts system-owned combinations it cannot receive;
  with keyboard capture on, the ones Android hands over are forwarded as is.
- The tables are written from the Android and Carbon HIToolbox documentation,
  not copied from GPL projects.

## 9. Security model

- Threats in scope: other devices on the LAN reading or injecting a session,
  and a stolen token. Out of scope: a compromised Mac or Googlebook.
- Signaling is TLS with a pinned self-signed certificate after trust on first
  use; the pairing proof binds the fingerprint, so an interposed certificate
  fails pairing. Media and input are DTLS-SRTP and DTLS-SCTP inside WebRTC,
  keyed by fingerprints exchanged over the authenticated signaling channel.
- Tokens are 256-bit random, hashed at rest on the host, revocable, and never
  logged. Pairing is rate limited and PINs are single use.
- The host injects input only for an authenticated session and shows a
  visible indicator while streaming.

## 10. Performance targets and tuning

| Metric | Target | How it is met or measured |
|---|---|---|
| Frame rate | 60 fps at up to 2560x1600 output | hardware capture scaling, VideoToolbox, `maxFramerate` 60 |
| Glass-to-glass latency on Wi-Fi | 60 ms typical, 80 ms worst case | playout delay 0/0 on both ends, no upscaling, stats overlay, camera test in S2 |
| Input to visible effect | under 100 ms | unordered pointer channel, HID tap posting |
| Bitrate | 2 to 40 Mbps adaptive | BWE bounds, per-host cap |
| Host CPU while idle in picker | under 5 percent | thumbnails only while subscribed, 2 s cadence |

If measured latency in S2 exceeds target with the stock decoder, the client
wraps MediaCodec in its own decoder factory with `KEY_LOW_LATENCY`; if it still
exceeds target, the transport interface gains a raw H.264-over-TLS
implementation (both sides isolate transport behind a `MediaTransport` interface from the start).

## 11. Testing strategy

- Shared test vectors in `protocol/testvectors/`: JSON message samples, binary
  input records, pairing proof vectors and coordinate fixtures. Both code
  bases must pass them, which keeps the two codecs identical.
- Host: `WindowcastCore` is a Swift package holding protocol models, the input
  codec, the coordinate mapper, the key map and pairing crypto, tested with
  `swift test`. `ControlServerTests` start the server on an ephemeral port
  with a fake catalog and drive pairing and listing with
  `URLSessionWebSocketTask`.
- Client: JVM unit tests for the same vectors plus viewport math and the host
  store; a Compose UI test for the Picker against `FakeHostApi`; the
  device is the integration target (no emulator required).
- Manual checklist in `docs/TESTING.md`: permissions, pairing, revoke,
  picker, window session, display session, move across displays, resize,
  minimize and restore, close, focus loss, shortcuts, scrolling, clipboard,
  reconnect, permission revoked mid-session.
- Spikes S1 and S2 produce numbers and behavior tables before the MVP starts.

## 12. Repository, tooling, CI and licensing

```
windowcast/
  README.md  LICENSE (MIT)  CLAUDE.md  .gitignore  wc (dev helper)
  .github/workflows/  host.yml  client.yml  release.yml
  docs/  superpowers/specs/  superpowers/plans/  TESTING.md  PICKING-UP.md
  protocol/  PROTOCOL.md  testvectors/
  host-macos/  project.yml (XcodeGen)  Windowcast/ (app)  WindowcastCore/ (package)
  client-android/  settings.gradle.kts  gradle/libs.versions.toml  app/
  spikes/  (throwaway; removed after phase 0)
```

- `wc` mirrors the helper scripts of the sibling projects: `wc host` (xcodegen,
  build, launch), `wc app` (assemble, install over Wi-Fi adb, launch), `wc
  connect` (find the Googlebook's changing adb port with `adb mdns services`),
  `wc logs`, `wc live-resize`, `wc test`.
- Xcode project generated by XcodeGen from `project.yml`; `Local.xcconfig`
  (ignored) carries `DEVELOPMENT_TEAM`. Automatic signing with the Personal
  Team keeps TCC grants stable. Android release signing reads
  `~/.config/windowcast/keystore.jks` and `keystore.pass` if present, as in
  the sibling projects; debug builds use the default debug keystore.
- CI: `client.yml` on Ubuntu with JDK 21 runs unit tests and uploads the debug
  APK; `host.yml` on a macOS runner installs XcodeGen, builds the app with
  signing disabled and runs `swift test`. `release.yml` on a tag attaches the
  APK and a zipped host app to a GitHub Release.
- License MIT for this repository. Dependencies: libwebrtc (BSD-3),
  swift-certificates and swift-crypto (Apache-2.0), OkHttp (Apache-2.0).

## 13. Delivery phases

Each phase gets its own implementation plan. The phase 1 plan is written after
the spikes report, so their findings feed it.

### Phase 0: spikes (throwaway)

- S1 capture and poke (Mac only): enumerate windows; stream an app-filtered
  crop of a chosen window; log per-frame geometry; observe occluded, minimized,
  other-Space and cross-display behavior; raise and activate from a background
  agent; post a click at a computed point in Finder, Safari, Terminal, Chrome
  and System Settings. Exit: a behavior table, a confirmed mapping formula, and
  activation working in all five apps or a documented fallback.
- S2 WebRTC loop (Mac to Googlebook): the S1 stream over WebRTC to a bare
  Android activity; latency with and without the playout-delay trials; 60 fps
  at 1920x1200 output; H.264 level negotiation and HEVC decode availability on
  the Snapdragon X; behavior of keyboard capture and Esc; the local network
  permission and foreground service in practice. Exit: a numbers table and the
  codec and decoder decisions.

### Phase 1: MVP, one runnable increment per milestone

- M1 Host foundation: XcodeGen project, menu-bar app, permissions UI, identity
  and TLS, Bonjour, control server, pairing, persistence, `WindowcastCore` with
  tests and shared vectors.
- M2 Client foundation: Gradle project, Hosts screen with discovery and manual
  entry, pairing, token storage, `ControlClient` with tests, `FakeHostApi`.
- M3 Catalog: listing, thumbnails and change pushes on the host; Picker on the
  client.
- M4 Video session: capture engine, tracker, WebRTC, session renderer,
  viewport policy, session states, reconnect, foreground service.
- M5 Input: data channels, injector, mapping, keyboard with capture toggle,
  scrolling, release-all on focus loss, clipboard text, Match size.
- M6 Hardening and release: stats overlay, settings, permission-revoked
  handling, CI, README with Googlebook install steps, CLAUDE.md, TESTING.md,
  PICKING-UP.md, v0.1 release.

### Phase 2 backlog

Several windows at once (one Android window per Mac window, several tracks on
one connection), remote cursor shapes via `NSCursor.currentSystem`, the Mac
menu bar as native Android menus built from the Accessibility menu tree, HEVC
by default where it measures better, per-app audio, Tailscale documentation
and STUN option, non-US layouts through `UCKeyTranslate`, relative mouse mode,
host auto-update.

## 14. Risks and mitigations

1. Screen Recording re-authorization prompts on macOS 15 and later stop
   capture silently. Mitigation: detect the stopped stream, notify on both
   ends, stable signing, document `tccutil reset` for recovery.
2. Raising and activating from a background app can fail in some apps.
   Mitigation: Accessibility frontmost plus raise, Launch Services fallback,
   verified in S1 across five apps.
3. `sourceRect` with an app-inclusive filter may behave differently than
   documented. Mitigation: S1 checks it first; fallback is the single-window
   filter with popups accepted as missing.
4. Output-size changes rebuild the encoder. Mitigation: debounce, never
   upscale, 2 percent hysteresis.
5. Wi-Fi jitter. Mitigation: adaptive bitrate, stats overlay, per-host cap,
   raw-TLS transport as a fallback path.
6. Keyboard capture semantics on Googlebook OS (Esc hint) may fight the Mac's
   Esc. Mitigation: S2 measures, toolbar toggle, Esc consumed at dispatch.
7. Snapdragon X decoder quirks. Mitigation: H.264 default, S2 measurements,
   optional custom decoder factory.
8. Dependence on a forked libwebrtc distribution. Mitigation: pinned
   versions, transport behind an interface.
9. Keychain and TLS identity friction. Mitigation: regenerate on failure,
   re-pair flow, tested in M1.
10. The remote pointer's shape is not visible in v1. Mitigation: phase 2
    cursor sync; the local arrow is always responsive.

## 15. Open items resolved by spikes, not by review

- Units of `contentRect` when `sourceRect` is set (S1).
- Whether `updateConfiguration` for `sourceRect` alone is cheap at 10 Hz (S1).
- Measured latency and the decoder flag decision (S2).
- Whether the Googlebook trackpad reports two-finger scroll as touchpad or
  mouse source (S2).

## 16. References

- ScreenCaptureKit: Apple docs and WWDC22 sessions 10155 and 10156; WWDC24
  10088 for the content sharing picker.
- VideoToolbox low-latency rate control: WWDC21 session 10158.
- Accessibility activation caveats: AppKit release notes for macOS 14.
- webrtc-sdk Android and Specs releases 150.7871.01 (LiveKit fork of
  libwebrtc, August 2026); field trials in `rtp_sender_video.cc` and
  `rtp_video_stream_receiver2.cc`.
- Android desktop windowing, local network permission and foreground service
  types: developer.android.com guides for Android 16 and 17.
- Googlebook field notes: `kuscher/vscodebook` docs/GOOGLEBOOK.md; helper
  script and build conventions from `kuscher/studiosnap` and `kuscher/officebook`.
- Prior art examined and rejected as bases: RustDesk (CGDisplayStream capture,
  display-only protocol), Sunshine and Moonlight-Android (experimental macOS
  host, fixed session resolution), Deskreen (view only), Mirador (MIT Swift
  SCK-to-VideoToolbox reference).
