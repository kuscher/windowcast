// End-to-end test on a desktop: the extension (test-pattern mode instead of the ChromeOS window picker)
// shares a local target page's window, the viewer dials in through the public PeerJS broker, and the test
// drives the viewer like a person would. Run with `npm run build && npm run e2e` (HEADFUL=1 to watch).
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { generateKey } from '../../shared/ids.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const viewerDir = join(root, 'dist/viewer');
const extDir = join(root, 'dist/extension');
const targetFile = join(root, 'test/e2e/target.html');
const artifacts = join(root, 'test/e2e/artifacts');
await mkdir(artifacts, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const file = pathname === '/__target.html' ? targetFile : join(viewerDir, normalize(pathname === '/' ? '/index.html' : pathname));
  if (file !== targetFile && !file.startsWith(viewerDir)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
// VIEWER_URL=https://windowcast-viewer.vercel.app/ tests the deployed viewer (with its security headers) instead of the local copy.
const viewerBase = process.env.VIEWER_URL || base;
// CAPTURE=1 shares the target through real screen capture (a tab, auto-picked by title) instead of a test
// pattern, so the host's check that proves which window is shared runs for real.
const CAPTURE = Boolean(process.env.CAPTURE);

const results = [];
function check(ok, name, info = '') {
  results.push({ ok: Boolean(ok), name, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
}
const consoleLines = [];
async function dump(label) {
  const pick = async (page, expr) => (page ? page.evaluate(expr).catch(() => null) : null);
  console.log(`--- evidence: ${label}`);
  console.log('host events:', JSON.stringify(await pick(host, () => window.__wc && window.__wc.events.slice(-25))));
  console.log('host error:', JSON.stringify(await pick(host, () => window.__wc && window.__wc.state.error)));
  console.log('viewer events:', JSON.stringify(await pick(viewer, () => window.__wcViewer && window.__wcViewer.events.slice(-25))));
  console.log('viewer remote:', JSON.stringify(await pick(viewer, () => window.__wcViewer && { ...window.__wcViewer.remote, tabs: window.__wcViewer.remote.tabs.length })));
  console.log('viewer address:', JSON.stringify(await pick(viewer, () => ({ disabled: document.getElementById('address').disabled, value: document.getElementById('address').value, active: document.activeElement && document.activeElement.id }))));
  console.log('target:', JSON.stringify(await pick(target, () => ({ url: location.href, field: document.getElementById('field').value, events: window.__events.slice(-4) }))));
  console.log('console:', consoleLines.slice(-15).join('\n  '));
}
async function step(name, fn) {
  try { await fn(); } catch (e) { check(false, name, e.message.split('\n')[0]); await dump(name); }
}

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  enableExtensions: [extDir],
  defaultViewport: null,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    ...(CAPTURE ? ['--auto-select-desktop-capture-source=Windowcast test target'] : [])],
});

let host;
let target;
let viewer;
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/sw.js'), { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  // The extension opens its window on install; close it so only the test-mode host uses the pairing identity.
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of await browser.pages()) {
    if (p.url().startsWith(`chrome-extension://${extId}/host.html`)) await p.close();
  }

  browser.on('targetcreated', async (t) => {
    const pg = await t.page().catch(() => null);
    if (pg) pg.on('console', (m) => consoleLines.push(`[${new URL(pg.url() || 'about:blank').pathname}] ${m.type()}: ${m.text().slice(0, 200)}`));
  });
  target = await browser.newPage({ type: 'window', windowBounds: { width: 1000, height: 720 } });
  await target.goto(`${base}__target.html`);
  const targetUrl = target.url();

  host = await browser.newPage({ type: 'window', windowBounds: { width: 460, height: 800 } });
  await host.goto(`chrome-extension://${extId}/host.html?test=${CAPTURE ? 'capture' : 'pattern'}&targetUrl=${encodeURIComponent(targetUrl)}&viewer=${encodeURIComponent(viewerBase)}`);
  await host.waitForFunction(() => window.__wc && window.__wc.state.broker === 'online' && window.__wc.state.track, { timeout: 40000 });
  check(true, 'host registers with the broker and shares the target window');
  const link = await host.evaluate(() => window.__wc.link());

  viewer = await browser.newPage({ type: 'window', windowBounds: { width: 1100, height: 800 } });
  await viewer.goto(link);
  const t0 = Date.now();
  await step('viewer connects, authenticates and shows video', async () => {
    await viewer.waitForFunction(() => window.__wcViewer && window.__wcViewer.phase === 'connected' && window.__wcViewer.hasVideo
      && document.getElementById('video').videoWidth > 0, { timeout: 60000 });
    const f1 = await viewer.evaluate(() => document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames);
    await new Promise((r) => setTimeout(r, 1500));
    const f2 = await viewer.evaluate(() => document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames);
    check(f2 > f1, 'viewer connects, authenticates and shows video', `${Date.now() - t0} ms to first picture, ${f2 - f1} frames in 1.5 s`);
  });
  check(!(await viewer.evaluate(() => location.hash)), 'the key is removed from the viewer address bar');
  await viewer.screenshot({ path: join(artifacts, 'viewer-connected.png') });
  await host.screenshot({ path: join(artifacts, 'host-live.png') });

  await host.waitForFunction(() => window.__wc.state.control.attached, { timeout: 20000 }).catch(() => {});
  if (!(await host.evaluate(() => window.__wc.state.control.attached))) {
    console.log('host state:', JSON.stringify(await host.evaluate(() => ({
      events: window.__wc.events, error: window.__wc.state.error, candidates: window.__wc.state.candidates,
      verifyFailed: window.__wc.state.verifyFailed, control: { ...window.__wc.state.control, canceledBy: undefined },
      frame: [document.getElementById('preview').videoWidth, document.getElementById('preview').videoHeight], dpr: devicePixelRatio,
    }))));
    console.log('tab sizes:', JSON.stringify(await host.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((w) => ({ id: w.id, w: w.width, h: w.height, tabs: w.tabs.filter((t) => t.active).map((t) => [t.width, t.height, t.url.slice(0, 40)]) })))));
  }
  check(await host.evaluate(() => window.__wc.state.control.attached), 'host attaches control to the shared tab',
    await host.evaluate(() => `window ${window.__wc.state.windowHow}; ${window.__wc.events.filter((e) => /marker|shared a|attach/.test(e)).slice(-3).join(' | ')}`));

  // Where to click in the viewer so the host lands on a CSS point in the target page.
  async function viewerPointFor(cssX, cssY) {
    const inner = await target.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    // In CAPTURE mode the captured "window" is the tab's page area.
    const win = CAPTURE ? { width: inner.w, height: inner.h } : await host.evaluate(async () => {
      const w = await chrome.windows.get(window.__wc.state.windowId);
      return { width: w.width, height: w.height };
    });
    const top = win.height - inner.h;
    const nx = cssX / win.width;
    const ny = (top + cssY) / win.height;
    return viewer.evaluate((x, y) => {
      const v = document.getElementById('video');
      const r = v.getBoundingClientRect();
      const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      const w = v.videoWidth * s;
      const h = v.videoHeight * s;
      return { x: r.left + (r.width - w) / 2 + x * w, y: r.top + (r.height - h) / 2 + y * h };
    }, nx, ny);
  }
  const centerOf = (sel) => target.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);

  await step('a click in the viewer lands on the button', async () => {
    const btn = await centerOf('#btn');
    const p = await viewerPointFor(btn.x, btn.y);
    await viewer.mouse.click(p.x, p.y);
    await target.waitForFunction(() => window.__events.some((e) => e.type === 'click'), { timeout: 10000 });
    const click = await target.evaluate(() => window.__events.find((e) => e.type === 'click'));
    check(click.trusted && Math.abs(click.x - btn.x) < 6 && Math.abs(click.y - btn.y) < 6,
      'a click in the viewer lands on the button', `at ${Math.round(click.x)},${Math.round(click.y)} vs ${Math.round(btn.x)},${Math.round(btn.y)}, trusted=${click.trusted}`);
  });

  await step('typing in the viewer fills the field', async () => {
    const field = await centerOf('#field');
    const p = await viewerPointFor(field.x, field.y);
    await viewer.mouse.click(p.x, p.y);
    await viewer.keyboard.type('hello windowcast');
    await target.waitForFunction(() => document.getElementById('field').value === 'hello windowcast', { timeout: 10000 });
    check(true, 'typing in the viewer fills the field');
  });

  await step('Ctrl+A never types an a into the page', async () => {
    await viewer.keyboard.down('Control');
    await viewer.keyboard.press('KeyA');
    await viewer.keyboard.up('Control');
    await viewer.keyboard.type('x');
    await target.waitForFunction(() => document.getElementById('field').value.endsWith('x'), { timeout: 10000 });
    const value = await target.evaluate(() => document.getElementById('field').value);
    // ChromeOS and Linux run select-all from the key itself; Chrome on macOS needs an explicit editing
    // command for synthetic keys, so there the selection doesn't happen but the letter must still not appear.
    const mac = process.platform === 'darwin';
    check(mac ? value === 'hello windowcastx' : value === 'x', 'Ctrl+A never types an a into the page',
      `field="${value}"${mac ? ', macOS host: no select-all expected' : ''}`);
  });

  await step('the scroll wheel scrolls the page', async () => {
    const btn = await centerOf('#btn');
    const p = await viewerPointFor(btn.x, btn.y + 200);
    await viewer.mouse.move(p.x, p.y);
    await viewer.mouse.wheel({ deltaY: 500 });
    await target.waitForFunction(() => (window.__scrolled || 0) > 0, { timeout: 10000 });
    check(true, 'the scroll wheel scrolls the page', `scrollY=${await target.evaluate(() => window.__scrolled)}`);
  });

  await step('the address field navigates the Chromebook tab and Back returns', async () => {
    await viewer.click('#address');
    await viewer.type('#address', `${base}__target.html?page=2`);
    await viewer.keyboard.press('Enter');
    await target.waitForFunction(() => location.search === '?page=2', { timeout: 15000 });
    await viewer.waitForFunction(() => !document.getElementById('back').disabled, { timeout: 5000 });
    await viewer.click('#back');
    await target.waitForFunction(() => location.search === '', { timeout: 15000 });
    check(true, 'the address field navigates the Chromebook tab and Back returns');
  });

  await step('a page dialog is answered from the viewer', async () => {
    target.on('dialog', () => {});  // leave the dialog to Windowcast instead of Puppeteer
    await target.evaluate(() => { window.__answer = undefined; window.scrollTo(0, 0); });
    const ask = await centerOf('#ask');
    const p = await viewerPointFor(ask.x, ask.y);
    await viewer.mouse.click(p.x, p.y);
    await viewer.waitForFunction(() => document.getElementById('page-dialog').open, { timeout: 10000 });
    const text = await viewer.evaluate(() => document.getElementById('pd-message').textContent);
    await viewer.click('#pd-ok');
    await target.waitForFunction(() => window.__answer === true, { timeout: 10000 });
    check(text === 'Proceed?', 'a page dialog is answered from the viewer', `dialog said "${text}"`);
  });

  await step('a window with many long tabs stays connected and lists what fits', async () => {
    const ids = await host.evaluate(async () => {
      const made = [];
      for (let i = 0; i < 45; i++) {
        const t = await chrome.tabs.create({ windowId: window.__wc.state.windowId, active: false, url: `about:blank#${i}-${'x'.repeat(1500)}` });
        made.push(t.id);
      }
      return made;
    });
    await viewer.waitForFunction(() => window.__wcViewer.remote.more > 0, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));
    const r = await viewer.evaluate(() => ({ phase: window.__wcViewer.phase, listed: window.__wcViewer.remote.tabs.length, more: window.__wcViewer.remote.more }));
    await host.evaluate(async (list) => { await chrome.tabs.remove(list); }, ids);
    check(r.phase === 'connected' && r.listed <= 40 && r.listed + r.more === 46, 'a window with many long tabs stays connected and lists what fits', JSON.stringify(r));
  });

  await step('the address field refuses Chrome pages', async () => {
    await viewer.click('#address');
    await viewer.type('#address', 'chrome://settings');
    await viewer.keyboard.press('Enter');
    await viewer.waitForFunction(() => !document.getElementById('toast').hidden && /only web addresses/.test(document.getElementById('toast').textContent), { timeout: 10000 });
    check(!(await target.evaluate(() => location.href)).startsWith('chrome:'), 'the address field refuses Chrome pages');
  });

  await step('a Chrome page shows the reason control is refused', async () => {
    await host.evaluate(async () => { await chrome.tabs.update((await chrome.tabs.query({ windowId: window.__wc.state.windowId, active: true }))[0].id, { url: 'chrome://version/' }); });
    await viewer.waitForFunction(() => /Chrome’s own pages/.test(window.__wcViewer.remote.note || '') && !window.__wcViewer.remote.controllable, { timeout: 15000 });
    const reason = await host.evaluate(() => window.__wc.state.control.error);
    await host.evaluate(async (url) => { await chrome.tabs.update((await chrome.tabs.query({ windowId: window.__wc.state.windowId, active: true }))[0].id, { url }); }, `${base}__target.html`);
    await target.waitForFunction(() => location.pathname === '/__target.html', { timeout: 15000 }).catch(() => {});
    await host.waitForFunction(() => window.__wc.state.control.attached, { timeout: 15000 });
    check(true, 'a Chrome page shows the reason control is refused', `Chrome said: ${reason}`);
  });

  await step('a viewer with the wrong key is refused', async () => {
    const bad = await browser.newPage({ type: 'window', windowBounds: { width: 800, height: 600 } });
    await bad.goto(link.replace(/k=[^&]+/, `k=${generateKey()}`));
    await bad.waitForFunction(() => window.__wcViewer && window.__wcViewer.phase === 'invalid', { timeout: 40000 });
    const noVideo = await bad.evaluate(() => document.getElementById('video').srcObject === null);
    await bad.screenshot({ path: join(artifacts, 'viewer-invalid.png') });
    await bad.close();
    const stillOn = await viewer.evaluate(() => window.__wcViewer.phase === 'connected');
    check(noVideo && stillOn, 'a viewer with the wrong key is refused', `no video=${noVideo}, paired viewer still connected=${stillOn}`);
  });

  await step('the viewer reconnects after the host restarts', async () => {
    const t1 = Date.now();
    await host.reload();
    await viewer.waitForFunction(() => window.__wcViewer.phase !== 'connected', { timeout: 20000 });
    await viewer.screenshot({ path: join(artifacts, 'viewer-waiting.png') });
    await viewer.waitForFunction(() => window.__wcViewer.phase === 'connected' && window.__wcViewer.hasVideo, { timeout: 60000 });
    check(true, 'the viewer reconnects after the host restarts', `${Date.now() - t1} ms`);
  });

  await step('control works again after reconnecting', async () => {
    await host.waitForFunction(() => window.__wc && window.__wc.state.control.attached, { timeout: 15000 });
    // The scroll test left the page scrolled (and Back restored it), which puts the button off-screen.
    await target.evaluate(() => { window.__events = []; window.scrollTo(0, 0); });
    const btn = await centerOf('#btn');
    const p = await viewerPointFor(btn.x, btn.y);
    await viewer.mouse.click(p.x, p.y);
    await target.waitForFunction(() => window.__events.some((e) => e.type === 'click'), { timeout: 10000 });
    check(true, 'control works again after reconnecting');
  });
} catch (e) {
  check(false, 'unexpected error', e.message.split('\n')[0]);
} finally {
  if (viewer) await viewer.screenshot({ path: join(artifacts, 'viewer-final.png') }).catch(() => {});
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
