// Windowcast host: shares one window of this Chromebook, keeps the device awake, and lets the paired
// viewer control the window's page through the DevTools protocol.
import { PROTOCOL_VERSION, VIEWER_BASE_URL, AUTH_TIMEOUT_MS, MSG } from './shared/protocol.js';
import { generateHostId, generateKey, isValidHostId, isValidKey, pairingLink } from './shared/ids.js';
import { extractFingerprint, computeProof, verifyProof, newNonce } from './shared/auth.js';
import { mapToPage, matchWindow } from './shared/geometry.js';
import { toCdpKeyEvent } from './shared/keys.js';
import { toUrlOrSearch } from './shared/nav.js';
import { retryDelay } from './shared/retry.js';

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === 'pattern';
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intOrNull = (v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const state = {
  identity: null,
  settings: { keepAwake: true, autoStart: true },
  broker: 'connecting',            // connecting | online | reconnecting | offline
  stream: null,
  track: null,
  label: '',
  title: '',
  tabs: [],
  windowId: null,                  // Chrome window that receives input
  windowHow: null,                 // nominated | unique | ambiguous | test
  windowChoices: [],
  nominated: intOrNull(params.get('nominate')),
  viewer: null,                    // the authenticated session, if any
  control: { tabId: null, attached: false, blocked: null, canceledBy: null },
  stats: null,
  error: '',
};
let myWindowId = null;
const events = [];
function note(text) {
  events.push(`${(performance.now() / 1000).toFixed(1)}s ${text}`);
  if (events.length > 300) events.shift();
}

// ---------- identity and settings ----------

async function loadIdentity() {
  const got = await chrome.storage.local.get(['identity', 'settings']);
  let identity = got.identity;
  if (!identity || !isValidHostId(identity.hostId) || !isValidKey(identity.key)) {
    identity = { hostId: generateHostId(), key: generateKey() };
    await chrome.storage.local.set({ identity });
  }
  state.identity = identity;
  state.settings = { ...state.settings, ...(got.settings || {}) };
}

function viewerBase() {
  return params.get('viewer') || VIEWER_BASE_URL;
}

function currentLink() {
  return pairingLink(viewerBase(), state.identity.hostId, state.identity.key);
}

async function saveSettings() {
  await chrome.storage.local.set({ settings: state.settings });
}

function applyKeepAwake() {
  if (state.track && state.settings.keepAwake) chrome.power.requestKeepAwake('display');
  else chrome.power.releaseKeepAwake();
}

// ---------- sharing ----------

let picking = false;
async function pick() {
  if (picking || TEST) return;
  picking = true;
  try {
    const streamId = await new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(['window'], (id) => resolve(id)));
    if (!streamId) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: 2400, maxFrameRate: 30 } },
    });
    await useStream(stream);
  } catch (e) {
    state.error = `Couldn't share the window: ${e.message}`;
    render();
  } finally {
    picking = false;
  }
}

async function useStream(stream, { testWindowId } = {}) {
  stopStream({ userStopped: false });
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = 'detail';
  state.stream = stream;
  state.track = track;
  state.label = track.label || '';
  track.addEventListener('ended', () => { if (state.track === track) endShare(); });
  $('preview').srcObject = stream;
  await chrome.storage.local.set({ wasSharing: true });
  applyKeepAwake();
  if (testWindowId !== undefined) {
    state.windowId = testWindowId;
    state.windowHow = 'test';
  } else {
    await identifyWindow();
  }
  state.nominated = null;
  if (state.viewer?.sender) await state.viewer.sender.replaceTrack(track).catch(() => {});
  refreshSoon();
  if (state.viewer) attachControl();
}

