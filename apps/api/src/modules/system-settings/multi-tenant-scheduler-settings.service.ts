import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

export type MultiTenantSchedulerSettingsSource = "default" | "db";

export interface MultiTenantSchedulerSettingsPublic {
  source: MultiTenantSchedulerSettingsSource;
  realtimeSignalsOrgConcurrency: number;
  newsEventsTimelineOrgConcurrency: number;
  newsEventsIngestionOrgConcurrency: number;
  knowledgeGraphIngestionOrgConcurrency: number;
  sentimentSnapshotOrgConcurrency: number;
  newsnowHottestAnalysisOrgConcurrency: number;
  classificationQualityAlertOrgConcurrency: number;
  newsIndicatorAssociationOrgConcurrency: number;
  crawlQualityTaskSnapshotOrgConcurrency: number;
  situationMonitorOrefDefaultRuleOrgConcurrency: number;
  userDigestDeliveryOrgConcurrency: number;
}

interface StoredMultiTenantSchedulerSettings {
  realtimeSignalsOrgConcurrency?: unknown;
  newsEventsTimelineOrgConcurrency?: unknown;
  newsEventsIngestionOrgConcurrency?: unknown;
  knowledgeGraphIngestionOrgConcurrency?: unknown;
  sentimentSnapshotOrgConcurrency?: unknown;
  newsnowHottestAnalysisOrgConcurrency?: unknown;
  classificationQualityAlertOrgConcurrency?: unknown;
  newsIndicatorAssociationOrgConcurrency?: unknown;
  crawlQualityTaskSnapshotOrgConcurrency?: unknown;
  situationMonitorOrefDefaultRuleOrgConcurrency?: unknown;
  userDigestDeliveryOrgConcurrency?: unknown;
}

const SETTINGS_KEY = "multi_tenant_scheduler_runtime_settings";
const SETTINGS_DESCRIPTION =
  "Multi-tenant scheduler runtime settings (org fan-out concurrency).";
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 16;
const RUNTIME_CACHE_TTL_MS = 30_000;
const INVALID_PERSISTED_SETTINGS_CODE =
  "MULTI_TENANT_SCHEDULER_SETTINGS_INVALID";
const INVALID_PERSISTED_SETTINGS_ERROR =
  "Stored multi-tenant scheduler runtime settings are invalid.";
const INVALID_PERSISTED_SETTINGS_DETAIL =
  "Multi-tenant scheduler concurrency settings must be integers between 1 and 16.";

