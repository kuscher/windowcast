# Windowcast Phase 0 (Spikes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the questions the spec leaves to spikes S1, S2 and S3 with measured numbers and behavior tables, so the phase 1 plan is written on facts: how ScreenCaptureKit's app-filtered crop behaves, what unit `contentRect` uses, whether raise-and-click works from a background process, what latency, frame rate and keyboard behavior a WebRTC stream to the Googlebook really gets, and whether the same stream works over Tailscale from outside the home network.

**Architecture:** Two throwaway programs. `spikes/macprobe` is a SwiftPM package with a library `ProbeKit` (capture, geometry, tracking, Accessibility, input injection), a CLI `captureprobe` (S1 experiments), a library `ProbeRTC` (WebSocket signaling, encoder factory) and a CLI `webrtcprobe` (S2 host). `spikes/webrtcprobe-android` is a small Kotlin/Compose app that renders the stream in one or three desktop windows and logs input events, stats and permission behavior. Findings go into `docs/superpowers/spikes/2026-09-27-phase0-findings.md`; the code is deleted at the end of phase 0 and lives on in git history.

**Tech Stack:** Swift 6.4 toolchain (Swift 5 language mode), SwiftPM, ScreenCaptureKit, CoreGraphics events, Accessibility API, Network.framework WebSocket, libwebrtc `webrtc-sdk/Specs` 150.7871.01; Kotlin 2.4.20, AGP 9.4.1, Gradle 9.8.0, compileSdk 37, Compose BOM 2026.09.00, OkHttp 5.5.0, `io.github.webrtc-sdk:android:150.7871.01`.

**Spec:** `docs/superpowers/specs/2026-09-27-windowcast-design.md` (sections 4.5 to 4.8, 7, 10, 11, 14 "Phase 0" and "Who does what", 16).

## Global Constraints

- Spike code lives only under `spikes/` and is removed by the last task of this plan; nothing in it is shipped.
- macOS package platform `.macOS(.v15)`; run on macOS 26.6.2. Android `compileSdk = 37`, `targetSdk = 37`, `minSdk = 34`, AGP `9.4.1`, Kotlin `2.4.20`, Compose BOM `2026.09.00`, Gradle `9.8.0`.
- libwebrtc version `150.7871.01` on both sides (`https://github.com/webrtc-sdk/Specs.git` exact, and `io.github.webrtc-sdk:android`).
- Android package `io.github.kuscher.windowcast.spike` so it never collides with the real client `io.github.kuscher.windowcast`.
- The spike signaling port is `47901`; `47900` stays reserved for the real host.
- The Googlebook runs apps as user 10: every `am`/`pm` call uses `--user current`. adb is `$HOME/Library/Android/sdk/platform-tools/adb`, reached through `./wc`.
- Field trials, verbatim: host `WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/`, client `WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/`.
- No code copied from GPL projects (Moonlight, Sunshine, RustDesk). Reading them for ideas is fine.
- Every task ends with a commit on `main` and a push (`git push`), as in the sibling projects.
- Screen Recording and Accessibility are granted to the app that launches the CLIs (the terminal hosting the session). Both grants can be revoked after phase 0.

## Review Focus

1. A window at negative coordinates or on a second display: the mapper must add the display origin, not assume (0,0). Pinned by `testNegativeDisplayOriginOffsetsGlobalPoint` in Task 1.
2. A viewport smaller than 64 px or with odd dimensions: the output size must stay even and at least 64x64 or the encoder rejects it. Pinned by `testRoundsToEvenAndKeepsMinimum` in Task 1.
3. Screen Recording denied or revoked: the tools must print what to enable instead of a bare error code. Pinned by the denial check in Task 2 step 6.
4. Red content elsewhere in the frame or no marker at all: the self-test must report "NEITHER" rather than pass on a wrong centroid. Pinned by `testIgnoresDarkRedAndReportsNilWhenAbsent` in Task 4.
5. The Android app dies mid-stream: the host must stop capturing that session within seconds instead of streaming into a closed socket forever. Pinned by Task 9 step 9.

---

## Who does what

Claude runs every step below unless the step says **Alex:**. Those steps need a person at the devices or the owner of an account. They are collected here so a session can be planned; each also appears inline in its task.

| Task | Alex |
|---|---|
| 2 | Grant Screen Recording to the terminal app when macOS asks (step 4); briefly revoke and restore it for the denial check (step 6). |
| 4 | Nothing; the self-test drives its own window. |
| 5 | Grant Accessibility when asked (step 3); during each `poke`, click another app within 3 s so the target is behind it (steps 4 and 5); watch where the click lands. |
| 6 | Start a video in Safari and in Chrome and `top -s 0` in Terminal so three windows animate. |
| 8 | On the Googlebook: turn on Wireless debugging and read out the pairing code (step 2); tap the permission and window buttons (step 7). |
| 9 | Enter the Mac's IP on the Googlebook; move the mouse, scroll with the trackpad and a mouse, press each key of the keyboard matrix with capture on and off (steps 5 to 7); open Safari's menus on the Mac (step 8). |
| 10 | Install Tailscale on the Mac (App Store) and on the Googlebook (Play Store), sign both into one tailnet, enable MagicDNS in the admin console (step 1); put the Googlebook on a phone hotspot (step 5); turn the Googlebook's Wi-Fi on and off during a stream (step 6). |
| 11 | Take 10 burst photos per configuration with a phone, Mac timer and Googlebook side by side (steps 1 and 2); quit and reopen the probe app when a switch changes (steps 1 and 2). |

Everything else, including builds, installs over Wi-Fi adb, log reading, filling the findings file and the commits, is Claude's.

---

### Task 1: Spike package, geometry math and the findings template

**Files:**
- Create: `spikes/README.md`
- Create: `spikes/macprobe/Package.swift`
- Create: `spikes/macprobe/Sources/ProbeKit/Geometry.swift`
- Create: `spikes/macprobe/Sources/captureprobe/main.swift` (placeholder that prints usage; filled in Task 2)
- Create: `spikes/macprobe/Tests/ProbeKitTests/GeometryTests.swift`
- Create: `docs/superpowers/spikes/2026-09-27-phase0-findings.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `FrameGeometry(surfaceSize:contentRect:contentScale:scaleFactor:)`, `ContentRectUnit` (`.points`, `.pixels`), `StreamMapper(sourceOrigin:sourceSize:geometry:unit:)` with `sourcePoint(nx:ny:) -> CGPoint`, `globalPoint(nx:ny:) -> CGPoint`, `surfacePixel(forSourcePoint:) -> CGPoint`; `OutputSizePolicy.outputSize(source:viewport:) -> CGSize`, `OutputSizePolicy.shouldApply(current:proposed:) -> Bool`.

- [ ] **Step 1: Add ignore rules and the spike README**

Append to `.gitignore`:

```gitignore

# Spikes (throwaway)
spikes/macprobe/.build/
spikes/webrtcprobe-android/.gradle/
spikes/webrtcprobe-android/**/build/
spikes/webrtcprobe-android/local.properties
spikes/webrtcprobe-android/.kotlin/
```

Create `spikes/README.md`:

```markdown
# Phase 0 spikes (throwaway)

Two probes that answer the open questions in the design spec before the real
code is written. Results are recorded in
`docs/superpowers/spikes/2026-09-27-phase0-findings.md`. This directory is
deleted at the end of phase 0; the code stays in git history.

- `macprobe/` (SwiftPM): `captureprobe` for ScreenCaptureKit, geometry and
  input experiments (S1); `webrtcprobe` streams a window over WebRTC (S2 host).
- `webrtcprobe-android/` (Gradle): the S2 client for the Googlebook.

Run everything from the repo root: `swift run --package-path spikes/macprobe
captureprobe list`, `./wc spike-app`. Screen Recording and Accessibility are
granted to the app that launched the terminal.
```

- [ ] **Step 2: Create the package manifest**

Create `spikes/macprobe/Package.swift`:

```swift
// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "macprobe",
    platforms: [.macOS(.v15)],
    targets: [
        .target(
            name: "ProbeKit",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
            ]
        ),
        .executableTarget(name: "captureprobe", dependencies: ["ProbeKit"]),
        .testTarget(name: "ProbeKitTests", dependencies: ["ProbeKit"]),
    ]
)
```

Create `spikes/macprobe/Sources/captureprobe/main.swift` (temporary, replaced in Task 2):

```swift
print("captureprobe: commands arrive in Task 2")
```

- [ ] **Step 3: Write the failing geometry tests**

Create `spikes/macprobe/Tests/ProbeKitTests/GeometryTests.swift`:

```swift
import XCTest
@testable import ProbeKit

final class StreamMapperTests: XCTestCase {
    // 800x500 pt source rendered 1:1 into a 1600x1000 px surface on a 2x display.
    private let full = FrameGeometry(surfaceSize: CGSize(width: 1600, height: 1000),
                                     contentRect: CGRect(x: 0, y: 0, width: 800, height: 500),
                                     contentScale: 1, scaleFactor: 2)
    // 2000x1000 pt source letterboxed into a 1000x1000 px surface at 1x: content 1000x500 at y=250.
    private let letterbox = FrameGeometry(surfaceSize: CGSize(width: 1000, height: 1000),
                                          contentRect: CGRect(x: 0, y: 250, width: 1000, height: 500),
                                          contentScale: 0.5, scaleFactor: 1)

    func testFullSurfaceMapsCornersAndCenter() {
        let m = StreamMapper(sourceOrigin: CGPoint(x: 100, y: 50), sourceSize: CGSize(width: 800, height: 500), geometry: full)
        XCTAssertEqual(m.globalPoint(nx: 0, ny: 0), CGPoint(x: 100, y: 50))
        XCTAssertEqual(m.globalPoint(nx: 1, ny: 1), CGPoint(x: 900, y: 550))
        XCTAssertEqual(m.globalPoint(nx: 0.5, ny: 0.5), CGPoint(x: 500, y: 300))
    }

    func testLetterboxedSurface() {
        let m = StreamMapper(sourceOrigin: .zero, sourceSize: CGSize(width: 2000, height: 1000), geometry: letterbox)
        XCTAssertEqual(m.globalPoint(nx: 0, ny: 0.25), CGPoint(x: 0, y: 0))
        XCTAssertEqual(m.globalPoint(nx: 1, ny: 0.75), CGPoint(x: 2000, y: 1000))
        XCTAssertEqual(m.globalPoint(nx: 0.5, ny: 0.5), CGPoint(x: 1000, y: 500))
    }

    func testPointsInTheLetterboxBarsClampToTheSourceEdge() {
        let m = StreamMapper(sourceOrigin: .zero, sourceSize: CGSize(width: 2000, height: 1000), geometry: letterbox)
        XCTAssertEqual(m.globalPoint(nx: 0.5, ny: 0).y, 0)
        XCTAssertEqual(m.globalPoint(nx: 0.5, ny: 1).y, 1000)
    }

    func testPixelUnitHypothesisDividesContentRectByScaleFactor() {
        let g = FrameGeometry(surfaceSize: CGSize(width: 1600, height: 1000),
                              contentRect: CGRect(x: 0, y: 0, width: 1600, height: 1000),
                              contentScale: 1, scaleFactor: 2)
        let m = StreamMapper(sourceOrigin: .zero, sourceSize: CGSize(width: 800, height: 500), geometry: g, unit: .pixels)
        XCTAssertEqual(m.globalPoint(nx: 1, ny: 1), CGPoint(x: 800, y: 500))
    }

    func testNegativeDisplayOriginOffsetsGlobalPoint() {
        let g = FrameGeometry(surfaceSize: CGSize(width: 800, height: 500),
                              contentRect: CGRect(x: 0, y: 0, width: 800, height: 500),
                              contentScale: 1, scaleFactor: 1)
        let m = StreamMapper(sourceOrigin: CGPoint(x: -1920, y: -200), sourceSize: CGSize(width: 800, height: 500), geometry: g)
        XCTAssertEqual(m.globalPoint(nx: 0.5, ny: 0.5), CGPoint(x: -1520, y: 50))
    }

    func testSurfacePixelIsTheInverseOfSourcePoint() {
        let m = StreamMapper(sourceOrigin: .zero, sourceSize: CGSize(width: 2000, height: 1000), geometry: letterbox)
        let p = m.sourcePoint(nx: 0.3, ny: 0.6)
        let px = m.surfacePixel(forSourcePoint: p)
        XCTAssertEqual(px.x, 300, accuracy: 0.01)
        XCTAssertEqual(px.y, 600, accuracy: 0.01)
    }
}

final class OutputSizePolicyTests: XCTestCase {
    func testFitsDownPreservingAspect() {
        XCTAssertEqual(OutputSizePolicy.outputSize(source: CGSize(width: 3200, height: 2000), viewport: CGSize(width: 1600, height: 1200)),
                       CGSize(width: 1600, height: 1000))
    }

    func testNeverUpscales() {
        XCTAssertEqual(OutputSizePolicy.outputSize(source: CGSize(width: 800, height: 500), viewport: CGSize(width: 1600, height: 1200)),
                       CGSize(width: 800, height: 500))
    }

    func testRoundsToEvenAndKeepsMinimum() {
        XCTAssertEqual(OutputSizePolicy.outputSize(source: CGSize(width: 1601, height: 1001), viewport: CGSize(width: 4000, height: 4000)),
                       CGSize(width: 1600, height: 1000))
        XCTAssertEqual(OutputSizePolicy.outputSize(source: CGSize(width: 10, height: 10), viewport: CGSize(width: 4000, height: 4000)),
                       CGSize(width: 64, height: 64))
    }

