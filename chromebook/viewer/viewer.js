// Windowcast viewer: dials into the paired Chromebook, shows its shared window and forwards input.
import { PROTOCOL_VERSION, MSG } from './shared/protocol.js';
import { isValidHostId, isValidKey, parsePairingFragment } from './shared/ids.js';
import { channelFingerprints, computeProof, verifyProof, newNonce } from './shared/auth.js';
import { videoContentRect, normalizePointer } from './shared/geometry.js';
import { browserShortcut } from './shared/keys.js';
import { retryDelay } from './shared/retry.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const STORE = 'windowcast.pairing';

// ---------- pairing ----------

function store(p) {
  try {
    if (p) localStorage.setItem(STORE, JSON.stringify(p));
    else localStorage.removeItem(STORE);
  } catch { /* storage unavailable: keep the pairing in memory only */ }
}

function stored() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) || 'null');
    return p && isValidHostId(p.hostId) && isValidKey(p.key) ? p : null;
  } catch {
    return null;
  }
}

function takeLink() {
  const p = parsePairingFragment(location.hash);
  history.replaceState(null, '', location.pathname + location.search);  // keep the key out of the address bar
  if (!p) return null;
  // A link for another Chromebook replaces the pairing only when the person agrees.
  const current = stored();
  if (current && current.hostId !== p.hostId
    && !window.confirm(`Connect this viewer to a different Chromebook? Its pairing ID starts with ${p.hostId.slice(0, 9)}.`)) {
    return null;
  }
  store(p);
  return p;
}

let pairing = takeLink() || stored();

// ---------- connection ----------

let phase = 'connecting';
let peer = null;
let conn = null;
let pc = null;
let authed = false;
let auth = null;
let attempt = 0;
let retryTimer = null;
let retryAt = 0;
let helloTimer = null;
let connectTimer = null;
let stopped = false;
let hasVideo = false;
let remote = { sharing: false, title: '', controllable: false, note: null, tabs: [], more: 0, url: '' };
// Before authentication nothing from the other side can be trusted: an "invalid" or "wrong version" answer
// could come from someone holding the Chromebook's id while it's offline, so it slows retries but never stops them.
const SLOW = new Set(['invalid', 'version']);
let detail = '';
const events = [];
function note(text) {
  events.push(`${(performance.now() / 1000).toFixed(1)}s ${text}`);
  if (events.length > 300) events.shift();
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  teardown();
  if (!pairing) { setPhase('unpaired'); return; }
  if (stopped) return;
  if (!SLOW.has(phase)) setPhase(attempt === 0 ? 'connecting' : 'waiting');
  note(`connect attempt ${attempt}`);
  const p = new Peer({ debug: 1 });
  peer = p;
  p.on('open', () => {
    if (peer !== p) return;
    const c = p.connect(pairing.hostId, { reliable: true, serialization: 'json' });
    conn = c;
    c.on('open', () => { if (conn === c) helloTimer = setTimeout(() => fail('no-hello'), 10000); });
    c.on('data', (m) => { if (conn === c) onMessage(m).catch(() => fail('error')); });
    c.on('close', () => { if (conn === c) fail('closed'); });
    c.on('error', () => { if (conn === c) fail('connection-error'); });
    connectTimer = setTimeout(() => { if (conn === c && !authed) fail('timeout'); }, 20000);
  });
  p.on('error', (err) => { note(`peer error ${err.type}`); if (peer === p) fail(err.type === 'peer-unavailable' ? 'offline' : 'broker'); });
  p.on('disconnected', () => { if (peer === p && !authed) fail('broker-lost'); });
}

function teardown() {
  clearTimeout(helloTimer);
  clearTimeout(connectTimer);
  releaseAll();
  const oldPc = pc;
  const oldConn = conn;
  const oldPeer = peer;
  pc = null;
  conn = null;
  peer = null;
  authed = false;
  auth = null;
  hasVideo = false;
  try { if (oldPc) oldPc.close(); } catch { /* ignore */ }
  try { if (oldConn) oldConn.close(); } catch { /* ignore */ }
  try { if (oldPeer) oldPeer.destroy(); } catch { /* ignore */ }
  video.srcObject = null;
}