async function previewSize() {
  const v = $('preview');
  if (!v.videoWidth) {
    await new Promise((resolve) => {
      v.addEventListener('loadedmetadata', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }
  return { w: v.videoWidth, h: v.videoHeight };
}

// The picker doesn't say which window was chosen, so match the frame against Chrome's windows.
async function identifyWindow() {
  const { w, h } = await previewSize();
  const all = await chrome.windows.getAll({ populate: true });
  const wins = all.filter((x) => x.id !== myWindowId && x.state !== 'minimized');
  const match = w && h
    ? matchWindow(w, h, wins.map(({ id, width, height }) => ({ id, width, height })), state.nominated, devicePixelRatio)
    : null;
  state.windowId = match ? match.id : null;
  state.windowHow = match ? match.how : null;
  state.windowChoices = wins.map((x) => ({ id: x.id, title: (x.tabs || []).find((t) => t.active)?.title || `Window ${x.id}` }));
  boundsCache = null;
}

function stopStream({ userStopped }) {
  const t = state.track;
  state.track = null;
  state.stream = null;
  state.label = '';
  state.windowId = null;
  state.windowHow = null;
  if (t) { try { t.stop(); } catch { /* already stopped */ } }
  $('preview').srcObject = null;
  if (userStopped) chrome.storage.local.set({ wasSharing: false });
  applyKeepAwake();
  detachControl();
  if (state.viewer?.sender) state.viewer.sender.replaceTrack(null).catch(() => {});
}

function endShare() {
  stopStream({ userStopped: true });
  refreshSoon();
}

// ---------- broker (PeerJS public server) ----------

let peer = null;
let brokerAttempt = 0;
let brokerTimer = null;

function setBroker(value) {
  if (value !== state.broker) note(`broker ${value}`);
  state.broker = value;
  render();
}

function scheduleBroker(fn) {
  clearTimeout(brokerTimer);
  brokerTimer = setTimeout(fn, retryDelay(brokerAttempt++));
}

function startBroker() {
  clearTimeout(brokerTimer);
  if (peer && !peer.destroyed) peer.destroy();
  setBroker('connecting');
  const p = new Peer(state.identity.hostId, { debug: 1 });
  peer = p;
  p.on('open', () => { if (peer !== p) return; brokerAttempt = 0; setBroker('online'); });
  p.on('connection', (conn) => { if (peer === p) onConnection(conn); });
  p.on('disconnected', () => {
    if (peer !== p || p.destroyed) return;
    setBroker('reconnecting');
    scheduleBroker(() => { if (peer === p && !p.destroyed && p.disconnected) p.reconnect(); });
  });
  p.on('close', () => { if (peer !== p) return; setBroker('offline'); scheduleBroker(startBroker); });
  p.on('error', (err) => {
    note(`broker error ${err.type}`);
    if (peer !== p) return;
    state.error = `Broker: ${err.type}`;
    if (err.type === 'unavailable-id' || p.destroyed) scheduleBroker(startBroker);
    else if (p.disconnected) scheduleBroker(() => { if (peer === p && !p.destroyed) p.reconnect(); });
    render();
  });
}

window.addEventListener('online', () => {
  if (!peer || peer.destroyed) startBroker();
  else if (peer.disconnected) peer.reconnect();
});

// ---------- viewer sessions ----------

const failures = [];

function onConnection(conn) {
  note(`connection from ${conn.peer}`);
  const now = Date.now();
  while (failures.length && now - failures[0] > 60000) failures.shift();
  if (failures.length >= 10) {
    conn.on('open', () => conn.close());
    return;
  }
  const s = {
    conn, hostNonce: newNonce(), authed: false, closed: false,
    pc: null, sender: null, hints: new Set(),
  };
  s.authTimer = setTimeout(() => { if (!s.authed) closeSession(s, 'auth-timeout'); }, AUTH_TIMEOUT_MS);
  conn.on('open', () => send(s, { t: MSG.HELLO, v: PROTOCOL_VERSION, nonce: s.hostNonce }));
  conn.on('data', (m) => { onMessage(s, m).catch((e) => { state.error = String(e?.message || e); render(); }); });
  conn.on('close', () => closeSession(s, 'closed'));
  conn.on('error', () => closeSession(s, 'error'));
}

function send(s, msg) {
  if (s && !s.closed && s.conn.open) s.conn.send(msg);
}

function notice(text) {
  send(state.viewer, { t: MSG.NOTICE, text });
}

function hintOnce(key, text) {
  const s = state.viewer;
  if (!s || s.hints.has(key)) return;
  s.hints.add(key);
  notice(text);
}

async function onMessage(s, m) {
  if (!m || typeof m !== 'object' || s.closed) return;
  if (!s.authed) {
    if (m.t === MSG.AUTH) await authenticate(s, m);
    return;
  }
  switch (m.t) {
    case MSG.SDP:
      if (m.sdp && m.sdp.type === 'answer' && s.pc) {
        await s.pc.setRemoteDescription(m.sdp);
        await tuneSender(s.sender);
      }
      break;
    case MSG.ICE:
      if (m.candidate && s.pc) await s.pc.addIceCandidate(m.candidate).catch(() => {});
      break;
    case MSG.INPUT: if (s === state.viewer) enqueue(() => onPointer(m)); break;
    // (key, nav and tab messages are queued behind pointer input so they keep their order)
    case MSG.KEY: if (s === state.viewer) enqueue(() => onKey(m.e)); break;
    case MSG.NAV: if (s === state.viewer) enqueue(() => onNav(m)); break;
    case MSG.TAB: if (s === state.viewer) enqueue(() => onTab(m)); break;
    default: break;
  }
}

async function authenticate(s, m) {
  if (typeof m.nonce !== 'string' || m.nonce.length > 64) return;
  const pc = s.conn.peerConnection;
  const proofParams = {
    hostNonce: s.hostNonce,
    viewerNonce: m.nonce,
    hostFingerprint: extractFingerprint(pc && pc.localDescription && pc.localDescription.sdp),
    viewerFingerprint: extractFingerprint(pc && pc.remoteDescription && pc.remoteDescription.sdp),
  };
  const ok = Boolean(proofParams.hostFingerprint && proofParams.viewerFingerprint)
    && await verifyProof(state.identity.key, 'viewer', proofParams, m.proof);
  note(`auth ${ok ? 'ok' : 'failed'}`);
  if (!ok) {
    failures.push(Date.now());
    send(s, { t: MSG.AUTH_FAIL });
    setTimeout(() => closeSession(s, 'auth-failed'), 300);
    return;
  }
  s.authed = true;
  clearTimeout(s.authTimer);
  send(s, { t: MSG.AUTH_OK, proof: await computeProof(state.identity.key, 'host', proofParams) });
  const previous = state.viewer;
  state.viewer = s;
  if (previous && previous !== s) {
    send(previous, { t: MSG.BYE, reason: 'replaced' });
    setTimeout(() => closeSession(previous, 'replaced'), 200);
  }
  state.control.canceledBy = null;
  pulseStage();
  await startMedia(s);
  await attachControl();
  refreshSoon();
}

function closeSession(s, reason) {
  if (s.closed) return;
  note(`session closed: ${reason}`);
  s.closed = true;
  clearTimeout(s.authTimer);
  try { s.pc && s.pc.close(); } catch { /* ignore */ }
  try { s.conn.close(); } catch { /* ignore */ }
  if (state.viewer === s) {
    state.viewer = null;
    releaseInput();
    detachControl();
    state.stats = null;
  }
  state.error = reason === 'closed' || reason === 'replaced' ? state.error : `Viewer: ${reason}`;
  render();
}

// ---------- video connection ----------

function preferCodecs(transceiver) {
  const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const rank = (c) => {
    const mime = c.mimeType.toLowerCase();
    if (mime === 'video/h264') return (c.sdpFmtpLine || '').includes('packetization-mode=1') ? 0 : 1;
    if (mime === 'video/vp9') return 2;
    if (mime === 'video/vp8') return 3;
    if (mime === 'video/av1') return 4;
    return 5;
  };
  try { transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b))); } catch { /* keep defaults */ }
}