    func testHysteresis() {
        let current = CGSize(width: 1600, height: 1000)
        XCTAssertFalse(OutputSizePolicy.shouldApply(current: current, proposed: CGSize(width: 1616, height: 1010)))  // 1 percent
        XCTAssertTrue(OutputSizePolicy.shouldApply(current: current, proposed: CGSize(width: 1660, height: 1000)))   // 3.75 percent
        XCTAssertTrue(OutputSizePolicy.shouldApply(current: current, proposed: CGSize(width: 1620, height: 1000)))   // aspect 1.25 percent
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `swift test --package-path spikes/macprobe 2>&1 | tail -5`
Expected: compile error `cannot find 'FrameGeometry' in scope` (the target has no sources yet).

- [ ] **Step 5: Implement Geometry.swift**

Create `spikes/macprobe/Sources/ProbeKit/Geometry.swift`:

```swift
import CoreGraphics

/// What ScreenCaptureKit attaches to every frame, plus the surface size.
public struct FrameGeometry: Equatable {
    public var surfaceSize: CGSize    // output surface, pixels
    public var contentRect: CGRect    // SCStreamFrameInfo.contentRect exactly as delivered
    public var contentScale: CGFloat  // SCStreamFrameInfo.contentScale
    public var scaleFactor: CGFloat   // SCStreamFrameInfo.scaleFactor (points -> pixels)

    public init(surfaceSize: CGSize, contentRect: CGRect, contentScale: CGFloat, scaleFactor: CGFloat) {
        self.surfaceSize = surfaceSize
        self.contentRect = contentRect
        self.contentScale = contentScale
        self.scaleFactor = scaleFactor
    }
}

/// Which unit `contentRect` is expressed in. Spike S1 decides; the spec assumes `.points`.
public enum ContentRectUnit: String { case points, pixels }

/// Maps normalized client coordinates to global CoreGraphics points (top-left origin).
public struct StreamMapper {
    public var sourceOrigin: CGPoint   // global CG point of the source rect's top-left corner
    public var sourceSize: CGSize      // source rect size in points
    public var geometry: FrameGeometry
    public var unit: ContentRectUnit

    public init(sourceOrigin: CGPoint, sourceSize: CGSize, geometry: FrameGeometry, unit: ContentRectUnit = .points) {
        self.sourceOrigin = sourceOrigin
        self.sourceSize = sourceSize
        self.geometry = geometry
        self.unit = unit
    }

    /// The content rect in surface points, whatever unit it was delivered in.
    var contentRectPoints: CGRect {
        switch unit {
        case .points:
            return geometry.contentRect
        case .pixels:
            let s = geometry.scaleFactor
            return CGRect(x: geometry.contentRect.minX / s, y: geometry.contentRect.minY / s,
                          width: geometry.contentRect.width / s, height: geometry.contentRect.height / s)
        }
    }

    /// Source point (relative to the source rect, in points) for normalized coordinates in 0...1.
    public func sourcePoint(nx: CGFloat, ny: CGFloat) -> CGPoint {
        let r = contentRectPoints
        let sx = nx * geometry.surfaceSize.width / geometry.scaleFactor
        let sy = ny * geometry.surfaceSize.height / geometry.scaleFactor
        let x = (sx - r.minX) / geometry.contentScale
        let y = (sy - r.minY) / geometry.contentScale
        return CGPoint(x: min(max(x, 0), sourceSize.width), y: min(max(y, 0), sourceSize.height))
    }

    public func globalPoint(nx: CGFloat, ny: CGFloat) -> CGPoint {
        let p = sourcePoint(nx: nx, ny: ny)
        return CGPoint(x: sourceOrigin.x + p.x, y: sourceOrigin.y + p.y)
    }

    /// Inverse of `sourcePoint`: where a source point lands in the surface, in pixels.
    public func surfacePixel(forSourcePoint p: CGPoint) -> CGPoint {
        let r = contentRectPoints
        let sx = p.x * geometry.contentScale + r.minX
        let sy = p.y * geometry.contentScale + r.minY
        return CGPoint(x: sx * geometry.scaleFactor, y: sy * geometry.scaleFactor)
    }
}

public enum OutputSizePolicy {
    public static let minimumSide: CGFloat = 64

    /// Fit `source` (pixels) into `viewport` (pixels) without upscaling; even dimensions; at least 64x64.
    public static func outputSize(source: CGSize, viewport: CGSize) -> CGSize {
        var scale: CGFloat = 1
        if source.width > viewport.width || source.height > viewport.height {
            scale = min(viewport.width / source.width, viewport.height / source.height)
        }
        let w = max(minimumSide, (source.width * scale).rounded(.down))
        let h = max(minimumSide, (source.height * scale).rounded(.down))
        return CGSize(width: even(w), height: even(h))
    }

    /// Apply when a side changes by more than 2 percent or the aspect ratio by more than 1 percent.
    public static func shouldApply(current: CGSize, proposed: CGSize) -> Bool {
        guard current.width > 0, current.height > 0, proposed.height > 0 else { return true }
        let dw = abs(proposed.width - current.width) / current.width
        let dh = abs(proposed.height - current.height) / current.height
        let currentAspect = current.width / current.height
        let aspectDelta = abs(proposed.width / proposed.height - currentAspect) / currentAspect
        return dw > 0.02 || dh > 0.02 || aspectDelta > 0.01
    }

    static func even(_ v: CGFloat) -> CGFloat {
        let i = Int(v)
        return CGFloat(i - (i % 2))
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `swift test --package-path spikes/macprobe 2>&1 | tail -3`
Expected: `Executed 10 tests, with 0 failures`.

- [ ] **Step 7: Create the findings template**

Create `docs/superpowers/spikes/2026-09-27-phase0-findings.md`:

```markdown
# Phase 0 findings

Filled in while executing `docs/superpowers/plans/2026-09-27-phase0-spikes.md`.
Every number was measured on the Mac Studio (macOS 26.6.2) and the HP
Googlebook 14 unless a row says otherwise. Spike code: see the commit named in
the last section.

## S1 capture and poke

### Behavior of the three filters (`captureprobe probe`)

| Situation | appcrop (display + app + sourceRect) | independent (desktopIndependentWindow) | display |
|---|---|---|---|
| Another app's window covers the target | | | |
| Target minimized | | | |
| Target moved to another Space | | | |
| Target moved on the same display | | | |
| Target resized | | | |
| Target closed | | | |
| Menu or popover opened from the target | | | |

### Frame geometry (`captureprobe selftest`)

- `contentRect` unit:
- Marker error per size, px:
- `updateConfiguration` with `sourceRect` only: ms
- `updateConfiguration` with width and height: ms
- Button click through the mapper: hit / missed

### Activation and clicks (`captureprobe poke`, target behind another app)

| App | AXFrontmost | AXRaise | activate() | Frontmost after | Click landed | Typed text verified |
|---|---|---|---|---|---|---|
| Finder | | | | | | n/a |
| Safari | | | | | | n/a |
| Terminal | | | | | | |
| Google Chrome | | | | | | n/a |
| System Settings | | | | | | n/a |
| TextEdit | | | | | | |

### Resizing through Accessibility (`captureprobe resize`)

| App | AXError | Requested | Resulting bounds |
|---|---|---|---|
| Finder | | | |
| Safari | | | |
| Terminal | | | |
| Google Chrome | | | |
| System Settings | | | |
| TextEdit | | | |

### Three concurrent streams (`captureprobe multi`)

- Windows used:
- fps per stream:
- Process CPU percent:
- WindowServer CPU percent (Activity Monitor):

## S2 WebRTC loop

### Latency (camera method, 10 photos each, ms)

| Configuration | median | min | max | jitter buffer ms/frame | decode ms | ICE RTT ms | data channel RTT ms |
|---|---|---|---|---|---|---|---|
| A: trials on both ends, H.264 level 5.2 | | | | | | | |
| B: trials off on both ends | | | | | | | |
| C: HEVC | | | | | | | |
| D: H.264 default level 3.1 | | | | | | | |

### Frame rate at 1920x1200 output (display stream)

- Host `sent fps`, `qualityLimitationReason`:
- Client `framesPerSecond`, decoder implementation:

### Three windows

- All three render:
- fps per window:
- Host process CPU and WindowServer CPU:
- Launch bounds honored (position, size):

### Codec negotiation

- Offer lines:
- Answer lines:
- Stats `codec` with level lifted / not lifted:
- HEVC decoders on the Googlebook (`MainActivity` report):

### Keyboard capture matrix (StreamActivity focused)

| Key | capture on: reaches app? system reaction | capture off |
|---|---|---|
| Esc | | |
| Alt+Tab | | |
| Meta alone | | |
| Meta+Space | | |
| Ctrl+W | | |
| Meta+Esc | | |
| F11 | | |
| Ctrl+Alt+Delete | | |

### Trackpad and mouse scroll events

- Two-finger trackpad scroll: source, axis values per event:
- Mouse wheel: source, axis values per notch:

### Local network permission and foreground service

- First launch prompt:
- With the permission denied:
- `startForeground(connectedDevice)` result:

### Android app-initiated window resize API

- Searched SDK 37 for:
- Result:

## S3 remote access over Tailscale

### Setup

- Tailscale versions (Mac, Googlebook) and whether the Android app runs on Googlebook OS:
- Mac tailnet address and MagicDNS name:
- Googlebook network during the remote runs (carrier, hotspot device):

### Candidates and selected pair

| Run | Host local candidates (types, addresses) | Client local candidates | Selected pair (local -> remote, networkType) | `tailscale status`: direct or relay |
|---|---|---|---|---|
| Googlebook on home Wi-Fi, connecting to the 100.x address | | | | |
| Googlebook on phone hotspot | | | | |

### Remote numbers (phone hotspot, timer window)

| Configuration | connect time s | median latency ms | min | max | fps | target Mbps | jitter buffer ms/frame | ICE RTT ms |
|---|---|---|---|---|---|---|---|---|
| 40 Mbps cap, 60 fps (defaults) | | | | | | | | |
| 12 Mbps cap, 30 fps (proposed remote default) | | | | | | | | |
| relayed path (if a relay was observed) | | | | | | | | |

### Network switch mid-stream

- Wi-Fi turned back on during a hotspot stream: what happened, after how many seconds:
- Reconnect by reopening the window worked:

## Decisions for phase 1

- Capture filter for window sessions:
- `contentRect` unit:
- Codec, level and decoder factory:
- Field trials:
- Keyboard capture default and Esc handling:
- Remote defaults for M7 (cap, fps, connect timeout) and whether Tailscale is confirmed as the path:
- Anything that changes the spec:
- Spike code commit:
```

- [ ] **Step 8: Commit**

```bash
git add .gitignore spikes docs/superpowers/spikes
git commit -m "spike: macprobe package with geometry math and the phase 0 findings template"
git push
```

---

### Task 2: Enumerate windows and displays (`captureprobe list`)

**Files:**
- Create: `spikes/macprobe/Sources/ProbeKit/ShareableContent.swift`
- Create: `spikes/macprobe/Sources/captureprobe/Commands.swift`
- Create: `spikes/macprobe/Sources/captureprobe/Commands+List.swift`
- Modify: `spikes/macprobe/Sources/captureprobe/main.swift` (replace the placeholder)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProbeError` (`.windowNotFound(CGWindowID)`, `.noDisplay`, `.usage(String)`); `Shareable.content() async throws -> SCShareableContent`, `Shareable.window(_:in:) throws -> SCWindow`, `Shareable.display(for:in:) throws -> SCDisplay`, `Shareable.backingScale(of:) -> CGFloat`, `Shareable.listableWindows(in:) -> [SCWindow]`, `Shareable.table(_:) -> String`, `Shareable.fmt(_ rect: CGRect) -> String`; in the CLI, `Args.all`, `Args.option(_:)`, `Args.flag(_:)`, `Args.parseSize(_:)`, `usage() -> Never`, `now() -> Double`, `f1(_:) -> String`, `Commands` enum.

- [ ] **Step 1: Write ShareableContent.swift**

Create `spikes/macprobe/Sources/ProbeKit/ShareableContent.swift`:

```swift
import ScreenCaptureKit
import AppKit

public enum ProbeError: Error, CustomStringConvertible {
    case windowNotFound(CGWindowID)
    case noDisplay
    case usage(String)

    public var description: String {
        switch self {
        case .windowNotFound(let id): return "no window with id \(id); run `captureprobe list`"
        case .noDisplay: return "no display found"
        case .usage(let s): return s
        }
    }
}

public enum Shareable {
    /// All windows, including off-screen ones, and all displays. Triggers the Screen Recording prompt on first use.
    public static func content() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch let e as NSError where e.domain == SCStreamErrorDomain && e.code == -3801 {
            // -3801 = SCStreamErrorUserDeclined
            throw ProbeError.usage("""
            Screen Recording is not allowed for the app that launched this tool.
            Open System Settings > Privacy & Security > Screen & System Audio Recording, enable that app \
            (the terminal you are running in), quit and reopen it, then run again. (\(e.localizedDescription))
            """)
        }
    }

    public static func window(_ id: CGWindowID, in content: SCShareableContent) throws -> SCWindow {
        guard let w = content.windows.first(where: { $0.windowID == id }) else { throw ProbeError.windowNotFound(id) }
        return w
    }

    /// The display whose frame contains the window's center; falls back to the first display.
    public static func display(for window: SCWindow, in content: SCShareableContent) throws -> SCDisplay {
        let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
        if let d = content.displays.first(where: { $0.frame.contains(center) }) { return d }
        guard let d = content.displays.first else { throw ProbeError.noDisplay }
        return d
    }

    /// Pixels per point of the NSScreen backing this display (2 on the Studio Display, 1 on non-Retina).
    public static func backingScale(of display: SCDisplay) -> CGFloat {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        let screen = NSScreen.screens.first { ($0.deviceDescription[key] as? NSNumber)?.uint32Value == display.displayID }
        return screen?.backingScaleFactor ?? 2
    }

    /// Windows worth listing: layer 0, at least 100x50 points, with an owning app, not this process.
    public static func listableWindows(in content: SCShareableContent) -> [SCWindow] {
        let me = ProcessInfo.processInfo.processIdentifier
        return content.windows
            .filter { w in
                w.windowLayer == 0 && w.frame.width >= 100 && w.frame.height >= 50
                    && w.owningApplication != nil && w.owningApplication?.processID != me
            }
            .sorted { a, b in
                (a.owningApplication?.applicationName ?? "", a.title ?? "") < (b.owningApplication?.applicationName ?? "", b.title ?? "")
            }
    }

    public static func table(_ content: SCShareableContent) -> String {
        var out = "DISPLAYS  (id  points  frame  scale)\n"
        for d in content.displays {
            out += "  \(d.displayID)\t\(d.width)x\(d.height)\t\(fmt(d.frame))\t\(backingScale(of: d))x\n"
        }
        out += "WINDOWS  (id  app  title  frame  on-screen)\n"
        for w in listableWindows(in: content) {
            out += "  \(w.windowID)\t\(w.owningApplication?.applicationName ?? "?")\t\(w.title ?? "")\t\(fmt(w.frame))\t\(w.isOnScreen ? "on" : "OFF")\n"
        }
        return out
    }

    public static func fmt(_ r: CGRect) -> String {
        "(\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height)))"
    }
}
```

- [ ] **Step 2: Write the CLI skeleton**

Create `spikes/macprobe/Sources/captureprobe/Commands.swift`:

```swift
import Foundation
import ProbeKit

enum Args {
    static let all = Array(CommandLine.arguments.dropFirst())

    static func option(_ name: String) -> String? {
        guard let i = all.firstIndex(of: name), i + 1 < all.count else { return nil }
        return all[i + 1]
    }

    static func flag(_ name: String) -> Bool { all.contains(name) }

    /// "1200x800" -> CGSize(1200, 800)
    static func parseSize(_ s: String?) -> CGSize? {
        guard let s, let x = s.firstIndex(of: "x"),
              let w = Double(s[..<x]), let h = Double(s[s.index(after: x)...]) else { return nil }
        return CGSize(width: w, height: h)
    }
}

let startTime = CFAbsoluteTimeGetCurrent()
func now() -> Double { CFAbsoluteTimeGetCurrent() - startTime }
func f1(_ d: Double) -> String { String(format: "%.1f", d) }

func usage() -> Never {
    print("""
    usage: captureprobe list
           captureprobe probe <windowID> [--mode appcrop|display|independent] [--seconds 30] [--out WxH]
           captureprobe selftest [--sizes 800x500,1200x900,500x400]
           captureprobe poke <windowID> --at nx,ny [--click] [--type TEXT] [--scroll DY] [--delay 3]
           captureprobe resize <windowID> WxH
           captureprobe multi <id1,id2,id3> [--seconds 20] [--out WxH]
    """)
    exit(64)
}

enum Commands {}
```

Create `spikes/macprobe/Sources/captureprobe/Commands+List.swift`:

```swift
import Foundation
import ProbeKit

extension Commands {
    static func list() async throws {
        let content = try await Shareable.content()
        print(Shareable.table(content))
    }
}
```

Replace `spikes/macprobe/Sources/captureprobe/main.swift`:

```swift
import Foundation
import AppKit
import ProbeKit

// Commands are async; they run in a Task while AppKit's run loop keeps the process alive
// (the self-test opens a window and clicks need a run loop).
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

Task {
    do {
        switch Args.all.first ?? "" {
        case "list": try await Commands.list()
        default: usage()
        }
        exit(0)
    } catch {
        fputs("error: \(error)\n", stderr)
        exit(1)
    }
}

app.run()
```

- [ ] **Step 3: Build**

Run: `swift build --package-path spikes/macprobe 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 4: Run list and grant Screen Recording when asked**

Run: `swift run --package-path spikes/macprobe captureprobe list`
Expected on the first run: macOS shows the Screen Recording prompt for the app that launched the terminal, or the tool prints the "Screen Recording is not allowed" instructions. Grant it in System Settings, quit and reopen that app, run again.
Expected afterwards: a `DISPLAYS` block with one line for the 5K display (for example `... 2560x1440 ((0,0 2560x1440)) 2.0x`, depending on the chosen scaling), and a `WINDOWS` block listing Finder, Safari, Terminal and other windows with ids.

- [ ] **Step 5: Verify off-screen windows are included**

Minimize any window (for example a Finder window), run `list` again.
Expected: that window is still listed, with `OFF` in the last column.

- [ ] **Step 6: Verify the denial message (Review Focus 3)**

In System Settings, turn Screen Recording off for the launching app, quit and reopen it, run `list`.
Expected: the tool exits with the multi-line "Screen Recording is not allowed..." message and no stack trace. Turn the permission back on, quit and reopen the app before continuing.

- [ ] **Step 7: Commit**

```bash
git add spikes/macprobe
git commit -m "spike: captureprobe list enumerates windows and displays"
git push
```

---

### Task 3: Stream one window three ways and watch it (`captureprobe probe`)

**Files:**
- Create: `spikes/macprobe/Sources/ProbeKit/CaptureStream.swift`
- Create: `spikes/macprobe/Sources/ProbeKit/WindowTracker.swift`
- Create: `spikes/macprobe/Sources/ProbeKit/Stats.swift`
- Create: `spikes/macprobe/Sources/captureprobe/Commands+Probe.swift`
- Modify: `spikes/macprobe/Sources/captureprobe/main.swift` (add the `probe` case)

**Interfaces:**
- Consumes: `Shareable`, `FrameGeometry`, `Args`, `usage()`, `now()`, `f1(_:)`.
- Produces: `CaptureMode` (`.appcrop`, `.display`, `.independent`); `CapturedFrame` (`pixelBuffer`, `status: SCFrameStatus`, `geometry: FrameGeometry`, `screenRect: CGRect?`, `presentationTime: CMTime`); `CaptureStream(window:display:mode:outputSize:fps:pixelFormat:showsCursor:) throws` with `onFrame`, `onStop`, `start() async throws`, `stop() async`, `updateSourceRect(_:) async throws -> TimeInterval`, `updateOutputSize(_:) async throws -> TimeInterval`, `sourceRect: CGRect`, `sourceOrigin: CGPoint`, `displayFrame: CGRect`, `outputSize: CGSize`; `WindowState` (`bounds`, `isOnScreen`, `ownerPID`, `title`) and `WindowTracker.state(of:) -> WindowState?`; `RateCounter` (`tick()`, `perSecond`), `ProcessCPU.seconds() -> Double`, `statusName(_:) -> String`.

- [ ] **Step 1: Write CaptureStream.swift**

Create `spikes/macprobe/Sources/ProbeKit/CaptureStream.swift`:

```swift
import ScreenCaptureKit
import CoreMedia
import CoreVideo

public enum CaptureMode: String {
    case appcrop      // display filter including only the owning app, cropped with sourceRect (the spec's choice)
    case display      // whole display
    case independent  // SCContentFilter(desktopIndependentWindow:)
}

public struct CapturedFrame {
    public let pixelBuffer: CVPixelBuffer
    public let status: SCFrameStatus
    public let geometry: FrameGeometry
    public let screenRect: CGRect?
    public let presentationTime: CMTime
}

public func statusName(_ s: SCFrameStatus) -> String {
    switch s {
    case .complete: return "complete"
    case .idle: return "idle"
    case .blank: return "blank"
    case .suspended: return "suspended"
    case .started: return "started"
    case .stopped: return "stopped"
    @unknown default: return "unknown(\(s.rawValue))"
    }
}

public final class CaptureStream: NSObject, SCStreamOutput, SCStreamDelegate {
    public let mode: CaptureMode
    public let displayFrame: CGRect                 // global points
    public private(set) var sourceRect: CGRect      // display-local points that we asked SCK to crop
    public private(set) var outputSize: CGSize
    public var onFrame: ((CapturedFrame) -> Void)?
    public var onStop: ((Error?) -> Void)?

    private let filter: SCContentFilter
    private let configuration: SCStreamConfiguration
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "windowcast.probe.capture")

    public init(window: SCWindow?, display: SCDisplay, mode: CaptureMode, outputSize: CGSize,
                fps: Int = 60, pixelFormat: OSType = kCVPixelFormatType_32BGRA, showsCursor: Bool = false) throws {
        self.mode = mode
        self.displayFrame = display.frame
        self.outputSize = outputSize
        switch mode {
        case .appcrop:
            guard let window, let app = window.owningApplication else { throw ProbeError.usage("appcrop needs a window with an owning app") }
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        case .display:
            filter = SCContentFilter(display: display, excludingWindows: [])
            sourceRect = CGRect(origin: .zero, size: display.frame.size)
        case .independent:
            guard let window else { throw ProbeError.usage("independent needs a window") }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceRect = CGRect(origin: .zero, size: window.frame.size)
        }
        let config = SCStreamConfiguration()
        config.width = Int(outputSize.width)
        config.height = Int(outputSize.height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.queueDepth = 5
        config.pixelFormat = pixelFormat
        config.showsCursor = showsCursor
        config.scalesToFit = true
        config.preservesAspectRatio = true
        if mode == .appcrop { config.sourceRect = sourceRect }
        configuration = config
        super.init()
    }

    /// Global CG origin of the source rect, for StreamMapper.
    public var sourceOrigin: CGPoint {
        CGPoint(x: displayFrame.minX + sourceRect.minX, y: displayFrame.minY + sourceRect.minY)
    }

    public func start() async throws {
        let s = SCStream(filter: filter, configuration: configuration, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
    }

    public func stop() async {
        guard let s = stream else { return }
        try? await s.stopCapture()
        stream = nil
    }

    /// Re-crops (appcrop only). Returns how long `updateConfiguration` took.
    @discardableResult
    public func updateSourceRect(_ rect: CGRect) async throws -> TimeInterval {
        guard mode == .appcrop, let s = stream else { return 0 }
        sourceRect = rect
        configuration.sourceRect = rect
        let t0 = CFAbsoluteTimeGetCurrent()
        try await s.updateConfiguration(configuration)
        return CFAbsoluteTimeGetCurrent() - t0
    }

    @discardableResult
    public func updateOutputSize(_ size: CGSize) async throws -> TimeInterval {
        guard let s = stream else { return 0 }
        outputSize = size
        configuration.width = Int(size.width)
        configuration.height = Int(size.height)
        let t0 = CFAbsoluteTimeGetCurrent()
        try await s.updateConfiguration(configuration)
        return CFAbsoluteTimeGetCurrent() - t0
    }

    // MARK: SCStreamOutput

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let info = attachments.first,
              let statusRaw = info[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw),
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let contentRect = (info[.contentRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
        let contentScale = (info[.contentScale] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 1
        let scaleFactor = (info[.scaleFactor] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 1
        let screenRect = (info[.screenRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        let geometry = FrameGeometry(surfaceSize: CGSize(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb)),
                                     contentRect: contentRect, contentScale: contentScale, scaleFactor: scaleFactor)
        onFrame?(CapturedFrame(pixelBuffer: pb, status: status, geometry: geometry, screenRect: screenRect,
                               presentationTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer)))
    }

    // MARK: SCStreamDelegate

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop?(error)
    }
}
```

- [ ] **Step 2: Write WindowTracker.swift and Stats.swift**

Create `spikes/macprobe/Sources/ProbeKit/WindowTracker.swift`:

```swift
import CoreGraphics
import Foundation

public struct WindowState: Equatable {
    public var bounds: CGRect       // global points, top-left origin (kCGWindowBounds)
    public var isOnScreen: Bool
    public var ownerPID: pid_t
    public var title: String?
}

public enum WindowTracker {
    /// nil when the window no longer exists.
    public static func state(of id: CGWindowID) -> WindowState? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let d = list.first,
              let b = d[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
        return WindowState(bounds: bounds,
                           isOnScreen: d[kCGWindowIsOnscreen as String] as? Bool ?? false,
                           ownerPID: d[kCGWindowOwnerPID as String] as? pid_t ?? 0,
                           title: d[kCGWindowName as String] as? String)
    }
}
```

Create `spikes/macprobe/Sources/ProbeKit/Stats.swift`:

```swift
import Foundation

/// Events per trailing second. Safe to tick from a capture queue and read from the main thread.
public final class RateCounter {
    private let lock = NSLock()
    private var stamps: [TimeInterval] = []

    public init() {}

    public func tick() {
        let t = CFAbsoluteTimeGetCurrent()
        lock.lock()
        stamps.append(t)
        stamps.removeAll { t - $0 > 1 }
        lock.unlock()
    }

    public var perSecond: Int {
        lock.lock(); defer { lock.unlock() }
        let t = CFAbsoluteTimeGetCurrent()
        return stamps.filter { t - $0 <= 1 }.count
    }
}

public enum ProcessCPU {
    /// User plus system CPU seconds consumed by this process so far.
    public static func seconds() -> Double {
        var ru = rusage()
        getrusage(RUSAGE_SELF, &ru)
        return Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6
            + Double(ru.ru_stime.tv_sec) + Double(ru.ru_stime.tv_usec) / 1e6
    }
}
```

- [ ] **Step 3: Write the probe command**

Create `spikes/macprobe/Sources/captureprobe/Commands+Probe.swift`:

```swift
import Foundation
import ScreenCaptureKit
import ProbeKit

extension Commands {
    static func probe() async throws {
        guard Args.all.count >= 2, let id = UInt32(Args.all[1]) else { usage() }
        let mode = CaptureMode(rawValue: Args.option("--mode") ?? "appcrop") ?? .appcrop
        let seconds = Double(Args.option("--seconds") ?? "30") ?? 30
        let content = try await Shareable.content()
        let window = try Shareable.window(id, in: content)
        let display = try Shareable.display(for: window, in: content)
        let scale = Shareable.backingScale(of: display)
        let native = mode == .display
            ? CGSize(width: display.frame.width * scale, height: display.frame.height * scale)
            : CGSize(width: window.frame.width * scale, height: window.frame.height * scale)
        let out = Args.parseSize(Args.option("--out")) ?? OutputSizePolicy.outputSize(source: native, viewport: CGSize(width: 3840, height: 2400))
        print("target: \(window.owningApplication?.applicationName ?? "?") — \(window.title ?? "") id=\(id) frame=\(Shareable.fmt(window.frame)) display=\(display.displayID) mode=\(mode.rawValue) out=\(Int(out.width))x\(Int(out.height))")
        print("Now: cover it with another app, minimize and restore it, move it to another Space and back, move it, resize it, open one of its menus, and finally close it. Watching for \(Int(seconds)) s.")

        let stream = try CaptureStream(window: window, display: display, mode: mode, outputSize: out)
        let fps = RateCounter()
        var frames = 0
        var lastGeometry: FrameGeometry?
        var lastStatus: SCFrameStatus?
        stream.onFrame = { f in
            fps.tick()
            frames += 1
            if frames <= 3 || f.geometry != lastGeometry || f.status != lastStatus {
                print("[\(f1(now()))] frame #\(frames) status=\(statusName(f.status)) surface=\(Int(f.geometry.surfaceSize.width))x\(Int(f.geometry.surfaceSize.height)) contentRect=\(Shareable.fmt(f.geometry.contentRect)) contentScale=\(String(format: "%.3f", f.geometry.contentScale)) scaleFactor=\(f1(f.geometry.scaleFactor)) screenRect=\(f.screenRect.map(Shareable.fmt) ?? "-")")
                lastGeometry = f.geometry
                lastStatus = f.status
            }
        }
        stream.onStop = { err in print("[\(f1(now()))] stream stopped: \(err.map { "\($0)" } ?? "no error")") }
        try await stream.start()

        var lastState = WindowTracker.state(of: id)
        print("[\(f1(now()))] window bounds=\(lastState.map { Shareable.fmt($0.bounds) } ?? "?") onScreen=\(lastState?.isOnScreen ?? false)")
        let deadline = Date().addingTimeInterval(seconds)
        var lastFpsPrint = Date()
        while Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
            let state = WindowTracker.state(of: id)
            if state != lastState {
                guard let s = state else {
                    print("[\(f1(now()))] window is gone (closed). Stopping.")
                    break
                }
                print("[\(f1(now()))] window bounds=\(Shareable.fmt(s.bounds)) onScreen=\(s.isOnScreen)")
                if mode == .appcrop, s.bounds != lastState?.bounds {
                    let local = s.bounds.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
                    let dt = try await stream.updateSourceRect(local)
                    print("[\(f1(now()))] updateConfiguration(sourceRect) took \(f1(dt * 1000)) ms")
                }
                lastState = state
            }
            if Date().timeIntervalSince(lastFpsPrint) >= 5 {
                print("[\(f1(now()))] \(fps.perSecond) fps (SCK sends frames only while content changes)")
                lastFpsPrint = Date()
            }
        }
        await stream.stop()
    }
}
```

Add the case to `main.swift`'s switch, above `default`:

```swift
        case "probe": try await Commands.probe()
```

- [ ] **Step 4: Build**

Run: `swift build --package-path spikes/macprobe 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 5: Run the appcrop experiment and record the behavior table**

Open Safari with any page, note its window id from `captureprobe list`, then run (replace `ID`):

```bash
swift run --package-path spikes/macprobe captureprobe probe ID --mode appcrop --seconds 90
```

While it runs, do each action from the printed list and watch the log. Record in the findings table, column "appcrop": whether frames keep arriving (`fps` line stays above 0 while you move the mouse over the page) when covered; what `status` becomes when minimized (expect `idle` or `blank` and `onScreen=false`); what happens on another Space; that a move prints new `window bounds=` and an `updateConfiguration(sourceRect) took N ms` line (write the typical N into "updateConfiguration with sourceRect only"); that a resize changes `contentRect`/`contentScale` but not `surface`; that closing prints `window is gone`. Open Safari's File menu during the run and note whether the menu's pixels appear in the stream (they cannot be seen from the log; hold the menu open, then check with the self-test's approach later, or temporarily add `--out` and eyeball via the S2 client in Task 9; write "checked in S2" for now if unsure).

- [ ] **Step 6: Repeat for the other two modes**

```bash
swift run --package-path spikes/macprobe captureprobe probe ID --mode independent --seconds 60
swift run --package-path spikes/macprobe captureprobe probe ID --mode display --seconds 30
```

Fill the remaining two columns of the behavior table. For `independent`, the expected results from Apple's documentation are: full content while covered, `idle`/paused while minimized, output size fixed with content scaled.

- [ ] **Step 7: Commit**

```bash
git add spikes/macprobe docs/superpowers/spikes
git commit -m "spike: captureprobe probe streams a window three ways and logs geometry"
git push
```

---

### Task 4: Validate the coordinate formula against real pixels (`captureprobe selftest`)

**Files:**
- Create: `spikes/macprobe/Sources/ProbeKit/PixelProbe.swift`
- Create: `spikes/macprobe/Sources/ProbeKit/Injector.swift`
- Create: `spikes/macprobe/Sources/captureprobe/MarkerWindow.swift`
- Create: `spikes/macprobe/Sources/captureprobe/Commands+SelfTest.swift`
- Create: `spikes/macprobe/Tests/ProbeKitTests/PixelProbeTests.swift`
- Modify: `spikes/macprobe/Sources/captureprobe/main.swift` (add the `selftest` case)

**Interfaces:**
- Consumes: `CaptureStream`, `StreamMapper`, `ContentRectUnit`, `WindowTracker`, `Shareable`, `Args`, `f1(_:)`.
- Produces: `PixelProbe.redCentroid(in: CVPixelBuffer) -> (center: CGPoint, count: Int)?`, `PixelProbe.redCentroid(bgra:width:height:bytesPerRow:)`; `Injector.move(to:dragging:)`, `Injector.click(at:button:clickCount:)`, `Injector.scroll(dx:dy:pixels:)`, `Injector.key(_:down:flags:)`, `Injector.typeText(_:)`; `FrameBox` (`set(_:)`, `get()`), `MarkerWindow`.

- [ ] **Step 1: Write the failing PixelProbe test**

Create `spikes/macprobe/Tests/ProbeKitTests/PixelProbeTests.swift`:

```swift
import XCTest
@testable import ProbeKit

final class PixelProbeTests: XCTestCase {
    /// 100x80 BGRA buffer, black, with a 10x10 pure-red square whose top-left pixel is (30,20).
    private func buffer(withDarkRedAt dark: (Int, Int)? = nil, square: Bool = true) -> [UInt8] {
        let w = 100, h = 80
        var b = [UInt8](repeating: 0, count: w * h * 4)
        func set(_ x: Int, _ y: Int, r: UInt8, g: UInt8, bl: UInt8) {
            let i = (y * w + x) * 4
            b[i] = bl; b[i + 1] = g; b[i + 2] = r; b[i + 3] = 255
        }
        if square { for y in 20..<30 { for x in 30..<40 { set(x, y, r: 255, g: 0, bl: 0) } } }
        if let (x, y) = dark { set(x, y, r: 120, g: 0, bl: 0) }
        return b
    }

    func testFindsTheCentroidOfTheRedSquare() {
        let b = buffer()
        let result = b.withUnsafeBytes { PixelProbe.redCentroid(bgra: $0.baseAddress!, width: 100, height: 80, bytesPerRow: 400) }
        XCTAssertEqual(result?.count, 100)
        XCTAssertEqual(result?.center.x ?? 0, 35.0, accuracy: 0.01)
        XCTAssertEqual(result?.center.y ?? 0, 25.0, accuracy: 0.01)
    }

    func testIgnoresDarkRedAndReportsNilWhenAbsent() {
        let withDark = buffer(withDarkRedAt: (5, 5))
        let r1 = withDark.withUnsafeBytes { PixelProbe.redCentroid(bgra: $0.baseAddress!, width: 100, height: 80, bytesPerRow: 400) }
        XCTAssertEqual(r1?.count, 100, "a dark red pixel must not count")
        let empty = buffer(square: false)
        let r2 = empty.withUnsafeBytes { PixelProbe.redCentroid(bgra: $0.baseAddress!, width: 100, height: 80, bytesPerRow: 400) }
        XCTAssertNil(r2)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --package-path spikes/macprobe --filter PixelProbeTests 2>&1 | tail -3`
Expected: compile error `cannot find 'PixelProbe' in scope`.

- [ ] **Step 3: Implement PixelProbe.swift**

Create `spikes/macprobe/Sources/ProbeKit/PixelProbe.swift`:

```swift
import CoreVideo
import CoreGraphics

public enum PixelProbe {
    /// Centroid (pixel coordinates, center-of-pixel convention) and count of bright red pixels in a BGRA buffer.
    public static func redCentroid(in pb: CVPixelBuffer) -> (center: CGPoint, count: Int)? {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_32BGRA,
              let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
        return redCentroid(bgra: base, width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb),
                           bytesPerRow: CVPixelBufferGetBytesPerRow(pb))
    }

    public static func redCentroid(bgra: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int) -> (center: CGPoint, count: Int)? {
        var sumX = 0, sumY = 0, n = 0
        for y in 0..<height {
            let row = bgra.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let b = row[x * 4], g = row[x * 4 + 1], r = row[x * 4 + 2]
                if r > 180 && g < 90 && b < 90 {
                    sumX += x; sumY += y; n += 1
                }
            }
        }
        guard n > 0 else { return nil }
        return (CGPoint(x: Double(sumX) / Double(n) + 0.5, y: Double(sumY) / Double(n) + 0.5), n)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `swift test --package-path spikes/macprobe 2>&1 | tail -3`
Expected: `Executed 12 tests, with 0 failures`.

- [ ] **Step 5: Write Injector.swift**

Create `spikes/macprobe/Sources/ProbeKit/Injector.swift`:

```swift
import CoreGraphics
import Foundation

/// Posts synthetic input at the HID level, exactly as the host will.
public enum Injector {
    public static func move(to p: CGPoint, dragging button: CGMouseButton? = nil) {
        let type: CGEventType
        switch button {
        case .left?: type = .leftMouseDragged
        case .right?: type = .rightMouseDragged
        case .some: type = .otherMouseDragged
        case nil: type = .mouseMoved
        }
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button ?? .left)?.post(tap: .cghidEventTap)
    }

    public static func click(at p: CGPoint, button: CGMouseButton = .left, clickCount: Int = 1) {
        let down: CGEventType, up: CGEventType
        switch button {
        case .left: (down, up) = (.leftMouseDown, .leftMouseUp)
        case .right: (down, up) = (.rightMouseDown, .rightMouseUp)
        default: (down, up) = (.otherMouseDown, .otherMouseUp)
        }
        move(to: p)
        usleep(20_000)
        let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        d?.post(tap: .cghidEventTap)
        usleep(30_000)
        let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        u?.post(tap: .cghidEventTap)
    }

    /// Trackpad-style (pixels, continuous) or wheel-style (lines) scrolling at the current cursor position.
    public static func scroll(dx: Double, dy: Double, pixels: Bool) {
        let e = CGEvent(scrollWheelEvent2Source: nil, units: pixels ? .pixel : .line, wheelCount: 2,
                        wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
        if pixels { e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1) }
        e?.post(tap: .cghidEventTap)
    }

    public static func key(_ vk: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: down)
        e?.flags = flags
        e?.post(tap: .cghidEventTap)
    }

    /// Types text through the Unicode-string path (what the host uses for IME commits and unmapped characters).
    public static func typeText(_ s: String) {
        for scalar in s.unicodeScalars {
            var utf16 = Array(String(scalar).utf16)
            let d = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            d?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            d?.post(tap: .cghidEventTap)
            let u = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            u?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            u?.post(tap: .cghidEventTap)
            usleep(8_000)
        }
    }
}
```

- [ ] **Step 6: Write the marker window and the self-test**

Create `spikes/macprobe/Sources/captureprobe/MarkerWindow.swift`:

```swift
import AppKit
import ProbeKit

/// A borderless black window with a red 20x20 marker at (40,40) from its top-left corner and a
/// "Hit" button at (200,100). Borderless means the window frame equals the content frame.
final class MarkerWindow: NSObject {
    let window: NSWindow
    let markerOrigin = CGPoint(x: 40, y: 40)
    let markerSize = CGSize(width: 20, height: 20)
    let buttonFrame = CGRect(x: 200, y: 100, width: 120, height: 40)
    private(set) var hits = 0
    private let root: FlippedView

    init(size: CGSize) {
        window = NSWindow(contentRect: NSRect(x: 300, y: 300, width: size.width, height: size.height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        root = FlippedView(frame: NSRect(origin: .zero, size: size))
        super.init()
        window.backgroundColor = .black
        window.isOpaque = true
        window.level = .normal
        root.wantsLayer = true
        let marker = NSView(frame: NSRect(origin: markerOrigin, size: markerSize))
        marker.wantsLayer = true
        marker.layer?.backgroundColor = NSColor(red: 1, green: 0, blue: 0, alpha: 1).cgColor
        root.addSubview(marker)
        let button = NSButton(title: "Hit", target: self, action: #selector(hit))
        button.frame = buttonFrame
        root.addSubview(button)
        window.contentView = root
        window.makeKeyAndOrderFront(nil)
    }

    @objc func hit() { hits += 1 }

    func resize(to size: CGSize) {
        window.setContentSize(size)
        root.frame = NSRect(origin: .zero, size: size)
    }

    var windowID: CGWindowID { CGWindowID(window.windowNumber) }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Latest frame, handed from the capture queue to the command's task.
final class FrameBox {
    private let lock = NSLock()
    private var frame: CapturedFrame?
    func set(_ f: CapturedFrame) { lock.lock(); frame = f; lock.unlock() }
    func get() -> CapturedFrame? { lock.lock(); defer { lock.unlock() }; return frame }
}
```

Create `spikes/macprobe/Sources/captureprobe/Commands+SelfTest.swift`:

```swift
import AppKit
import ScreenCaptureKit
import ProbeKit

extension Commands {
    static func selftest() async throws {
        let sizes = (Args.option("--sizes") ?? "800x500,1200x900,500x400").split(separator: ",").compactMap { Args.parseSize(String($0)) }
        guard let first = sizes.first else { usage() }
        let marker = await MainActor.run { MarkerWindow(size: first) }
        await MainActor.run { NSApp.activate(ignoringOtherApps: true) }
        try await Task.sleep(nanoseconds: 500_000_000)

        let content = try await Shareable.content()
        let window = try Shareable.window(marker.windowID, in: content)
        let display = try Shareable.display(for: window, in: content)
        let scale = Shareable.backingScale(of: display)
        let stream = try CaptureStream(window: window, display: display, mode: .appcrop,
                                       outputSize: CGSize(width: first.width * scale, height: first.height * scale))
        let latest = FrameBox()
        stream.onFrame = { if $0.status == .complete { latest.set($0) } }
        try await stream.start()
        try await Task.sleep(nanoseconds: 600_000_000)

        var failures = 0
        var detected: ContentRectUnit?
        for (i, size) in sizes.enumerated() {
            if i > 0 {
                await MainActor.run { marker.resize(to: size) }
                try await Task.sleep(nanoseconds: 300_000_000)
                guard let st = WindowTracker.state(of: marker.windowID) else { throw ProbeError.usage("marker window vanished") }
                let dtRect = try await stream.updateSourceRect(st.bounds.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY))
                print("size \(Int(size.width))x\(Int(size.height)): updateConfiguration(sourceRect only) \(f1(dtRect * 1000)) ms")
                try await Task.sleep(nanoseconds: 500_000_000)
                let (fails, unit) = check(marker: marker, stream: stream, latest: latest, label: "letterboxed in old output")
                failures += fails
                detected = unit ?? detected
                let dtSize = try await stream.updateOutputSize(CGSize(width: size.width * scale, height: size.height * scale))
                print("size \(Int(size.width))x\(Int(size.height)): updateConfiguration(width/height) \(f1(dtSize * 1000)) ms")
            }
            try await Task.sleep(nanoseconds: 600_000_000)
            let (fails, unit) = check(marker: marker, stream: stream, latest: latest, label: "1:1 output \(Int(size.width))x\(Int(size.height))")
            failures += fails
            detected = unit ?? detected
        }

        // Click the button through the same math the host will use: source point -> normalized -> global.
        if let frame = latest.get(), let st = WindowTracker.state(of: marker.windowID) {
            let m = StreamMapper(sourceOrigin: stream.sourceOrigin, sourceSize: st.bounds.size, geometry: frame.geometry, unit: detected ?? .points)
            let target = CGPoint(x: marker.buttonFrame.midX, y: marker.buttonFrame.midY)
            let px = m.surfacePixel(forSourcePoint: target)
            let nx = px.x / frame.geometry.surfaceSize.width, ny = px.y / frame.geometry.surfaceSize.height
            let global = m.globalPoint(nx: nx, ny: ny)
            let before = await MainActor.run { marker.hits }
            Injector.click(at: global)
            try await Task.sleep(nanoseconds: 500_000_000)
            let hit = await MainActor.run { marker.hits } > before
            print("click at normalized (\(f1(nx)),\(f1(ny))) -> global (\(Int(global.x)),\(Int(global.y))): \(hit ? "button hit" : "MISSED")")
            if !hit { failures += 1 }
        } else {
            print("no frame for the click test"); failures += 1
        }

        await stream.stop()
        print(failures == 0 ? "SELFTEST PASS (contentRect unit = \(detected?.rawValue ?? "?"))" : "SELFTEST FAIL (\(failures) checks failed)")
        exit(failures == 0 ? 0 : 1)
    }

    /// Compares where the red marker really is in the frame with where each unit hypothesis predicts it.
    private static func check(marker: MarkerWindow, stream: CaptureStream, latest: FrameBox, label: String) -> (Int, ContentRectUnit?) {
        guard let frame = latest.get(), let found = PixelProbe.redCentroid(in: frame.pixelBuffer) else {
            print("  \(label): no complete frame or no red marker found -> FAIL"); return (1, nil)
        }
        guard let st = WindowTracker.state(of: marker.windowID) else { return (1, nil) }
        let expected = CGPoint(x: marker.markerOrigin.x + marker.markerSize.width / 2, y: marker.markerOrigin.y + marker.markerSize.height / 2)
        var line = "  \(label): surface=\(Int(frame.geometry.surfaceSize.width))x\(Int(frame.geometry.surfaceSize.height)) contentRect=\(Shareable.fmt(frame.geometry.contentRect)) contentScale=\(String(format: "%.3f", frame.geometry.contentScale)) scaleFactor=\(f1(frame.geometry.scaleFactor)) marker@px=(\(f1(found.center.x)),\(f1(found.center.y))) n=\(found.count)"
        var best: (ContentRectUnit, CGFloat)?
        for unit in [ContentRectUnit.points, .pixels] {
            let m = StreamMapper(sourceOrigin: stream.sourceOrigin, sourceSize: st.bounds.size, geometry: frame.geometry, unit: unit)
            let predicted = m.surfacePixel(forSourcePoint: expected)
            let err = hypot(predicted.x - found.center.x, predicted.y - found.center.y)
            line += " | \(unit.rawValue) predicts (\(f1(predicted.x)),\(f1(predicted.y))) err=\(f1(err))px"
            if best == nil || err < best!.1 { best = (unit, err) }
        }
        print(line)
        if let b = best, b.1 <= 3 {
            print("  -> contentRect unit = \(b.0.rawValue) (error \(f1(b.1)) px)")
            return (0, b.0)
        }
        print("  -> NEITHER hypothesis matches within 3 px -> FAIL")
        return (1, nil)
    }
}
```

Add to `main.swift`'s switch:

```swift
        case "selftest": try await Commands.selftest()
```

- [ ] **Step 7: Build and run the self-test**

Run: `swift build --package-path spikes/macprobe 2>&1 | tail -3` then `swift run --package-path spikes/macprobe captureprobe selftest`
Expected: a black window appears; three `1:1 output` lines and two `letterboxed` lines each end with `contentRect unit = points` (or `pixels`, which is the finding); two `updateConfiguration` timings per resize; `click ... button hit`; final line `SELFTEST PASS (contentRect unit = ...)`. If a line says `NEITHER`, paste the full line into the findings file: it means the attachment semantics differ from both hypotheses and the phase 1 mapper must be adjusted.

- [ ] **Step 8: Record the findings**

Fill "Frame geometry" in the findings file: the unit, the per-size errors, both `updateConfiguration` timings, and the click result.

- [ ] **Step 9: Commit**

```bash
git add spikes/macprobe docs/superpowers/spikes
git commit -m "spike: selftest validates the coordinate formula against captured pixels"
git push
```

---

### Task 5: Raise, click, type and resize other apps' windows (`captureprobe poke`, `resize`)

**Files:**
- Create: `spikes/macprobe/Sources/ProbeKit/Accessibility.swift`
- Create: `spikes/macprobe/Sources/captureprobe/Commands+Poke.swift`
- Modify: `spikes/macprobe/Sources/captureprobe/main.swift` (add `poke` and `resize`)

**Interfaces:**
- Consumes: `CaptureStream`, `StreamMapper`, `WindowTracker`, `Injector`, `FrameBox`, `Shareable`, `Args`.
- Produces: `AX.isTrusted(prompt:) -> Bool`, `AX.windowElement(pid:matching:title:) -> AXUIElement?`, `AX.frame(of:) -> CGRect?`, `AX.raise(pid:window:) -> [String]`, `AX.setSize(_:of:) -> AXError`, `AX.setMinimized(_:of:) -> AXError`, `AX.focusedElementValue(pid:) -> String?`.

- [ ] **Step 1: Write Accessibility.swift**

Create `spikes/macprobe/Sources/ProbeKit/Accessibility.swift`:

```swift
import ApplicationServices
import AppKit

public enum AX {
    public static func isTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// The app's AX window whose frame is closest to `bounds` (within 8 points in total), since there is no
    /// public bridge from a CGWindowID to an AXUIElement.
    public static func windowElement(pid: pid_t, matching bounds: CGRect, title: String?) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        var best: (AXUIElement, CGFloat)?
        for w in windows {
            guard let f = frame(of: w) else { continue }
            let d = abs(f.minX - bounds.minX) + abs(f.minY - bounds.minY) + abs(f.width - bounds.width) + abs(f.height - bounds.height)
            if best == nil || d < best!.1 { best = (w, d) }
        }
        guard let b = best, b.1 < 8 else { return nil }
        return b.0
    }

    public static func frame(of element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero, size = CGSize.zero
        // swiftlint:disable force_cast
        AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        return CGRect(origin: pos, size: size)
    }

    /// Brings the app and window to the front three ways and reports each result code (0 = success).
    @discardableResult
    public static func raise(pid: pid_t, window: AXUIElement?) -> [String] {
        var log: [String] = []
        let app = AXUIElementCreateApplication(pid)
        log.append("AXFrontmost=\(AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue)")
        if let w = window {
            log.append("AXRaise=\(AXUIElementPerformAction(w, kAXRaiseAction as CFString).rawValue)")
            log.append("AXMain=\(AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue).rawValue)")
        } else {
            log.append("AXRaise=skipped(no window element)")
        }
        if let running = NSRunningApplication(processIdentifier: pid) {
            log.append("activate()=\(running.activate(options: []))")
        }
        return log
    }

    @discardableResult
    public static func setSize(_ size: CGSize, of window: AXUIElement) -> AXError {
        var s = size
        guard let v = AXValueCreate(.cgSize, &s) else { return .failure }
        return AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, v)
    }

    @discardableResult
    public static func setMinimized(_ flag: Bool, of window: AXUIElement) -> AXError {
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, flag ? kCFBooleanTrue : kCFBooleanFalse)
    }

    /// The string value of the app's focused element (a text view's contents), if it exposes one.
    public static func focusedElementValue(pid: pid_t) -> String? {
        let app = AXUIElementCreateApplication(pid)
        var el: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &el) == .success, let element = el else { return nil }
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element as! AXUIElement, kAXValueAttribute as CFString, &v) == .success else { return nil }
        return v as? String
    }
}
```

- [ ] **Step 2: Write the poke and resize commands**

Create `spikes/macprobe/Sources/captureprobe/Commands+Poke.swift`:

```swift
import AppKit
import ScreenCaptureKit
import ProbeKit

extension Commands {
    private static func requireAccessibility() throws {
        guard AX.isTrusted(prompt: true) else {
            throw ProbeError.usage("Accessibility is not allowed for the app that launched this tool. Enable it in System Settings > Privacy & Security > Accessibility, then run again.")
        }
    }