function fail(reason) {
  note(`fail ${reason}${stopped ? ' (stopped)' : ''}${retryTimer ? ' (retry pending)' : ''}`);
  if (stopped || retryTimer) return;
  const wasConnected = authed;
  teardown();
  if (reason === 'replaced') { stopped = true; setPhase('replaced'); return; }
  if (reason === 'auth-fail') setPhase('invalid');
  else if (reason === 'version') setPhase('version');
  if (wasConnected) attempt = 0;
  const delay = SLOW.has(phase) ? 60000 : retryDelay(attempt++);
  retryAt = Date.now() + delay;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  if (!SLOW.has(phase)) setPhase(reason === 'unverified' ? 'unverified' : 'waiting');
}

function tryNow() {
  stopped = false;
  attempt = 0;
  connect();
}

function send(msg) {
  if (conn && conn.open && authed) conn.send(msg);
  else if (msg.t !== MSG.INPUT) note(`dropped ${msg.t} (open=${Boolean(conn && conn.open)} authed=${authed})`);
}

async function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t !== MSG.ICE) note(`recv ${m.t}`);
  switch (m.t) {
    case MSG.HELLO: {
      clearTimeout(helloTimer);
      if (m.v !== PROTOCOL_VERSION) { fail('version'); return; }
      const c = conn;
      // Fingerprints of the certificates DTLS actually verified, cross-checked against the SDP.
      const fps = await channelFingerprints(c.peerConnection);
      if (conn !== c) return;
      if (!fps) { fail('no-fingerprint'); return; }
      const viewerNonce = newNonce();
      auth = { hostNonce: String(m.nonce || '').slice(0, 64), viewerNonce, hostFingerprint: fps.remote, viewerFingerprint: fps.local };
      const proof = await computeProof(pairing.key, 'viewer', auth);
      if (conn === c) c.send({ t: MSG.AUTH, nonce: viewerNonce, proof });
      return;
    }
    case MSG.AUTH_OK:
      if (!auth || !(await verifyProof(pairing.key, 'host', auth, m.proof))) { fail('unverified'); return; }
      authed = true;
      attempt = 0;
      clearTimeout(connectTimer);
      setPhase('connected');
      return;
    case MSG.AUTH_FAIL:
      fail('auth-fail');
      return;
    case MSG.BYE:
      if (authed && m.reason === 'replaced') fail('replaced');
      return;
    default:
      break;
  }
  if (!authed) return;
  if (m.t === MSG.SDP) await onOffer(m.sdp);
  else if (m.t === MSG.ICE) { if (pc && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {}); }
  else if (m.t === MSG.STATE) applyState(m);
  else if (m.t === MSG.NOTICE) toast(String(m.text || '').slice(0, 300));
  else if (m.t === MSG.DIALOG) showPageDialog(m);
  else if (m.t === MSG.DIALOG_CLOSED) closePageDialog();
}

// ---------- page dialogs (alert, confirm, prompt, leave page) ----------

let dialogFromHost = false;

function showPageDialog(m) {
  const kind = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(m.kind) ? m.kind : 'alert';
  const leave = kind === 'beforeunload';
  $('pd-title').textContent = leave ? 'Leave this page? Changes you made may not be saved.'
    : kind === 'alert' ? 'The page on your Chromebook says' : 'The page on your Chromebook asks';
  $('pd-message').textContent = leave ? '' : clip(m.message, 1000);
  $('pd-message').hidden = leave;
  $('pd-input').hidden = kind !== 'prompt';
  $('pd-input').value = clip(m.prompt, 500);
  $('pd-cancel').hidden = kind === 'alert';
  $('pd-cancel').textContent = leave ? 'Stay' : 'Cancel';
  $('pd-ok').textContent = leave ? 'Leave' : 'OK';
  const d = $('page-dialog');
  dialogFromHost = true;
  if (!d.open) d.showModal();
  (kind === 'prompt' ? $('pd-input') : $('pd-ok')).focus();
}