async function tuneSender(sender) {
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return;
  p.encodings[0].maxBitrate = 20_000_000;
  p.encodings[0].maxFramerate = 30;
  p.degradationPreference = 'maintain-resolution';
  try { await sender.setParameters(p); } catch (e) { state.error = `Encoder settings: ${e.message}`; }
}

async function startMedia(s) {
  const iceServers = peer && peer.options && peer.options.config ? peer.options.config.iceServers : undefined;
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  s.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) send(s, { t: MSG.ICE, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') closeSession(s, 'video-failed');
    render();
  };
  const transceiver = state.track
    ? pc.addTransceiver(state.track, { direction: 'sendonly', streams: [state.stream] })
    : pc.addTransceiver('video', { direction: 'sendonly' });
  s.sender = transceiver.sender;
  preferCodecs(transceiver);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send(s, { t: MSG.SDP, sdp: pc.localDescription.toJSON() });
}

// ---------- control through chrome.debugger ----------

function cdp(tabId, method, commandParams) {
  return chrome.debugger.sendCommand({ tabId }, method, commandParams);
}

async function activeTab() {
  if (state.windowId === null) return null;
  const [tab] = await chrome.tabs.query({ windowId: state.windowId, active: true });
  return tab || null;
}

let attaching = null;
function attachControl() {
  attaching = (attaching || Promise.resolve()).then(doAttach).catch(() => {});
  return attaching;
}

