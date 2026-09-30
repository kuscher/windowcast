// Keeps the state message under PeerJS's JSON limit (16,300 bytes per message; bigger ones are refused
// with an error that would end the session). Keeps the active tab, trims text, drops data: icons.

const encoder = new TextEncoder();
const bytes = (o) => encoder.encode(JSON.stringify(o)).length;
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

function shapeTab(t, titleMax, urlMax, keepIcon) {
  const icon = keepIcon && typeof t.icon === 'string' && t.icon.startsWith('https:') && t.icon.length <= 300 ? t.icon : '';
  return { id: t.id, title: clip(t.title, titleMax), url: clip(t.url, urlMax), active: Boolean(t.active), icon };
}

// [tabs, title length, address length, keep icons] from generous to tight.
const STEPS = [[40, 120, 400, true], [40, 80, 200, false], [25, 60, 120, false], [12, 40, 80, false], [5, 30, 60, false], [1, 30, 60, false]];

export function compactState(s, maxBytes = 12000) {
  const all = Array.isArray(s.tabs) ? s.tabs : [];
  const activeIndex = Math.max(0, all.findIndex((t) => t && t.active));
  const base = { ...s, title: clip(s.title, 200), url: clip(s.url, 2000), note: s.note == null ? null : clip(s.note, 300) };
  for (const [maxTabs, titleMax, urlMax, icons] of STEPS) {
    const start = Math.max(0, Math.min(activeIndex - Math.floor(maxTabs / 2), all.length - maxTabs));
    const tabs = all.slice(start, start + maxTabs).map((t) => shapeTab(t, titleMax, urlMax, icons));
    const out = { ...base, tabs, more: all.length - tabs.length };
    if (bytes(out) <= maxBytes) return out;
  }
  return { ...base, title: clip(base.title, 100), url: clip(base.url, 300), tabs: [], more: all.length };
}