function closePageDialog() {
  dialogFromHost = false;
  if ($('page-dialog').open) $('page-dialog').close();
}

$('page-dialog').addEventListener('close', () => {
  if (!dialogFromHost) return;
  dialogFromHost = false;
  send({ t: MSG.DIALOG_ANSWER, accept: $('page-dialog').returnValue === 'ok', text: $('pd-input').value });
  stage.focus();
});

async function onOffer(sdp) {
  if (!sdp || sdp.type !== 'offer') return;
  if (!pc) {
    const iceServers = peer && peer.options && peer.options.config ? peer.options.config.iceServers : undefined;
    const p = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc = p;
    p.onicecandidate = (e) => { if (e.candidate) send({ t: MSG.ICE, candidate: e.candidate.toJSON() }); };
    p.ontrack = (e) => {
      try { e.receiver.jitterBufferTarget = 0; } catch { /* older Chrome */ }
      video.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    p.onconnectionstatechange = () => { if (pc === p && p.connectionState === 'failed') fail('video-failed'); };
  }
  await pc.setRemoteDescription(sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  send({ t: MSG.SDP, sdp: pc.localDescription.toJSON() });
}

function clip(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function applyState(m) {
  const previousNote = remote.note;
  remote = {
    sharing: Boolean(m.sharing),
    title: clip(m.title, 300),
    controllable: Boolean(m.controllable),
    note: typeof m.note === 'string' ? m.note.slice(0, 300) : null,
    tabs: Array.isArray(m.tabs) ? m.tabs.slice(0, 200).map((t) => ({
      id: Number(t.id),
      title: clip(t.title, 300) || 'New tab',
      url: clip(t.url, 2048),
      active: Boolean(t.active),
      icon: typeof t.icon === 'string' && /^(https:|data:image\/)/.test(t.icon) ? t.icon : '',
    })) : [],
    more: Math.max(0, Number(m.more) || 0),
    url: clip(m.url, 2048),
  };
  if (!remote.sharing) hasVideo = false;
  else if (video.videoWidth) hasVideo = true;
  if (remote.note && remote.note !== previousNote) toast(remote.note);
  render();
}

// ---------- screen ----------

function setPhase(p) {
  if (p !== phase) note(`phase ${p}`);
  phase = p;
  document.body.dataset.phase = p;
  render();
}

function overlayContent() {
  switch (phase) {
    case 'unpaired':
      return { title: 'Connect to your Chromebook', body: 'On the Chromebook, click the Windowcast icon, then open its pairing link on this device.' };
    case 'connecting':
      return { title: 'Connecting to your Chromebook', body: '' };
    case 'waiting':
      return {
        title: 'Waiting for your Chromebook',
        body: 'It may be asleep, offline or signed out. Windowcast keeps trying and connects as soon as it’s back.',
        meta: nextTry(), action: ['Try now', tryNow],
      };
    case 'unverified':
      return {
        title: 'The connection couldn’t be verified',
        body: 'Something between the devices changed the connection, so Windowcast didn’t use it. It tries again shortly.',
        meta: nextTry(),
      };
    case 'invalid':
      return {
        title: 'This pairing link doesn’t work anymore',
        body: 'The Chromebook may have made a new link. Open the new link on this device. Windowcast checks again every minute.',
        action: ['Try now', tryNow], secondary: ['Forget this Chromebook', forget],
      };
    case 'replaced':
      return { title: 'Showing on another device', body: 'Your Chromebook window opened somewhere else, so it closed here.', action: ['Show it here', tryNow] };
    case 'version':
      return { title: 'Update Windowcast on the Chromebook', body: 'The extension and this viewer are different versions. Update the extension; this page checks again every minute.', action: ['Try now', tryNow] };
    case 'connected':
      if (!remote.sharing) return { title: 'Nothing is shared yet', body: 'On the Chromebook, click the Windowcast icon in the window you want to see here.' };
      if (!hasVideo) return { title: 'Connecting to your Chromebook', body: '' };
      return null;
    default:
      return null;
  }
}

function nextTry() {
  const s = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  return s > 0 ? `Next try in ${s} s` : 'Trying now';
}

function forget() {
  store(null);
  pairing = null;
  stopped = false;
  teardown();
  setPhase('unpaired');
}

function render() {
  const content = overlayContent();
  document.body.dataset.overlay = content ? 'on' : 'off';
  if (content) {
    $('ov-title').textContent = content.title;
    $('ov-body').textContent = content.body || '';
    $('ov-meta').textContent = content.meta || '';
    const action = $('ov-action');
    action.hidden = !content.action;
    if (content.action) {
      action.textContent = content.action[0];
      action.onclick = content.action[1];
    }
    const secondary = $('ov-secondary');
    secondary.hidden = !content.secondary;
    if (content.secondary) {
      secondary.textContent = content.secondary[0];
      secondary.onclick = content.secondary[1];
    }
  }

  const connected = phase === 'connected' && remote.sharing;
  const browserWindow = connected && remote.tabs.length > 0;
  for (const id of ['back', 'forward', 'reload']) $(id).disabled = !browserWindow;
  const address = $('address');
  address.disabled = !browserWindow;
  if (document.activeElement !== address) address.value = browserWindow ? remote.url : '';
  $('tabs').disabled = !browserWindow;
  $('tab-count').textContent = String(remote.tabs.length);
  if (!$('tab-menu').hidden) renderTabs();

  const dot = $('dot');
  let dotState = 'off';
  let label = 'Not connected';
  if (phase === 'connected') {
    dotState = remote.sharing && remote.controllable ? 'live' : 'view';
    label = remote.sharing && remote.controllable ? 'Connected, you can control this window' : 'Connected, view only';
    if (detail) label += `. ${detail}`;
  } else if (phase === 'connecting' || phase === 'waiting') {
    dotState = 'wait';
    label = 'Connecting';
  } else if (SLOW.has(phase) || phase === 'unverified') {
    dotState = 'error';
    label = 'Can’t connect';
  }
  dot.dataset.state = dotState;
  dot.title = label;
  dot.setAttribute('aria-label', label);
  document.title = connected && remote.title ? `${remote.title} – Windowcast` : 'Windowcast';
}

setInterval(() => { if (phase === 'waiting' || phase === 'unverified') render(); }, 1000);

let toastTimer = null;
function toast(text) {
  if (!text) return;
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

for (const ev of ['loadeddata', 'resize', 'playing']) {
  video.addEventListener(ev, () => {
    if (video.videoWidth && remote.sharing && !hasVideo) { hasVideo = true; render(); }
  });
}

// ---------- tabs and toolbar ----------

function renderTabs() {
  $('tab-list').replaceChildren(...remote.tabs.map((t) => {
    const li = document.createElement('li');
    if (t.active) li.className = 'active';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tab-item';
    let icon;
    if (t.icon) {
      icon = document.createElement('img');
      icon.src = t.icon;
      icon.alt = '';
      icon.referrerPolicy = 'no-referrer';
    } else {
      icon = document.createElement('span');
      icon.className = 'blank';
    }
    const label = document.createElement('span');
    label.textContent = t.title;
    item.append(icon, label);
    item.addEventListener('click', () => { send({ t: MSG.TAB, a: 'activate', id: t.id }); closeMenu(); stage.focus(); });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.setAttribute('aria-label', `Close ${t.title}`);
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', () => send({ t: MSG.TAB, a: 'close', id: t.id }));
    li.append(item, close);
    return li;
  }));
  if (remote.more > 0) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `${remote.more} more tab${remote.more === 1 ? ' isn’t' : 's aren’t'} listed`;
    $('tab-list').append(li);
  }
}

function openMenu() {
  renderTabs();
  $('tab-menu').hidden = false;
  $('tabs').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  $('tab-menu').hidden = true;
  $('tabs').setAttribute('aria-expanded', 'false');
}

$('tabs').addEventListener('click', () => { if ($('tab-menu').hidden) openMenu(); else closeMenu(); });
$('new-tab').addEventListener('click', () => { closeMenu(); runAction('new-tab'); });
document.addEventListener('mousedown', (ev) => {
  if (!$('tab-menu').hidden && !$('tab-menu').contains(ev.target) && !$('tabs').contains(ev.target)) closeMenu();
});

$('back').addEventListener('click', () => send({ t: MSG.NAV, a: 'back' }));
$('forward').addEventListener('click', () => send({ t: MSG.NAV, a: 'forward' }));
$('reload').addEventListener('click', () => send({ t: MSG.NAV, a: 'reload' }));
$('go').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = $('address').value.trim();
  if (text) send({ t: MSG.NAV, a: 'go', text });
  stage.focus();
});
$('address').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    $('address').value = remote.url;
    stage.focus();
  }
});
$('address').addEventListener('blur', () => { $('address').value = remote.url; });
// Like Chrome's own address bar: the first click selects the whole address, so typing replaces it.
let selectOnMouseUp = false;
$('address').addEventListener('mousedown', () => { selectOnMouseUp = document.activeElement !== $('address'); });
$('address').addEventListener('mouseup', (ev) => {
  if (!selectOnMouseUp) return;
  selectOnMouseUp = false;
  ev.preventDefault();
  $('address').select();
});
$('address').addEventListener('focus', () => $('address').select());

