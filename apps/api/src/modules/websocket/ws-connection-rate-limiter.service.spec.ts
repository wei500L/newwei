import { WsConnectionRateLimiterService } from "./ws-connection-rate-limiter.service";

describe("WsConnectionRateLimiterService", () => {
  const mockRateLimiter = {
    consume: jest.fn()
  };

  const mockEnv = {
    webSocketSecurity: {
      connectRateLimitPerIp: 60,
      connectRateLimitWindowSeconds: 60
    }
  };

  const mockRedis = {
    incr: jest.fn(),
    expire: jest.fn(),
    get: jest.fn(),
    del: jest.fn()
  };

  let service: WsConnectionRateLimiterService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WsConnectionRateLimiterService(
      mockRateLimiter as any,
      mockEnv as any,
      mockRedis as any
    );
  });

  describe("checkConnectionRateLimit", () => {
    it("returns allowed=true when under limit", async () => {
      mockRateLimiter.consume.mockResolvedValue(true);

      const result = await service.checkConnectionRateLimit("192.168.1.100");

      expect(result).toEqual({ allowed: true });
      expect(mockRateLimiter.consume).toHaveBeenCalledWith(
        "ws:connect:192.168.1.100",
        60,
        60
      );
    });

    it("returns allowed=false with retryAfterMs when limit exceeded", async () => {
      mockRateLimiter.consume.mockResolvedValue(false);

      const result = await service.checkConnectionRateLimit("192.168.1.100");

      expect(result).toEqual({ allowed: false, retryAfterMs: 60000 });
    });

    it("returns allowed=true for empty IP (fail-open)", async () => {
      const result = await service.checkConnectionRateLimit("");

      expect(result).toEqual({ allowed: true });
      expect(mockRateLimiter.consume).not.toHaveBeenCalled();
    });

    it("returns allowed=true when rate limiter throws (fail-open)", async () => {
      mockRateLimiter.consume.mockRejectedValue(new Error("Redis error"));

      const result = await service.checkConnectionRateLimit("192.168.1.100");

      expect(result).toEqual({ allowed: true });
    });
  });

  describe("recordFailedAuth", () => {
    it("increments failure counter in Redis", async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      await service.recordFailedAuth("192.168.1.100");

      expect(mockRedis.incr).toHaveBeenCalledWith("ws:backoff:192.168.1.100");
      expect(mockRedis.expire).toHaveBeenCalledWith("ws:backoff:192.168.1.100", 120);
    });

    it("does nothing for empty IP", async () => {
      await service.recordFailedAuth("");

      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it("handles Redis errors gracefully", async () => {
      mockRedis.incr.mockRejectedValue(new Error("Redis error"));

      await expect(service.recordFailedAuth("192.168.1.100")).resolves.not.toThrow();
    });
  });

  describe("getBackoffDelay", () => {
    it("returns 0 when no failures recorded", async () => {
      mockRedis.get.mockResolvedValue(null);

      const delay = await service.getBackoffDelay("192.168.1.100");

      expect(delay).toBe(0);
    });

    it("returns exponential delays (1s, 2s, 4s, 8s...)", async () => {
      // 1 failure = 1s
      mockRedis.get.mockResolvedValue("1");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(1000);

      // 2 failures = 2s
      mockRedis.get.mockResolvedValue("2");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(2000);

      // 3 failures = 4s
      mockRedis.get.mockResolvedValue("3");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(4000);

      // 4 failures = 8s
      mockRedis.get.mockResolvedValue("4");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(8000);

      // 5 failures = 16s
      mockRedis.get.mockResolvedValue("5");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(16000);

      // 6 failures = 32s
      mockRedis.get.mockResolvedValue("6");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(32000);
    });

    it("caps delay at 60s max", async () => {
      // 7 failures would be 64s, but capped at 60s
      mockRedis.get.mockResolvedValue("7");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(60000);

      // 10 failures would be 512s, but capped at 60s
      mockRedis.get.mockResolvedValue("10");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(60000);
    });

    it("returns 0 for empty IP", async () => {
      const delay = await service.getBackoffDelay("");

      expect(delay).toBe(0);
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it("returns 0 on Redis error (fail-open)", async () => {
      mockRedis.get.mockRejectedValue(new Error("Redis error"));

      const delay = await service.getBackoffDelay("192.168.1.100");

      expect(delay).toBe(0);
    });

    it("returns 0 for invalid failure count", async () => {
      mockRedis.get.mockResolvedValue("invalid");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(0);

      mockRedis.get.mockResolvedValue("0");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(0);

      mockRedis.get.mockResolvedValue("-1");
      expect(await service.getBackoffDelay("192.168.1.100")).toBe(0);
    });
  });

  describe("clearBackoff", () => {
    it("deletes backoff key from Redis", async () => {
      mockRedis.del.mockResolvedValue(1);

      await service.clearBackoff("192.168.1.100");

      expect(mockRedis.del).toHaveBeenCalledWith("ws:backoff:192.168.1.100");
    });

    it("does nothing for empty IP", async () => {
      await service.clearBackoff("");

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it("handles Redis errors gracefully", async () => {
      mockRedis.del.mockRejectedValue(new Error("Redis error"));

      await expect(service.clearBackoff("192.168.1.100")).resolves.not.toThrow();
    });
  });
});