    static func poke() async throws {
        guard Args.all.count >= 2, let id = UInt32(Args.all[1]), let at = Args.option("--at") else { usage() }
        let parts = at.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2 else { usage() }
        let (nx, ny) = (CGFloat(parts[0]), CGFloat(parts[1]))
        let delay = Double(Args.option("--delay") ?? "3") ?? 3
        try requireAccessibility()

        let content = try await Shareable.content()
        let window = try Shareable.window(id, in: content)
        let display = try Shareable.display(for: window, in: content)
        let scale = Shareable.backingScale(of: display)
        let stream = try CaptureStream(window: window, display: display, mode: .appcrop,
                                       outputSize: CGSize(width: window.frame.width * scale, height: window.frame.height * scale))
        let latest = FrameBox()
        stream.onFrame = { if $0.status == .complete { latest.set($0) } }
        try await stream.start()

        print("Bring some OTHER app to the front now. Acting in \(Int(delay)) s...")
        try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        guard let st = WindowTracker.state(of: id) else { throw ProbeError.windowNotFound(id) }
        let pid = st.ownerPID
        let before = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
        let element = AX.windowElement(pid: pid, matching: st.bounds, title: window.title)
        let log = AX.raise(pid: pid, window: element)
        try await Task.sleep(nanoseconds: 300_000_000)
        let after = NSWorkspace.shared.frontmostApplication
        print("raise: \(log.joined(separator: " ")) | frontmost before=\(before) after=\(after?.localizedName ?? "?") -> \(after?.processIdentifier == pid ? "OK" : "NOT the target")")

        if let moved = WindowTracker.state(of: id), moved.bounds != st.bounds {
            try await stream.updateSourceRect(moved.bounds.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY))
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        guard let frame = latest.get(), let current = WindowTracker.state(of: id) else { throw ProbeError.usage("no frame received") }
        let m = StreamMapper(sourceOrigin: stream.sourceOrigin, sourceSize: current.bounds.size, geometry: frame.geometry, unit: .points)
        let p = m.globalPoint(nx: nx, ny: ny)
        print("normalized (\(nx),\(ny)) -> global (\(Int(p.x)),\(Int(p.y))) via contentRect=\(Shareable.fmt(frame.geometry.contentRect)) contentScale=\(String(format: "%.3f", frame.geometry.contentScale))")

        if Args.flag("--click") { Injector.click(at: p); print("clicked") }
        if let dy = Args.option("--scroll").flatMap(Double.init) {
            Injector.move(to: p); Injector.scroll(dx: 0, dy: dy, pixels: true); print("scrolled \(dy) px")
        }
        if let text = Args.option("--type") {
            Injector.typeText(text)
            try await Task.sleep(nanoseconds: 300_000_000)
            let value = AX.focusedElementValue(pid: pid)
            let verified = value?.contains(text) == true
            print("typed \"\(text)\"; focused element value: \(value.map { "\"...\($0.suffix(60))\"" } ?? "unavailable") -> \(verified ? "PASS" : "not verified")")
        }
        await stream.stop()
    }

