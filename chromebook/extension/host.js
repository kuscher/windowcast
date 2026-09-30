// Windowcast host: shares one window of this Chromebook, keeps the device awake, and lets the paired
// viewer control the window's page through the DevTools protocol.
import { PROTOCOL_VERSION, VIEWER_BASE_URL, AUTH_TIMEOUT_MS, MSG } from './shared/protocol.js';
import { generateHostId, generateKey, isValidHostId, isValidKey, pairingLink } from './shared/ids.js';
import { channelFingerprints, computeProof, verifyProof, newNonce } from './shared/auth.js';
import { mapToPage, sizeCandidates, pageToFrame, detectMarker } from './shared/geometry.js';
import { toCdpKeyEvent } from './shared/keys.js';
import { toUrlOrSearch } from './shared/nav.js';
import { retryDelay } from './shared/retry.js';
import { compactState } from './shared/limits.js';
import { createInputQueue } from './shared/queue.js';

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === 'pattern';
// Automated tests only: real capture of a tab, auto-picked by Chrome's --auto-select-desktop-capture-source flag.
const TEST_CAPTURE = params.get('test') === 'capture';
const LIMITS = { maxWidth: 3840, maxHeight: 2400 };
const MAX_PENDING = 3;
const MAGENTA = { r: 255, g: 0, b: 255, a: 1 };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intOrNull = (v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const state = {
  identity: null,
  settings: { keepAwake: true, autoStart: true },
  broker: 'connecting',            // connecting | online | reconnecting | offline
  idTaken: false,                  // the broker keeps refusing our id: someone else holds it
  stream: null,
  track: null,
  label: '',
  title: '',
  tabs: [],
  candidates: [],                  // Chrome windows the size of the shared frame, most likely first
  guessTitle: '',
  windowId: null,                  // the Chrome window proven to be the shared one; input goes here
  windowHow: null,                 // verified | chosen | test
  verifying: false,
  verifyFailed: false,
  windowChoices: [],
  nominated: intOrNull(params.get('nominate')),
  viewer: null,                    // the authenticated session, if any
  control: { tabId: null, attached: false, blocked: null, error: '', canceledBy: null },
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
    const sources = TEST_CAPTURE ? ['tab'] : ['window'];
    const streamId = await new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(sources, (id) => resolve(id)));
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
  track.addEventListener('ended', () => { if (state.track === track) endShare({ userStopped: false }); });
  $('preview').srcObject = stream;
  await chrome.storage.local.set({ wasSharing: true });
  applyKeepAwake();
  if (testWindowId !== undefined) {
    state.candidates = [testWindowId];
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

// The picker doesn't say which window was chosen. Windows of the right size become candidates; which one it
// really is gets proven when a viewer connects (see verifyShared), because maximized windows all look alike.
async function identifyWindow() {
  const { w, h } = await previewSize();
  const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app'] });
  const wins = all.filter((x) => x.id !== myWindowId && x.state !== 'minimized');
  const activeTabOf = (x) => ((x && x.tabs) || []).find((t) => t.active) || {};
  // In the capture test a tab is captured instead of a window, so there the "window" is the tab's page area.
  const sizeOf = (x) => (TEST_CAPTURE ? { width: activeTabOf(x).width, height: activeTabOf(x).height } : { width: x.width, height: x.height });
  const sized = wins.map((x) => ({ id: x.id, ...sizeOf(x) })).filter((x) => x.width > 0 && x.height > 0);
  let candidates = w && h && !TEST_CAPTURE ? sizeCandidates(w, h, sized, devicePixelRatio, LIMITS, state.nominated) : [];
  if (!candidates.length && w && h) {
    // Nothing has the expected size (another screen scale, a shadow in the picture): try the windows of the
    // most similar shape. The marker check decides which one it really is.
    const aspect = w / h;
    candidates = sized
      .map((x) => ({ id: x.id, off: Math.abs(x.width / x.height - aspect) / aspect }))
      .filter((x) => x.off < 0.1)
      .sort((a, b) => (a.id === state.nominated ? -1 : b.id === state.nominated ? 1 : a.off - b.off))
      .map((x) => x.id);
  }
  state.candidates = candidates.slice(0, 4);
  state.windowChoices = state.candidates.map((id) => ({ id, title: activeTabOf(wins.find((x) => x.id === id)).title || `Window ${id}` }));
  state.guessTitle = state.windowChoices.length ? state.windowChoices[0].title : '';
  state.windowId = null;
  state.windowHow = null;
  state.verifyFailed = false;
  boundsCache = null;
  note(`shared a ${w}x${h} frame; ${state.candidates.length} candidate window(s)`);
}

function stopStream({ userStopped }) {
  const t = state.track;
  state.track = null;
  state.stream = null;
  state.label = '';
  state.windowId = null;
  state.windowHow = null;
  state.candidates = [];
  state.windowChoices = [];
  state.guessTitle = '';
  state.verifyFailed = false;
  state.control = { ...state.control, blocked: null, error: '' };
  if (t) { try { t.stop(); } catch { /* already stopped */ } }
  $('preview').srcObject = null;
  if (userStopped) chrome.storage.local.set({ wasSharing: false });
  applyKeepAwake();
  detachControl();
  if (state.viewer?.sender) state.viewer.sender.replaceTrack(null).catch(() => {});
}

// userStopped is true only for this window's Stop button; a window that closes (or Chrome shutting down)
// keeps "was sharing" so the picker comes back after a restart.
function endShare({ userStopped }) {
  stopStream({ userStopped });
  refreshSoon();
}

// ---------- broker (PeerJS public server) ----------

let peer = null;
let brokerAttempt = 0;
let brokerTimer = null;
let idRefusals = 0;

// PeerJS keeps messages for unknown connections forever, and anyone can send them to our public id.
setInterval(() => { if (peer && peer._lostMessages && peer._lostMessages.size > 20) peer._lostMessages.clear(); }, 30000);

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
  p.on('open', () => {
    if (peer !== p) return;
    brokerAttempt = 0;
    idRefusals = 0;
    state.idTaken = false;
    setBroker('online');
  });
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
    if (err.type === 'unavailable-id') {
      idRefusals += 1;
      state.idTaken = idRefusals >= 3;
      scheduleBroker(startBroker);
    } else if (p.destroyed) scheduleBroker(startBroker);
    else if (p.disconnected) scheduleBroker(() => { if (peer === p && !p.destroyed) p.reconnect(); });
    render();
  });
}

