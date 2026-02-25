import { BadRequestException, type ArgumentMetadata, ValidationPipe } from "@nestjs/common";

import { UpdateNewsSourceSchedulerSettingsDto } from "./news-source-scheduler-settings.dto";

describe("UpdateNewsSourceSchedulerSettingsDto", () => {
  const metadata: ArgumentMetadata = {
    type: "body",
    metatype: UpdateNewsSourceSchedulerSettingsDto,
    data: undefined,
  };

  it("accepts valid payload", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(
      pipe.transform(
        {
          seedFreshnessWindowDays: 365,
          seedCacheTtlSecondsSitemapRss: 60,
          seedCacheTtlSecondsListDeep: 180,
          seedCacheTtlForceGlobal: true,
        },
        metadata,
      ),
    ).resolves.toMatchObject({
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: true,
    });
  });

  it("rejects non-boolean toggle", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(
      pipe.transform(
        {
          seedFreshnessWindowDays: 365,
          seedCacheTtlSecondsSitemapRss: 60,
          seedCacheTtlSecondsListDeep: 180,
          seedCacheTtlForceGlobal: "true",
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
