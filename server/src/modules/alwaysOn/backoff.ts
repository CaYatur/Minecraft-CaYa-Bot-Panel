/** Exponential reconnect delay with a cap and symmetric jitter. */
export function nextBackoffMs(input: {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
  random?: () => number;
}): number {
  const attempt = Math.max(0, Math.floor(input.attempt));
  const base = clamp(input.baseMs, 1_000, 3_600_000, 5_000);
  const max = clamp(input.maxMs, base, 3_600_000, 120_000);
  const jitter = clamp(input.jitter, 0, 0.5, 0.2);
  const random = input.random ?? Math.random;
  const raw = Math.min(max, base * 2 ** attempt);
  const swing = raw * jitter;
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(Math.min(max, Math.max(1_000, raw - swing + sample * swing * 2)));
}

/** True when the session was long enough to treat the next drop as a fresh start. */
export function sessionIsStable(onlineMs: number, stableMs: number): boolean {
  return onlineMs >= clamp(stableMs, 10_000, 3_600_000, 120_000);
}

export function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
