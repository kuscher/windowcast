import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../../shared/retry.js';

test('retry delays double from one second and cap at fifteen', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelay(n, () => 0.5)), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test('jitter stays within plus or minus twenty percent', () => {
  assert.equal(retryDelay(1, () => 0), 1600);
  assert.equal(retryDelay(1, () => 1), 2400);
});
