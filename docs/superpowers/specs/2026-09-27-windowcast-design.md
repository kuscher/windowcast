# Windowcast design

Date: 2026-09-27, revised the same day to bring multi-window, the Resize menu and
key remapping into v1, and on 2026-09-28 to add internet access (M7) and the
split of work between Claude and Alex. Status: draft for review. Author: Alex Kuscher with Claude.

Windowcast streams macOS windows, or a whole display, from a Mac Studio to a
Googlebook, where each one appears as an ordinary resizable Android window that
you control with the Googlebook's keyboard, trackpad and mouse. It is two small
native programs: a Swift menu-bar **host** on the Mac and a Kotlin/Jetpack
Compose **client** on Android, joined by WebRTC on the local network.

## 1. Goals and non-goals

### Goals (v1)

1. Pick, from the Googlebook, any window on the Mac Studio (grouped by app, with
   live thumbnails) or any display, and stream it into an Android window.
2. Several at once: each Mac window you open becomes its own Android window with
   its own taskbar entry, and you switch between them like local apps.
3. Control them: mouse, trackpad scrolling, right and middle click, physical
   keyboard including Mac shortcuts, and text clipboard in both directions.
4. Remap keys in the app: choose what Ctrl, Alt, Meta and Caps Lock send to the
   Mac, and add your own key-to-key rules, from day one.
5. Resize from the Android side: every session window has a Resize menu that
   matches the Mac window to the Android window once, keeps it following as you
   resize, or sets a preset size.
6. Feel local for productivity work: 60 fps, glass-to-glass latency around
   60 ms on home Wi-Fi, text readable at the Googlebook's native pixels.
7. Follow the window: the stream tracks moves and resizes, pauses when the
   window is minimized, and ends cleanly when it closes.
8. Pair once with a PIN, then reconnect with one click. At home nothing leaves
   the LAN; away from home the same session runs over your own Tailscale
   network from any Wi-Fi or a phone hotspot, with no server of ours in between.
9. Build and install from the Mac with one helper script; release an APK and a
   host app zip on GitHub.

### Non-goals (v1)

Audio, file transfer, other host platforms, relay or signaling servers run by
us (remote access rides on Tailscale), non-US base keyboard layouts (remap rules and the text fallback cover individual
keys), remote cursor shapes, HDR, touch-first gestures, unattended access to
the login window, per-host keymap profiles, and two clients controlling the
same window. Section 14 lists which of these are planned for phase 2.

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
  fixed per-session resolution. Both were rejected as bases; section 17 lists
  the prior art examined.
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
  orientation and resizability locks. Every task is a window: launching an
  activity with `FLAG_ACTIVITY_NEW_DOCUMENT | FLAG_ACTIVITY_MULTIPLE_TASK`
  opens a new window, `ActivityOptions.setLaunchBounds` sizes it at launch,
  and no public API resizes an existing window afterwards.
  `setKeyboardCaptureEnabled` with the normal permission `CAPTURE_KEYBOARD`
  lets a window receive Alt+Tab and Meta shortcuts. A `connectedDevice`
  foreground service has no time limit.

## 3. Architecture

```
 Mac Studio                                         Googlebook
 +-----------------------------------------+        +------------------------------------+
 | Windowcast host (menu bar app, Swift)   |        | Windowcast client (Kotlin/Compose) |
 |                                         |        |                                    |
 |  Discovery  Bonjour _windowcast._tcp ---|------->|  NsdManager discovery              |
 |  Control    WSS (TLS, self-signed) <----|--------|  OkHttp WebSocket, pinned cert     |
 |    pairing, catalog, thumbnails,        |        |    Hosts / Pair / Picker window    |
 |    session control, SDP + ICE, clipboard|        |                                    |
 |                                         |        |                                    |
 |  Sessions   one per window or display   |        |  Session windows, 1 per Mac window |
 |    Capture  ScreenCaptureKit stream     |        |    SurfaceViewRenderer (MediaCodec)|
 |    Stream   libwebrtc video track  =====|=DTLS==>|    libwebrtc PeerConnection        |
 |    VideoToolbox H.264 / HEVC            |        |    keyboard, mouse, trackpad,      |
 |    Input    data channels <=============|========|      Resize menu, key remap        |
 |  Injector   AX raise + CGEvent HID tap  |        |  SessionRegistry in a foreground   |
 |  Tracker    CGWindowList poll 10 Hz     |        |    service (connectedDevice)       |
 +-----------------------------------------+        +------------------------------------+
```

One control connection per client carries all of that client's sessions, up to
six at once. Each session (one Mac window or display) has its own peer
connection, video track and data channels, so a failing session never disturbs
the others and each Android window owns exactly one. The host is the WebRTC
offerer. ICE uses host candidates only (no STUN or TURN); away from home the
candidates are the two devices' Tailscale addresses (section 10).