    static func resize() async throws {
        guard Args.all.count >= 3, let id = UInt32(Args.all[1]), let size = Args.parseSize(Args.all[2]) else { usage() }
        try requireAccessibility()
        guard let st = WindowTracker.state(of: id) else { throw ProbeError.windowNotFound(id) }
        guard let el = AX.windowElement(pid: st.ownerPID, matching: st.bounds, title: st.title) else {
            throw ProbeError.usage("no AX window matches bounds \(Shareable.fmt(st.bounds)); the app may not expose its windows")
        }
        let r = AX.setSize(size, of: el)
        try await Task.sleep(nanoseconds: 300_000_000)
        let after = WindowTracker.state(of: id)
        print("AXSize -> \(r.rawValue) (0 = success); bounds before \(Shareable.fmt(st.bounds)) after \(after.map { Shareable.fmt($0.bounds) } ?? "gone")")
    }
}
```

Add to `main.swift`'s switch:

```swift
        case "poke": try await Commands.poke()
        case "resize": try await Commands.resize()
```

- [ ] **Step 3: Build and grant Accessibility**

Run: `swift build --package-path spikes/macprobe 2>&1 | tail -3`, then `swift run --package-path spikes/macprobe captureprobe resize 1 100x100`
Expected: the Accessibility prompt appears (or the "Accessibility is not allowed" message). Grant it to the launching app in System Settings. The command itself then fails with `no window with id 1`, which is fine.

- [ ] **Step 4: TextEdit end-to-end check**

Run `open -a TextEdit`, create a new document, find its window id with `list`, then:

```bash
swift run --package-path spikes/macprobe captureprobe poke ID --at 0.5,0.6 --click --type windowcast42
```

Within the 3 s, click on Finder or another app so TextEdit is behind. Expected: `raise: AXFrontmost=0 AXRaise=0 AXMain=0 activate()=true | ... -> OK`, `clicked`, and `typed "windowcast42"; ... -> PASS`. Record the row in "Activation and clicks".

- [ ] **Step 5: The other five apps**

For Finder, Safari, Terminal, Google Chrome and System Settings: open a window, run `poke ID --at 0.5,0.5 --click` (Terminal: add `--type "echo windowcast42"`), put another app in front during the delay, and record: each result code in the `raise:` line, whether the frontmost app became the target, and whether the click visibly landed where expected (a link, a sidebar item, a file). Finder's window ids belong to the `Finder` app entry in `list`.

- [ ] **Step 6: Resizing matrix**

For each of the six apps: `swift run --package-path spikes/macprobe captureprobe resize ID 1000x700`, then `... resize ID 700x500`. Record the AXError and resulting bounds. System Settings is expected to refuse (fixed size); note it as the fallback case for the Resize menu.

- [ ] **Step 7: Commit**

```bash
git add spikes/macprobe docs/superpowers/spikes
git commit -m "spike: poke and resize other apps' windows through Accessibility and CGEvent"
git push
```

---

### Task 6: Three concurrent streams (`captureprobe multi`)

**Files:**
- Create: `spikes/macprobe/Sources/captureprobe/Commands+Multi.swift`
- Modify: `spikes/macprobe/Sources/captureprobe/main.swift` (add `multi`)

**Interfaces:**
- Consumes: `CaptureStream`, `RateCounter`, `ProcessCPU`, `OutputSizePolicy`, `Shareable`, `Args`.
- Produces: nothing new.

- [ ] **Step 1: Write the multi command**

Create `spikes/macprobe/Sources/captureprobe/Commands+Multi.swift`:

```swift
import Foundation
import CoreVideo
import ProbeKit