function runAction(a) {
  if (!(phase === 'connected' && remote.sharing && remote.tabs.length)) return;
  if (a === 'focus-address') { $('address').focus(); $('address').select(); }
  else if (a === 'back' || a === 'forward' || a === 'reload') send({ t: MSG.NAV, a });
  else if (a === 'new-tab') { send({ t: MSG.TAB, a: 'new' }); setTimeout(() => runAction('focus-address'), 350); }
  else if (a === 'close-tab') send({ t: MSG.TAB, a: 'close' });
  else if (a === 'next-tab') send({ t: MSG.TAB, a: 'next' });
  else if (a === 'prev-tab') send({ t: MSG.TAB, a: 'prev' });
}

// ---------- full screen ----------

$('full').addEventListener('click', async () => {
  if (document.fullscreenElement) { await document.exitFullscreen(); return; }
  await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  try { if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(); } catch { /* not supported */ }
  stage.focus();
});
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement));
  document.body.classList.remove('reveal');
  if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
});
document.addEventListener('mousemove', (ev) => {
  if (!document.fullscreenElement) return;
  const open = document.body.classList.contains('reveal');
  document.body.classList.toggle('reveal', ev.clientY < 6 || (open && ev.clientY < 70));
});

// ---------- pointer ----------

const mods = (ev) => (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
const frameSize = () => ({ fw: video.videoWidth, fh: video.videoHeight });
const canControl = () => authed && remote.sharing && remote.controllable && video.videoWidth > 0;

function pointerAt(ev) {
  const r = video.getBoundingClientRect();
  const rect = videoContentRect(r.width, r.height, video.videoWidth, video.videoHeight);
  return normalizePointer(ev.clientX - r.left, ev.clientY - r.top, rect);
}

let pendingMove = null;
let moveScheduled = false;
let buttonsDown = 0;
let lastPos = null;

function flushMove() {
  moveScheduled = false;
  if (pendingMove) { send(pendingMove); pendingMove = null; }
}

stage.addEventListener('mousemove', (ev) => {
  if (!canControl()) return;
  const p = pointerAt(ev);
  if (!p.inside && !buttonsDown) return;
  lastPos = p;
  pendingMove = { t: MSG.INPUT, k: 'move', x: p.x, y: p.y, m: mods(ev), ...frameSize() };
  if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(flushMove); }
});

