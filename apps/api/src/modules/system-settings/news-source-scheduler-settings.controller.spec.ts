import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsSourceSchedulerSettingsController } from "./news-source-scheduler-settings.controller";

describe("NewsSourceSchedulerSettingsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["settings.manage"],
    firstName: "Demo",
    lastName: "User",
  };

  const settings = {
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
  } as const;

  let controller: NewsSourceSchedulerSettingsController;

  beforeEach(() => {
    jest.resetAllMocks();
    const adaptiveDefaults = {
      rssAdaptiveHotHitRatePercent: 60,
      rssAdaptiveWarmHitRatePercent: 25,
      rssAdaptiveColdConsecutiveNoHitRuns: 4,
      rssAdaptiveHotIntervalSeconds: 30,
      rssAdaptiveWarmIntervalDivisor: 2,
      rssAdaptiveWarmMinIntervalSeconds: 30,
      rssAdaptiveColdIntervalMultiplier: 2,
      rssAdaptiveColdMaxIntervalSeconds: 3600,
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds: 30,
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: 60,
    };
    settings.getSettings.mockResolvedValue({
      source: "db",
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: false,
      seedUrlQueryParamAllowlist: ["id", "lang"],
      ...adaptiveDefaults,
    });
    settings.updateSettings.mockResolvedValue({
      source: "db",
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: true,
      seedUrlQueryParamAllowlist: ["id", "lang"],
      ...adaptiveDefaults,
    });
    controller = new NewsSourceSchedulerSettingsController(settings as any);
  });

  it("returns current scheduler settings", async () => {
    const result = await controller.getSettings();
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      seedFreshnessWindowDays: 365,
      seedCacheTtlForceGlobal: false,
    });
  });

  it("passes update payload with toggle field", async () => {
    const body = {
      seedFreshnessWindowDays: 30,
      seedCacheTtlSecondsSitemapRss: 90,
      seedCacheTtlSecondsListDeep: 240,
      seedCacheTtlForceGlobal: true,
      seedUrlQueryParamAllowlist: ["id", "lang"],
      rssAdaptiveHotHitRatePercent: 60,
      rssAdaptiveWarmHitRatePercent: 25,
      rssAdaptiveColdConsecutiveNoHitRuns: 4,
      rssAdaptiveHotIntervalSeconds: 30,
      rssAdaptiveWarmIntervalDivisor: 2,
      rssAdaptiveWarmMinIntervalSeconds: 30,
      rssAdaptiveColdIntervalMultiplier: 2,
      rssAdaptiveColdMaxIntervalSeconds: 3600,
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds: 30,
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: 60,
    };

    await controller.updateSettings(user, body);

    expect(settings.updateSettings).toHaveBeenCalledWith("org-1", "user-1", body);
  });
});