extension Commands {
    static func multi() async throws {
        guard Args.all.count >= 2 else { usage() }
        let ids = Args.all[1].split(separator: ",").compactMap { UInt32($0) }
        guard !ids.isEmpty else { usage() }
        let seconds = Double(Args.option("--seconds") ?? "20") ?? 20
        let content = try await Shareable.content()
        var streams: [(id: CGWindowID, stream: CaptureStream, rate: RateCounter)] = []
        for id in ids {
            let w = try Shareable.window(id, in: content)
            let d = try Shareable.display(for: w, in: content)
            let scale = Shareable.backingScale(of: d)
            let native = CGSize(width: w.frame.width * scale, height: w.frame.height * scale)
            let out = Args.parseSize(Args.option("--out")) ?? OutputSizePolicy.outputSize(source: native, viewport: CGSize(width: 1920, height: 1200))
            // NV12 like the real host, so the compositor path matches phase 1.
            let s = try CaptureStream(window: w, display: d, mode: .appcrop, outputSize: out,
                                      pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            let rate = RateCounter()
            s.onFrame = { if $0.status == .complete { rate.tick() } }
            try await s.start()
            streams.append((id, s, rate))
            print("stream \(id): \(w.owningApplication?.applicationName ?? "?") — \(w.title ?? "") out=\(Int(out.width))x\(Int(out.height))")
        }
        print("Keep all windows animating (a playing video, `top` in Terminal, a page scrolling). SCK only sends frames for changing content.")
        var cpuPrev = ProcessCPU.seconds()
        var tPrev = CFAbsoluteTimeGetCurrent()
        var samples: [Double] = []
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let cpuNow = ProcessCPU.seconds(), tNow = CFAbsoluteTimeGetCurrent()
            let pct = (cpuNow - cpuPrev) / (tNow - tPrev) * 100
            samples.append(pct); cpuPrev = cpuNow; tPrev = tNow
            print("fps " + streams.map { "\($0.id)=\($0.rate.perSecond)" }.joined(separator: " ") + "  process CPU \(f1(pct))%  (watch WindowServer in Activity Monitor as well)")
        }
        for s in streams { await s.stream.stop() }
        let avg = samples.reduce(0, +) / Double(max(samples.count, 1))
        print("average process CPU \(f1(avg))% over \(samples.count) s with \(streams.count) streams")
    }
}
```

Add to `main.swift`'s switch:

```swift
        case "multi": try await Commands.multi()
```

- [ ] **Step 2: Build and run with three animating windows**

Open a YouTube video in Safari, a second video or an animated page in Chrome, and `top` in Terminal. Get the three ids from `list`, open Activity Monitor sorted by CPU, then:

```bash
swift run --package-path spikes/macprobe captureprobe multi ID1,ID2,ID3 --seconds 20
```

Expected: three `stream` lines, then 20 `fps` lines with each stream near its content's rate (a 30 fps video shows about 30; `top` shows about 1 unless its refresh is raised with `top -s 0`), and an `average process CPU` line. Note WindowServer's percentage from Activity Monitor during the run.

- [ ] **Step 3: Record the findings and commit**

Fill "Three concurrent streams". Then:

```bash
git add spikes/macprobe docs/superpowers/spikes
git commit -m "spike: multi runs three app-crop streams and reports fps and CPU"
git push
```

---

### Task 7: WebRTC host probe (`webrtcprobe`)

**Files:**
- Modify: `spikes/macprobe/Package.swift` (add the WebRTC dependency, `ProbeRTC`, `webrtcprobe`, `ProbeRTCTests`)
- Create: `spikes/macprobe/Sources/ProbeRTC/Signaling.swift`
- Create: `spikes/macprobe/Sources/ProbeRTC/ProbeEncoderFactory.swift`
- Create: `spikes/macprobe/Sources/webrtcprobe/PeerSession.swift`
- Create: `spikes/macprobe/Sources/webrtcprobe/TimerWindow.swift`
- Create: `spikes/macprobe/Sources/webrtcprobe/main.swift`
- Create: `spikes/macprobe/Tests/ProbeRTCTests/SignalingServerTests.swift`
- Create: `spikes/macprobe/Tests/ProbeRTCTests/ProbeEncoderFactoryTests.swift`

**Interfaces:**
- Consumes: `CaptureStream`, `CapturedFrame`, `FrameGeometry`, `StreamMapper`, `WindowTracker`, `Injector`, `Shareable`, `RateCounter`, `OutputSizePolicy`.
- Produces: `SignalingServer(port:)` with `onConnection`, `start() async throws -> UInt16`, `stop()`; `SignalingConnection` with `remote: String`, `onMessage: (([String: Any]) -> Void)?`, `onClose: (() -> Void)?`, `send(_ json: [String: Any])`, `close()`; `ProbeEncoderFactory(h264Level:preferHEVC:)`; `PeerSession(id:signaling:factory:window:display:options:)` with `start()`, `close(reason:)`; `SessionOptions(outputSize:fps:maxBitrate:)`; `TimerWindow` with `windowID`.
- Wire format between host and client (JSON text over WebSocket): `{"type":"offer","sdp":...}`, `{"type":"answer","sdp":...}`, `{"type":"ice","candidate":...,"sdpMid":...,"sdpMLineIndex":...}`, `{"type":"bye"}`. Data channels `input` (reliable) and `pointer` (unreliable) carry JSON text: `{"t":"ping","ts":<nanoTime>}` echoed back unchanged, `{"t":"move","x":nx,"y":ny}`, `{"t":"click","x":nx,"y":ny,"button":n}`.

- [ ] **Step 1: Extend the package manifest**

Replace `spikes/macprobe/Package.swift`:

```swift
// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "macprobe",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/webrtc-sdk/Specs.git", exact: "150.7871.01"),
    ],
    targets: [
        .target(
            name: "ProbeKit",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
            ]
        ),
        .target(
            name: "ProbeRTC",
            dependencies: [.product(name: "WebRTC", package: "Specs")],
            linkerSettings: [.linkedFramework("Network")]
        ),
        .executableTarget(name: "captureprobe", dependencies: ["ProbeKit"]),
        .executableTarget(name: "webrtcprobe", dependencies: ["ProbeKit", "ProbeRTC", .product(name: "WebRTC", package: "Specs")]),
        .testTarget(name: "ProbeKitTests", dependencies: ["ProbeKit"]),
        .testTarget(name: "ProbeRTCTests", dependencies: ["ProbeRTC"]),
    ]
)
```

- [ ] **Step 2: Write the failing signaling and encoder-factory tests**

Create `spikes/macprobe/Tests/ProbeRTCTests/SignalingServerTests.swift`:

```swift
import XCTest
@testable import ProbeRTC

