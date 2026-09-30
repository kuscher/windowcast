// Reconnect back-off: 1 s doubling to a 15 s cap, with plus or minus 20 percent jitter.
export function retryDelay(attempt, random = Math.random) {
  const base = Math.min(1000 * 2 ** attempt, 15000);
  return Math.round(base * (0.8 + 0.4 * random()));
}
