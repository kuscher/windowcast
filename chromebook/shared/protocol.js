// Message names and constants shared by the extension (host) and the viewer.
export const PROTOCOL_VERSION = 1;
export const VIEWER_BASE_URL = 'https://windowcast-viewer.vercel.app/';
export const AUTH_TIMEOUT_MS = 10000;

export const MSG = Object.freeze({
  HELLO: 'hello',          // host -> viewer {v, nonce}
  AUTH: 'auth',            // viewer -> host {nonce, proof}
  AUTH_OK: 'auth-ok',      // host -> viewer {proof}
  AUTH_FAIL: 'auth-fail',  // host -> viewer
  SDP: 'sdp',              // both ways {sdp} for the video connection
  ICE: 'ice',              // both ways {candidate}
  STATE: 'state',          // host -> viewer {sharing, title, controllable, note, tabs, url}
  NOTICE: 'notice',        // host -> viewer {text}
  INPUT: 'in',             // viewer -> host {k: move|down|up|wheel, x, y, b, n, dx, dy, m}
  KEY: 'key',              // viewer -> host {e}
  NAV: 'nav',              // viewer -> host {a: back|forward|reload|go, text}
  TAB: 'tab',              // viewer -> host {a: activate|new|close|next|prev, id}
  BYE: 'bye',              // host -> viewer {reason: 'replaced'} before closing
  DIALOG: 'dialog',        // host -> viewer {kind: alert|confirm|prompt|beforeunload, message, prompt}
  DIALOG_CLOSED: 'dialog-closed', // host -> viewer
  DIALOG_ANSWER: 'dialog-answer', // viewer -> host {accept, text}
});