final class SignalingServerTests: XCTestCase {
    func testClientMessageReachesHandlerAndReplyComesBack() async throws {
        let server = try SignalingServer(port: 0)
        let received = expectation(description: "server received hello")
        server.onConnection = { conn in
            conn.onMessage = { m in
                XCTAssertEqual(m["type"] as? String, "hello")
                conn.send(["type": "welcome"])
                received.fulfill()
            }
        }
        let port = try await server.start()
        XCTAssertGreaterThan(port, 0)

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        try await task.send(.string(#"{"type":"hello"}"#))
        let reply = try await task.receive()
        guard case .string(let text) = reply else { return XCTFail("expected a text frame") }
        XCTAssertTrue(text.contains("welcome"))
        await fulfillment(of: [received], timeout: 5)
        task.cancel(with: .normalClosure, reason: nil)
        server.stop()
    }
}
```

Create `spikes/macprobe/Tests/ProbeRTCTests/ProbeEncoderFactoryTests.swift`:

```swift
import XCTest
@testable import ProbeRTC

final class ProbeEncoderFactoryTests: XCTestCase {
    func testOffersHighProfileLevel52First() {
        let codecs = ProbeEncoderFactory(h264Level: "640034").supportedCodecs()
        XCTAssertEqual(codecs.first?.name, "H264")
        XCTAssertEqual(codecs.first?.parameters["profile-level-id"], "640034")
        XCTAssertEqual(codecs.first?.parameters["level-asymmetry-allowed"], "1")
    }

    func testHEVCComesFirstWhenPreferred() {
        XCTAssertEqual(ProbeEncoderFactory(preferHEVC: true).supportedCodecs().first?.name, "H265")
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `swift test --package-path spikes/macprobe --filter ProbeRTCTests 2>&1 | tail -3`
Expected: the WebRTC xcframework downloads once (about 150 MB), then a compile error `cannot find 'SignalingServer' in scope`.

- [ ] **Step 4: Write Signaling.swift**

Create `spikes/macprobe/Sources/ProbeRTC/Signaling.swift`:

```swift
import Foundation
import Network

/// Plain (non-TLS) WebSocket server; the real host adds TLS. One `SignalingConnection` per client.
public final class SignalingServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "windowcast.probe.signaling")
    public var onConnection: ((SignalingConnection) -> Void)?

    public init(port: UInt16) throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        listener = try NWListener(using: params, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
    }

    /// Starts listening and returns the bound port.
    public func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    if !resumed { resumed = true; cont.resume(returning: self.listener.port?.rawValue ?? 0) }
                case .failed(let error):
                    if !resumed { resumed = true; cont.resume(throwing: error) }
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                guard let self else { return }
                let c = SignalingConnection(connection: conn, queue: self.queue)
                self.onConnection?(c)
                c.start()
            }
            listener.start(queue: queue)
        }
    }

    public func stop() { listener.cancel() }
}

public final class SignalingConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    public let remote: String
    public var onMessage: (([String: Any]) -> Void)?
    public var onClose: (() -> Void)?
    private var closed = false

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
        remote = "\(connection.endpoint)"
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.fireClose()
            default: break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    private func receive() {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                self.onMessage?(obj)
            }
            if error == nil && !(context?.isFinal ?? false) {
                self.receive()
            } else {
                self.fireClose()
            }
        }
    }

    private func fireClose() {
        guard !closed else { return }
        closed = true
        onClose?()
    }

    public func send(_ json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    public func close() { connection.cancel() }
}
```

- [ ] **Step 5: Write ProbeEncoderFactory.swift**

Create `spikes/macprobe/Sources/ProbeRTC/ProbeEncoderFactory.swift`:

```swift
import WebRTC

/// Offers H.264 High at a chosen level (the default factory advertises level 3.1, which makes the encoder
/// assume 13 fps at 1080p) and, optionally, HEVC first.
public final class ProbeEncoderFactory: NSObject, RTCVideoEncoderFactory {
    public let h264Level: String
    public let preferHEVC: Bool

    public init(h264Level: String = "640034", preferHEVC: Bool = false) {
        self.h264Level = h264Level
        self.preferHEVC = preferHEVC
        super.init()
    }

    public func supportedCodecs() -> [RTCVideoCodecInfo] {
        var list: [RTCVideoCodecInfo] = []
        if preferHEVC { list.append(RTCVideoCodecInfo(name: "H265")) }
        list.append(RTCVideoCodecInfo(name: "H264", parameters: [
            "profile-level-id": h264Level, "level-asymmetry-allowed": "1", "packetization-mode": "1"]))
        list.append(RTCVideoCodecInfo(name: "H264", parameters: [
            "profile-level-id": "42e01f", "level-asymmetry-allowed": "1", "packetization-mode": "1"]))
        return list
    }

    public func createEncoder(_ info: RTCVideoCodecInfo) -> RTCVideoEncoder? {
        switch info.name {
        case "H264": return RTCVideoEncoderH264(codecInfo: info)
        case "H265": return RTCVideoEncoderH265(codecInfo: info)
        default: return nil
        }
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `swift test --package-path spikes/macprobe --filter ProbeRTCTests 2>&1 | tail -3`
Expected: `Executed 3 tests, with 0 failures`. If the test binary fails to launch with `Library not loaded: @rpath/WebRTC.framework`, run once with `DYLD_FRAMEWORK_PATH=$(find spikes/macprobe/.build/artifacts -type d -name 'macos-*' | head -1)` prefixed and note it in `spikes/README.md`.

- [ ] **Step 7: Write the timer window**

Create `spikes/macprobe/Sources/webrtcprobe/TimerWindow.swift`:

```swift
import AppKit

/// Big millisecond counter plus a sweeping bar, for photographing both screens side by side.
final class TimerWindow: NSObject {
    let window: NSWindow
    private let view: TimerView

    override init() {
        view = TimerView(frame: NSRect(x: 0, y: 0, width: 640, height: 240))
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 240),
                          styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        window.title = "Windowcast timer"
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        Timer.scheduledTimer(withTimeInterval: 1.0 / 240.0, repeats: true) { [view] _ in view.needsDisplay = true }
    }

    var windowID: CGWindowID { CGWindowID(window.windowNumber) }
}

final class TimerView: NSView {
    private let start = CFAbsoluteTimeGetCurrent()

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        let ms = (CFAbsoluteTimeGetCurrent() - start) * 1000
        let text = String(format: "%08.0f", ms) as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 96, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        text.draw(at: NSPoint(x: 40, y: 90), withAttributes: attrs)
        NSColor.white.setFill()
        let x = CGFloat(ms.truncatingRemainder(dividingBy: 1000) / 1000) * (bounds.width - 40)
        NSRect(x: 20 + x, y: 30, width: 20, height: 40).fill()
    }
}
```

- [ ] **Step 8: Write PeerSession.swift**

Create `spikes/macprobe/Sources/webrtcprobe/PeerSession.swift`:

```swift
import Foundation
import CoreVideo
import ScreenCaptureKit
import WebRTC
import ProbeKit
import ProbeRTC

struct SessionOptions {
    var outputSize: CGSize
    var fps: Int
    var maxBitrate: Int
}

/// One client: one peer connection, one capture stream, two data channels.
final class PeerSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    let id: Int
    private let signaling: SignalingConnection
    private let factory: RTCPeerConnectionFactory
    private let window: SCWindow?
    private let display: SCDisplay
    private let options: SessionOptions
    private var pc: RTCPeerConnection!
    private var source: RTCVideoSource!
    private var capturer: RTCVideoCapturer!
    private var capture: CaptureStream?
    private var inputChannel: RTCDataChannel?
    private var pointerChannel: RTCDataChannel?
    private var statsTimer: Timer?
    private var trackerTimer: Timer?
    private var lastBounds: CGRect?
    private let frames = RateCounter()
    private var latestGeometry: FrameGeometry?
    private var closed = false

    init(id: Int, signaling: SignalingConnection, factory: RTCPeerConnectionFactory,
         window: SCWindow?, display: SCDisplay, options: SessionOptions) {
        self.id = id
        self.signaling = signaling
        self.factory = factory
        self.window = window
        self.display = display
        self.options = options
        super.init()
    }

    func start() {
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc = factory.peerConnection(with: config, constraints: constraints, delegate: self)
        source = factory.videoSource(forScreenCast: true)
        capturer = RTCVideoCapturer(delegate: source)
        let track = factory.videoTrack(with: source, trackId: "video0")
        let transceiverInit = RTCRtpTransceiverInit()
        transceiverInit.direction = .sendOnly
        _ = pc.addTransceiver(with: track, init: transceiverInit)

        let reliable = RTCDataChannelConfiguration()
        reliable.isOrdered = true
        inputChannel = pc.dataChannel(forLabel: "input", configuration: reliable)
        inputChannel?.delegate = self
        let lossy = RTCDataChannelConfiguration()
        lossy.isOrdered = false
        lossy.maxRetransmits = 0
        pointerChannel = pc.dataChannel(forLabel: "pointer", configuration: lossy)
        pointerChannel?.delegate = self

        signaling.onMessage = { [weak self] m in self?.handle(m) }
        signaling.onClose = { [weak self] in self?.close(reason: "signaling closed") }

        pc.offer(for: constraints) { [weak self] sdp, error in
            guard let self else { return }
            guard let sdp else { self.log("offer failed: \(error.map { "\($0)" } ?? "nil")"); return }
            self.pc.setLocalDescription(sdp) { err in
                if let err { self.log("setLocalDescription: \(err)"); return }
                self.signaling.send(["type": "offer", "sdp": sdp.sdp])
                self.log("offer sent; codecs: " + PeerSession.codecLines(sdp.sdp))
            }
        }
    }

    static func codecLines(_ sdp: String) -> String {
        sdp.components(separatedBy: "\n")
            .filter { $0.hasPrefix("a=rtpmap") || $0.hasPrefix("a=fmtp") }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .joined(separator: " | ")
    }

    private func log(_ s: String) { print("[s\(id)] \(s)") }

    private func handle(_ m: [String: Any]) {
        switch (m["type"] as? String) ?? "" {
        case "answer":
            guard let sdp = m["sdp"] as? String else { return }
            pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] err in
                guard let self else { return }
                if let err { self.log("setRemoteDescription: \(err)"); return }
                self.log("answer applied; codecs: " + PeerSession.codecLines(sdp))
                self.applyBitrate()
                self.startCapture()
            }
        case "ice":
            guard let c = m["candidate"] as? String else { return }
            let candidate = RTCIceCandidate(sdp: c, sdpMLineIndex: Int32(m["sdpMLineIndex"] as? Int ?? 0), sdpMid: m["sdpMid"] as? String)
            pc.add(candidate) { [weak self] err in if let err { self?.log("addIceCandidate: \(err)") } }
        case "bye":
            close(reason: "client said bye")
        default:
            break
        }
    }

    private func applyBitrate() {
        pc.setBweMinBitrateBps(NSNumber(value: 2_000_000), currentBitrateBps: NSNumber(value: 15_000_000), maxBitrateBps: NSNumber(value: options.maxBitrate))
        for sender in pc.senders where sender.track?.kind == "video" {
            let params = sender.parameters
            for e in params.encodings {
                e.maxBitrateBps = NSNumber(value: options.maxBitrate)
                e.minBitrateBps = NSNumber(value: 2_000_000)
                e.maxFramerate = NSNumber(value: options.fps)
            }
            params.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
            sender.parameters = params
        }
    }

    private func startCapture() {
        guard capture == nil else { return }
        do {
            let mode: CaptureMode = window == nil ? .display : .appcrop
            let c = try CaptureStream(window: window, display: display, mode: mode, outputSize: options.outputSize,
                                      fps: options.fps, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            c.onFrame = { [weak self] f in
                guard let self, f.status == .complete else { return }
                self.latestGeometry = f.geometry
                self.frames.tick()
                let ns = Int64(CMTimeGetSeconds(f.presentationTime) * 1_000_000_000)
                let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: f.pixelBuffer), rotation: ._0, timeStampNs: ns)
                self.source.capturer(self.capturer, didCapture: frame)
            }
            c.onStop = { [weak self] e in self?.log("capture stopped: \(e.map { "\($0)" } ?? "-")") }
            capture = c
            Task {
                try await c.start()
                self.log("capture started \(Int(self.options.outputSize.width))x\(Int(self.options.outputSize.height)) @\(self.options.fps) fps")
            }
            DispatchQueue.main.async { self.startTimers() }
        } catch {
            log("capture error: \(error)")
        }
    }

    private func startTimers() {
        if let w = window {
            lastBounds = WindowTracker.state(of: w.windowID)?.bounds
            trackerTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                guard let self, let st = WindowTracker.state(of: w.windowID), st.bounds != self.lastBounds, let c = self.capture else { return }
                self.lastBounds = st.bounds
                Task { try? await c.updateSourceRect(st.bounds.offsetBy(dx: -self.display.frame.minX, dy: -self.display.frame.minY)) }
            }
        }
        statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.printStats() }
    }

    private func printStats() {
        pc.statistics { [weak self] report in
            guard let self else { return }
            var line = "capture \(self.frames.perSecond) fps"
            var codecs: [String: String] = [:]
            for (_, s) in report.statistics where s.type == "codec" {
                codecs[s.id] = "\(s.values["mimeType"] ?? "") \(s.values["sdpFmtpLine"] ?? "")"
            }
            for (_, s) in report.statistics where s.type == "outbound-rtp" {
                let v = s.values
                let encoded = (v["framesEncoded"] as? NSNumber)?.doubleValue ?? 0
                let encodeTime = (v["totalEncodeTime"] as? NSNumber)?.doubleValue ?? 0
                let target = ((v["targetBitrate"] as? NSNumber)?.doubleValue ?? 0) / 1_000_000
                let avgEncodeMs = encoded > 0 ? encodeTime / encoded * 1000 : 0
                line += " | sent \(v["framesPerSecond"] ?? 0) fps \(v["frameWidth"] ?? 0)x\(v["frameHeight"] ?? 0)"
                line += " target \(String(format: "%.1f", target)) Mbps limit=\(v["qualityLimitationReason"] ?? "?")"
                line += " encode \(String(format: "%.1f", avgEncodeMs)) ms/frame avg codec=\(codecs[(v["codecId"] as? String) ?? ""] ?? "?")"
            }
            for (_, s) in report.statistics where s.type == "candidate-pair" && (s.values["nominated"] as? NSNumber)?.boolValue == true {
                let rtt = ((s.values["currentRoundTripTime"] as? NSNumber)?.doubleValue ?? 0) * 1000
                line += " | rtt \(String(format: "%.1f", rtt)) ms"
            }
            self.log(line)
        }
    }

    /// Maps a normalized client point through the live geometry, exactly as the host will.
    private func globalPoint(x: Double, y: Double) -> CGPoint? {
        guard let g = latestGeometry, let c = capture else { return nil }
        let sourceSize: CGSize
        if let w = window, let st = WindowTracker.state(of: w.windowID) { sourceSize = st.bounds.size } else { sourceSize = display.frame.size }
        return StreamMapper(sourceOrigin: c.sourceOrigin, sourceSize: sourceSize, geometry: g, unit: .points).globalPoint(nx: x, ny: y)
    }

    func close(reason: String) {
        guard !closed else { return }
        closed = true
        log("closing: \(reason)")
        DispatchQueue.main.async {
            self.statsTimer?.invalidate()
            self.trackerTimer?.invalidate()
        }
        if let c = capture { Task { await c.stop(); self.log("capture stopped") } }
        pc.close()
        signaling.close()
    }

    // MARK: RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        log("data channel \(dataChannel.label) state \(dataChannel.readyState.rawValue)")
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let obj = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
        switch (obj["t"] as? String) ?? "" {
        case "ping":
            dataChannel.sendData(buffer)   // echo, unchanged
        case "move":
            if let x = obj["x"] as? Double, let y = obj["y"] as? Double, let p = globalPoint(x: x, y: y) { Injector.move(to: p) }
        case "click":
            if let x = obj["x"] as? Double, let y = obj["y"] as? Double, let p = globalPoint(x: x, y: y) {
                let button: CGMouseButton = (obj["button"] as? Int) == 2 ? .right : .left
                Injector.click(at: p, button: button)
                log("click at (\(Int(p.x)),\(Int(p.y)))")
            }
        default:
            break
        }
    }

    // MARK: RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        log("ice state \(newState.rawValue)")
        if newState == .failed || newState == .closed { close(reason: "ice \(newState.rawValue)") }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        signaling.send(["type": "ice", "candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? "", "sdpMLineIndex": Int(candidate.sdpMLineIndex)])
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
```

- [ ] **Step 9: Write main.swift**

Create `spikes/macprobe/Sources/webrtcprobe/main.swift`:

```swift
import Foundation
import AppKit
import ScreenCaptureKit
import WebRTC
import ProbeKit
import ProbeRTC

let arguments = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
    return arguments[i + 1]
}
func has(_ name: String) -> Bool { arguments.contains(name) }
func parseSize(_ s: String?) -> CGSize? {
    guard let s, let x = s.firstIndex(of: "x"), let w = Double(s[..<x]), let h = Double(s[s.index(after: x)...]) else { return nil }
    return CGSize(width: w, height: h)
}

if has("--help") || arguments.isEmpty {
    print("""
    usage: webrtcprobe (--windows ID[,ID,ID] | --display | --timer) [--port 47901] [--fps 60] [--mbps 40]
                       [--out WxH] [--level 640034|640c1f] [--hevc] [--no-trials]
      --timer opens a millisecond timer window and streams it (add --windows to stream more).
      Each connecting client gets the next target, round robin.
    """)
    exit(arguments.isEmpty ? 64 : 0)
}

let port = UInt16(opt("--port") ?? "47901") ?? 47901
let fps = Int(opt("--fps") ?? "60") ?? 60
let maxBitrate = Int((Double(opt("--mbps") ?? "40") ?? 40) * 1_000_000)
let level = opt("--level") ?? "640034"
let hevc = has("--hevc")
let noTrials = has("--no-trials")
let windowIDs = (opt("--windows") ?? "").split(separator: ",").compactMap { UInt32($0) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var timerWindow: TimerWindow?
if has("--timer") {
    timerWindow = TimerWindow()
    app.activate(ignoringOtherApps: true)
}

if !noTrials {
    RTCInitFieldTrialDictionary(["WebRTC-ForceSendPlayoutDelay": "min_ms:0,max_ms:0"])
}
RTCInitializeSSL()
let factory = RTCPeerConnectionFactory(encoderFactory: ProbeEncoderFactory(h264Level: level, preferHEVC: hevc),
                                       decoderFactory: RTCDefaultVideoDecoderFactory())

var sessions: [Int: PeerSession] = [:]
var nextSessionID = 0

Task {
    do {
        let content = try await Shareable.content()
        var targets: [(window: SCWindow?, display: SCDisplay)] = []
        if has("--display") {
            guard let d = content.displays.first else { throw ProbeError.noDisplay }
            targets.append((nil, d))
        }
        var ids = windowIDs
        if let t = timerWindow { ids.insert(t.windowID, at: 0) }
        for id in ids {
            let w = try Shareable.window(id, in: content)
            targets.append((w, try Shareable.display(for: w, in: content)))
        }
        guard !targets.isEmpty else {
            print("nothing to stream: pass --windows ID[,ID...] (see `captureprobe list`), --display, or --timer")
            exit(64)
        }
        let server = try SignalingServer(port: port)
        server.onConnection = { conn in
            let i = nextSessionID
            nextSessionID += 1
            let target = targets[i % targets.count]
            let scale = Shareable.backingScale(of: target.display)
            let sourcePx = target.window.map { CGSize(width: $0.frame.width * scale, height: $0.frame.height * scale) }
                ?? CGSize(width: target.display.frame.width * scale, height: target.display.frame.height * scale)
            let out = parseSize(opt("--out")) ?? OutputSizePolicy.outputSize(source: sourcePx, viewport: CGSize(width: 1920, height: 1200))
            let session = PeerSession(id: i, signaling: conn, factory: factory, window: target.window, display: target.display,
                                      options: SessionOptions(outputSize: out, fps: fps, maxBitrate: maxBitrate))
            sessions[i] = session
            print("[s\(i)] client \(conn.remote) -> \(target.window?.title ?? "display \(target.display.displayID)") out=\(Int(out.width))x\(Int(out.height))")
            session.start()
        }
        let bound = try await server.start()
        print("webrtcprobe listening on ws://<mac-ip>:\(bound)   (this Mac's IP: `ipconfig getifaddr en0`)")
        print("trials=\(!noTrials) level=\(level) hevc=\(hevc) fps=\(fps) maxMbps=\(maxBitrate / 1_000_000) targets=\(targets.count)")
    } catch {
        print("error: \(error)")
        exit(1)
    }
}

app.run()
```

- [ ] **Step 10: Build and smoke-test the host alone**

Run: `swift build --package-path spikes/macprobe 2>&1 | tail -3`, then `swift run --package-path spikes/macprobe webrtcprobe --timer`
Expected: the timer window appears counting milliseconds with a sweeping bar, and the console prints `webrtcprobe listening on ws://<mac-ip>:47901` followed by the `trials=true level=640034 ...` line. Stop it with Ctrl-C. If it fails at launch with `Library not loaded: @rpath/WebRTC.framework`, prefix the command with the `DYLD_FRAMEWORK_PATH` from Task 7 step 6.

- [ ] **Step 11: Commit**

```bash
git add spikes/macprobe
git commit -m "spike: webrtcprobe streams a window over WebRTC with plain WebSocket signaling"
git push
```

---

### Task 8: Android probe project, `wc` helper, first install on the Googlebook

**Files:**
- Create: `wc` (repo root, executable)
- Create: `spikes/webrtcprobe-android/settings.gradle.kts`
- Create: `spikes/webrtcprobe-android/build.gradle.kts`
- Create: `spikes/webrtcprobe-android/gradle.properties`
- Create: `spikes/webrtcprobe-android/gradle/libs.versions.toml`
- Create: `spikes/webrtcprobe-android/gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties` (copied from `kuscher/studiosnap`)
- Create: `spikes/webrtcprobe-android/app/build.gradle.kts`
- Create: `spikes/webrtcprobe-android/app/src/main/AndroidManifest.xml`
- Create: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/Prefs.kt`
- Create: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/MainActivity.kt`
- Create: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/StreamActivity.kt` (placeholder; real one in Task 9)
- Create: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/ProbeService.kt`

**Interfaces:**
- Produces: `Prefs` (`host: String`, `port: Int`, `lowLatencyTrials: Boolean`, `liftH264Level: Boolean`); `ProbeService` (foreground service, log tag `WCProbe`); `MainActivity` launches `StreamActivity` with extra `index: Int` and launch bounds; `./wc` commands `pair`, `connect`, `adb`, `spike-app`, `spike-logs`, `live-resize`.

- [ ] **Step 1: Write the `wc` helper**

Create `wc` at the repo root:

```bash
#!/usr/bin/env bash
# Windowcast dev helper: talk to the Googlebook over Wi-Fi adb and drive the spike app.
# Usage: ./wc <command>   (mirrors the other Book projects' helpers)
set -euo pipefail
cd "$(dirname "$0")"

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
STATE_DIR="$HOME/.config/windowcast"
SERIAL_FILE="$STATE_DIR/adb-serial"
SPIKE_PKG=io.github.kuscher.windowcast.spike
SPIKE_DIR=spikes/webrtcprobe-android
SPIKE_APK=$SPIKE_DIR/app/build/outputs/apk/debug/app-debug.apk

serial() { cat "$SERIAL_FILE" 2>/dev/null || true; }

# Wireless debugging's connect port changes after every reboot; find it over mDNS from the Mac.
connect() {
  local s; s="$(serial)"
  if [ -n "$s" ] && "$ADB" -s "$s" shell true </dev/null >/dev/null 2>&1; then echo "$s"; return; fi
  local line; line="$("$ADB" mdns services 2>/dev/null | grep '_adb-tls-connect' | head -1 || true)"
  if [ -z "$line" ]; then
    echo "Googlebook not found over mDNS. Turn on Wireless debugging (Developer options) and pair once: ./wc pair IP:PORT CODE" >&2
    exit 1
  fi
  local hp; hp="$(echo "$line" | awk '{print $NF}')"
  "$ADB" connect "$hp" >/dev/null
  mkdir -p "$STATE_DIR"; echo "$hp" > "$SERIAL_FILE"
  echo "$hp"
}

A() { "$ADB" -s "$(connect)" "$@"; }

install_apk() {
  local apk="$1"
  A shell settings put global verifier_verify_adb_installs 0
  A install -r -g "$apk" || { A shell settings put global verifier_verify_adb_installs 1; exit 1; }
  A shell settings put global verifier_verify_adb_installs 1
}

case "${1:-}" in
  pair)        shift; "$ADB" pair "$@" ;;                       # ./wc pair 192.168.1.23:41263 123456
  connect)     connect ;;
  adb)         shift; A "$@" ;;                                 # ./wc adb shell dumpsys window windows
  spike-build) (cd "$SPIKE_DIR" && ./gradlew :app:assembleDebug --console=plain) ;;
  spike-app)   (cd "$SPIKE_DIR" && ./gradlew :app:assembleDebug --console=plain)
               install_apk "$SPIKE_APK"
               A shell am start --user current -n "$SPIKE_PKG/.MainActivity" >/dev/null
               echo "started $SPIKE_PKG" ;;
  spike-logs)  A logcat -v time -s WCProbe:* AndroidRuntime:E ;;
  live-resize) A shell am compat enable ENABLE_FLUID_RESIZING "$SPIKE_PKG"; echo "fluid resizing enabled for $SPIKE_PKG" ;;
  *) echo "usage: ./wc pair IP:PORT CODE | connect | adb ... | spike-build | spike-app | spike-logs | live-resize"; exit 64 ;;
esac
```

Then `chmod +x wc`.

- [ ] **Step 2: Pair and connect the Googlebook**

On the Googlebook: Settings, System, Developer options, Wireless debugging, "Pair device with pairing code". On the Mac:

```bash
./wc pair 192.168.X.Y:PORT CODE     # values from the pairing dialog
./wc connect
./wc adb shell getprop ro.product.device
```

Expected: `Successfully paired`, then the connect address is printed, then `quartz` (the HP Googlebook 14). If `./wc connect` cannot find the device over mDNS, run `./wc adb devices` after a manual `adb connect IP:PORT` with the port shown on the Wireless debugging screen; `connect` caches whatever works.

- [ ] **Step 3: Gradle project files**

Create `spikes/webrtcprobe-android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "WebRTCProbe"
include(":app")
```

Create `spikes/webrtcprobe-android/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
```

Create `spikes/webrtcprobe-android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx3g
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
org.gradle.caching=true
org.gradle.configuration-cache=true
```

Create `spikes/webrtcprobe-android/gradle/libs.versions.toml`:

```toml
[versions]
agp = "9.4.1"
kotlin = "2.4.20"
coreKtx = "1.19.1"
activityCompose = "1.13.0"
composeBom = "2026.09.00"
okhttp = "5.5.0"
webrtc = "150.7871.01"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-compose-foundation = { group = "androidx.compose.foundation", name = "foundation" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
webrtc = { group = "io.github.webrtc-sdk", name = "android", version.ref = "webrtc" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
```

Copy the Gradle wrapper (9.8.0) from the sibling project and point Gradle at the SDK:

```bash
cd spikes/webrtcprobe-android
mkdir -p gradle/wrapper
for f in gradlew gradlew.bat gradle/wrapper/gradle-wrapper.jar gradle/wrapper/gradle-wrapper.properties; do
  gh api "repos/kuscher/studiosnap/contents/$f" --jq .content | base64 -d > "$f"
done
chmod +x gradlew
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
grep distributionUrl gradle/wrapper/gradle-wrapper.properties
cd ../..
```

Expected: the last line prints `...gradle-9.8.0-bin.zip`.

- [ ] **Step 4: App module, manifest and the small files**

Create `spikes/webrtcprobe-android/app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "io.github.kuscher.windowcast.spike"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.kuscher.windowcast.spike"
        minSdk = 34
        targetSdk = 37
        versionCode = 1
        versionName = "0.0"
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.okhttp)
    implementation(libs.webrtc)
}
```

Create `spikes/webrtcprobe-android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
    <uses-permission android:name="android.permission.ACCESS_LOCAL_NETWORK" />
    <uses-permission android:name="android.permission.CAPTURE_KEYBOARD" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <uses-feature android:name="android.hardware.type.pc" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:label="WC Probe"
        android:icon="@android:drawable/ic_menu_view"
        android:theme="@android:style/Theme.Material.Light.NoActionBar"
        android:allowBackup="false">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:resizeableActivity="true"
            android:configChanges="screenSize|smallestScreenSize|screenLayout|orientation|density|keyboard|keyboardHidden|navigation|uiMode">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <layout android:minWidth="480dp" android:minHeight="360dp" android:defaultWidth="720dp" android:defaultHeight="640dp" />
        </activity>

        <activity
            android:name=".StreamActivity"
            android:exported="false"
            android:documentLaunchMode="always"
            android:taskAffinity=""
            android:resizeableActivity="true"
            android:configChanges="screenSize|smallestScreenSize|screenLayout|orientation|density|keyboard|keyboardHidden|navigation|uiMode" />

        <service
            android:name=".ProbeService"
            android:exported="false"
            android:foregroundServiceType="connectedDevice" />
    </application>
</manifest>
```

Create `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/Prefs.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

import android.content.Context

class Prefs(context: Context) {
    private val p = context.getSharedPreferences("probe", Context.MODE_PRIVATE)

    var host: String
        get() = p.getString("host", "") ?: ""
        set(v) = p.edit().putString("host", v).apply()

    var port: Int
        get() = p.getInt("port", 47901)
        set(v) = p.edit().putInt("port", v).apply()

    /** Receiver-side field trial WebRTC-ForcePlayoutDelay 0/0. Read once when the factory is created. */
    var lowLatencyTrials: Boolean
        get() = p.getBoolean("trials", true)
        set(v) = p.edit().putBoolean("trials", v).apply()

    /** Advertise H.264 High level 5.2 instead of libwebrtc's default 3.1. */
    var liftH264Level: Boolean
        get() = p.getBoolean("lift", true)
        set(v) = p.edit().putBoolean("lift", v).apply()
}
```

Create `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/ProbeService.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log

/** Keeps the process alive while stream windows are open; also answers "does a connectedDevice FGS start?" */
class ProbeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("probe", "WC Probe", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, "probe")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("WC Probe streaming")
            .build()
        try {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            Log.i(TAG, "FGS connectedDevice started OK")
        } catch (e: Exception) {
            Log.e(TAG, "FGS start FAILED: $e")
        }
        return START_NOT_STICKY
    }

    companion object {
        const val TAG = "WCProbe"
    }
}
```

Create the placeholder `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/StreamActivity.kt` (replaced in Task 9):

```kotlin
package io.github.kuscher.windowcast.spike

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text

class StreamActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Text("Stream window ${intent.getIntExtra("index", 0)} (Task 9 fills this in)") }
    }
}
```

- [ ] **Step 5: MainActivity**

Create `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/MainActivity.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

import android.app.ActivityOptions
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Rect
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.system.exitProcess

class MainActivity : ComponentActivity() {
    private lateinit var prefs: Prefs
    private val permissionState = mutableStateOf("")
    private val requestPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionState.value = "ACCESS_LOCAL_NETWORK granted=$granted"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        permissionState.value = "ACCESS_LOCAL_NETWORK granted=${checkSelfPermission(LOCAL_NET) == PackageManager.PERMISSION_GRANTED}"
        setContent { MaterialTheme { Screen() } }
    }

    @Composable
    private fun Screen() {
        var host by remember { mutableStateOf(prefs.host) }
        var port by remember { mutableStateOf(prefs.port.toString()) }
        var trials by remember { mutableStateOf(prefs.lowLatencyTrials) }
        var lift by remember { mutableStateOf(prefs.liftH264Level) }
        Column(
            Modifier.padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Windowcast WebRTC probe", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(host, { host = it; prefs.host = it.trim() }, label = { Text("Mac IP") })
            OutlinedTextField(port, { port = it; it.toIntOrNull()?.let { p -> prefs.port = p } }, label = { Text("Port") })
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(trials, { trials = it; prefs.lowLatencyTrials = it })
                Text("  playout-delay 0/0 field trial (quit app to apply)")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(lift, { lift = it; prefs.liftH264Level = it })
                Text("  advertise H.264 level 5.2 (quit app to apply)")
            }
            Text("Factory initialized with: ${Rtc.initializedWith ?: "not yet"}")
            Text(permissionState.value)
            Button({ requestPermission.launch(LOCAL_NET) }) { Text("Request local network permission") }
            Button({ openWindows(1) }) { Text("Open 1 stream window") }
            Button({ openWindows(3) }) { Text("Open 3 stream windows") }
            Button({ finishAffinity(); exitProcess(0) }) { Text("Quit app (applies the switches)") }
            Text(decoderReport(), fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
    }

    /** One task per window, sized and cascaded at launch (the only moment Android lets an app size its window). */
    private fun openWindows(n: Int) {
        repeat(n) { i ->
            val intent = Intent(this, StreamActivity::class.java)
                .putExtra("index", i)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
            val left = 80 + i * 60
            val top = 80 + i * 60
            val bounds = Rect(left, top, left + 960, top + 640)  // display pixels
            startActivity(intent, ActivityOptions.makeBasic().setLaunchBounds(bounds).toBundle())
        }
    }

    private fun decoderReport(): String = buildString {
        append("Video decoders:\n")
        for (info in MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos) {
            if (info.isEncoder) continue
            for (type in info.supportedTypes) {
                if (type != "video/avc" && type != "video/hevc") continue
                val caps = info.getCapabilitiesForType(type)
                val lowLatency = caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
                append("$type ${info.name} lowLatency=$lowLatency maxInstances=${caps.maxSupportedInstances}\n")
            }
        }
    }

    companion object {
        const val LOCAL_NET = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
```

`Rtc.initializedWith` arrives in Task 9; for this task create a stub `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/Rtc.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

object Rtc {
    @Volatile var initializedWith: String? = null
}
```

- [ ] **Step 6: Build, install and launch**

Run: `./wc spike-app`
Expected: Gradle downloads 9.8.0 and, through AGP's SDK auto-download, platform 37 and build-tools 36.0.0 (several minutes the first time); `BUILD SUCCESSFUL`; `started io.github.kuscher.windowcast.spike`; the "Windowcast WebRTC probe" window opens on the Googlebook with the decoder list at the bottom. If AGP reports that platform 37 is missing and cannot be downloaded, install "Android 17 (API 37)" and build-tools 36.0.0 from Android Studio's SDK Manager and rerun.

- [ ] **Step 7: Permission and multi-window checks**

On the Googlebook: tap "Request local network permission" and record the prompt and result. Tap "Open 3 stream windows": three placeholder windows must appear cascaded at the requested positions, each with its own taskbar entry, while the probe window stays open. Record both in the findings file ("Local network permission", "Three windows: launch bounds honored"). Copy the decoder report lines into "Codec negotiation: HEVC decoders".

- [ ] **Step 8: Commit**

```bash
git add wc spikes/webrtcprobe-android docs/superpowers/spikes
git commit -m "spike: Android probe scaffold with wc helper, permission and multi-window checks"
git push
```

---

### Task 9: Android stream window with stats, input logging and keyboard capture

**Files:**
- Modify: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/Rtc.kt` (replace the stub)
- Create: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/Signaling.kt`
- Modify: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/StreamActivity.kt` (replace the placeholder)

**Interfaces:**
- Consumes: `Prefs`, `ProbeService`, the wire format from Task 7, `MainActivity`'s `index` extra.
- Produces: `Rtc.factory(context, prefs)`, `Rtc.eglBase`, `Rtc.initializedWith`; `LevelLiftingDecoderFactory`; `Signaling(url, onMessage, onState)` with `send(JSONObject)`, `close()`; `StreamActivity` logging lines tagged `WCProbe`: `key ...`, `motion ...`, `scroll ...`, `focus=...`, `keyboard capture=...`, `ice ...`, `pc ...`, `data channel ...`.

- [ ] **Step 1: Rtc.kt with the factory and the level-lifting decoder factory**

Replace `Rtc.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory

object Rtc {
    @Volatile var initializedWith: String? = null
    lateinit var eglBase: EglBase
    private var factory: PeerConnectionFactory? = null

    @Synchronized
    fun factory(context: Context, prefs: Prefs): PeerConnectionFactory {
        factory?.let { return it }
        val trials = if (prefs.lowLatencyTrials) "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/" else ""
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .setFieldTrials(trials)
                .createInitializationOptions()
        )
        eglBase = EglBase.create()
        val decoders: VideoDecoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext).let {
            if (prefs.liftH264Level) LevelLiftingDecoderFactory(it) else it
        }
        val encoders = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        initializedWith = "trials='${trials.ifEmpty { "none" }}' liftLevel=${prefs.liftH264Level}"
        return PeerConnectionFactory.builder()
            .setVideoDecoderFactory(decoders)
            .setVideoEncoderFactory(encoders)
            .createPeerConnectionFactory()
            .also { factory = it }
    }
}