async function doAttach() {
  if (!state.viewer || state.windowId === null || state.control.canceledBy === state.viewer) return;
  const tab = await activeTab();
  if (!tab) return;
  if (state.control.attached && state.control.tabId === tab.id) return;
  await detachControl();
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    state.control = { ...state.control, tabId: tab.id, attached: true, blocked: null };
    metricsCache.delete(tab.id);
  } catch (e) {
    note(`attach failed: ${e.message}`);
    state.control = { ...state.control, tabId: tab.id, attached: false, blocked: 'This page can’t be controlled remotely. Chrome’s own pages and the Web Store are off limits.' };
  }
  refreshSoon();
}

// Debugger sessions belong to the extension, not to this page, so a session from an earlier host
// window survives a reload and blocks attaching again. Detaching a tab we don't hold just fails.
async function releaseStaleSessions() {
  const targets = await chrome.debugger.getTargets();
  await Promise.all(targets
    .filter((t) => t.attached && t.tabId !== undefined)
    .map((t) => chrome.debugger.detach({ tabId: t.tabId }).catch(() => {})));
}

async function detachControl() {
  if (!state.control.attached) return;
  const tabId = state.control.tabId;
  state.control = { ...state.control, attached: false };
  try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== state.control.tabId) return;
  state.control = { ...state.control, attached: false };
  if (reason === 'canceled_by_user') {
    state.control.canceledBy = state.viewer;
    notice('Remote control was turned off on the Chromebook. It comes back when you reconnect.');
  } else {
    setTimeout(attachControl, 400);
  }
  refreshSoon();
});

// ---------- input ----------

let inputChain = Promise.resolve();
function enqueue(fn) {
  inputChain = inputChain.then(fn).catch((e) => { note(`input error ${e.message}`); state.error = `Input: ${e.message}`; });
}

let boundsCache = null;
async function windowBounds() {
  if (boundsCache && boundsCache.id === state.windowId && Date.now() - boundsCache.at < 2000) return boundsCache.value;
  const w = await chrome.windows.get(state.windowId);
  boundsCache = { id: state.windowId, at: Date.now(), value: { width: w.width, height: w.height } };
  return boundsCache.value;
}

