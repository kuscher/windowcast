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

/**
 * Which Chrome window a captured frame shows. windows: [{id, width, height}] in DIP; scale: device pixel ratio.
 * Matches on aspect ratio (the frame may be downscaled), then prefers the nominated window, then a size match.
 * Returns {id, how: 'nominated' | 'unique' | 'ambiguous'} or null.
 */
export function matchWindow(frameW, frameH, windows, nominatedId, scale) {
  const aspect = frameW / frameH;
  const candidates = windows.filter((w) => {
    const a = w.width / w.height;
    return Math.abs(aspect - a) / a < 0.02;
  });
  if (candidates.length === 0) return null;
  if (candidates.some((w) => w.id === nominatedId)) return { id: nominatedId, how: 'nominated' };
  if (candidates.length === 1) return { id: candidates[0].id, how: 'unique' };
  const sized = candidates.filter((w) =>
    Math.abs(frameW - w.width * scale) / frameW < 0.03 && Math.abs(frameH - w.height * scale) / frameH < 0.03);
  if (sized.length === 1) return { id: sized[0].id, how: 'unique' };
  return { id: (sized[0] || candidates[0]).id, how: 'ambiguous' };
}