/** Advertises H.264 High as level 5.2 so the negotiated codec does not pin the Mac encoder to level 3.1. */
class LevelLiftingDecoderFactory(private val inner: VideoDecoderFactory) : VideoDecoderFactory {
    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? = inner.createDecoder(info)

    override fun getSupportedCodecs(): Array<VideoCodecInfo> = inner.supportedCodecs.map { c ->
        val level = c.params["profile-level-id"]
        if (c.name.equals("H264", ignoreCase = true) && level != null && level.startsWith("64")) {
            VideoCodecInfo(c.name, c.params.toMutableMap().apply { put("profile-level-id", "640034") }, c.scalabilityModes)
        } else c
    }.toTypedArray()
}
```

- [ ] **Step 2: Signaling.kt**

Create `Signaling.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** JSON text over a plain WebSocket to webrtcprobe. Callbacks arrive on OkHttp threads. */
class Signaling(url: String, private val onMessage: (JSONObject) -> Unit, private val onState: (String) -> Unit) {
    private val client = OkHttpClient.Builder().pingInterval(10, TimeUnit.SECONDS).build()
    private val socket: WebSocket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = onState("open")
        override fun onMessage(webSocket: WebSocket, text: String) = onMessage(JSONObject(text))
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onState("failed: ${t.message}")
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onState("closed $code $reason")
    })

    fun send(obj: JSONObject) { socket.send(obj.toString()) }

    fun close() {
        socket.send(JSONObject().put("type", "bye").toString())
        socket.close(1000, "bye")
    }
}
```

- [ ] **Step 3: StreamActivity.kt**

Replace `StreamActivity.kt`:

```kotlin
package io.github.kuscher.windowcast.spike

import android.app.ActivityManager
import android.content.Intent
import android.graphics.RectF
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RendererCommon
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

class StreamActivity : ComponentActivity() {
    private lateinit var prefs: Prefs
    private var pc: PeerConnection? = null
    private var signaling: Signaling? = null
    private var renderer: SurfaceViewRenderer? = null
    private var inputChannel: DataChannel? = null
    private var pointerChannel: DataChannel? = null
    private val stats = mutableStateOf("connecting…")
    private val lastInput = mutableStateOf("")
    private val captureKeys = mutableStateOf(true)
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var videoSize = Size(0, 0)
    @Volatile private var rttMs = 0.0
    private var prevJitterDelay = 0.0
    private var prevJitterCount = 0.0
    private var prevDecodeTime = 0.0
    private var prevDecoded = 0.0

    /** Records the decoded size (for letterbox math) and forwards frames to the renderer. */
    private val sink = VideoSink { frame ->
        videoSize = Size(frame.rotatedWidth, frame.rotatedHeight)
        renderer?.onFrame(frame)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val index = intent.getIntExtra("index", 0)
        setTaskDescription(ActivityManager.TaskDescription.Builder().setLabel("Probe $index").build())
        openWindows++
        startForegroundService(Intent(this, ProbeService::class.java))
        setContent { MaterialTheme { StreamScreen() } }
        connect()
        handler.post(statsTick)
        handler.post(pingTick)
    }

