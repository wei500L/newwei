import { BadRequestException, type ArgumentMetadata, ValidationPipe } from "@nestjs/common";

import { UpdateNewsSourceSchedulerSettingsDto } from "./news-source-scheduler-settings.dto";

describe("UpdateNewsSourceSchedulerSettingsDto", () => {
  const metadata: ArgumentMetadata = {
    type: "body",
    metatype: UpdateNewsSourceSchedulerSettingsDto,
    data: undefined,
  };
  const basePayload = {
    seedFreshnessWindowDays: 365,
    seedCacheTtlSecondsSitemapRss: 60,
    seedCacheTtlSecondsListDeep: 180,
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

  it("accepts valid payload", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(
      pipe.transform(basePayload, metadata),
    ).resolves.toMatchObject({
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: true,
      seedUrlQueryParamAllowlist: ["id", "lang"],
      rssAdaptiveHotHitRatePercent: 60,
      rssAdaptiveWarmHitRatePercent: 25,
    });
  });

  it("rejects non-boolean toggle", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(
      pipe.transform(
        {
          ...basePayload,
          seedCacheTtlForceGlobal: "true",
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects invalid query allowlist values", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(
      pipe.transform(
        {
          ...basePayload,
          seedUrlQueryParamAllowlist: ["id", "utm source"],
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
