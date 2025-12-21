import { AlertsNotificationThrottleService } from "./alerts-notification-throttle.service";

class FakeRedis {
  private values = new Map<string, number>();

  async eval(_script: string, _keys: number, key: string, now: number, intervalMs: number, _ttlMs: number): Promise<number> {
    void _ttlMs;
    const next = this.values.get(key) ?? now;
    const scheduled = Math.max(now, next);
    const newNext = scheduled + intervalMs;
    this.values.set(key, newNext);
    return scheduled - now;
  }
}

describe("AlertsNotificationThrottleService", () => {
  let service: AlertsNotificationThrottleService;
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    service = new AlertsNotificationThrottleService(
      new FakeRedis() as any,
      {
        bullmqConfig: { namespace: "test" },
        alertingConfig: {
          notifyGlobalPerSecond: 0,
          notifyEmailPerSecond: 0,
          notifyWebhookPerSecond: 0,
          notifyPerChannelPerSecond: 0,
          notifyLimiterTtlMs: 60_000
        }
      } as any
    );
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("parses muteUntil timestamps from numbers and strings", () => {
    expect(service.parseMuteUntilMs(null)).toBeNull();
    expect(service.parseMuteUntilMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(service.parseMuteUntilMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(service.parseMuteUntilMs("1700000000")).toBe(1_700_000_000_000);
    expect(service.parseMuteUntilMs("1700000000000")).toBe(1_700_000_000_000);
    expect(service.parseMuteUntilMs("2023-11-14T22:13:20.000Z")).toBe(1_700_000_000_000);
    expect(service.parseMuteUntilMs("")).toBeNull();
  });

  it("paces successive reservations on the same key", async () => {
    (service as any).env.alertingConfig.notifyGlobalPerSecond = 2;

    const scheduled: number[] = [];
    scheduled.push(await service.reserveNotificationScheduleMs({ channelType: "email", channelId: null }));
    scheduled.push(await service.reserveNotificationScheduleMs({ channelType: "email", channelId: null }));
    scheduled.push(await service.reserveNotificationScheduleMs({ channelType: "email", channelId: null }));

    expect(scheduled).toEqual([now, now + 500, now + 1000]);
  });
});
