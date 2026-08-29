import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../core/circuit-breaker.js';

// Fast config so tests don't wait around
const fast = { failureThreshold: 2, failureWindow: 5000, cooldownMs: 50, requestTimeout: 200 };

describe('CircuitBreaker', () => {
  it('starts closed and passes requests through', async () => {
    const cb = new CircuitBreaker(fast);
    expect(cb.currentState).toBe('closed');
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('stays closed below failure threshold', async () => {
    const cb = new CircuitBreaker(fast);
    // 1 failure — still below threshold of 2
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.currentState).toBe('closed');
    // Success still works
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('opens after hitting failure threshold', async () => {
    const cb = new CircuitBreaker(fast);
    await expect(cb.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');
  });

  it('rejects immediately when open (CircuitOpenError)', async () => {
    const cb = new CircuitBreaker(fast);
    await expect(cb.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();

    let called = false;
    await expect(cb.execute(() => { called = true; return Promise.resolve('x'); }))
      .rejects.toThrow(CircuitOpenError);
    expect(called).toBe(false); // fn was never invoked
  });

  it('transitions open → half_open after cooldown', async () => {
    const cb = new CircuitBreaker({ ...fast, cooldownMs: 30 });
    await expect(cb.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');

    await sleep(40);

    // Next request should be allowed (half_open probe)
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.currentState).toBe('closed');
  });

  it('goes back to open if probe fails in half_open', async () => {
    const cb = new CircuitBreaker({ ...fast, cooldownMs: 30 });
    await expect(cb.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();

    await sleep(40);

    // Probe fails
    await expect(cb.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');
  });

  it('times out slow requests', async () => {
    const cb = new CircuitBreaker({ ...fast, requestTimeout: 30 });
    await expect(cb.execute(() => sleep(100).then(() => 'late')))
      .rejects.toThrow(/timed out/);
    expect(cb.stats.totalFailures).toBe(1);
  });

  it('sliding window: old failures expire', async () => {
    const cb = new CircuitBreaker({ ...fast, failureThreshold: 2, failureWindow: 50 });
    await expect(cb.execute(() => Promise.reject(new Error('old')))).rejects.toThrow();
    expect(cb.currentState).toBe('closed');

    await sleep(60); // wait for the failure window to expire

    await expect(cb.execute(() => Promise.reject(new Error('new')))).rejects.toThrow();
    // Only 1 recent failure (the old one expired), still closed
    expect(cb.currentState).toBe('closed');
  });

  it('tracks stats correctly', async () => {
    const cb = new CircuitBreaker(fast);
    await cb.execute(() => Promise.resolve('a'));
    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('y')))).rejects.toThrow();
    // Now open — next call short-circuits
    await expect(cb.execute(() => Promise.resolve('z'))).rejects.toThrow(CircuitOpenError);

    const s = cb.stats;
    expect(s.totalRequests).toBe(4);
    expect(s.totalFailures).toBe(2);
    expect(s.totalShortCircuited).toBe(1);
    expect(s.state).toBe('open');
  });

  it('reset() clears state back to closed', async () => {
    const cb = new CircuitBreaker(fast);
    await expect(cb.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');

    cb.reset();
    expect(cb.currentState).toBe('closed');
    const result = await cb.execute(() => Promise.resolve('back'));
    expect(result).toBe('back');
  });

  it('CircuitOpenError has retryAfterMs', async () => {
    const cb = new CircuitBreaker({ ...fast, cooldownMs: 500 });
    await expect(cb.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();

    try {
      await cb.execute(() => Promise.resolve('x'));
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      expect((err as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(500);
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