const DEFAULT_SETTINGS: Omit<MultiTenantSchedulerSettingsPublic, "source"> = {
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

@Injectable()
export class MultiTenantSchedulerSettingsService {
  private readonly logger = createLogger({
    name: "multi-tenant-scheduler-settings",
  });
  private cachedRuntime?: MultiTenantSchedulerSettingsPublic;
  private cachedRuntimeAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<MultiTenantSchedulerSettingsPublic> {
    let record: { value: unknown } | null = null;
    try {
      record = await this.prisma.systemSetting.findUnique({
        where: { key: SETTINGS_KEY },
        select: { value: true },
      });
    } catch (error) {
      this.logger.error(
        { error, settingsKey: SETTINGS_KEY },
        "Failed to load multi-tenant scheduler runtime settings",
      );
      throw error;
    }

    if (!record) {
      return {
        source: "default",
        ...DEFAULT_SETTINGS,
      };
    }

    const normalized = this.normalizeStoredSettings(record.value);
    if (!normalized) {
      this.logger.error(
        { settingsKey: SETTINGS_KEY, storedValue: record.value },
        "Invalid persisted multi-tenant scheduler runtime settings",
      );
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: INVALID_PERSISTED_SETTINGS_DETAIL,
      });
    }

    return {
      source: "db",
      ...normalized,
    };
  }

  async getRuntimeSettings(): Promise<MultiTenantSchedulerSettingsPublic> {
    const now = Date.now();
    if (
      this.cachedRuntime &&
      now - this.cachedRuntimeAt <= RUNTIME_CACHE_TTL_MS
    ) {
      return this.cachedRuntime;
    }

    const settings = await this.getSettings();
    this.cachedRuntime = settings;
    this.cachedRuntimeAt = now;
    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      realtimeSignalsOrgConcurrency?: number;
      newsEventsTimelineOrgConcurrency?: number;
      newsEventsIngestionOrgConcurrency: number;
      knowledgeGraphIngestionOrgConcurrency: number;
      sentimentSnapshotOrgConcurrency: number;
      newsnowHottestAnalysisOrgConcurrency: number;
      classificationQualityAlertOrgConcurrency?: number;
      newsIndicatorAssociationOrgConcurrency?: number;
      crawlQualityTaskSnapshotOrgConcurrency?: number;
      situationMonitorOrefDefaultRuleOrgConcurrency?: number;
      userDigestDeliveryOrgConcurrency: number;
    },
  ): Promise<MultiTenantSchedulerSettingsPublic> {
    const normalized = this.normalizeInputOrThrow(input);

    try {
      await this.prisma.systemSetting.upsert({
        where: { key: SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue(normalized),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
        create: {
          key: SETTINGS_KEY,
          value: toPrismaJsonValue(normalized),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
      });
    } catch (error) {
      this.logger.error(
        {
          error,
          orgId,
          actorId,
          settingsKey: SETTINGS_KEY,
          ...normalized,
        },
        "Failed to persist multi-tenant scheduler runtime settings",
      );
      throw error;
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "multi_tenant_scheduler_settings_update",
          metadata: toPrismaJsonValue(normalized),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "multi_tenant_scheduler_settings_update",
      },
    );

    this.cachedRuntime = {
      source: "db",
      ...normalized,
    };
    this.cachedRuntimeAt = Date.now();

    return this.cachedRuntime;
  }

  private normalizeStoredSettings(
    value: unknown,
  ): Omit<MultiTenantSchedulerSettingsPublic, "source"> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const record = value as StoredMultiTenantSchedulerSettings;
    const realtimeSignalsOrgConcurrency = this.toStrictOptionalInt(
      record.realtimeSignalsOrgConcurrency,
    );
    const newsEventsTimelineOrgConcurrency = this.toStrictOptionalInt(
      record.newsEventsTimelineOrgConcurrency,
    );
    const newsEventsIngestionOrgConcurrency = this.toStrictOptionalInt(
      record.newsEventsIngestionOrgConcurrency,
    );
    const knowledgeGraphIngestionOrgConcurrency = this.toStrictOptionalInt(
      record.knowledgeGraphIngestionOrgConcurrency,
    );
    const sentimentSnapshotOrgConcurrency = this.toStrictOptionalInt(
      record.sentimentSnapshotOrgConcurrency,
    );
    const newsnowHottestAnalysisOrgConcurrency = this.toStrictOptionalInt(
      record.newsnowHottestAnalysisOrgConcurrency,
    );
    const classificationQualityAlertOrgConcurrency = this.toStrictOptionalInt(
      record.classificationQualityAlertOrgConcurrency,
    );
    const newsIndicatorAssociationOrgConcurrency = this.toStrictOptionalInt(
      record.newsIndicatorAssociationOrgConcurrency,
    );
    const crawlQualityTaskSnapshotOrgConcurrency = this.toStrictOptionalInt(
      record.crawlQualityTaskSnapshotOrgConcurrency,
    );
    const situationMonitorOrefDefaultRuleOrgConcurrency =
      this.toStrictOptionalInt(
        record.situationMonitorOrefDefaultRuleOrgConcurrency,
      );
    const userDigestDeliveryOrgConcurrency = this.toStrictOptionalInt(
      record.userDigestDeliveryOrgConcurrency,
    );

    if (
      realtimeSignalsOrgConcurrency === null ||
      newsEventsTimelineOrgConcurrency === null ||
      newsEventsIngestionOrgConcurrency === null ||
      knowledgeGraphIngestionOrgConcurrency === null ||
      sentimentSnapshotOrgConcurrency === null ||
      newsnowHottestAnalysisOrgConcurrency === null ||
      classificationQualityAlertOrgConcurrency === null ||
      newsIndicatorAssociationOrgConcurrency === null ||
      crawlQualityTaskSnapshotOrgConcurrency === null ||
      situationMonitorOrefDefaultRuleOrgConcurrency === null ||
      userDigestDeliveryOrgConcurrency === null
    ) {
      return null;
    }

    return {
      realtimeSignalsOrgConcurrency:
        realtimeSignalsOrgConcurrency ??
        DEFAULT_SETTINGS.realtimeSignalsOrgConcurrency,
      newsEventsTimelineOrgConcurrency:
        newsEventsTimelineOrgConcurrency ??
        DEFAULT_SETTINGS.newsEventsTimelineOrgConcurrency,
      newsEventsIngestionOrgConcurrency:
        newsEventsIngestionOrgConcurrency ??
        DEFAULT_SETTINGS.newsEventsIngestionOrgConcurrency,
      knowledgeGraphIngestionOrgConcurrency:
        knowledgeGraphIngestionOrgConcurrency ??
        DEFAULT_SETTINGS.knowledgeGraphIngestionOrgConcurrency,
      sentimentSnapshotOrgConcurrency:
        sentimentSnapshotOrgConcurrency ??
        DEFAULT_SETTINGS.sentimentSnapshotOrgConcurrency,
      newsnowHottestAnalysisOrgConcurrency:
        newsnowHottestAnalysisOrgConcurrency ??
        DEFAULT_SETTINGS.newsnowHottestAnalysisOrgConcurrency,
      classificationQualityAlertOrgConcurrency:
        classificationQualityAlertOrgConcurrency ??
        DEFAULT_SETTINGS.classificationQualityAlertOrgConcurrency,
      newsIndicatorAssociationOrgConcurrency:
        newsIndicatorAssociationOrgConcurrency ??
        DEFAULT_SETTINGS.newsIndicatorAssociationOrgConcurrency,
      crawlQualityTaskSnapshotOrgConcurrency:
        crawlQualityTaskSnapshotOrgConcurrency ??
        DEFAULT_SETTINGS.crawlQualityTaskSnapshotOrgConcurrency,
      situationMonitorOrefDefaultRuleOrgConcurrency:
        situationMonitorOrefDefaultRuleOrgConcurrency ??
        DEFAULT_SETTINGS.situationMonitorOrefDefaultRuleOrgConcurrency,
      userDigestDeliveryOrgConcurrency:
        userDigestDeliveryOrgConcurrency ??
        DEFAULT_SETTINGS.userDigestDeliveryOrgConcurrency,
    };
  }

  private normalizeInputOrThrow(input: {
    realtimeSignalsOrgConcurrency?: number;
    newsEventsTimelineOrgConcurrency?: number;
    newsEventsIngestionOrgConcurrency: number;
    knowledgeGraphIngestionOrgConcurrency: number;
    sentimentSnapshotOrgConcurrency: number;
    newsnowHottestAnalysisOrgConcurrency: number;
    classificationQualityAlertOrgConcurrency?: number;
    newsIndicatorAssociationOrgConcurrency?: number;
    crawlQualityTaskSnapshotOrgConcurrency?: number;
    situationMonitorOrefDefaultRuleOrgConcurrency?: number;
    userDigestDeliveryOrgConcurrency: number;
  }): Omit<MultiTenantSchedulerSettingsPublic, "source"> {
    return {
      realtimeSignalsOrgConcurrency:
        input.realtimeSignalsOrgConcurrency === undefined
          ? DEFAULT_SETTINGS.realtimeSignalsOrgConcurrency
          : this.requireConcurrencyOrThrow(
              input.realtimeSignalsOrgConcurrency,
              "realtimeSignalsOrgConcurrency",
            ),
      newsEventsTimelineOrgConcurrency:
        input.newsEventsTimelineOrgConcurrency === undefined
          ? DEFAULT_SETTINGS.newsEventsTimelineOrgConcurrency
          : this.requireConcurrencyOrThrow(
              input.newsEventsTimelineOrgConcurrency,
              "newsEventsTimelineOrgConcurrency",
            ),
      newsEventsIngestionOrgConcurrency: this.requireConcurrencyOrThrow(
        input.newsEventsIngestionOrgConcurrency,
        "newsEventsIngestionOrgConcurrency",
      ),
      knowledgeGraphIngestionOrgConcurrency: this.requireConcurrencyOrThrow(
        input.knowledgeGraphIngestionOrgConcurrency,
        "knowledgeGraphIngestionOrgConcurrency",
      ),
      sentimentSnapshotOrgConcurrency: this.requireConcurrencyOrThrow(
        input.sentimentSnapshotOrgConcurrency,
        "sentimentSnapshotOrgConcurrency",
      ),
      newsnowHottestAnalysisOrgConcurrency: this.requireConcurrencyOrThrow(
        input.newsnowHottestAnalysisOrgConcurrency,
        "newsnowHottestAnalysisOrgConcurrency",
      ),
      classificationQualityAlertOrgConcurrency:
        input.classificationQualityAlertOrgConcurrency === undefined
          ? DEFAULT_SETTINGS.classificationQualityAlertOrgConcurrency
          : this.requireConcurrencyOrThrow(
              input.classificationQualityAlertOrgConcurrency,
              "classificationQualityAlertOrgConcurrency",
            ),
      newsIndicatorAssociationOrgConcurrency:
        input.newsIndicatorAssociationOrgConcurrency === undefined
          ? DEFAULT_SETTINGS.newsIndicatorAssociationOrgConcurrency
          : this.requireConcurrencyOrThrow(
              input.newsIndicatorAssociationOrgConcurrency,
              "newsIndicatorAssociationOrgConcurrency",
            ),
      crawlQualityTaskSnapshotOrgConcurrency:
        input.crawlQualityTaskSnapshotOrgConcurrency === undefined
          ? DEFAULT_SETTINGS.crawlQualityTaskSnapshotOrgConcurrency
          : this.requireConcurrencyOrThrow(
              input.crawlQualityTaskSnapshotOrgConcurrency,
              "crawlQualityTaskSnapshotOrgConcurrency",
            ),
      situationMonitorOrefDefaultRuleOrgConcurrency:
        input.situationMonitorOrefDefaultRuleOrgConcurrency === undefined
          ? DEFAULT_SETTINGS.situationMonitorOrefDefaultRuleOrgConcurrency
          : this.requireConcurrencyOrThrow(
              input.situationMonitorOrefDefaultRuleOrgConcurrency,
              "situationMonitorOrefDefaultRuleOrgConcurrency",
            ),
      userDigestDeliveryOrgConcurrency: this.requireConcurrencyOrThrow(
        input.userDigestDeliveryOrgConcurrency,
        "userDigestDeliveryOrgConcurrency",
      ),
    };
  }

  private requireConcurrencyOrThrow(value: unknown, fieldName: string): number {
    const parsed = this.toStrictOptionalInt(value);
    if (parsed === undefined || parsed === null) {
      throw new BadRequestException(
        `${fieldName} must be an integer between ${CONCURRENCY_MIN} and ${CONCURRENCY_MAX}`,
      );
    }
    return parsed;
  }

  private toStrictOptionalInt(value: unknown): number | null | undefined {
    if (value === undefined) {
      return undefined;
    }

    const parsed = typeof value === "number" ? value : Number(value);
    if (
      !Number.isInteger(parsed) ||
      parsed < CONCURRENCY_MIN ||
      parsed > CONCURRENCY_MAX
    ) {
      return null;
    }

    return parsed;
  }
}
