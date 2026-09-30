# Windowcast for Chromebook

Share one window of a Chromebook and see and control it from your Googlebook, whenever you like. A Chrome
extension on the Chromebook shares the window and keeps the Chromebook awake. A viewer app on the
Googlebook dials in, shows the window in its own desktop window, and passes your mouse, trackpad and
keyboard through.

Status: version 0.1.1. Tested end to end on a Mac; the ChromeOS-specific parts still need a real
Chromebook (see [What to check first](#what-to-check-first)).

## Install on the Chromebook

1. On the Chromebook, download `windowcast-chromebook-0.1.1.zip` from the
   [latest release](https://github.com/kuscher/windowcast/releases).
2. Open the zip in the Files app and copy the `windowcast` folder into **My files**. Leave it there:
   Chrome runs the extension from that folder.
3. In Chrome, go to `chrome://extensions`, turn on **Developer mode** at the top right, click
   **Load unpacked**, and choose the `windowcast` folder.
4. Pin the extension: click the puzzle piece in Chrome's toolbar, then the pin next to Windowcast.

A small Windowcast window opens on first install. Keep it open while you share; you can minimize it.

## Share a window

1. In the Chrome window you want to share, click the Windowcast icon.
2. ChromeOS asks which window to share. Choose that same window and click **Share**.
3. The Windowcast window shows a live preview and says **Ready**.

To share a different window, click the icon in that window, or **Share a different window** in the
Windowcast window. After the Chromebook restarts, the Windowcast window opens by itself at sign-in and
asks for the window again; that one click is the only thing a personal Chromebook can't skip.

**Keep it reachable:** plug the Chromebook in. Windowcast keeps the screen on while it shares. To close the
lid, turn off **Sleep when cover is closed** in Settings, Device, Power.

## Connect the Googlebook

1. In the Windowcast window on the Chromebook, click **Copy link** or **Email it to yourself**.
2. Open the link in Chrome on the Googlebook. The Chromebook window appears within a few seconds.
3. Install it as an app from Chrome's menu, so it gets its own window and taskbar entry.

From then on, just open the Windowcast app. It connects by itself, waits while the Chromebook is asleep or
offline, and reconnects when it's back. It works on your home network and away from it.

## Use it

- **Click, scroll and type** in the picture as if it were the Chromebook's window.
- **The toolbar** has back, forward, reload, an address field and the list of tabs. Use it instead of the
  Chromebook's own tab strip and address bar, which can't receive clicks from the Googlebook.
- **Shortcuts:** Ctrl+L goes to the address field, Alt+Left and Alt+Right go back and forward, Ctrl+R
  reloads, and Ctrl+Tab switches tabs. In a normal window, Ctrl+T and Ctrl+W act on the viewer itself;
  in **full screen** they go to the Chromebook. Press and hold Esc to leave full screen.

**When the Googlebook connects,** a magenta square flashes for a moment in the shared window. That's
Windowcast checking which Chrome window is shared and where clicks land. If it can't tell, the Windowcast
window on the Chromebook asks you to choose the window once.

**To update,** download the new zip, replace the contents of the `windowcast` folder, and click the reload
arrow on Windowcast's card in `chrome://extensions`.

## Limits

- While the Googlebook is connected, the Chromebook shows "Windowcast started debugging this browser".
  That bar is how Chrome signals remote control. Clicking **Cancel** on it turns control off until the
  Googlebook reconnects.
- Chrome's own pages, such as settings and the new tab page, and the Chrome Web Store can be seen but not
  controlled. The address field and tab list still work on them.
- Chrome refuses remote control from an extension on a Chromebook managed by a school or company that
  blocks extensions on some websites or turns off screenshots, and on any page that contains a frame from
  another extension, as some password managers and writing assistants add. When that happens, the
  Windowcast window and the Googlebook say which of these it is.
- Page dialogs (alerts, confirmations, "Leave this page?") appear on the Googlebook, and you answer them
  there.
- Android and Linux app windows can be shared view-only.
- The connection is set up through PeerJS's free public service. If it's down, the Googlebook waits
  until it's back.

## Privacy and security

- The pairing link carries a secret key after the `#`, a part of the link browsers never send to a
  server. The viewer stores it on the Googlebook and removes it from the address bar.
- Before anything else, both sides prove they hold the key, in a way that also detects a tampered
  connection. Without the key, a device gets no picture and can't click or type anything.
- The picture and your input travel encrypted end to end. When no direct path exists they go through
  PeerJS's relay, which can't decrypt them either.
- **Make a new pairing link** in the Windowcast window's Details disconnects every device that had the
  old link.
- The viewer is served from its own address, `windowcast-viewer.vercel.app`, so no other website can
  read the stored key.

## What to check first

These parts can only be tried on a real Chromebook:

- Does a click land exactly where you clicked? If not, or if control stays off, send what **Details** in
  the Windowcast window shows under **Chrome refused control** and **Recent events**.
- Does the picture keep coming with the lid closed, with the Windowcast window minimized, and after the
  Chromebook sleeps and wakes?
- Does the window picker open by itself after a restart?

## Troubleshooting

- **"Waiting for your Chromebook"** on the Googlebook: check that the Windowcast window on the Chromebook
  says **Online** and shows the shared window.
- **"This pairing link doesn't work anymore":** someone made a new pairing link. Open the new link on
  the Googlebook.
- **"Showing on another device":** the window was opened on a second device. Click **Show it here**.

## Development

```sh
npm test               # unit tests
npm run build          # dist/extension and dist/viewer
npm run e2e            # end-to-end test in Chrome for Testing (needs `npx puppeteer browsers install chrome`)
./deploy-viewer.sh     # publish the viewer to windowcast-viewer.vercel.app
```

Design: [docs/superpowers/specs/2026-09-29-chromebook-quick-host-design.md](../docs/superpowers/specs/2026-09-29-chromebook-quick-host-design.md).