    @Composable
    private fun StreamScreen() {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    SurfaceViewRenderer(ctx).apply {
                        init(Rtc.eglBase.eglBaseContext, null)
                        setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                        setEnableHardwareScaler(true)
                        renderer = this
                    }
                },
            )
            Column(
                Modifier.align(Alignment.TopEnd).padding(8.dp).background(Color(0x99000000)).padding(8.dp),
            ) {
                Text(stats.value, color = Color.White, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                Text(lastInput.value, color = Color.Yellow, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                Button(onClick = { captureKeys.value = !captureKeys.value; applyKeyboardCapture(captureKeys.value) }) {
                    Text(if (captureKeys.value) "Keys: captured" else "Keys: normal")
                }
            }
        }
    }

    // ---- WebRTC ----

    private fun connect() {
        val factory = Rtc.factory(this, prefs)
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        pc = factory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                signaling?.send(JSONObject().put("type", "ice").put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex))
            }
            override fun onTrack(t: RtpTransceiver) {
                (t.receiver.track() as? VideoTrack)?.addSink(sink)
                Log.i(TAG, "track ${t.receiver.track()?.kind()}")
            }
            override fun onDataChannel(dc: DataChannel) {
                Log.i(TAG, "data channel ${dc.label()}")
                if (dc.label() == "input") inputChannel = dc else pointerChannel = dc
                dc.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(previousAmount: Long) {}
                    override fun onStateChange() { Log.i(TAG, "data channel ${dc.label()} ${dc.state()}") }
                    override fun onMessage(buffer: DataChannel.Buffer) {
                        val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                        val text = String(bytes)
                        if (text.contains("\"ping\"")) rttMs = (System.nanoTime() - JSONObject(text).getLong("ts")) / 1e6
                    }
                })
            }
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) { Log.i(TAG, "ice $s") }
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState) { Log.i(TAG, "pc $s") }
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        })
        val url = "ws://${prefs.host}:${prefs.port}/"
        signaling = Signaling(url,
            onMessage = { m -> runOnUiThread { handleSignal(m) } },
            onState = { s -> Log.i(TAG, "ws $s"); runOnUiThread { if (!s.startsWith("open")) stats.value = "ws $s" } })
    }

    private fun handleSignal(m: JSONObject) {
        when (m.optString("type")) {
            "offer" -> {
                val offer = SessionDescription(SessionDescription.Type.OFFER, m.getString("sdp"))
                Log.i(TAG, "offer codecs: " + codecLines(offer.description))
                pc?.setRemoteDescription(object : SdpObserverAdapter() {
                    override fun onSetSuccess() {
                        pc?.createAnswer(object : SdpObserverAdapter() {
                            override fun onCreateSuccess(sdp: SessionDescription) {
                                pc?.setLocalDescription(SdpObserverAdapter(), sdp)
                                signaling?.send(JSONObject().put("type", "answer").put("sdp", sdp.description))
                                Log.i(TAG, "answer codecs: " + codecLines(sdp.description))
                            }
                        }, MediaConstraints())
                    }
                }, offer)
            }
            "ice" -> pc?.addIceCandidate(IceCandidate(m.optString("sdpMid"), m.optInt("sdpMLineIndex"), m.getString("candidate")))
        }
    }

    private fun codecLines(sdp: String) =
        sdp.lines().filter { it.startsWith("a=rtpmap") || it.startsWith("a=fmtp") }.joinToString(" | ") { it.trim() }

    private open class SdpObserverAdapter : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) { Log.e(TAG, "sdp create failure $error") }
        override fun onSetFailure(error: String) { Log.e(TAG, "sdp set failure $error") }
    }

    private fun DataChannel.sendText(s: String) {
        if (state() == DataChannel.State.OPEN) send(DataChannel.Buffer(ByteBuffer.wrap(s.toByteArray()), false))
    }

    // ---- stats ----

    private val statsTick = object : Runnable {
        override fun run() {
            pc?.getStats { report ->
                var line = "dc rtt %.1f ms".format(rttMs)
                val codecs = report.statsMap.values.filter { it.type == "codec" }
                    .associate { it.id to "${it.members["mimeType"]} ${it.members["sdpFmtpLine"]}" }
                report.statsMap.values.filter { it.type == "inbound-rtp" && it.members["kind"] == "video" }.forEach { s ->
                    val m = s.members
                    val decoded = (m["framesDecoded"] as? Number)?.toDouble() ?: 0.0
                    val jitterDelay = (m["jitterBufferDelay"] as? Number)?.toDouble() ?: 0.0
                    val jitterCount = (m["jitterBufferEmittedCount"] as? Number)?.toDouble() ?: 0.0
                    val decodeTime = (m["totalDecodeTime"] as? Number)?.toDouble() ?: 0.0
                    val jbPerFrame = (jitterDelay - prevJitterDelay) / max(jitterCount - prevJitterCount, 1.0) * 1000
                    val decodePerFrame = (decodeTime - prevDecodeTime) / max(decoded - prevDecoded, 1.0) * 1000
                    prevJitterDelay = jitterDelay; prevJitterCount = jitterCount; prevDecodeTime = decodeTime; prevDecoded = decoded
                    line += "\n${m["frameWidth"]}x${m["frameHeight"]} ${m["framesPerSecond"]} fps decoded=${decoded.toLong()}"
                    line += "\njitterBuf %.1f ms/frame  decode %.1f ms/frame (last second)".format(jbPerFrame, decodePerFrame)
                    line += "\n${m["decoderImplementation"]}\n${codecs[m["codecId"]]}"
                }
                report.statsMap.values.filter { it.type == "candidate-pair" && it.members["nominated"] == true }.forEach {
                    val rtt = ((it.members["currentRoundTripTime"] as? Number)?.toDouble() ?: 0.0) * 1000
                    line += "\nice rtt %.1f ms".format(rtt)
                }
                runOnUiThread { stats.value = line }
            }
            handler.postDelayed(this, 1000)
        }
    }

    private val pingTick = object : Runnable {
        override fun run() {
            inputChannel?.sendText("""{"t":"ping","ts":${System.nanoTime()}}""")
            handler.postDelayed(this, 1000)
        }
    }

    // ---- input ----

    private fun fittedRect(w: Int, h: Int): RectF? {
        val vw = videoSize.width; val vh = videoSize.height
        if (vw == 0 || vh == 0 || w == 0 || h == 0) return null
        val s = min(w.toFloat() / vw, h.toFloat() / vh)
        val fw = vw * s; val fh = vh * s
        val l = (w - fw) / 2; val t = (h - fh) / 2
        return RectF(l, t, l + fw, t + fh)
    }

    private fun onPointer(ev: MotionEvent) {
        val r = renderer ?: return
        val loc = IntArray(2).also { r.getLocationOnScreen(it) }
        val fit = fittedRect(r.width, r.height) ?: return
        val nx = ((ev.rawX - loc[0] - fit.left) / fit.width()).coerceIn(0f, 1f)
        val ny = ((ev.rawY - loc[1] - fit.top) / fit.height()).coerceIn(0f, 1f)
        when (ev.actionMasked) {
            MotionEvent.ACTION_HOVER_MOVE, MotionEvent.ACTION_MOVE ->
                pointerChannel?.sendText("""{"t":"move","x":$nx,"y":$ny}""")
            MotionEvent.ACTION_BUTTON_PRESS ->
                inputChannel?.sendText("""{"t":"click","x":$nx,"y":$ny,"button":${ev.actionButton}}""")
            MotionEvent.ACTION_SCROLL -> {
                val s = "scroll src=${ev.source} touchpad=${ev.isFromSource(InputDevice.SOURCE_TOUCHPAD)} mouse=${ev.isFromSource(InputDevice.SOURCE_MOUSE)} v=${ev.getAxisValue(MotionEvent.AXIS_VSCROLL)} h=${ev.getAxisValue(MotionEvent.AXIS_HSCROLL)}"
                lastInput.value = s
                Log.i(TAG, s)
            }
        }
        if (ev.actionMasked != MotionEvent.ACTION_HOVER_MOVE && ev.actionMasked != MotionEvent.ACTION_MOVE && ev.actionMasked != MotionEvent.ACTION_SCROLL) {
            Log.i(TAG, "motion ${MotionEvent.actionToString(ev.actionMasked)} src=${ev.source} btn=${ev.actionButton} state=${ev.buttonState} x=$nx y=$ny")
        }
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean { onPointer(ev); return true }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean { onPointer(ev); return super.dispatchTouchEvent(ev) }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val s = "key ${KeyEvent.keyCodeToString(event.keyCode)} ${if (event.action == KeyEvent.ACTION_DOWN) "down" else "up"} meta=0x${Integer.toHexString(event.metaState)} uni=${event.unicodeChar} rep=${event.repeatCount}"
        Log.i(TAG, s)
        lastInput.value = s
        return true  // consume everything, including Esc, which would otherwise become Back
    }

    private fun applyKeyboardCapture(on: Boolean) {
        try {
            val lp = window.attributes
            lp.setKeyboardCaptureEnabled(on)
            window.attributes = lp
            Log.i(TAG, "keyboard capture=$on")
        } catch (e: Throwable) {
            Log.e(TAG, "keyboard capture failed: $e")
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        Log.i(TAG, "focus=$hasFocus")
        if (hasFocus) applyKeyboardCapture(captureKeys.value)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        signaling?.close()
        pc?.close()
        renderer?.release()
        openWindows--
        if (openWindows == 0) stopService(Intent(this, ProbeService::class.java))
        super.onDestroy()
    }

    companion object {
        const val TAG = "WCProbe"
        private var openWindows = 0
    }
}
```

- [ ] **Step 4: Build and install**

Run: `./wc spike-app 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL` and the probe window opens. If `setKeyboardCaptureEnabled` does not resolve, the SDK 37 platform is not the one compiling; check `compileSdk = 37` and the SDK install from Task 8 step 6.

- [ ] **Step 5: First stream**

On the Mac: `swift run --package-path spikes/macprobe webrtcprobe --timer`, and note the IP from `ipconfig getifaddr en0`. On the Googlebook: enter the IP, keep port 47901, tap "Open 1 stream window".
Expected: the timer window appears in the Android window within two seconds, counting; the overlay shows `WxH 60 fps`, a decoder name such as `c2.qti.hevc...` or `OMX.qcom...`/`c2.qti.avc.decoder`, a `codec` line with `H264` and the negotiated `profile-level-id`, `jitterBuf` and `decode` per-frame numbers and both RTTs. In another terminal `./wc spike-logs` shows `ice CONNECTED`, `data channel input`, `data channel pointer`, `FGS connectedDevice started OK` (or the failure text, which is itself a finding).

- [ ] **Step 6: Input round trip**

Move the mouse over the video on the Googlebook: the Mac's pointer follows inside the timer window. Click: the host log prints `click at (x,y)`. Two-finger scroll on the trackpad and roll a mouse wheel if one is available: the yellow overlay line and logcat show `scroll src=... touchpad=... v=...`. Record the sources and per-event values in "Trackpad and mouse scroll events".

- [ ] **Step 7: Keyboard matrix**

With the stream window focused and "Keys: captured" on, press each key in the findings matrix and record whether logcat shows a `key ...` line and what the system did (switched apps, opened the launcher, showed an "exit hint"). Toggle to "Keys: normal" and repeat. Record the matrix.

- [ ] **Step 8: Menus and popups in the stream**

Run the host with `--windows SAFARI_ID` instead of `--timer`, open Safari's File menu and a right-click context menu on the Mac while watching the Android window. Record in the S1 behavior table ("Menu or popover opened from the target", appcrop column) whether they are visible.

- [ ] **Step 9: Disconnect handling (Review Focus 5)**

With a stream running, force-stop the app: `./wc adb shell am force-stop io.github.kuscher.windowcast.spike`.
Expected: within 10 s the host prints `closing: signaling closed` (or `ice ...`) followed by `capture stopped`, and the timer window keeps running normally. If the host keeps printing `capture N fps` lines for that session, the close path is broken and must be fixed before Task 10.

**Alex** in this task: enters the IP (step 5), moves the mouse and scrolls (step 6), presses the keys (step 7) and opens the Safari menus (step 8).

- [ ] **Step 10: Commit**

```bash
git add spikes/webrtcprobe-android docs/superpowers/spikes
git commit -m "spike: Android stream window renders WebRTC video and logs stats, input and keyboard capture"
git push
```

---

### Task 10: S3, the same stream over Tailscale from outside the home network

**Files:**
- Modify: `spikes/macprobe/Sources/webrtcprobe/PeerSession.swift` (log local candidates and the selected pair)
- Modify: `spikes/webrtcprobe-android/app/src/main/java/io/github/kuscher/windowcast/spike/StreamActivity.kt` (same on the client)
- Modify: `docs/superpowers/spikes/2026-09-27-phase0-findings.md` (section "S3")

**Interfaces:**
- Consumes: everything from Tasks 7 to 9; the `--mbps`, `--fps` and `--timer` options of `webrtcprobe`.
- Produces: log lines `local candidate ...` on both ends and `pair <local> -> <remote>` in both stats outputs; the S3 tables in the findings file.

- [ ] **Step 1: Alex: install and join Tailscale on both devices**

**Alex:** install Tailscale from the Mac App Store and from the Play Store on the Googlebook, sign both in to the same tailnet, and turn on MagicDNS in the Tailscale admin console (DNS tab). Leave the Googlebook on the home Wi-Fi for now.

Verify from the Mac:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
```

Expected: the Googlebook appears in the status list with a `100.x.y.z` address, and the second command prints the Mac's own `100.x.y.z`. Write both into the S3 "Setup" lines of the findings file, with the app versions shown in each app's settings.

- [ ] **Step 2: Log candidates and the selected pair on the host**

In `PeerSession.swift`, replace the `didGenerate` delegate method with:

```swift
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        log("local candidate \(candidate.sdp)")
        signaling.send(["type": "ice", "candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? "", "sdpMLineIndex": Int(candidate.sdpMLineIndex)])
    }
```

In `printStats()`, replace the `candidate-pair` loop with:

```swift
            var candidates: [String: String] = [:]
            for (_, s) in report.statistics where s.type == "local-candidate" || s.type == "remote-candidate" {
                let v = s.values
                candidates[s.id] = "\(v["address"] ?? "?"):\(v["port"] ?? "?") \(v["candidateType"] ?? "?") \(v["networkType"] ?? "")"
            }
            for (_, s) in report.statistics where s.type == "candidate-pair" && (s.values["nominated"] as? NSNumber)?.boolValue == true {
                let rtt = ((s.values["currentRoundTripTime"] as? NSNumber)?.doubleValue ?? 0) * 1000
                let local = candidates[(s.values["localCandidateId"] as? String) ?? ""] ?? "?"
                let remote = candidates[(s.values["remoteCandidateId"] as? String) ?? ""] ?? "?"
                line += " | rtt \(String(format: "%.1f", rtt)) ms pair \(local) -> \(remote)"
            }
```

- [ ] **Step 3: Log candidates and the selected pair on the client**

In `StreamActivity.kt`, change `onIceCandidate` to log before sending:

```kotlin
            override fun onIceCandidate(c: IceCandidate) {
                Log.i(TAG, "local candidate ${c.sdp}")
                signaling?.send(JSONObject().put("type", "ice").put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex))
            }
```

and replace the `candidate-pair` block inside `statsTick` with:

```kotlin
                val candidates = report.statsMap.values
                    .filter { it.type == "local-candidate" || it.type == "remote-candidate" }
                    .associate { it.id to "${it.members["address"]}:${it.members["port"]} ${it.members["candidateType"]} ${it.members["networkType"] ?: ""}" }
                report.statsMap.values.filter { it.type == "candidate-pair" && it.members["nominated"] == true }.forEach {
                    val rtt = ((it.members["currentRoundTripTime"] as? Number)?.toDouble() ?: 0.0) * 1000
                    line += "\nice rtt %.1f ms".format(rtt)
                    line += "\npair ${candidates[it.members["localCandidateId"]]} -> ${candidates[it.members["remoteCandidateId"]]}"
                }
```

Build both: `swift build --package-path spikes/macprobe 2>&1 | tail -1` and `./wc spike-app 2>&1 | tail -2`. Expected: `Build complete!` and `BUILD SUCCESSFUL`.

- [ ] **Step 4: Tailnet path while still on the home Wi-Fi**

Host: `swift run --package-path spikes/macprobe webrtcprobe --timer`. On the Googlebook enter the Mac's `100.x.y.z` address instead of the LAN IP and open one stream window.
Expected: the stream connects; the host log shows `local candidate` lines that include the `100.x` address; the overlay's `pair` line shows `100.x` on both sides, or two `192.168.x` addresses if libwebrtc preferred the LAN while both were reachable, which is itself a finding. Record the first row of "Candidates and selected pair", and what `/Applications/Tailscale.app/Contents/MacOS/Tailscale status` says on the Googlebook's line (`direct` or `relay`).

- [ ] **Step 5: Alex: leave the home network**

**Alex:** turn on a phone hotspot, connect the Googlebook to it, and confirm the Tailscale app on the Googlebook still shows Connected. Then open one stream window against the same `100.x` address.
Expected: the window connects within a few seconds (write the time from tapping to the first frame into "connect time"); the `pair` line shows `100.x` on both sides; `Tailscale status` says whether the path is `direct` or `relay "<code>"`. Measure latency as in Task 11 step 1 (**Alex:** 10 burst photos) and copy the overlay's fps, the host line's target Mbps, the jitter buffer and ICE RTT into the "40 Mbps cap, 60 fps" row. Then restart the host with `--mbps 12 --fps 30` and fill the second row. If the path was direct, write "not observed" in the relayed row; if it was relayed, write that in the notes and keep both rows.

- [ ] **Step 6: Alex: switch networks mid-stream**

With a stream running over the hotspot, **Alex:** turn the Googlebook's Wi-Fi on so it rejoins the home network, then off again after a minute. Record after how many seconds the picture froze, what the overlay and `./wc spike-logs` reported (`ice DISCONNECTED`, `FAILED`), and whether closing and reopening the stream window reconnected.

- [ ] **Step 7: Record and commit**

Fill the S3 section and the remote-defaults line under "Decisions for phase 1". Then:

```bash
git add spikes docs/superpowers/spikes
git commit -m "spike: S3 measures the WebRTC stream over Tailscale from outside the home network"
git push
```

---

### Task 11: Measurements, decisions, cleanup

**Files:**
- Modify: `docs/superpowers/spikes/2026-09-27-phase0-findings.md` (fill every table)
- Delete: `spikes/` (after the findings record the commit hash)
- Modify: `.gitignore` (drop the spike rules), `README.md` (status line)

**Interfaces:** none; this task produces numbers and decisions.

- [ ] **Step 1: Latency, configuration A**

Host: `swift run --package-path spikes/macprobe webrtcprobe --timer`. Client: switches "playout-delay 0/0" and "level 5.2" both on (quit and reopen the app if they were changed), open 1 stream window, drag it next to the Mac's timer window so both are visible from one spot. **Alex:** take 10 photos with a phone in burst mode; for each, latency = Mac digits minus Googlebook digits. Write median, min and max into row A, plus the overlay's `jitterBuf`, `decode`, `ice rtt` and `dc rtt` values read while streaming.

- [ ] **Step 2: Configurations B, C, D**

- B: host `--no-trials`; client switch "playout-delay 0/0" off, quit and reopen the app. Measure as in step 1.
- C: host `--hevc` (trials on again); client both switches on. The overlay's codec line must say `video/H265`; if it says H264, HEVC was not negotiated and the row records "not negotiated" with the answer's codec lines from logcat.
- D: host `--level 640c1f`; client "level 5.2" off, quit and reopen. Record the stats `codec` line for C and D under "Codec negotiation" too.

- [ ] **Step 3: Frame rate at 1920x1200**

Host: `swift run --package-path spikes/macprobe webrtcprobe --display --out 1920x1200`. Play a video full-screen on the Mac. Record the host line (`sent N fps`, `limit=`, `encode ms/frame`) and the client overlay (`fps`, decoder name) after 20 s.

- [ ] **Step 4: Three windows**

Open three animating windows on the Mac (two videos and `top -s 0`), then `swift run --package-path spikes/macprobe webrtcprobe --windows ID1,ID2,ID3`. On the Googlebook tap "Open 3 stream windows". Record fps per window from each overlay, the host's per-session `sent` lines, and Activity Monitor's CPU for `webrtcprobe` and `WindowServer`.

- [ ] **Step 5: Android self-resize API check**

```bash
J=$HOME/Library/Android/sdk/platforms/android-37/android.jar
for c in android.app.Activity android.view.Window android.view.WindowManager android.app.ActivityOptions android.app.ActivityManager; do
  echo "== $c"; javap -cp "$J" "$c" | grep -iE "bounds|resize" || true
done
```

Record which methods exist and whether any lets an app change its own existing window's bounds (the field notes say none does; `setLaunchBounds` only applies at launch). Write the answer under "Android app-initiated window resize API".

- [ ] **Step 6: Decisions for phase 1**

Fill the last section of the findings file with one line per item, derived from the tables:
- Capture filter for window sessions: `appcrop` if menus and popovers were visible in step 8 of Task 9 and occlusion behaved; otherwise the fallback and why.
- `contentRect` unit from the self-test, and the measured `updateConfiguration` costs, with the resulting tracker cadence.
- Codec, level and decoder factory: from rows A, C, D and the codec lines.
- Field trials: keep 0/0 if row A beats row B; otherwise the values to use.
- Keyboard capture default and Esc handling: from the matrix.
- Activation and resize fallbacks per app: from the S1 tables.
- Remote access: Tailscale confirmed or not, the M7 defaults (cap, fps, connect
  timeout) from the S3 rows, and whether the network-switch behavior needs
  more than the planned reconnect.
- Anything that changes the spec, listed explicitly (for example "S2 found X, so section 4.7 changes to Y"); an empty list is written as "none".

- [ ] **Step 7: Remove the spike code**

```bash
git log -1 --format=%h   # write this hash into "Spike code commit" in the findings file first
git rm -r spikes
```

Edit `.gitignore` to drop the four `spikes/...` lines. Keep `wc`; phase 1 extends it. In `README.md` change the status line to: `Status: phase 0 spikes done; findings in docs/superpowers/spikes/2026-09-27-phase0-findings.md. Phase 1 (MVP) is next.`

- [ ] **Step 8: Commit and push**

```bash
git add -A
git commit -m "spikes: record phase 0 findings and remove the throwaway probes"
git push
```

Expected: `git status` clean, the findings file has no empty cells in the tables that a measurement could fill (an unmeasurable cell says why), and the phase 1 plan can be written from it.