window.addEventListener('online', () => {
  if (!peer || peer.destroyed) startBroker();
  else if (peer.disconnected) peer.reconnect();
});

// ---------- viewer sessions ----------

const sessions = new Set();

function onConnection(conn) {
  note(`connection from ${conn.peer}`);
  if (conn.serialization !== 'json') {
    conn.on('open', () => conn.close());
    return;
  }
  const pending = [...sessions].filter((x) => !x.authed && !x.closed);
  if (pending.length >= MAX_PENDING) closeSession(pending[0], 'too many pending');
  const s = {
    conn, hostNonce: newNonce(), authed: false, authing: false, failed: false, closed: false,
    pc: null, sender: null, hints: new Set(), lastState: '',
  };
  sessions.add(s);
  s.authTimer = setTimeout(() => { if (!s.authed) closeSession(s, 'auth-timeout'); }, AUTH_TIMEOUT_MS);
  conn.on('open', () => send(s, { t: MSG.HELLO, v: PROTOCOL_VERSION, nonce: s.hostNonce }));
  conn.on('data', (m) => { onMessage(s, m).catch((e) => { note(`message error: ${e.message}`); }); });
  conn.on('close', () => closeSession(s, 'closed'));
  conn.on('error', (err) => {
    // A message over PeerJS's size limit is refused, not fatal; the state message is bounded anyway.
    if (err && err.type === 'message-too-big') { note('a message was too big to send'); return; }
    closeSession(s, 'error');
  });
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
    case MSG.INPUT: if (s === state.viewer) queue.push(() => onPointer(m), m.k === 'move' ? 'move' : 'act'); break;
    case MSG.KEY: if (s === state.viewer) queue.push(() => onKey(m.e)); break;
    // Toolbar and dialog commands don't go through the page, so they never wait behind stuck input.
    case MSG.NAV: if (s === state.viewer) onNav(m).catch((e) => note(`nav failed: ${e.message}`)); break;
    case MSG.TAB: if (s === state.viewer) onTab(m).catch((e) => note(`tab failed: ${e.message}`)); break;
    case MSG.DIALOG_ANSWER: if (s === state.viewer) onDialogAnswer(m).catch((e) => note(`dialog failed: ${e.message}`)); break;
    default: break;
  }
}

