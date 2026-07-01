import {
  BadRequestException,
  type ArgumentMetadata,
  ValidationPipe,
} from "@nestjs/common";

import { UpdateMultiTenantSchedulerSettingsDto } from "./multi-tenant-scheduler-settings.dto";

describe("UpdateMultiTenantSchedulerSettingsDto", () => {
  const metadata: ArgumentMetadata = {
    type: "body",
    metatype: UpdateMultiTenantSchedulerSettingsDto,
    data: undefined,
  };
  const basePayload = {
    realtimeSignalsOrgConcurrency: 4,
    newsEventsTimelineOrgConcurrency: 2,
    newsEventsIngestionOrgConcurrency: 4,
    knowledgeGraphIngestionOrgConcurrency: 4,
    sentimentSnapshotOrgConcurrency: 2,
    newsnowHottestAnalysisOrgConcurrency: 6,
    classificationQualityAlertOrgConcurrency: 4,
    newsIndicatorAssociationOrgConcurrency: 2,
    crawlQualityTaskSnapshotOrgConcurrency: 2,
    situationMonitorOrefDefaultRuleOrgConcurrency: 16,
    userDigestDeliveryOrgConcurrency: 4,
  };

  it("accepts valid payload", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });

    await expect(pipe.transform(basePayload, metadata)).resolves.toMatchObject(
      basePayload,
    );
  });

  it("accepts legacy payloads without newly added optional concurrency fields", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const legacyPayload: Partial<typeof basePayload> = { ...basePayload };
    delete legacyPayload.realtimeSignalsOrgConcurrency;
    delete legacyPayload.newsEventsTimelineOrgConcurrency;
    delete legacyPayload.classificationQualityAlertOrgConcurrency;
    delete legacyPayload.newsIndicatorAssociationOrgConcurrency;
    delete legacyPayload.crawlQualityTaskSnapshotOrgConcurrency;
    delete legacyPayload.situationMonitorOrefDefaultRuleOrgConcurrency;

    await expect(
      pipe.transform(legacyPayload, metadata),
    ).resolves.toMatchObject(legacyPayload);
  });

  it("rejects out-of-range concurrency", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });

    await expect(
      pipe.transform(
        {
          ...basePayload,
          newsEventsIngestionOrgConcurrency: 17,
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
