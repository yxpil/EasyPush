import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/main/core/rateLimiter';

function clockFrom(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('RateLimiter', () => {
  it('allows up to the limit and reports a retry window', () => {
    const clock = clockFrom(1000);
    const limiter = new RateLimiter(2, 60_000, clock.now);
    expect(limiter.hit('ip').allowed).toBe(true);
    clock.advance(500);
    expect(limiter.hit('ip').allowed).toBe(true);
    clock.advance(500);
    const blocked = limiter.hit('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBe(59_000);
  });

  it('expires hits after the window', () => {
    const clock = clockFrom(0);
    const limiter = new RateLimiter(1, 1000, clock.now);
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(false);
    clock.advance(1001);
    expect(limiter.hit('ip').allowed).toBe(true);
  });

  it('tracks keys independently and supports reset', () => {
    const clock = clockFrom(0);
    const limiter = new RateLimiter(1, 1000, clock.now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    limiter.reset('a');
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('prunes expired keys', () => {
    const clock = clockFrom(0);
    const limiter = new RateLimiter(5, 100, clock.now);
    limiter.hit('a');
    clock.advance(101);
    limiter.prune();
    expect(limiter.hit('a').remaining).toBe(4);
  });

  it('reports remaining budget', () => {
    const clock = clockFrom(0);
    const limiter = new RateLimiter(3, 10_000, clock.now);
    expect(limiter.hit('x').remaining).toBe(2);
    expect(limiter.hit('x').remaining).toBe(1);
    expect(limiter.hit('x').remaining).toBe(0);
  });
});