async function authenticate(s, m) {
  if (s.authing || s.failed || typeof m.nonce !== 'string' || m.nonce.length > 64) return;
  s.authing = true;
  try {
    // Fingerprints of the certificates DTLS actually verified, not just what the SDP text says.
    const fps = await channelFingerprints(s.conn.peerConnection);
    if (s.closed) return;
    const proofParams = {
      hostNonce: s.hostNonce, viewerNonce: m.nonce,
      hostFingerprint: fps ? fps.local : null, viewerFingerprint: fps ? fps.remote : null,
    };
    const ok = Boolean(fps) && await verifyProof(state.identity.key, 'viewer', proofParams, m.proof);
    if (s.closed) return;
    note(`auth ${ok ? 'ok' : 'failed'}`);
    if (!ok) {
      s.failed = true;
      send(s, { t: MSG.AUTH_FAIL });
      setTimeout(() => closeSession(s, 'auth-failed'), 300);
      return;
    }
    const proof = await computeProof(state.identity.key, 'host', proofParams);
    if (s.closed) return;
    s.authed = true;
    clearTimeout(s.authTimer);
    send(s, { t: MSG.AUTH_OK, proof });
    const previous = state.viewer;
    releaseInput();
    queue.reset();
    state.viewer = s;
    if (previous && previous !== s) {
      send(previous, { t: MSG.BYE, reason: 'replaced' });
      setTimeout(() => closeSession(previous, 'replaced'), 200);
    }
    state.control.canceledBy = null;
    pulseStage();
    await startMedia(s);
    if (s.closed) return;
    attachControl();
    refreshSoon();
  } finally {
    s.authing = false;
  }
}

function closeSession(s, reason) {
  if (s.closed) return;
  note(`session closed: ${reason}`);
  s.closed = true;
  sessions.delete(s);
  clearTimeout(s.authTimer);
  try { s.pc && s.pc.close(); } catch { /* ignore */ }
  try { s.conn.close(); } catch { /* ignore */ }
  if (state.viewer === s) {
    state.viewer = null;
    queue.reset();
    detachControl();
    state.stats = null;
  }
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
  attaching = (attaching || Promise.resolve()).then(doAttach).catch((e) => note(`attach error: ${e.message}`));
  return attaching;
}

// Chrome's reasons for refusing chrome.debugger.attach, in words a person can act on.
function explainAttachError(message, tab) {
  const m = String(message || '');
  const url = tab && tab.url ? tab.url : '';
  if (/Host access is restricted by policy/i.test(m)) {
    return 'Remote control is blocked on this Chromebook. Its administrator restricts extensions on some websites, and then Chrome doesn’t let extensions control any page.';
  }
  if (/Screenshot capture is restricted by policy/i.test(m)) {
    return 'Remote control is blocked on this Chromebook. Its administrator turned off screenshots, which also turns off remote control by extensions.';
  }
  if (/restricted on this target/i.test(m)) return 'Your organization’s data protection rules block remote control on this page.';
  if (/ExtensionsSettings policy/i.test(m)) return 'Your organization blocks extensions on this website, so it can’t be controlled remotely.';
  if (/URL of different extension/i.test(m)) {
    return 'Another extension shows its own frame inside this page, and Chrome doesn’t let Windowcast control such pages. Try another page, or turn off extensions that add frames to pages, such as password managers or writing assistants.';
  }
  if (/chrome:\/\/ URL/i.test(m) || /^(chrome|chrome-untrusted|devtools|chrome-search):/i.test(url)) {
    return `This is one of Chrome’s own pages${url ? ` (${url.slice(0, 60)})` : ''}, which can’t be controlled. Open a website in the shared window.`;
  }
  if (/Cannot attach to this target/i.test(m)) return 'Chrome is showing a warning page here, which can’t be controlled.';
  if (/already attached/i.test(m)) return 'Chrome’s developer tools or another extension is controlling this tab. Close them, then reconnect.';
  if (/Cannot access contents of the page/i.test(m)) return 'Chrome doesn’t let extensions control this page.';
  return `Remote control isn’t possible on this page. Chrome said: ${m}`;
}

async function tryAttach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    return null;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

function useAttached(tab) {
  state.control = { ...state.control, tabId: tab.id, attached: true, blocked: null, error: '' };
  sizeCache.delete(tab.id);
  cdp(tab.id, 'Page.enable').catch(() => {});  // for page dialogs
}

async function grabFrame() {
  if (typeof ImageCapture === 'undefined' || !state.track || state.track.readyState !== 'live') return null;
  return new ImageCapture(state.track).grabFrame();
}

