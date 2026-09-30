import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUrlOrSearch } from '../../shared/nav.js';

test('web addresses pass through', () => {
  assert.deepEqual(toUrlOrSearch('https://example.com/a?b=1'), { kind: 'url', url: 'https://example.com/a?b=1' });
  assert.deepEqual(toUrlOrSearch('  http://example.com '), { kind: 'url', url: 'http://example.com' });
  assert.deepEqual(toUrlOrSearch('about:blank'), { kind: 'url', url: 'about:blank' });
});

test('browser, file and script addresses are refused', () => {
  for (const t of ['chrome://settings', 'file:///etc/passwd', 'chrome-extension://abc/x.html', 'view-source:https://a.com',
    'javascript:alert(1)', 'data:text/html,hi', 'about:settings', 'ftp://example.com/']) {
    assert.equal(toUrlOrSearch(t).kind, 'blocked', t);
  }
});

test('bare domains and paths get https', () => {
  assert.deepEqual(toUrlOrSearch('example.com'), { kind: 'url', url: 'https://example.com' });
  assert.deepEqual(toUrlOrSearch('docs.google.com/document/d/1'), { kind: 'url', url: 'https://docs.google.com/document/d/1' });
});

test('local names and addresses get http', () => {
  assert.deepEqual(toUrlOrSearch('localhost:8080'), { kind: 'url', url: 'http://localhost:8080' });
  assert.deepEqual(toUrlOrSearch('192.168.1.20/admin'), { kind: 'url', url: 'http://192.168.1.20/admin' });
});

test('everything else is a search', () => {
  assert.deepEqual(toUrlOrSearch('weather in berlin'), { kind: 'search', query: 'weather in berlin' });
  assert.deepEqual(toUrlOrSearch('pytest'), { kind: 'search', query: 'pytest' });
});

test('empty input is nothing', () => {
  assert.equal(toUrlOrSearch('   '), null);
});
