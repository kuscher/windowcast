import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUrlOrSearch } from '../../shared/nav.js';

test('full URLs pass through', () => {
  assert.deepEqual(toUrlOrSearch('https://example.com/a?b=1'), { kind: 'url', url: 'https://example.com/a?b=1' });
  assert.deepEqual(toUrlOrSearch('  chrome://settings '), { kind: 'url', url: 'chrome://settings' });
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
  assert.deepEqual(toUrlOrSearch('javascript:alert(1)'), { kind: 'search', query: 'javascript:alert(1)' });
});

test('empty input is nothing', () => {
  assert.equal(toUrlOrSearch('   '), null);
});