const metricsCache = new Map();
async function pageMetrics(tabId) {
  const cached = metricsCache.get(tabId);
  if (cached && Date.now() - cached.at < 1000) return cached.value;
  const r = await cdp(tabId, 'Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true });
  const [innerWidth, innerHeight] = r.result.value;
  const value = { innerWidth, innerHeight };
  metricsCache.set(tabId, { at: Date.now(), value });
  return value;
}

const zoomCache = new Map();
async function tabZoom(tabId) {
  if (!zoomCache.has(tabId)) zoomCache.set(tabId, await chrome.tabs.getZoom(tabId));
  return zoomCache.get(tabId);
}

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
const MASK = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
let pressed = 0;
let lastPoint = null;

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

async function pagePoint(m) {
  const fw = num(m.fw, 1, 16384);
  const fh = num(m.fh, 1, 16384);
  const x = num(m.x, 0, 1);
  const y = num(m.y, 0, 1);
  if (fw === null || fh === null || x === null || y === null) return { zone: 'outside' };
  const tabId = state.control.tabId;
  const [win, metrics, zoom] = await Promise.all([windowBounds(), pageMetrics(tabId), tabZoom(tabId)]);
  return mapToPage(x, y, { w: fw, h: fh }, win, metrics, zoom);
}

async function onPointer(m) {
  if (!state.control.attached) {
    if (m.k !== 'move') note(`pointer ${m.k} ignored: not attached`);
    if (m.k === 'down') {
      hintOnce('no-control', controlNote() || 'This window can’t be controlled right now.');
    }
    return;
  }
  const tabId = state.control.tabId;
  const modifiers = num(m.m, 0, 15) || 0;
  const target = await pagePoint(m);
  if (m.k !== 'move') note(`pointer ${m.k} b=${m.b} -> ${target.zone}${target.zone === 'page' ? ` ${Math.round(target.x)},${Math.round(target.y)}` : ''}`);
  if (m.k === 'move') {
    if (target.zone !== 'page') return;
    lastPoint = target;
    const button = pressed & MASK.left ? 'left' : pressed & MASK.right ? 'right' : pressed & MASK.middle ? 'middle' : 'none';
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, modifiers, button, buttons: pressed });
  } else if (m.k === 'down') {
    if (target.zone === 'browser-ui') {
      hintOnce('browser-ui', 'That’s the Chromebook’s own tab strip and toolbar. Use the toolbar at the top of this window instead.');
      return;
    }
    if (target.zone !== 'page') return;
    const button = BUTTONS[m.b] || 'left';
    pressed |= MASK[button];
    lastPoint = target;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: target.x, y: target.y, modifiers, button, buttons: pressed, clickCount: num(m.n, 1, 3) || 1,
    });
  } else if (m.k === 'up') {
    const button = BUTTONS[m.b] || 'left';
    if (!(pressed & MASK[button])) return;
    pressed &= ~MASK[button];
    const p = target.zone === 'page' ? target : lastPoint;
    if (!p) return;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: p.x, y: p.y, modifiers, button, buttons: pressed, clickCount: num(m.n, 1, 3) || 1,
    });
  } else if (m.k === 'wheel') {
    if (target.zone !== 'page') return;
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: target.x, y: target.y, modifiers, deltaX: num(m.dx, -10000, 10000) || 0, deltaY: num(m.dy, -10000, 10000) || 0,
    });
  }
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

async function onKey(e) {
  if (!state.control.attached || !e || (e.type !== 'down' && e.type !== 'up')) return;
  const clean = {
    type: e.type, key: str(e.key, 32), code: str(e.code, 32), keyCode: num(e.keyCode, 0, 255) || 0,
    location: num(e.location, 0, 3) || 0, repeat: Boolean(e.repeat),
    alt: Boolean(e.alt), ctrl: Boolean(e.ctrl), meta: Boolean(e.meta), shift: Boolean(e.shift),
  };
  await cdp(state.control.tabId, 'Input.dispatchKeyEvent', toCdpKeyEvent(clean));
}

// Lift any button still held when the viewer goes away, so nothing stays pressed on the Chromebook.
function releaseInput() {
  const tabId = state.control.tabId;
  if (!state.control.attached || !pressed || !lastPoint) { pressed = 0; return; }
  for (const [name, bit] of Object.entries(MASK)) {
    if (pressed & bit) {
      pressed &= ~bit;
      cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastPoint.x, y: lastPoint.y, button: name, buttons: pressed, clickCount: 1 }).catch(() => {});
    }
  }
}

// ---------- toolbar commands ----------

