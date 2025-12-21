import { RateLimiterService } from "./rate-limiter.service";

class FakeRedis {
  private buckets = new Map<string, { score: number; member: string }[]>();
  private counters = new Map<string, number>();

  async eval(
    _script: string,
    _keys: number,
    bucketKey: string,
    counterKey: string,
    now: number,
    windowMs: number,
    limit: number
    // extra args: ttlSeconds, cleanupLimit, cleanupThreshold
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

  it("fails open when redis eval times out (circuit protection)", async () => {
    const originalTimeout = process.env.RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS;
    const originalThreshold = process.env.RATE_LIMIT_REDIS_CIRCUIT_FAILURE_THRESHOLD;
    const originalOpenMs = process.env.RATE_LIMIT_REDIS_CIRCUIT_OPEN_MS;
    const originalFailOpen = process.env.RATE_LIMIT_REDIS_FAIL_OPEN;

    process.env.RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS = "50";
    process.env.RATE_LIMIT_REDIS_CIRCUIT_FAILURE_THRESHOLD = "1";
    process.env.RATE_LIMIT_REDIS_CIRCUIT_OPEN_MS = "5000";
    process.env.RATE_LIMIT_REDIS_FAIL_OPEN = "true";

    try {
      const slowRedis = {
        evalCalls: 0,
        eval: async () => {
          slowRedis.evalCalls += 1;
          return await new Promise<[number, number]>(() => undefined);
        }
      };
      const slowService = new RateLimiterService(slowRedis as any);

      const started = process.hrtime.bigint();
      await expect(slowService.consume("user", 1, 60)).resolves.toBe(true);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(durationMs).toBeLessThan(500);
      expect(slowRedis.evalCalls).toBe(1);

      await expect(slowService.consume("user", 1, 60)).resolves.toBe(true);
      expect(slowRedis.evalCalls).toBe(1);
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS;
      } else {
        process.env.RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS = originalTimeout;
      }
      if (originalThreshold === undefined) {
        delete process.env.RATE_LIMIT_REDIS_CIRCUIT_FAILURE_THRESHOLD;
      } else {
        process.env.RATE_LIMIT_REDIS_CIRCUIT_FAILURE_THRESHOLD = originalThreshold;
      }
      if (originalOpenMs === undefined) {
        delete process.env.RATE_LIMIT_REDIS_CIRCUIT_OPEN_MS;
      } else {
        process.env.RATE_LIMIT_REDIS_CIRCUIT_OPEN_MS = originalOpenMs;
      }
      if (originalFailOpen === undefined) {
        delete process.env.RATE_LIMIT_REDIS_FAIL_OPEN;
      } else {
        process.env.RATE_LIMIT_REDIS_FAIL_OPEN = originalFailOpen;
      }
    }
  });
});
