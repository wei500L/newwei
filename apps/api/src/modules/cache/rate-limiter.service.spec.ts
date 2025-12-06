import { RateLimiterService } from "./rate-limiter.service";

class FakeRedis {
  private buckets = new Map<string, Array<{ score: number; member: string }>>();
  private counters = new Map<string, number>();

  async eval(
    _script: string,
    _keys: number,
    bucketKey: string,
    counterKey: string,
    now: number,
    windowMs: number,
    limit: number
  ): Promise<[number, number]> {
    const windowStart = now - windowMs;
    const entries = this.buckets.get(bucketKey) ?? [];
    const recent = entries.filter((entry) => entry.score > windowStart);
    this.buckets.set(bucketKey, recent);

    const count = recent.length;
    if (count >= limit) {
      return [0, count];
    }

    const sequence = (this.counters.get(counterKey) ?? 0) + 1;
    this.counters.set(counterKey, sequence);
    recent.push({ score: now, member: `${now}-${sequence}` });
    this.buckets.set(bucketKey, recent);

    return [1, count + 1];
  }
}

describe("RateLimiterService (sliding window)", () => {
  let redis: FakeRedis;
  let service: RateLimiterService;
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new RateLimiterService(redis as any);
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("blocks when requests exceed the bucket within the window", async () => {
    expect(await service.consume("user", 2, 60)).toBe(true);
    expect(await service.consume("user", 2, 60)).toBe(true);
    expect(await service.consume("user", 2, 60)).toBe(false);
  });

  it("slides the window instead of resetting on boundary edges", async () => {
    await service.consume("user", 2, 60);
    now += 55_000;
    await service.consume("user", 2, 60);

    now += 6_000; // 61 seconds after first call; oldest hit falls out of the window
    expect(await service.consume("user", 2, 60)).toBe(true);
    expect(await service.consume("user", 2, 60)).toBe(false);
  });

  it("treats disabled buckets as allowed", async () => {
    expect(await service.consume("skip", 0, 60)).toBe(true);
    expect(await service.consume("skip", 5, 0)).toBe(true);
  });
});
