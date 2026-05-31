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
  newsEventsIngestionOrgConcurrency: number;
  knowledgeGraphIngestionOrgConcurrency: number;
  sentimentSnapshotOrgConcurrency: number;
  newsnowHottestAnalysisOrgConcurrency: number;
  classificationQualityAlertOrgConcurrency: number;
  userDigestDeliveryOrgConcurrency: number;
}

interface StoredMultiTenantSchedulerSettings {
  newsEventsIngestionOrgConcurrency?: unknown;
  knowledgeGraphIngestionOrgConcurrency?: unknown;
  sentimentSnapshotOrgConcurrency?: unknown;
  newsnowHottestAnalysisOrgConcurrency?: unknown;
  classificationQualityAlertOrgConcurrency?: unknown;
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
  "newsEventsIngestionOrgConcurrency, knowledgeGraphIngestionOrgConcurrency, sentimentSnapshotOrgConcurrency, newsnowHottestAnalysisOrgConcurrency, classificationQualityAlertOrgConcurrency, and userDigestDeliveryOrgConcurrency must be integers between 1 and 16.";

const DEFAULT_SETTINGS: Omit<MultiTenantSchedulerSettingsPublic, "source"> = {
  newsEventsIngestionOrgConcurrency: 4,
  knowledgeGraphIngestionOrgConcurrency: 4,
  sentimentSnapshotOrgConcurrency: 2,
  newsnowHottestAnalysisOrgConcurrency: 6,
  classificationQualityAlertOrgConcurrency: 4,
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
      newsEventsIngestionOrgConcurrency: number;
      knowledgeGraphIngestionOrgConcurrency: number;
      sentimentSnapshotOrgConcurrency: number;
      newsnowHottestAnalysisOrgConcurrency: number;
      classificationQualityAlertOrgConcurrency?: number;
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
    const userDigestDeliveryOrgConcurrency = this.toStrictOptionalInt(
      record.userDigestDeliveryOrgConcurrency,
    );

    if (
      newsEventsIngestionOrgConcurrency === null ||
      knowledgeGraphIngestionOrgConcurrency === null ||
      sentimentSnapshotOrgConcurrency === null ||
      newsnowHottestAnalysisOrgConcurrency === null ||
      classificationQualityAlertOrgConcurrency === null ||
      userDigestDeliveryOrgConcurrency === null
    ) {
      return null;
    }

    return {
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
      userDigestDeliveryOrgConcurrency:
        userDigestDeliveryOrgConcurrency ??
        DEFAULT_SETTINGS.userDigestDeliveryOrgConcurrency,
    };
  }

  private normalizeInputOrThrow(input: {
    newsEventsIngestionOrgConcurrency: number;
    knowledgeGraphIngestionOrgConcurrency: number;
    sentimentSnapshotOrgConcurrency: number;
    newsnowHottestAnalysisOrgConcurrency: number;
    classificationQualityAlertOrgConcurrency?: number;
    userDigestDeliveryOrgConcurrency: number;
  }): Omit<MultiTenantSchedulerSettingsPublic, "source"> {
    return {
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
