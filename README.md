# Windowcast

Stream one Mac window, or a whole display, to a Googlebook and control it from
there. A Swift menu-bar host on the Mac captures the window with
ScreenCaptureKit and streams it over WebRTC; a Kotlin/Jetpack Compose client
shows it as an ordinary resizable Android window with your keyboard, trackpad
and mouse passed through.

## Windowcast for Chromebook (quick version)

A Chrome extension that shares one Chromebook window, keeps the Chromebook awake, and lets you see and
control that window from your Googlebook at any time. Install and use: [chromebook/README.md](chromebook/README.md).

## Mac host

Status: design phase. The design is in
[docs/superpowers/specs/2026-09-27-windowcast-design.md](docs/superpowers/specs/2026-09-27-windowcast-design.md).

License: MIT.