Keyboard translation happens on the client: it knows the physical keyboard and
the user's remap rules, and sends the Mac virtual key and modifier flags to
post. The host injects exactly what it is told and keeps one global picture of
which keys and buttons are down, because there is one physical keyboard and
mouse behind all sessions.

## 4. Mac host

Bundle id `io.github.kuscher.windowcast.host`, name "Windowcast", an agent app
(`LSUIElement`) with a menu-bar item and no Dock icon. Deployment target
macOS 15 so GitHub runners can build it; developed and tested on macOS 26.

### 4.1 App shell and permissions

- SwiftUI `MenuBarExtra` popover with: a status line ("Idle" or "3 windows to
  Alex's Googlebook") and the list of active sessions with their targets, two
  permission rows with green/red dots and buttons that open the System
  Settings panes, the paired devices list with revoke, and Settings (host
  name, port, launch at login via `SMAppService`, session limit) and Quit.
  Codec, bitrate, resize-follow and keyboard choices are made on the client.
- Screen Recording is requested by calling `SCShareableContent` once;
  Accessibility by `AXIsProcessTrustedWithOptions` with the prompt option.
  Status is polled every 2 s while the popover is open.
- A pairing panel: a floating window showing the six-digit PIN and the
  requesting client's name, dismissed on success, failure or after 60 s. A
  user notification is posted as well.
- While any session runs, the menu-bar icon changes, and the first frame of a
  client's first session posts a notification naming the client, so the Mac's
  user always knows.

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
- Messages are JSON text frames (section 6). Thumbnails and icons are binary
  frames.
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
  windows by title; each carries `isOnScreen` and `busy` (already streamed by
  another client).
- Displays come from `SCShareableContent.displays` with names from `NSScreen`.
- Thumbnails: `SCScreenshotManager` with a single-window filter (or display
  filter), at most 480 px wide, JPEG quality 0.7. Off-screen windows that
  yield no image fall back to the app icon. App icons (64 px PNG) are sent
  once per app and reused by the client for its window task icons.
  Thumbnails refresh every 2 s only while a client has subscribed;
  `contentChanged` pushes are throttled to 1 Hz.

### 4.5 Capture engine

Two modes, one `CaptureEngine` instance per session with an `SCStreamOutput` on
its own serial queue.

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
  `RTCCVPixelBuffer` and handed to the session's WebRTC video source with its
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

- A 100 ms timer per window session reads `CGWindowListCopyWindowInfo` for the
  target window id: bounds, on-screen flag and owner. Missing entry means
  closed: the session ends with reason `windowClosed`.
- Bounds change: update `sourceRect` at once (at most 10 Hz) and push
  `sourceChanged`. Display change (center moved to another display): rebuild
  the filter for the new display. Title change: push `targetInfo`.
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
- `resizeTarget` sets the window's Accessibility size to the requested points,
  clamped to the display's visible frame, at most 5 times per second; apps
  that enforce minimum or fixed sizes simply end up at their nearest allowed
  size, which the tracker reports back. This backs the client's Resize menu,
  including its follow mode.

### 4.7 Streaming

- libwebrtc from `webrtc-sdk/Specs` 150.7871.01 via Swift Package Manager.
  Field trial `WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/` is set before
  the single factory is created.
- Each session owns one peer connection with a screencast video source
  (`videoSourceForScreenCast(true)`, so degradation preference is
  maintain-resolution) and one send-only transceiver, track id `video0`.
- Encoder factory: a custom `RTCVideoEncoderFactory` that offers H.264 High
  profile level 5.2 first, constrained baseline second, and HEVC Main when the
  session preference allows it. The default factory's level 3.1 would cap
  the frame rate at high resolutions.
- Bitrate per session: after negotiation, `setBweMinBitrateBps` with min
  2 Mbps, start 15 Mbps, max 40 Mbps; the encoding parameters carry the same
  bounds and `maxFramerate` 60. The client's per-host cap lowers the maximum,
  and with more than two sessions the host divides the cap evenly.
- Peer connection: unified plan, `bundlePolicy` max-bundle, no ICE servers,
  continual gathering. The host creates the offer and two data channels:
  `input` (ordered, reliable) and `pointer` (unordered, `maxRetransmits` 0).
  SDP and ICE candidates travel over the control connection tagged with the
  session id.

### 4.8 Input injection

One `InputInjector` for the whole host, running on the main thread. Each
session decodes its data-channel bytes on the WebRTC thread and hands them to
the injector with the session's target and geometry.

- Frontmost guarantee: on session start, and on any button-down or key-down
  when a check older than 250 ms shows the session's target is not frontmost,
  the injector sets `kAXFrontmostAttribute` on the app element, performs
  `kAXRaiseAction` on the window element (matched by title and frame among
  `kAXWindowsAttribute`) and sets `kAXMainAttribute`. If Accessibility
  reports failure it falls back to `NSRunningApplication.activate`. Pointer
  moves never raise, so hovering across two session windows does not make the
  Mac windows fight. Display mode skips all of this.
- Mouse: `CGEvent` mouse events posted to the HID tap at the mapped global
  point (section 7). Moves become dragged events while a button is held.
  Click count is computed from `NSEvent.doubleClickInterval` and a 4-point
  radius. Buttons 3 and 4 map to back and forward. Mouse events carry the
  modifier flags currently held according to the global key state.
- Scroll: trackpad deltas use pixel units with the continuous flag and
  synthesized phases (began after a 100 ms gap, ended after 100 ms idle);
  mouse wheel notches use line units.
- Keyboard: the client sends Mac virtual key codes and Mac modifier flags
  already translated (section 8). The injector posts `CGEvent` keyboard events
  with those flags, tracks the set of virtual keys down across all sessions,
  and marks repeats with the autorepeat flag. A record with no virtual key but
  a Unicode code point, or a `text` record, posts a key event carrying the
  Unicode string, which is how IME commits and unmapped characters arrive.
- `releaseAll` posts key-up for every key and button the injector believes is
  down, regardless of which session sent it. The client sends it whenever a
  session window loses focus, so no modifier sticks on the Mac.
- Clipboard: per client connection. While any session runs the host polls
  `NSPasteboard.general`'s change count every 500 ms and sends string
  contents up to 1 MB; incoming `setClipboard` writes the pasteboard. A hash
  of the last value sent or received prevents loops.

### 4.9 Sessions, concurrency, errors and persistence

- `SessionRegistry` (actor) owns all sessions: at most 6 per client and 8 in
  total; a window or display can be in one session at a time across all
  clients. `startSession` for a busy target returns error `busy`; over the
  limit returns `limit`. When a client's connection drops, all its sessions
  end with `transportFailed`.
- Swift 6 language mode. `ControlServer`, `ContentCatalog`, `PairingStore`,
  `SessionRegistry` and `Session` are actors; `CaptureEngine` and
  `InputInjector` are classes bound to their queues; WebRTC callbacks hop to
  the owning actor.
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
and no navigation library: a root `Screen` state in the main view model.

### 5.1 Windows, manifest and process structure

- Two activities. `MainActivity` is the launcher window with Hosts, Pair,
  Picker and Settings. `SessionActivity` shows one session; it is declared
  with `documentLaunchMode="always"` and an empty `taskAffinity`, and the
  Picker starts it with `FLAG_ACTIVITY_NEW_DOCUMENT | FLAG_ACTIVITY_MULTIPLE_TASK`,
  so every session is its own task and therefore its own desktop window with
  its own taskbar entry. The Picker window stays open so you can add more.
- Launch size: `ActivityOptions.setLaunchBounds` sizes the new window to the
  Mac window's size in points, taken as dp one to one, clamped to 90 percent
  of the display's work area with a minimum of 480x360 dp, and cascaded by
  32 dp for each already-open session window. Android offers no API to
  resize an existing window later, so this is the one moment the Android
  window is sized to the Mac window; the Resize menu works the other way
  round.
- Each session window's task description carries the Mac window title and
  the Mac app's icon, so the taskbar and overview show "Safari" with Safari's
  icon rather than five identical Windowcast entries. Title changes update it.
- `WindowcastSessionService` is a `connectedDevice` foreground service that
  owns the process-wide `SessionRegistry`: one `ControlClient` per host
  (shared by all windows), one `SessionEngine` per session, and the map from
  target to session id and task id. It starts with the first session, shows
  one notification ("2 windows from Mac Studio", with Disconnect all) and
  stops with the last. Activities attach and detach from it, so covering,
  recreating or reopening a window never interrupts a stream.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_STATE`,
  `CHANGE_WIFI_MULTICAST_STATE`, `ACCESS_LOCAL_NETWORK` (runtime),
  `CAPTURE_KEYBOARD`, `REORDER_TASKS` (to bring an already-open session
  window to the front from the Picker), `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS` (runtime,
  optional).
- `uses-feature` `android.hardware.type.pc` and `android.hardware.touchscreen`
  both not required, the former so mouse events arrive untranslated.
- Both activities set `resizeableActivity` true and `configChanges` covering
  size, density, keyboard, navigation and UI mode so a resize never recreates
  them. `MainActivity` declares a `layout` element with `minWidth` 480 dp,
  `minHeight` 360 dp, `defaultWidth` 1100 dp, `defaultHeight` 720 dp and the
  `PROPERTY_SUPPORTS_MULTI_INSTANCE_SYSTEM_UI` property, so its caption bar
  offers a second Picker window.
- The dev helper enables `ENABLE_FLUID_RESIZING` for the package so live
  resizing shows content instead of a veil.

### 5.2 Screens

- Hosts: saved hosts with an online dot, then "Found on this network", and
  "Add by address" for IP or Tailscale names. A banner explains and requests
  local network access when it is missing. A gear opens Settings.
- Pair: the host name and a six-box PIN field; connects on the sixth digit.
- Picker: a header with host name, search field and refresh; a horizontal
  Displays row of cards; Windows grouped under app icon and name in an
  adaptive grid (minimum 220 dp cells) of 16:10 thumbnail cards with title and
  badges: "Off screen", "Open" (this client already streams it; clicking
  brings that window to the front) and "In use" (another client streams it).
  Thumbnails refresh every 2 s while visible. Arrow keys and Enter work
  through Compose focus.
- Session window: full-bleed video, letterboxed with a dark background. A
  pill toolbar at the top center appears on hover near the top edge or on tap
  and hides after 2 s. Its items, in order: the window title and host; the
  **Resize** menu (below); Keyboard capture toggle; Fullscreen; Stats;
  Disconnect (closes this window). Overlays: Connecting, Paused (window
  minimized, Restore), Ended (reason, Close), Reconnecting.
- Resize menu: "Match this window" resizes the Mac window once to the video
  area's size in points; "Follow this window" is a toggle that repeats that
  on every Android resize (debounced 300 ms), so the letterbox disappears and
  stays gone; presets 1280x800, 1440x900, 1680x1050, 1920x1200 and "Fill Mac
  display" set the Mac window to that size. The follow toggle's default for
  new sessions is a per-host setting. Display sessions show the menu disabled.
- Settings: **Keyboard** (section 8: presets, the modifier map and custom
  rules), and per host: frame rate cap (60 or 30), bitrate cap, codec
  preference (Auto, H.264, HEVC), follow window size by default, start in
  fullscreen.

### 5.3 Discovery and connection

- `NsdManager.discoverServices("_windowcast._tcp")` with a multicast lock,
  resolving through `registerServiceInfoCallback`, stopped when the Hosts
  screen leaves. Spurious lost/found flaps are debounced by 2 s.
- `ControlClient` wraps an OkHttp WebSocket over TLS with a trust manager that
  pins the paired fingerprint (or accepts and records it during pairing) and
  disables hostname verification. Requests are correlated by id with a 10 s
  timeout; pushes go to a `SharedFlow` that sessions filter by session id.
- If the control connection drops, every open session window shows
  Reconnecting; the registry reconnects with backoff (1, 2, 4, 8 s, up to
  30 s) and restarts each session on its original target, keeping the Android
  windows in place. The host treats the old sessions as `transportFailed`.

### 5.4 Session engine

- One `PeerConnectionFactory` per process (field trial
  `WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/`, hardware decoder factory,
  shared EGL context). Each `SessionEngine` owns its peer connection, the two
  data channels, and stats polling (1 Hz: frames decoded, fps, bitrate, RTT,
  jitter buffer delay).
- Rendering: `SurfaceViewRenderer` in an `AndroidView`, aspect-fit, hardware
  scaler on. The video area's size in device pixels is reported to the host as
  the viewport, debounced 300 ms; in follow mode the same debounce also sends
  `resizeTarget` with the size in points.

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
  capture every key down and up in the focused session window and pass them
  through `KeyTranslator` (section 8), which yields a Mac virtual key and
  flags, a text fallback, or nothing. Esc is consumed so it never becomes
  Back. `setKeyboardCaptureEnabled(true)` (API 37 and later) is applied while
  the session view is focused and the toolbar toggle is on (default on), so
  Alt+Tab and Meta shortcuts go to the Mac; the exact Esc behavior with
  capture on is checked in spike S2.
- IME commits arrive through `onCommitText` of a minimal `InputConnection` and
  become `Text` records.
- Losing window focus sends `ReleaseAll`; regaining focus re-applies keyboard
  capture. Only the focused session window forwards keys.

### 5.6 Persistence

- `HostStore` (DataStore, JSON): host id, name, last address and port,
  certificate fingerprint, per-host settings. Tokens are wrapped by an Android
  Keystore AES key and stored beside them.
- `KeymapStore` (DataStore, JSON): the active preset, the modifier map and the
  rule list; changes apply to open sessions immediately.
- Logs use tag prefix `WC/`.

## 6. Cross-cutting: protocol summary

Details live in `protocol/PROTOCOL.md`; this is the contract.

- Transport: WebSocket over TLS, text frames carry JSON objects with a `type`
  field; requests carry `id` and replies carry `re`; pushes carry neither.
  Binary frames carry a 4-byte big-endian header length, a JSON header and a
  payload (used for thumbnails and icons).
- `protocolVersion` 1 in `hello` and `welcome`; a different major is refused
  with `error` code `version`. Other error codes: `unauthorized`, `busy`,
  `limit`, `notFound`, `permission`, `internal`.
- Client to host: `hello`, `pairRequest`, `pairProof`, `listContent`,
  `subscribeContent`, `unsubscribeContent`, `getThumbnail`, `startSession`
  (target kind and id, viewport, preferences), `sdpAnswer`, `ice`,
  `updateViewport`, `restoreWindow`, `resizeTarget`, `setClipboard`,
  `stopSession`, `ping`. Every session message carries `sessionId`.
- Host to client: `welcome`, `pairChallenge`, `pairResult`, `content`,
  `contentChanged`, thumbnail and icon binary frames, `sessionStarted`
  (session id, source size and scale, title, app), `sdpOffer`, `ice`,
  `sessionState` (capturing, paused, ended, with reason), `sourceChanged`,
  `targetInfo` (title, app), `clipboard`, `error`, `pong`.
- Data channels carry big-endian (network order) binary records, first byte
  the type: `0x01 PointerMove` (x, y as float32 in 0..1, buttons mask),
  `0x02 ButtonDown` and `0x03 ButtonUp` (button, x, y), `0x04 Scroll` (x, y,
  dx, dy, unit, phase), `0x05 KeyDown` and `0x06 KeyUp` (Mac virtual key as
  uint16 with 0xFFFF for none, Mac modifier flags as uint16, repeat as uint8,
  Unicode code point as uint32 or 0), `0x07 Text` (length, UTF-8),
  `0x08 ReleaseAll`. Modifier flag bits: 0 Shift, 1 Control, 2 Option,
  3 Command, 4 Function, 5 Caps Lock. `PointerMove` and `Scroll` use the
  `pointer` channel; the rest use `input`. Button events carry their own
  position so channel reordering cannot misplace a click.

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

## 8. Keyboard translation and remapping

Translation runs on the client in `KeyTranslator`, a pure function from
(Android key code, meta state, repeat, Unicode character) to one of: a Mac
virtual key with flags, a text fallback, or nothing. It is configured by a
`Keymap` value with three parts, edited in Settings, Keyboard:

1. **Preset.** "Mac-style" (default): Ctrl sends Command, Alt sends Option,
   Meta sends Control, Caps Lock stays Caps Lock. "PC-style": Ctrl sends
   Control, Alt sends Option, Meta sends Command. "Custom" unlocks the map
   below with the current values as the starting point.
2. **Modifier map.** For each of Ctrl, Alt, Meta and Caps Lock (both sides
   together), a target of Command, Option, Control, Shift, Function, Caps
   Lock or Nothing. The map applies both to modifier keys pressed on their
   own (they become the matching Mac modifier key so holding them works for
   drag and click modifiers) and to the flags of every other key.
3. **Rules.** An ordered list of "when I press this, send that". The source
   is a physical key plus a set of Android modifiers, captured by pressing
   the combination in a field. The target is a Mac key chosen by name from a
   list, plus Mac modifiers, or "Text" with a string. Rules match on the
   exact modifier set, run before the modifier map, and win over it. Typical
   uses: Delete sends Forward Delete, Alt+Left sends Command+Left, Meta+Space
   sends Command+Space.

The base table maps the US ANSI layout: letters, digits, punctuation, space,
enter, tab, backspace, forward delete, escape, arrows, home, end, page up and
down, F1 to F19, caps lock, both sides of shift, control, alt and meta, and the
numeric keypad. Keys without an entry and without a matching rule fall back to
a `Text` record when the event carries a Unicode character, and are dropped
otherwise. The tables are written from the Android and Carbon HIToolbox
documentation, not copied from GPL projects.

The client never intercepts system-owned combinations it cannot receive; with
keyboard capture on, the ones Android hands over are translated like any
other key. The keymap is global in v1; per-host profiles are phase 2.

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

## 10. Remote access over the internet

Away from home the Googlebook reaches the Mac through a Tailscale tailnet.
Tailscale is free for personal use, and Windowcast runs no servers of its own.
Nothing in the protocol changes: Tailscale gives both machines stable
addresses in 100.64.0.0/10 and MagicDNS names, does the NAT and carrier-grade
NAT traversal (direct WireGuard when it can, its DERP relays when it cannot),
and keeps the host's port reachable only from devices on the tailnet.

### Why Tailscale and not a relay of our own

- A cloud signaling relay plus a TURN server would need a hosted service, a
  domain, credentials on both ends and an internet-exposed host port. That is
  more code and more attack surface than the rest of the MVP together, for a
  single user. It stays in the phase 2 backlog for people who cannot run
  Tailscale.
- Port forwarding with dynamic DNS exposes the host directly and still fails
  behind the carrier-grade NAT that phone hotspots use.
- Tailscale's Android client is an ordinary VPN app from the Play Store with
  app-based split tunneling, and its macOS app ships a status CLI.

### What changes in the host

- Addresses: the host lists its own interface addresses and shows them in
  the popover, labelling any 100.64.0.0/10 address "Remote", plus the MagicDNS
  name when `/Applications/Tailscale.app/Contents/MacOS/Tailscale status
  --json` (or `tailscale` on the PATH) answers. The Bonjour advertisement
  stays LAN-only; remote clients connect by address or name.
- ICE: libwebrtc classifies `utun*` interfaces as VPN adapters and still
  gathers their host candidates; `ignoreVPNNetworkAdapter` stays false and no
  STUN or TURN is configured. The selected pair is Tailscale to Tailscale.
- Remote defaults: when the control connection's peer address is on the
  tailnet, new sessions start at a 12 Mbps cap and 30 fps unless the client's
  per-host settings say otherwise.
- Staying reachable: the host holds an `IOPMAssertion` that prevents idle
  system sleep while any session runs, and the popover warns when the Mac's
  energy settings would let it sleep with the display off, because a sleeping
  Mac cannot be woken from the tailnet.

### What changes in the client

- A saved host keeps several addresses: the LAN address learned from Bonjour
  and any address or name typed under "Add by address". Connecting tries the
  LAN address first with a 1 s timeout, then the others; the Hosts screen
  shows "Online (LAN)", "Online (remote)" or "Offline" from the same probe.
- The Session toolbar shows a "Remote" badge and the live bitrate. The
  Settings sheet gains "Remote quality": Balanced (12 Mbps, 30 fps) or Sharp
  (25 Mbps, 60 fps).
- A network change (Wi-Fi to hotspot) drops the peer connection; the reconnect
  logic of section 5.3 restarts the session on the same target. An ICE restart
  that keeps the session is phase 2.
- With Tailscale's app-based split tunneling only Windowcast has to use the
  VPN; `docs/REMOTE.md` shows the setting, but it is optional.

### Security

The pairing and token model is unchanged. The host's port is reachable from
the LAN and from the tailnet only; `docs/REMOTE.md` includes a Tailscale ACL
that limits port 47900 to the Googlebook. Media stays DTLS-SRTP inside
WireGuard.

### Verified before it is built

Spike S3 in phase 0 proves the path: Tailscale on both devices, the Googlebook
on a phone hotspot, a WebRTC stream over the tailnet, whether the pair is
direct or relayed, and measured latency and bitrate for both.

## 11. Performance targets and tuning

| Metric | Target | How it is met or measured |
|---|---|---|
| Frame rate | 60 fps at up to 2560x1600 output | hardware capture scaling, VideoToolbox, `maxFramerate` 60 |
| Concurrent sessions | 4 windows at 60 fps, 1920x1200 class, without drops; hard limit 6 per client | measured in S2 with three streams; the bitrate cap is shared beyond two |
| Glass-to-glass latency on Wi-Fi | 60 ms typical, 80 ms worst case | playout delay 0/0 on both ends, no upscaling, stats overlay, camera test in S2 |
| Input to visible effect | under 100 ms | unordered pointer channel, HID tap posting |
| Bitrate | 2 to 40 Mbps adaptive per session | BWE bounds, per-host cap |
| Remote session over Tailscale | connects within 5 s; 30 fps at 12 Mbps; latency under 120 ms on a direct WireGuard path | measured in S3 from a phone hotspot, direct and relayed |
| Host CPU while idle in picker | under 5 percent | thumbnails only while subscribed, 2 s cadence |

If measured latency in S2 exceeds target with the stock decoder, the client
wraps MediaCodec in its own decoder factory with `KEY_LOW_LATENCY`; if it still
exceeds target, the transport interface gains a raw H.264-over-TLS
implementation (both sides isolate transport behind a `MediaTransport`
interface from the start).

## 12. Testing strategy

- Shared test vectors in `protocol/testvectors/`: JSON message samples, binary
  input records, pairing proof vectors, coordinate fixtures and keymap cases
  (preset outputs, rule precedence, modifier keys on their own, text
  fallback). Both code bases must pass the ones that apply to them, which
  keeps the two codecs identical.
- Host: `WindowcastCore` is a Swift package holding protocol models, the input
  codec, the coordinate mapper and pairing crypto, tested with `swift test`.
  `SessionRegistryTests` cover the busy and limit rules. `ControlServerTests`
  start the server on an ephemeral port with a fake catalog and drive pairing
  and listing with `URLSessionWebSocketTask`.
- Client: JVM unit tests for the same vectors plus `KeyTranslator`, viewport
  math, the registry's target-to-session map and the stores; Compose UI tests
  for the Picker and the Keyboard settings against `FakeHostApi`; the device
  is the integration target (no emulator required).
- Manual checklist in `docs/TESTING.md`: permissions, pairing, revoke,
  picker, window session, display session, three sessions at once with focus
  switching and typing into each, closing one window while others continue,
  the host's limit message, move across displays, resize, each Resize menu
  item including follow mode, minimize and restore, close, focus loss,
  shortcuts under each preset and a custom rule, scrolling, clipboard,
  reconnect, permission revoked mid-session.
- Spikes S1, S2 and S3 produce numbers and behavior tables before the MVP
  starts.
- Manual checklist additions for M7: connect by Tailscale address from the
  LAN, from a phone hotspot, direct and relayed; Wi-Fi to hotspot switch
  mid-session; host asleep; ACL blocking a second device.

## 13. Repository, tooling, CI and licensing

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

## 14. Delivery phases

Each phase gets its own implementation plan. The phase 1 plan is written after
the spikes report, so their findings feed it.

### Phase 0: spikes (throwaway)

- S1 capture and poke (Mac only): enumerate windows; stream an app-filtered
  crop of a chosen window; log per-frame geometry; observe occluded, minimized,
  other-Space and cross-display behavior; run three such streams at once and
  watch CPU and GPU; raise and activate from a background agent; post a click
  at a computed point in Finder, Safari, Terminal, Chrome and System Settings;
  set a window's size through Accessibility in each. Exit: a behavior table, a
  confirmed mapping formula, and activation and resizing working in all five
  apps or a documented fallback.
- S2 WebRTC loop (Mac to Googlebook): the S1 stream over WebRTC to a bare
  Android activity; latency with and without the playout-delay trials; 60 fps
  at 1920x1200 output; three concurrent streams into three Android windows
  opened with `setLaunchBounds`; H.264 level negotiation and HEVC decode
  availability on the Snapdragon X; behavior of keyboard capture and Esc; the
  local network permission and foreground service in practice; whether
  Android 17 offers any app-initiated window resize. Exit: a numbers table and
  the codec and decoder decisions.
- S3 remote access over Tailscale (Mac to Googlebook on a phone hotspot): the
  S2 stream over the tailnet; which ICE candidates are gathered and selected;
  direct versus DERP-relayed connection; latency and bitrate at 40 Mbps and
  12 Mbps caps; behavior when the Googlebook switches networks mid-stream.
  Exit: a numbers table and the remote defaults for M7.

### Phase 1: MVP, one runnable increment per milestone

- M1 Host foundation: XcodeGen project, menu-bar app, permissions UI, identity
  and TLS, Bonjour, control server, pairing, persistence, `WindowcastCore` with
  tests and shared vectors.
- M2 Client foundation: Gradle project, Hosts screen with discovery and manual
  entry, pairing, token storage, `ControlClient` with tests, `FakeHostApi`.
- M3 Catalog: listing, thumbnails, icons and change pushes on the host; Picker
  on the client.
- M4 Video sessions: capture engine, tracker, per-session WebRTC, session
  registries on both sides, `SessionActivity` per window with launch bounds
  and task descriptions, Picker badges, viewport policy, session states,
  reconnect, foreground service.
- M5 Input and window controls: data channels, injector with global key state,
  `KeyTranslator` with the base table, the Keyboard settings screen (presets,
  modifier map, rules), keyboard capture toggle, scrolling, release-all on
  focus loss, clipboard text, the Resize menu with match, follow and presets.
- M6 Hardening and release: stats overlay, remaining settings,
  permission-revoked handling, CI, README with Googlebook install steps,
  CLAUDE.md, TESTING.md, PICKING-UP.md, v0.1 release.
- M7 Internet access: host address list with Tailscale detection and the
  sleep-prevention assertion; client hosts with several addresses, LAN-first
  connection with fallback, the Remote badge and quality presets; reconnect
  across network changes; `docs/REMOTE.md` with the Tailscale setup and ACL;
  one remote session from outside the home network recorded in TESTING.md;
  v0.2 release.

### Who does what

Claude writes all code, tests, documentation, commits and releases, runs the
Mac-side tools, and installs builds on the Googlebook over Wi-Fi adb. Alex's
part is what only a person at the devices, or the account owner, can do.

| When | Claude | Alex |
|---|---|---|
| Before phase 0 | Sets up the packages and the `wc` helper | Grants Screen Recording and Accessibility to the terminal app when macOS asks; pairs Wireless debugging once with `./wc pair` |
| Phase 0 | Builds and runs the probes, records every number | Puts another app in front during click tests; presses the keys of the keyboard matrix; takes the latency photos; for S3 installs Tailscale on the Mac and the Googlebook, signs both into one tailnet, enables MagicDNS, and puts the Googlebook on a phone hotspot |
| M1 | Host foundation | Signs into Xcode with an Apple ID so a Personal Team certificate exists; approves the host's two permission prompts |
| M2 to M5 | Client, catalog, sessions, input | Tries each milestone build on the Googlebook and says what feels wrong; types the pairing PIN; keeps the Mac awake during test sessions |
| M6 | Hardening, CI, docs, v0.1 | Creates the Android release keystore in `~/.config/windowcast` and keeps a backup; approves the release notes |
| M7 | Remote access code and docs, v0.2 | Keeps Tailscale signed in on both devices; sets the Mac's energy settings so it stays reachable (System Settings, Energy: prevent automatic sleeping when the display is off); runs one remote session from outside the home network and photographs the latency; optionally adds the Tailscale ACL |

### Phase 2 backlog

Remote cursor shapes via `NSCursor.currentSystem`, the Mac menu bar as native
Android menus built from the Accessibility menu tree, HEVC by default where it
measures better, per-app audio, a signaling relay and TURN for people without
Tailscale, ICE restart across network changes, non-US base layouts through
`UCKeyTranslate`, per-host keymap profiles and
separate left and right modifiers, relative mouse mode, "open all windows of
this app", host auto-update.

## 15. Risks and mitigations

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
5. Wi-Fi jitter, worse with several streams. Mitigation: adaptive bitrate, a
   shared cap beyond two sessions, stats overlay, raw-TLS transport as a
   fallback path.
6. Keyboard capture semantics on Googlebook OS (Esc hint) may fight the Mac's
   Esc. Mitigation: S2 measures, toolbar toggle, Esc consumed at dispatch.
7. Snapdragon X decoder quirks, including several decoders at once.
   Mitigation: H.264 default, S2 measurements with three streams, optional
   custom decoder factory.
8. Dependence on a forked libwebrtc distribution. Mitigation: pinned
   versions, transport behind an interface.
9. Keychain and TLS identity friction. Mitigation: regenerate on failure,
   re-pair flow, tested in M1.
10. The remote pointer's shape is not visible in v1. Mitigation: phase 2
    cursor sync; the local arrow is always responsive.
11. Two session windows fighting over which Mac window is in front.
    Mitigation: only clicks and keys raise, never hovering; the injector
    checks at most every 250 ms.
12. Apps that refuse Accessibility resizing make follow mode look broken.
    Mitigation: the tracker reports the real size and the video letterboxes;
    the menu shows the size actually reached.
13. Android cannot resize its own window after launch. Mitigation: size at
    launch from the Mac window, and offer the Mac-side Resize menu; S2 checks
    Android 17 for a new API.
14. WebRTC over Tailscale is reported to fail in some setups when the VPN
    interface's candidates are not gathered or selected. Mitigation: S3 logs
    every candidate and the selected pair; if libwebrtc will not use the
    `utun` candidates, the fallback is media relayed through the control
    connection, designed in phase 2 rather than guessed now.
15. A sleeping Mac is unreachable from the tailnet. Mitigation: the host's
    sleep assertion during sessions, an energy-settings warning in the popover,
    and the setup step in `docs/REMOTE.md`.
16. Tailscale's Android client on Googlebook OS is untested. Mitigation: S3
    installs it first; if it does not run, M7 falls back to a WireGuard
    configuration on the Googlebook or moves to the relay design.

## 16. Open items resolved by spikes, not by review

- Units of `contentRect` when `sourceRect` is set (S1).
- Whether `updateConfiguration` for `sourceRect` alone is cheap at 10 Hz (S1).
- Host cost of three concurrent streams (S1) and their measured latency (S2).
- The decoder flag decision (S2).
- Whether the Googlebook trackpad reports two-finger scroll as touchpad or
  mouse source (S2).
- Whether Android 17 exposes an app-initiated window resize (S2).
- Whether libwebrtc gathers and selects the Tailscale `utun` candidates on both
  platforms, and what a direct versus relayed tailnet path costs in latency and
  bitrate (S3).
- Whether Tailscale's Android app runs on Googlebook OS (S3).

## 17. References

- ScreenCaptureKit: Apple docs and WWDC22 sessions 10155 and 10156; WWDC24
  10088 for the content sharing picker.
- VideoToolbox low-latency rate control: WWDC21 session 10158.
- Accessibility activation caveats: AppKit release notes for macOS 14.
- webrtc-sdk Android and Specs releases 150.7871.01 (LiveKit fork of
  libwebrtc, August 2026); field trials in `rtp_sender_video.cc` and
  `rtp_video_stream_receiver2.cc`.
- Android desktop windowing, multi-instance, local network permission and
  foreground service types: developer.android.com guides for Android 16 and 17.
- Tailscale: Android install and app-based split tunneling docs
  (tailscale.com/docs); libwebrtc `rtc_base/network.cc` classifies `utun*` as
  `ADAPTER_TYPE_VPN` and gathers it unless `ignoreVPNNetworkAdapter` is set.
- Googlebook field notes: `kuscher/vscodebook` docs/GOOGLEBOOK.md; helper
  script and build conventions from `kuscher/studiosnap` and `kuscher/officebook`.
- Prior art examined and rejected as bases: RustDesk (CGDisplayStream capture,
  display-only protocol), Sunshine and Moonlight-Android (experimental macOS
  host, fixed session resolution), Deskreen (view only), Mirador (MIT Swift
  SCK-to-VideoToolbox reference).
