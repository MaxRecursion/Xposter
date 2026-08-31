/**
 * Wall-clock bounds for work that can hang without erroring.
 *
 * Network clients here already set request timeouts, but a request timeout
 * only covers a single HTTP call. An agentic generation loop, a rate-limited
 * embedding queue, or a Playwright-driven pipeline run can each sit for many
 * minutes without any one call timing out — and because nothing throws,
 * retry and alerting logic never engages. These helpers put a ceiling on the
 * whole operation instead of on its individual steps.
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Rejects with `TimeoutError` if `work` has not settled within `timeoutMs`.
 *
 * The underlying promise is not cancelled — it cannot be, in general — so the
 * work may still complete later and its result is discarded. Callers that care
 * about the abandoned work (a browser session, a spawned CLI) must own that
 * cleanup themselves.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    // `unref` keeps a pending timer from holding the process open at shutdown.
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Timeout variant for optional signals: returns `fallback` instead of throwing.
 *
 * Used where a slow enrichment should degrade the result rather than fail the
 * caller — a scoring boost that cannot be computed in time is better dropped
 * than allowed to stall the run that needed it.
 */
export async function withTimeoutFallback<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout?: (err: TimeoutError) => void,
): Promise<T> {
  try {
    return await withTimeout(work, timeoutMs, 'operation');
  } catch (err) {
    if (err instanceof TimeoutError) {
      onTimeout?.(err);
      return fallback;
    }
    throw err;
  }
}
