// Serial input queue for the host. A call that never settles (the page is stuck behind a dialog) is
// abandoned after timeoutMs and everything queued behind it is dropped, so input never piles up and fires
// late. Pointer moves waiting at the end of the queue collapse into the newest one.

export function createInputQueue({
  timeoutMs = 2000, staleMoveMs = 500, staleActMs = 3000, now = () => Date.now(),
  onTimeout = () => {}, onError = () => {},
} = {}) {
  let pending = [];
  let running = false;
  let generation = 0;

  async function pump() {
    if (running) return;
    running = true;
    const gen = generation;
    while (pending.length && gen === generation) {
      const item = pending.shift();
      if (now() - item.at > (item.kind === 'move' ? staleMoveMs : staleActMs)) continue;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('input timed out'), { timeout: true })), timeoutMs);
      });
      try {
        await Promise.race([Promise.resolve().then(item.fn), timeout]);
      } catch (e) {
        if (e && e.timeout) {
          generation += 1;
          pending = [];
          onTimeout();
        } else {
          onError(e);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    running = false;
    if (pending.length) pump();
  }

  return {
    push(fn, kind = 'act') {
      const item = { fn, kind, at: now() };
      const last = pending[pending.length - 1];
      if (kind === 'move' && last && last.kind === 'move') pending[pending.length - 1] = item;
      else pending.push(item);
      pump();
    },
    reset() {
      generation += 1;
      pending = [];
    },
  };
}
