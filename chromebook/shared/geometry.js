// Coordinate math. Viewer side: where the video is drawn and where the pointer is on it.
// Host side: from a point on the captured frame to CSS pixels in the shared window's page.

/** Rectangle of a videoW x videoH frame drawn with object-fit: contain inside elemW x elemH. */
export function videoContentRect(elemW, elemH, videoW, videoH) {
  if (!elemW || !elemH || !videoW || !videoH) return { x: 0, y: 0, w: elemW, h: elemH };
  const scale = Math.min(elemW / videoW, elemH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (elemW - w) / 2, y: (elemH - h) / 2, w, h };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Pointer position (element pixels) to 0..1 on the frame; `inside` is false over the bars. */
export function normalizePointer(px, py, rect) {
  const x = (px - rect.x) / rect.w;
  const y = (py - rect.y) / rect.h;
  return { x: clamp01(x), y: clamp01(y), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

/**
 * Frame point (nx, ny in 0..1) to the page of the shared window.
 * frame: {w, h} pixels; win: {width, height} DIP; page: {innerWidth, innerHeight} CSS px; zoom: tab zoom factor.
 * ChromeOS browser windows have no side or bottom frame, so the page sits at the window's left edge,
 * below the tab strip and toolbar; a side panel narrows it from the right.
 * Returns {zone: 'page', x, y}, {zone: 'browser-ui'} or {zone: 'outside'} (letterbox bars).
 */
export function mapToPage(nx, ny, frame, win, page, zoom) {
  const r = videoContentRect(frame.w, frame.h, win.width, win.height);
  const wx = (nx * frame.w - r.x) / r.w;
  const wy = (ny * frame.h - r.y) / r.h;
  if (wx < 0 || wx > 1 || wy < 0 || wy > 1) return { zone: 'outside' };
  const xd = wx * win.width;
  const yd = wy * win.height;
  const contentW = page.innerWidth * zoom;
  const top = Math.max(0, win.height - page.innerHeight * zoom);
  if (yd < top || xd > contentW) return { zone: 'browser-ui' };
  return { zone: 'page', x: xd / zoom, y: (yd - top) / zoom };
}

/** Frame size a window produces: DIP times screen scale, scaled down to fit the capture limits. */
export function expectedFrameSize(win, dpr, limits) {
  const w = win.width * dpr;
  const h = win.height * dpr;
  const s = Math.min(1, limits.maxWidth / w, limits.maxHeight / h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/** Ids of the windows whose expected frame matches within 3 percent, the nominated one first. */
export function sizeCandidates(frameW, frameH, windows, dpr, limits, nominatedId) {
  const close = (a, b) => Math.abs(a - b) / b <= 0.03;
  const ids = windows
    .filter((w) => { const e = expectedFrameSize(w, dpr, limits); return close(frameW, e.w) && close(frameH, e.h); })
    .map((w) => w.id);
  return ids.includes(nominatedId) ? [nominatedId, ...ids.filter((id) => id !== nominatedId)] : ids;
}

/** Inverse of mapToPage: a CSS point in the page to 0..1 on the frame. */
export function pageToFrame(x, y, frame, win, page, zoom) {
  const r = videoContentRect(frame.w, frame.h, win.width, win.height);
  const top = Math.max(0, win.height - page.innerHeight * zoom);
  const wx = (x * zoom) / win.width;
  const wy = (y * zoom + top) / win.height;
  return { x: (r.x + wx * r.w) / frame.w, y: (r.y + wy * r.h) / frame.h };
}

const isMarker = (d, i) => d[i] > 200 && d[i + 1] < 90 && d[i + 2] > 200;

/**
 * Looks for the magenta marker the host draws into the page. rgba: pixel data of width x height;
 * expected: normalized {x, y, w, h}. Found when most of the expected area is magenta and most magenta
 * pixels are there, so scattered magenta elsewhere doesn't count.
 */
export function detectMarker(rgba, width, height, expected) {
  const pad = 0.03;
  const x0 = Math.floor((expected.x - pad) * width);
  const x1 = Math.ceil((expected.x + expected.w + pad) * width);
  const y0 = Math.floor((expected.y - pad) * height);
  const y1 = Math.ceil((expected.y + expected.h + pad) * height);
  let inside = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isMarker(rgba, (y * width + x) * 4)) continue;
      total += 1;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) inside += 1;
    }
  }
  const area = Math.max(1, expected.w * width * expected.h * height);
  return { found: inside >= 0.4 * area && inside >= 0.7 * total, inside, total };
}
