import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputQueue } from '../../shared/queue.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('actions run one at a time, in order', async () => {
  const q = createInputQueue();
  const seen = [];
  for (const n of [1, 2, 3]) q.push(async () => { await wait(5); seen.push(n); });
  await wait(60);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('pointer moves waiting behind other work collapse into the latest one', async () => {
  const q = createInputQueue();
  const seen = [];
  q.push(async () => { await wait(30); seen.push('click'); });
  for (const n of [1, 2, 3]) q.push(async () => { seen.push(`move${n}`); }, 'move');
  await wait(80);
  assert.deepEqual(seen, ['click', 'move3']);
});

test('a move queued before a click is not moved past it', async () => {
  const q = createInputQueue();
  const seen = [];
  q.push(async () => { await wait(30); seen.push('first'); });
  q.push(async () => { seen.push('move1'); }, 'move');
  q.push(async () => { seen.push('down'); });
  q.push(async () => { seen.push('move2'); }, 'move');
  await wait(80);
  assert.deepEqual(seen, ['first', 'move1', 'down', 'move2']);
});

test('a stuck call is abandoned, what queued behind it is dropped, and later input works', async () => {
  let timeouts = 0;
  const q = createInputQueue({ timeoutMs: 40, onTimeout: () => { timeouts += 1; } });
  const seen = [];
  q.push(() => new Promise(() => {}));
  q.push(async () => { seen.push('behind the stuck call'); });
  await wait(90);
  q.push(async () => { seen.push('later'); });
  await wait(30);
  assert.deepEqual(seen, ['later']);
  assert.equal(timeouts, 1);
});

test('input that waited too long is skipped instead of firing late', async () => {
  const q = createInputQueue({ staleActMs: 20, staleMoveMs: 20 });
  const seen = [];
  q.push(async () => { await wait(50); seen.push('slow'); });
  q.push(async () => { seen.push('late click'); });
  await wait(90);
  assert.deepEqual(seen, ['slow']);
});

test('reset drops everything that has not started', async () => {
  const q = createInputQueue();
  const seen = [];
  q.push(async () => { await wait(20); seen.push('running'); });
  q.push(async () => { seen.push('dropped'); });
  q.reset();
  await wait(50);
  q.push(async () => { seen.push('after reset'); });
  await wait(20);
  assert.deepEqual(seen, ['running', 'after reset']);
});
