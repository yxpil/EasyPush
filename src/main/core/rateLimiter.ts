export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  hit(key: string): RateResult {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (existing.length >= this.limit) {
      const oldest = existing[0] ?? now;
      this.hits.set(key, existing);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    existing.push(now);
    this.hits.set(key, existing);
    return { allowed: true, remaining: this.limit - existing.length, retryAfterMs: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  prune(): void {
    const cutoff = this.clock() - this.windowMs;
    for (const [key, hits] of this.hits) {
      const kept = hits.filter((at) => at > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
