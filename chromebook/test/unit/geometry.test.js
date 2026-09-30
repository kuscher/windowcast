import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoContentRect, normalizePointer, mapToPage, expectedFrameSize, sizeCandidates, pageToFrame, detectMarker } from '../../shared/geometry.js';

test('content rect fills the element when aspect ratios match', () => {
  assert.deepEqual(videoContentRect(800, 500, 1600, 1000), { x: 0, y: 0, w: 800, h: 500 });
});

test('content rect is pillarboxed in a wide element and letterboxed in a tall one', () => {
  assert.deepEqual(videoContentRect(1000, 500, 1600, 1000), { x: 100, y: 0, w: 800, h: 500 });
  assert.deepEqual(videoContentRect(800, 1000, 1600, 1000), { x: 0, y: 250, w: 800, h: 500 });
});

test('pointer positions normalize to the video frame and report bars as outside', () => {
  const rect = { x: 100, y: 0, w: 800, h: 500 };
  assert.deepEqual(normalizePointer(500, 250, rect), { x: 0.5, y: 0.5, inside: true });
  assert.deepEqual(normalizePointer(50, 250, rect), { x: 0, y: 0.5, inside: false });
});

// A 1280x800 DIP window whose page area is 1280x712 CSS px at 100% zoom: 88 DIP of tab strip and toolbar.
const frame = { w: 2560, h: 1600 };
const win = { width: 1280, height: 800 };
const page = { innerWidth: 1280, innerHeight: 712 };

test('a click in the page maps to CSS pixels below the browser toolbar', () => {
  assert.deepEqual(mapToPage(0.5, 0.5, frame, win, page, 1), { zone: 'page', x: 640, y: 312 });
});

test("a click in the Chromebook's own tab strip or toolbar is reported, not sent to the page", () => {
  assert.equal(mapToPage(0.5, 0.05, frame, win, page, 1).zone, 'browser-ui');
});

test('page zoom scales the CSS coordinates', () => {
  const zoomed = { innerWidth: 1024, innerHeight: 569.6 };  // same DIP area at 125%
  const r = mapToPage(0.5, 0.5, frame, win, zoomed, 1.25);
  assert.equal(r.zone, 'page');
  assert.ok(Math.abs(r.x - 512) < 0.01 && Math.abs(r.y - 249.6) < 0.01, JSON.stringify(r));
});

test('a letterboxed frame still maps onto the right spot', () => {
  // Window 1280x800 drawn into a 2000x1000 frame: content 1600x1000 centered, bars 200 px each side.
  const r = mapToPage(0.5, 0.5, { w: 2000, h: 1000 }, win, page, 1);
  assert.deepEqual(r, { zone: 'page', x: 640, y: 312 });
  assert.equal(mapToPage(0.05, 0.5, { w: 2000, h: 1000 }, win, page, 1).zone, 'outside');
});

test('a side panel narrows the page, and clicks on it count as browser UI', () => {
  const withPanel = { innerWidth: 960, innerHeight: 712 };
  assert.equal(mapToPage(0.9, 0.5, frame, win, withPanel, 1).zone, 'browser-ui');
  assert.equal(mapToPage(0.25, 0.5, frame, win, withPanel, 1).zone, 'page');
});

const limits = { maxWidth: 3840, maxHeight: 2400 };
const windows = [
  { id: 1, width: 1280, height: 800 },
  { id: 2, width: 1280, height: 800 },
  { id: 3, width: 900, height: 700 },
];

test('the expected frame follows the window, the screen scale and the capture limits', () => {
  assert.deepEqual(expectedFrameSize({ width: 1280, height: 800 }, 2, limits), { w: 2560, h: 1600 });
  assert.deepEqual(expectedFrameSize({ width: 2560, height: 1600 }, 2, limits), { w: 3840, h: 2400 });
});

test('only windows of the right size are candidates, the nominated one first', () => {
  assert.deepEqual(sizeCandidates(2560, 1600, windows, 2, limits, 2), [2, 1]);
  assert.deepEqual(sizeCandidates(2560, 1600, windows, 2, limits, null), [1, 2]);
  assert.deepEqual(sizeCandidates(1800, 1400, windows, 2, limits, 1), [3]);
});

test('a window with the same shape but another size is not a candidate', () => {
  assert.deepEqual(sizeCandidates(1280, 800, [{ id: 1, width: 1280, height: 800 }], 2, limits, 1), []);
});

test('pageToFrame undoes mapToPage, also with zoom and letterboxing', () => {
  for (const [f, z, pg] of [[frame, 1, page], [{ w: 2000, h: 1000 }, 1, page], [frame, 1.25, { innerWidth: 1024, innerHeight: 569.6 }]]) {
    const p = mapToPage(0.3, 0.6, f, win, pg, z);
    const back = pageToFrame(p.x, p.y, f, win, pg, z);
    assert.ok(Math.abs(back.x - 0.3) < 1e-9 && Math.abs(back.y - 0.6) < 1e-9, JSON.stringify({ f, z, back }));
  }
});

function frameWith(w, h, rect) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 120; data[i + 1] = 130; data[i + 2] = 140; data[i + 3] = 255; }
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = 255; data[i + 1] = 0; data[i + 2] = 255;
      }
    }
  }
  return data;
}
const expected = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

test('the marker is found where the page should show it', () => {
  assert.equal(detectMarker(frameWith(100, 60, { x: 40, y: 24, w: 20, h: 12 }), 100, 60, expected).found, true);
});

test('a marker in another place, no marker, or scattered magenta pixels do not count', () => {
  assert.equal(detectMarker(frameWith(100, 60, { x: 5, y: 5, w: 20, h: 12 }), 100, 60, expected).found, false);
  assert.equal(detectMarker(frameWith(100, 60, null), 100, 60, expected).found, false);
  const noisy = frameWith(100, 60, null);
  for (let k = 0; k < 12; k++) { const i = ((k * 7) % 60 * 100 + (k * 13) % 100) * 4; noisy[i] = 255; noisy[i + 1] = 0; noisy[i + 2] = 255; }
  assert.equal(detectMarker(noisy, 100, 60, expected).found, false);
});
