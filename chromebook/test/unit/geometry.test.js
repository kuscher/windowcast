import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoContentRect, normalizePointer, mapToPage, matchWindow } from '../../shared/geometry.js';

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

const windows = [
  { id: 1, width: 1280, height: 800, type: 'normal' },
  { id: 2, width: 1280, height: 800, type: 'normal' },
  { id: 3, width: 900, height: 700, type: 'normal' },
];

test('the nominated window wins when the frame matches it', () => {
  assert.deepEqual(matchWindow(2560, 1600, windows, 2, 2), { id: 2, how: 'nominated' });
});

test('a unique size match is chosen without a nomination', () => {
  assert.deepEqual(matchWindow(1800, 1400, windows, null, 2), { id: 3, how: 'unique' });
});

test('equal windows without a nomination are ambiguous', () => {
  assert.deepEqual(matchWindow(2560, 1600, windows, null, 2), { id: 1, how: 'ambiguous' });
});

test('a downscaled frame still matches by aspect ratio', () => {
  assert.deepEqual(matchWindow(1170, 910, windows, null, 2), { id: 3, how: 'unique' });
});

test('no window matches an unrelated frame', () => {
  assert.equal(matchWindow(1000, 1000, windows, 1, 2), null);
});