// Draws a magenta square into the tab through the DevTools overlay and looks for it in the shared picture.
// Seeing it proves this window is the shared one, and that clicks will land where they should.
async function markerVisible(windowId, tab) {
  const tabId = tab.id;
  const zoom = await tabZoom(tabId);
  const size = await pageSize(tabId);
  const page = { innerWidth: size.width / zoom, innerHeight: size.height / zoom };
  const rect = {
    x: Math.round(page.innerWidth * 0.4), y: Math.round(page.innerHeight * 0.4),
    width: Math.max(8, Math.round(page.innerWidth * 0.2)), height: Math.max(8, Math.round(page.innerHeight * 0.2)),
  };
  let bitmap = null;
  await cdp(tabId, 'DOM.enable');
  await cdp(tabId, 'Overlay.enable');
  try {
    await cdp(tabId, 'Overlay.highlightRect', { ...rect, color: MAGENTA, outlineColor: MAGENTA });
    await sleep(300);
    bitmap = await grabFrame();
  } finally {
    await cdp(tabId, 'Overlay.hideHighlight').catch(() => {});
    await cdp(tabId, 'Overlay.disable').catch(() => {});
    await cdp(tabId, 'DOM.disable').catch(() => {});
  }
  if (!bitmap) return false;
  const win = await windowSize(windowId);
  const frame = { w: bitmap.width, h: bitmap.height };
  const a = pageToFrame(rect.x, rect.y, frame, win, page, zoom);
  const b = pageToFrame(rect.x + rect.width, rect.y + rect.height, frame, win, page, zoom);
  const W = 160;
  const H = Math.max(1, Math.round((W * frame.h) / frame.w));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, W, H);
  if (bitmap.close) bitmap.close();
  const found = detectMarker(ctx.getImageData(0, 0, W, H).data, W, H, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
  note(`marker in window ${windowId}: ${found.found ? 'seen' : 'not seen'} (${found.inside}/${found.total})`);
  return found.found;
}

async function verifyShared(s) {
  state.verifying = true;
  render();
  let firstError = null;
  let firstTab = null;
  for (const windowId of state.candidates.slice(0, 4)) {
    if (state.viewer !== s || !state.track) break;
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (!tab) continue;
    const error = await tryAttach(tab.id);
    if (error) {
      note(`attach to window ${windowId} failed: ${error}`);
      if (!firstError) { firstError = error; firstTab = tab; }
      continue;
    }
    let seen = false;
    try { seen = await markerVisible(windowId, tab); } catch (e) { note(`marker check failed: ${e.message}`); }
    if (seen && state.viewer === s) {
      state.windowId = windowId;
      state.windowHow = 'verified';
      useAttached(tab);
      break;
    }
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
  }
  state.verifying = false;
  if (state.windowId === null) {
    state.verifyFailed = true;
    state.control = {
      ...state.control, attached: false,
      blocked: firstError ? explainAttachError(firstError, firstTab) : null, error: firstError || '',
    };
  }
  refreshSoon();
}

async function doAttach() {
  const s = state.viewer;
  if (!s || !state.track || state.control.canceledBy === s) return;
  if (state.windowId === null) {
    if (state.candidates.length && !state.verifyFailed && !state.verifying) await verifyShared(s);
    return;
  }
  const tab = await activeTab();
  if (!tab || state.viewer !== s) return;
  if (state.control.attached && state.control.tabId === tab.id) return;
  await detachControl();
  const error = await tryAttach(tab.id);
  if (state.viewer !== s) {
    if (!error) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    return;
  }
  if (error) {
    note(`attach failed: ${error}`);
    state.control = { ...state.control, tabId: tab.id, attached: false, blocked: explainAttachError(error, tab), error };
  } else {
    useAttached(tab);
  }
  refreshSoon();
}

// Try again after the page changes, when the last try found no window or was refused on that page.
function retryControlSoon() {
  if (!state.viewer) return;
  if (state.windowId === null) state.verifyFailed = false;
  clearTimeout(retryControlSoon.timer);
  retryControlSoon.timer = setTimeout(attachControl, 500);
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
  releaseInput();
  if (!state.control.attached) return;
  const tabId = state.control.tabId;
  state.control = { ...state.control, attached: false };
  try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  if (source.tabId !== state.control.tabId || !state.viewer) return;
  if (method === 'Page.javascriptDialogOpening') {
    note(`page dialog: ${p.type}`);
    send(state.viewer, { t: MSG.DIALOG, kind: p.type, message: String(p.message || '').slice(0, 1000), prompt: String(p.defaultPrompt || '').slice(0, 500) });
  } else if (method === 'Page.javascriptDialogClosed') {
    send(state.viewer, { t: MSG.DIALOG_CLOSED });
  }
});

