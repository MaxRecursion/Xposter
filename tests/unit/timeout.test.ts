import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout, withTimeoutFallback } from '../../src/utils/timeout.js';

describe('withTimeout', () => {
  it('passes through a value that settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'work')).resolves.toBe('ok');
  });

  it('propagates the original rejection rather than masking it', async () => {
    const boom = new Error('upstream failed');
    await expect(withTimeout(Promise.reject(boom), 1000, 'work')).rejects.toBe(boom);
  });

  it('rejects with TimeoutError once the ceiling passes', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise(() => {});  // never settles
      const guarded = withTimeout(pending, 5000, 'stuck work');
      const assertion = expect(guarded).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the operation and duration in the error', async () => {
    vi.useFakeTimers();
    try {
      const guarded = withTimeout(new Promise(() => {}), 30_000, 'Agentic generation');
      const assertion = expect(guarded).rejects.toThrow('Agentic generation timed out after 30s');
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a non-positive timeout as no timeout at all', async () => {
    await expect(withTimeout(Promise.resolve(1), 0, 'work')).resolves.toBe(1);
  });
});

describe('withTimeoutFallback', () => {
  it('returns the real value when it arrives in time', async () => {
    await expect(withTimeoutFallback(Promise.resolve([1, 2]), 1000, null)).resolves.toEqual([1, 2]);
  });

  it('degrades to the fallback instead of throwing on timeout', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const guarded = withTimeoutFallback(new Promise(() => {}), 2000, 'base', onTimeout);
      await vi.advanceTimersByTimeAsync(2001);
      await expect(guarded).resolves.toBe('base');
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still surfaces real errors — only timeouts degrade', async () => {
    const boom = new Error('lookup exploded');
    await expect(withTimeoutFallback(Promise.reject(boom), 1000, 'base')).rejects.toBe(boom);
  });
});
