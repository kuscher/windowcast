Windowcast for Chromebook 0.1.1.

- When Chrome refuses remote control, the Chromebook's Windowcast window and the Googlebook now say why:
  an organization policy, a frame from another extension inside the page, or one of Chrome's own pages.
- Control goes only to the window that is really shared. Windowcast proves it by flashing a small marker
  in the window when the Googlebook connects, and asks you to choose if it can't tell.
- Page dialogs (alert, confirm, prompt, "Leave this page?") show up on the Googlebook to answer there.
- A page that stops responding no longer freezes remote control; input that can't be delivered is dropped
  instead of arriving late.
- Windows with many tabs no longer drop the connection.
- Security fixes from a code review: the key proof now uses the certificates the connection actually
  verified, the viewer never gives up on a Chromebook because of an unverified message, a link for a
  different Chromebook needs your confirmation, and the address field opens only web addresses.

Install or update: download `windowcast-chromebook-0.1.1.zip` below and follow
[the install steps](https://github.com/kuscher/windowcast/blob/main/chromebook/README.md#install-on-the-chromebook).