async function onDialogAnswer(m) {
  if (!state.control.attached) return;
  await cdp(state.control.tabId, 'Page.handleJavaScriptDialog', {
    accept: Boolean(m.accept), promptText: typeof m.text === 'string' ? m.text.slice(0, 2000) : '',
  });
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

const queue = createInputQueue({
  onTimeout: () => {
    note('the page stopped responding; queued input was dropped');
    notice('The page on the Chromebook isn’t responding, so your last input was dropped.');
  },
  onError: (e) => note(`input error: ${e.message}`),
});

// A window's size in DIP. In the capture test a tab is captured instead of a window, so there the "window"
// is the tab's page area.
async function windowSize(windowId) {
  if (TEST_CAPTURE) {
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    return { width: tab.width, height: tab.height };
  }
  const w = await chrome.windows.get(windowId);
  return { width: w.width, height: w.height };
}

let boundsCache = null;
async function windowBounds() {
  if (boundsCache && boundsCache.id === state.windowId && Date.now() - boundsCache.at < 2000) return boundsCache.value;
  boundsCache = { id: state.windowId, at: Date.now(), value: await windowSize(state.windowId) };
  return boundsCache.value;
}

// The page area's size in DIP comes from the tab itself, so a page can't lie about it.
const sizeCache = new Map();
async function pageSize(tabId) {
  const cached = sizeCache.get(tabId);
  if (cached && Date.now() - cached.at < 500) return cached.value;
  const t = await chrome.tabs.get(tabId);
  let value;
  if (t.width > 0 && t.height > 0) {
    value = { width: t.width, height: t.height };
  } else {
    const m = await cdp(tabId, 'Page.getLayoutMetrics');
    const zoom = await tabZoom(tabId);
    value = { width: m.cssLayoutViewport.clientWidth * zoom, height: m.cssLayoutViewport.clientHeight * zoom };
  }
  if (!(value.width > 0 && value.height > 0 && value.width < 20000 && value.height < 20000)) throw new Error('page size unknown');
  sizeCache.set(tabId, { at: Date.now(), value });
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
let pressedTab = null;
let lastPoint = null;
const heldKeys = new Map();  // code -> {tabId, event}

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

async function pagePoint(m) {
  const fw = num(m.fw, 1, 16384);
  const fh = num(m.fh, 1, 16384);
  const x = num(m.x, 0, 1);
  const y = num(m.y, 0, 1);
  if (fw === null || fh === null || x === null || y === null) return { zone: 'outside' };
  const tabId = state.control.tabId;
  const [win, size, zoom] = await Promise.all([windowBounds(), pageSize(tabId), tabZoom(tabId)]);
  return mapToPage(x, y, { w: fw, h: fh }, win, { innerWidth: size.width / zoom, innerHeight: size.height / zoom }, zoom);
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
    pressedTab = tabId;
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
  const tabId = state.control.tabId;
  const event = toCdpKeyEvent(clean);
  await cdp(tabId, 'Input.dispatchKeyEvent', event);
  if (event.type === 'keyUp') heldKeys.delete(clean.code);
  else heldKeys.set(clean.code, { tabId, event });
}

// Lift every key and button still held (viewer gone, replaced, or control moving), sent to the tab that got
// the press, so nothing stays pressed on the Chromebook.
function releaseInput() {
  for (const [, held] of heldKeys) {
    const { text, unmodifiedText, ...up } = held.event;
    cdp(held.tabId, 'Input.dispatchKeyEvent', { ...up, type: 'keyUp', autoRepeat: false }).catch(() => {});
  }
  heldKeys.clear();
  if (pressed && pressedTab !== null && lastPoint) {
    for (const [name, bit] of Object.entries(MASK)) {
      if (!(pressed & bit)) continue;
      pressed &= ~bit;
      cdp(pressedTab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastPoint.x, y: lastPoint.y, button: name, buttons: pressed, clickCount: 1 }).catch(() => {});
    }
  }
  pressed = 0;
  pressedTab = null;
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
    if (target.kind === 'blocked') {
      notice('Windowcast opens only web addresses. Chrome’s own pages, files and scripts are off limits.');
      return;
    }
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
    // No id means the active tab; an id that's gone or belongs elsewhere means nothing.
    const id = m.id === undefined || m.id === null ? tabs[index] && tabs[index].id : owns(m.id) ? m.id : undefined;
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
  if (state.control.canceledBy && state.control.canceledBy === state.viewer) return 'Remote control was turned off on the Chromebook. It comes back when your Googlebook reconnects.';
  if (state.verifying) return 'Checking which window is shared.';
  if (state.control.blocked) return state.control.blocked;
  if (state.windowId === null && state.verifyFailed) return 'View only. The shared window doesn’t look like one of this Chromebook’s Chrome windows.';
  if (state.windowId === null && !state.candidates.length) return 'View only. Only Chrome windows can be controlled from your Googlebook.';
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
    const message = compactState({
      t: MSG.STATE, sharing: Boolean(state.track), title: state.title || state.guessTitle || state.label || '',
      controllable: state.control.attached, note: controlNote(), tabs: state.tabs, url: active ? active.url : '',
    });
    const text = JSON.stringify(message);
    if (text !== s.lastState) {
      s.lastState = text;
      send(s, message);
    }
  }
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (windowId === state.windowId) {
    attachControl();
    refreshSoon();
  } else if (state.windowId === null && state.candidates.includes(windowId)) {
    retryControlSoon();
  }
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading') sizeCache.delete(tabId);
  if (tab.windowId === state.windowId) {
    if (tab.active && info.status === 'complete' && !state.control.attached) retryControlSoon();
    refreshSoon();
  } else if (state.windowId === null && state.candidates.includes(tab.windowId) && tab.active && info.status === 'complete') {
    retryControlSoon();
  }
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
  $('title').textContent = sharing ? (state.title || state.guessTitle || 'Shared window') : 'Choose a window to share';
  document.title = sharing ? `Sharing ${state.title || 'a window'} – Windowcast` : 'Windowcast';

  const status = $('status');
  if (!sharing) {
    status.textContent = 'Your Googlebook can dial in once a window is shared.';
    status.dataset.tone = '';
  } else if (live) {
    status.textContent = 'Your Googlebook is connected.';
    status.dataset.tone = 'live';
  } else if (state.idTaken) {
    status.textContent = 'Another device is using this Chromebook’s pairing ID, so your Googlebook can’t reach it. Make a new pairing link to fix it.';
    status.dataset.tone = 'warn';
  } else if (state.broker !== 'online') {
    status.textContent = 'Waiting for the internet. Your Googlebook can’t reach this Chromebook until it’s back.';
    status.dataset.tone = 'warn';
  } else {
    status.textContent = 'Ready. Your Googlebook can dial in with the pairing link.';
    status.dataset.tone = '';
  }

  const note = controlNote();
  // When the check can't prove which window is shared, let the person at the Chromebook say it.
  const offerChoice = sharing && state.windowId === null && state.verifyFailed && !state.control.blocked && state.windowChoices.length > 0;
  $('control').hidden = !note && !state.idTaken;
  $('control-text').textContent = note || '';
  $('fix-id').hidden = !state.idTaken;
  $('control-pick-wrap').hidden = !offerChoice;
  if (offerChoice) {
    const select = $('control-pick');
    select.replaceChildren(...state.windowChoices.map((c) => {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.title;
      return o;
    }));
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose the shared window';
    none.selected = true;
    select.prepend(none);
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
    ['Shared window', state.windowId === null ? `not confirmed (${state.candidates.length} candidate${state.candidates.length === 1 ? '' : 's'})` : `${state.windowId}, ${state.windowHow}`],
    ['Controlled tab', state.control.attached ? `${state.control.tabId} ${(state.tabs.find((t) => t.active) || {}).url || ''}` : 'not attached'],
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
  if (state.control.error) rows.push(['Chrome refused control', state.control.error]);
  if (state.error) rows.push(['Last problem', state.error]);
  rows.push(['Recent events', events.slice(-8).join('\n')]);
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
  $('stop').addEventListener('click', () => endShare({ userStopped: true }));
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
    if (!e.target.value) return;
    state.windowId = Number(e.target.value);
    state.windowHow = 'chosen';
    state.verifyFailed = false;
    boundsCache = null;
    detachControl().then(attachControl);
    refreshSoon();
  });
  $('fix-id').addEventListener('click', () => $('rekey').click());
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
  if (TEST || TEST_CAPTURE) window.__wc = { state, link: () => currentLink(), events };
  startBroker();
  if (TEST) await startTestPattern();
  else if (TEST_CAPTURE || state.nominated !== null || params.get('auto') === '1') pick();
}

init().catch((e) => {
  state.error = String(e && e.message ? e.message : e);
  render();
});
