/** Capped exponential backoff: 1s, 2s, 4s, 8s, then 15s (defaults). */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 15_000): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** Math.min(n, 30));
}