async function onNav(m) {
  note(`nav ${m.a}`);
  const tab = await activeTab();
  if (!tab) return;
  if (m.a === 'back') await chrome.tabs.goBack(tab.id).catch(() => {});
  else if (m.a === 'forward') await chrome.tabs.goForward(tab.id).catch(() => {});
  else if (m.a === 'reload') await chrome.tabs.reload(tab.id);
  else if (m.a === 'go') {
    const target = toUrlOrSearch(str(m.text, 4096));
    if (!target) return;
    if (target.kind === 'url') await chrome.tabs.update(tab.id, { url: target.url });
    else await chrome.search.query({ text: target.query, tabId: tab.id });
  }
}

async function onTab(m) {
  note(`tab ${m.a}`);
  if (state.windowId === null) return;
  const tabs = await chrome.tabs.query({ windowId: state.windowId });
  const index = tabs.findIndex((t) => t.active);
  const owns = (id) => tabs.some((t) => t.id === id);
  if (m.a === 'activate' && owns(m.id)) await chrome.tabs.update(m.id, { active: true });
  else if (m.a === 'new') await chrome.tabs.create({ windowId: state.windowId, active: true });
  else if (m.a === 'close') {
    const id = owns(m.id) ? m.id : tabs[index] && tabs[index].id;
    // Closing the last tab would close the shared window and end sharing.
    if (id !== undefined && tabs.length > 1) await chrome.tabs.remove(id);
    else if (tabs.length <= 1) notice('That’s the last tab. Closing it would end sharing, so it stays open.');
  } else if ((m.a === 'next' || m.a === 'prev') && tabs.length > 1) {
    const step = m.a === 'next' ? 1 : tabs.length - 1;
    await chrome.tabs.update(tabs[(index + step) % tabs.length].id, { active: true });
  }
}

// ---------- state for the page and the viewer ----------

function controlNote() {
  if (!state.track) return null;
  if (state.windowId === null) return 'View only. Only Chrome windows can be controlled from your Googlebook.';
  if (state.control.canceledBy && state.control.canceledBy === state.viewer) return 'Remote control was turned off on the Chromebook. It comes back when your Googlebook reconnects.';
  if (state.viewer && state.control.blocked) return state.control.blocked;
  return null;
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

async function refresh() {
  if (state.windowId !== null) {
    try {
      const tabs = await chrome.tabs.query({ windowId: state.windowId });
      state.tabs = tabs.map((t) => ({
        id: t.id, title: t.title || t.url || 'New tab', url: t.url || '', active: t.active,
        icon: t.favIconUrl && /^(https?:|data:image\/)/.test(t.favIconUrl) ? t.favIconUrl : '',
      }));
      state.title = (state.tabs.find((t) => t.active) || {}).title || '';
    } catch {
      state.tabs = [];
    }
  } else {
    state.tabs = [];
    state.title = '';
  }
  render();
  const s = state.viewer;
  if (s && s.authed) {
    const active = state.tabs.find((t) => t.active);
    send(s, {
      t: MSG.STATE, sharing: Boolean(state.track), title: state.title || state.label || '',
      controllable: state.control.attached, note: controlNote(), tabs: state.tabs, url: active ? active.url : '',
    });
  }
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (windowId !== state.windowId) return;
  attachControl();
  refreshSoon();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.windowId !== state.windowId) return;
  if (info.status === 'loading') metricsCache.delete(tabId);
  if (tab.active && info.status === 'complete' && !state.control.attached) attachControl();
  refreshSoon();
});
chrome.tabs.onCreated.addListener((tab) => { if (tab.windowId === state.windowId) refreshSoon(); });
chrome.tabs.onRemoved.addListener((tabId, info) => { if (info.windowId === state.windowId) refreshSoon(); });
chrome.tabs.onMoved.addListener((tabId, info) => { if (info.windowId === state.windowId) refreshSoon(); });
chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => { zoomCache.set(tabId, newZoomFactor); });
chrome.windows.onBoundsChanged.addListener((w) => { if (w.id === state.windowId) boundsCache = null; });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pick') {
    state.nominated = intOrNull(msg.nominate);
    pick();
  }
});