stage.addEventListener('mousedown', (ev) => {
  stage.focus({ preventScroll: true });
  note(`mousedown canControl=${canControl()} inside=${pointerAt(ev).inside}`);
  if (!canControl()) {
    if (authed && remote.sharing && remote.note) toast(remote.note);
    return;
  }
  const p = pointerAt(ev);
  if (!p.inside) return;
  ev.preventDefault();
  flushMove();
  buttonsDown |= 1 << ev.button;
  lastPos = p;
  send({ t: MSG.INPUT, k: 'down', x: p.x, y: p.y, b: ev.button, n: Math.max(1, ev.detail || 1), m: mods(ev), ...frameSize() });
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button === 3 || ev.button === 4) ev.preventDefault();  // don't let mouse side buttons navigate this app
  if (!(buttonsDown & (1 << ev.button))) return;
  buttonsDown &= ~(1 << ev.button);
  const p = pointerAt(ev);
  send({ t: MSG.INPUT, k: 'up', x: p.x, y: p.y, b: ev.button, n: Math.max(1, ev.detail || 1), m: mods(ev), ...frameSize() });
});

stage.addEventListener('wheel', (ev) => {
  if (!canControl()) return;
  const p = pointerAt(ev);
  if (!p.inside) return;
  ev.preventDefault();
  const f = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? 800 : 1;
  send({ t: MSG.INPUT, k: 'wheel', x: p.x, y: p.y, dx: ev.deltaX * f, dy: ev.deltaY * f, m: mods(ev), ...frameSize() });
}, { passive: false });

