import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactState } from '../../shared/limits.js';

const bytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
const longTab = (i, extra = {}) => ({
  id: i, title: `Tab ${i} ${'x'.repeat(200)}`, url: `https://example.com/${'p'.repeat(1000)}?${i}`,
  active: false, icon: `data:image/png;base64,${'A'.repeat(5000)}`, ...extra,
});

test('a window with hundreds of long tabs fits in one message and keeps the active tab', () => {
  const tabs = Array.from({ length: 300 }, (_, i) => longTab(i, { active: i === 150 }));
  const out = compactState({ t: 'state', sharing: true, title: 'x'.repeat(5000), controllable: true, note: null, tabs, url: tabs[150].url });
  assert.ok(bytes(out) <= 12000, `${bytes(out)} bytes`);
  assert.ok(out.tabs.some((t) => t.active && t.id === 150));
  assert.equal(out.tabs.length + out.more, 300);
});

test('titles, addresses and icons are trimmed', () => {
  const out = compactState({
    t: 'state', sharing: true, title: 'a'.repeat(500), controllable: true, note: 'n'.repeat(900),
    tabs: [longTab(1, { active: true })], url: `https://e.com/${'u'.repeat(3000)}`,
  });
  assert.ok(out.tabs[0].title.length <= 120);
  assert.ok(out.tabs[0].url.length <= 400);
  assert.equal(out.tabs[0].icon, '');
  assert.ok(out.title.length <= 200);
  assert.ok(out.url.length <= 2000);
  assert.ok(out.note.length <= 300);
});

test('a small window passes through with short https icons kept', () => {
  const tabs = [{ id: 1, title: 'Inbox', url: 'https://mail.google.com/', active: true, icon: 'https://www.gstatic.com/favicon.ico' }];
  const out = compactState({ t: 'state', sharing: true, title: 'Inbox', controllable: true, note: null, tabs, url: tabs[0].url });
  assert.deepEqual(out.tabs, tabs);
  assert.equal(out.more, 0);
});