// ---------- page ----------

function pulseStage() {
  const stage = $('stage');
  stage.classList.remove('pulse');
  void stage.offsetWidth;
  stage.classList.add('pulse');
}

function render() {
  const sharing = Boolean(state.track);
  const live = Boolean(state.viewer);
  const broker = $('broker');
  broker.dataset.state = state.broker;
  broker.textContent = { connecting: 'Connecting', online: 'Online', reconnecting: 'Reconnecting', offline: 'Offline' }[state.broker];
  $('stage').dataset.state = !sharing ? 'idle' : live ? 'live' : 'sharing';
  $('title').textContent = sharing ? (state.title || state.label || 'Shared window') : 'Choose a window to share';
  document.title = sharing ? `Sharing ${state.title || 'a window'} – Windowcast` : 'Windowcast';

  const status = $('status');
  if (!sharing) {
    status.textContent = 'Your Googlebook can dial in once a window is shared.';
    status.dataset.tone = '';
  } else if (live) {
    status.textContent = 'Your Googlebook is connected.';
    status.dataset.tone = 'live';
  } else if (state.broker !== 'online') {
    status.textContent = 'Waiting for the internet. Your Googlebook can’t reach this Chromebook until it’s back.';
    status.dataset.tone = 'warn';
  } else {
    status.textContent = 'Ready. Your Googlebook can dial in with the pairing link.';
    status.dataset.tone = '';
  }

  const note = controlNote();
  const ambiguous = sharing && state.windowHow === 'ambiguous';
  $('control').hidden = !note && !ambiguous;
  $('control-text').textContent = note || (ambiguous ? `Two windows look the same, so the Googlebook controls “${state.title || 'this window'}”.` : '');
  $('control-pick-wrap').hidden = !ambiguous;
  if (ambiguous) {
    const select = $('control-pick');
    select.replaceChildren(...state.windowChoices.map((c) => {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.title;
      o.selected = c.id === state.windowId;
      return o;
    }));
  }

  $('pick').textContent = sharing ? 'Share a different window' : 'Choose a window';
  $('stop').hidden = !sharing;
  $('awake').checked = state.settings.keepAwake;
  $('autostart').checked = state.settings.autoStart;
  if (state.identity) {
    const body = `Open this link on your Googlebook to connect it to your Chromebook:\n\n${currentLink()}`;
    $('email').href = `mailto:?subject=${encodeURIComponent('Windowcast pairing link')}&body=${encodeURIComponent(body)}`;
  }
  renderDiag();
}

function renderDiag() {
  const rows = [
    ['Host id', state.identity ? state.identity.hostId : ''],
    ['Broker', state.broker],
    ['Controlled window', state.windowId === null ? 'none' : `${state.windowId} (${state.windowHow})`],
    ['Controlled tab', state.control.attached ? String(state.control.tabId) : 'not attached'],
    ['Frame', $('preview').videoWidth ? `${$('preview').videoWidth} × ${$('preview').videoHeight}` : ''],
    ['Screen scale', String(devicePixelRatio)],
  ];
  const st = state.stats;
  if (st) {
    rows.push(['Sending', `${st.size || ''} at ${st.fps != null ? Math.round(st.fps) : '?'} fps, ${st.mbps != null ? st.mbps.toFixed(1) : '?'} Mbps`]);
    rows.push(['Codec', `${st.codec || '?'} (${st.encoder || 'encoder unknown'})`]);
    rows.push(['Path', `${st.path || '?'}, round trip ${st.rtt != null ? Math.round(st.rtt * 1000) : '?'} ms`]);
    if (st.limit && st.limit !== 'none') rows.push(['Limited by', st.limit]);
  }
  if (state.error) rows.push(['Last problem', state.error]);
  $('diag').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

let lastBytes = null;
async function collectStats() {
  const s = state.viewer;
  if (!s || !s.pc) { state.stats = null; lastBytes = null; return; }
  const report = await s.pc.getStats();
  const out = {};
  let localId = null;
  report.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') {
      out.fps = r.framesPerSecond;
      out.size = r.frameWidth ? `${r.frameWidth} × ${r.frameHeight}` : '';
      out.encoder = r.encoderImplementation;
      out.limit = r.qualityLimitationReason;
      out.codecId = r.codecId;
      out.bytes = r.bytesSent;
    }
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      out.rtt = r.currentRoundTripTime;
      localId = r.localCandidateId;
    }
  });
  if (out.codecId && report.get(out.codecId)) out.codec = report.get(out.codecId).mimeType;
  if (localId && report.get(localId)) out.path = report.get(localId).candidateType;
  const now = performance.now();
  if (lastBytes && out.bytes != null) out.mbps = ((out.bytes - lastBytes.bytes) * 8) / ((now - lastBytes.at) / 1000) / 1e6;
  if (out.bytes != null) lastBytes = { bytes: out.bytes, at: now };
  state.stats = out;
}