stage.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ---------- keyboard ----------

const held = new Map();

function keyData(ev, type) {
  return {
    type, key: ev.key, code: ev.code, keyCode: ev.keyCode, location: ev.location, repeat: ev.repeat,
    alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey,
  };
}

function keysGoRemote() {
  const a = document.activeElement;
  return authed && remote.sharing && (a === stage || a === document.body || a === null);
}

window.addEventListener('keydown', (ev) => {
  if (!keysGoRemote()) return;
  const d = keyData(ev, 'down');
  const action = browserShortcut(d);
  if (action) { ev.preventDefault(); runAction(action); return; }
  if (!remote.controllable) return;
  ev.preventDefault();
  held.set(ev.code, d);
  send({ t: MSG.KEY, e: d });
}, true);

window.addEventListener('keyup', (ev) => {
  if (!held.has(ev.code)) return;
  held.delete(ev.code);
  ev.preventDefault();
  send({ t: MSG.KEY, e: keyData(ev, 'up') });
}, true);

// Nothing stays pressed on the Chromebook when this window loses focus.
function releaseAll() {
  for (const d of held.values()) send({ t: MSG.KEY, e: { ...d, type: 'up', repeat: false } });
  held.clear();
  if (buttonsDown && lastPos) {
    for (let b = 0; b < 5; b++) {
      if (buttonsDown & (1 << b)) send({ t: MSG.INPUT, k: 'up', x: lastPos.x, y: lastPos.y, b, n: 1, m: 0, ...frameSize() });
    }
  }
  buttonsDown = 0;
}
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAll();
  else if (phase === 'waiting' && !stopped) tryNow();
});
window.addEventListener('online', () => { if (!authed && !stopped && pairing) tryNow(); });

// A new pairing link opened while the app is running replaces the old one.
window.addEventListener('hashchange', () => {
  const p = takeLink();
  if (!p) return;
  pairing = p;
  tryNow();
});

// ---------- stats for the status dot ----------

setInterval(async () => {
  if (!pc || phase !== 'connected') { detail = ''; return; }
  try {
    const report = await pc.getStats();
    let size = '';
    let fps = null;
    let rtt = null;
    let localId = null;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        size = r.frameWidth ? `${r.frameWidth} × ${r.frameHeight}` : '';
        fps = r.framesPerSecond;
      }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
        rtt = r.currentRoundTripTime;
        localId = r.localCandidateId;
      }
    });
    const path = localId && report.get(localId) ? report.get(localId).candidateType : '';
    detail = [size && `${size} at ${fps != null ? Math.round(fps) : '?'} fps`,
      path === 'relay' ? 'through a relay' : path ? 'direct connection' : '',
      rtt != null ? `round trip ${Math.round(rtt * 1000)} ms` : ''].filter(Boolean).join(', ');
    render();
  } catch { /* connection closing */ }
}, 2000);

// ---------- start ----------

window.__wcViewer = {
  get phase() { return phase; },
  get remote() { return remote; },
  get hasVideo() { return hasVideo; },
  get events() { return events.slice(); },
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

if (pairing) connect();
else setPhase('unpaired');