setInterval(() => { collectStats().then(renderDiag).catch(() => {}); }, 2000);

function bindUi() {
  $('pick').addEventListener('click', () => pick());
  $('stop').addEventListener('click', () => endShare());
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentLink());
      $('copied').textContent = 'Copied. Paste it into Chrome on your Googlebook.';
    } catch {
      $('copied').textContent = 'Couldn’t copy. Use “Email it to yourself” instead.';
    }
  });
  $('awake').addEventListener('change', async (e) => {
    state.settings.keepAwake = e.target.checked;
    await saveSettings();
    applyKeepAwake();
  });
  $('autostart').addEventListener('change', async (e) => {
    state.settings.autoStart = e.target.checked;
    await saveSettings();
  });
  $('control-pick').addEventListener('change', (e) => {
    state.windowId = Number(e.target.value);
    state.windowHow = 'nominated';
    boundsCache = null;
    detachControl().then(attachControl);
    refreshSoon();
  });
  $('rekey').addEventListener('click', async () => {
    if (!window.confirm('Make a new pairing link? Your Googlebook disconnects until you open the new link on it.')) return;
    state.identity = { hostId: generateHostId(), key: generateKey() };
    await chrome.storage.local.set({ identity: state.identity });
    if (state.viewer) closeSession(state.viewer, 'rekeyed');
    startBroker();
    render();
  });
  window.addEventListener('pagehide', () => chrome.power.releaseKeepAwake());
}

// ---------- test pattern (automated tests only) ----------

async function startTestPattern() {
  window.__wc = { state, link: () => currentLink(), events };
  const targetUrl = params.get('targetUrl');
  let tab = null;
  for (let i = 0; i < 40 && !tab; i++) {
    const page = targetUrl.split(/[?#]/)[0];
    tab = (await chrome.tabs.query({})).find((t) => t.url && t.url.split(/[?#]/)[0] === page) || null;
    if (!tab) await sleep(250);
  }
  if (!tab) throw new Error('Test target tab not found');
  const win = await chrome.windows.get(tab.windowId);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(win.width * devicePixelRatio);
  canvas.height = Math.round(win.height * devicePixelRatio);
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.fillStyle = '#0b57d0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((performance.now() / 4) % canvas.width, 0, 24, canvas.height);
    ctx.font = '40px sans-serif';
    ctx.fillText(new Date().toISOString(), 40, 80);
  };
  draw();
  setInterval(draw, 33);
  await useStream(canvas.captureStream(30), { testWindowId: tab.windowId });
}

// ---------- start ----------

async function init() {
  myWindowId = (await chrome.windows.getCurrent()).id;
  await releaseStaleSessions();
  await loadIdentity();
  bindUi();
  render();
  startBroker();
  if (TEST) await startTestPattern();
  else if (state.nominated !== null || params.get('auto') === '1') pick();
}

init().catch((e) => {
  state.error = String(e && e.message ? e.message : e);
  render();
});
