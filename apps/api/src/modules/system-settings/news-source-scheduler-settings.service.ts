import { createLogger } from "@modular/utils";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

export type NewsSourceSchedulerSettingsSource = "default" | "db";

export interface NewsSourceSchedulerSettingsPublic {
  source: NewsSourceSchedulerSettingsSource;
  seedFreshnessWindowDays: number;
}

interface StoredNewsSourceSchedulerSettings {
  seedFreshnessWindowDays?: unknown;
}

const SETTINGS_KEY = "news_source_scheduler_settings";
const SETTINGS_DESCRIPTION =
  "News source scheduler runtime settings (seed freshness window)";
const DEFAULT_SEED_FRESHNESS_WINDOW_DAYS = 365;
const MIN_SEED_FRESHNESS_WINDOW_DAYS = 1;
const MAX_SEED_FRESHNESS_WINDOW_DAYS = 3_650;
const INVALID_PERSISTED_SETTINGS_CODE = "NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID";
const INVALID_PERSISTED_SETTINGS_ERROR =
  "Stored news source scheduler settings are invalid.";
const INVALID_PERSISTED_SETTINGS_DETAIL =
  "seedFreshnessWindowDays must be an integer between 1 and 3650.";

@Injectable()
export class NewsSourceSchedulerSettingsService {
  private readonly logger = createLogger({ name: "news-source-scheduler-settings" });

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<NewsSourceSchedulerSettingsPublic> {
    let record: { value: unknown } | null = null;
    try {
      record = await this.prisma.systemSetting.findUnique({
        where: { key: SETTINGS_KEY },
        select: { value: true },
      });
    } catch (error) {
      this.logger.error(
        { error, settingsKey: SETTINGS_KEY },
        "Failed to load news source scheduler settings",
      );
      throw error;
    }

    if (!record) {
      return {
        source: "default",
        seedFreshnessWindowDays: DEFAULT_SEED_FRESHNESS_WINDOW_DAYS,
      };
    }

    const value = (record.value as StoredNewsSourceSchedulerSettings | null) ?? {};
    const parsed = this.toStrictSeedFreshnessWindowDays(
      value.seedFreshnessWindowDays,
    );
    if (parsed === null) {
      this.logger.error(
        {
          settingsKey: SETTINGS_KEY,
          storedSeedFreshnessWindowDays: value.seedFreshnessWindowDays,
        },
        "Invalid persisted news source scheduler settings value",
      );
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: INVALID_PERSISTED_SETTINGS_DETAIL,
      });
    }

    return {
      source: "db",
      seedFreshnessWindowDays: parsed,
    };
  }

  async getSeedFreshnessWindowDays(): Promise<number> {
    const settings = await this.getSettings();
    return settings.seedFreshnessWindowDays;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { seedFreshnessWindowDays: number },
  ): Promise<NewsSourceSchedulerSettingsPublic> {
    const normalizedSeedFreshnessWindowDays = this.toStrictSeedFreshnessWindowDays(
      input.seedFreshnessWindowDays,
    );
    if (normalizedSeedFreshnessWindowDays === null) {
      throw new BadRequestException(
        `seedFreshnessWindowDays must be an integer between ${MIN_SEED_FRESHNESS_WINDOW_DAYS} and ${MAX_SEED_FRESHNESS_WINDOW_DAYS}`,
      );
    }

    try {
      await this.prisma.systemSetting.upsert({
        where: { key: SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue({
            seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
          }),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
        create: {
          key: SETTINGS_KEY,
          value: toPrismaJsonValue({
            seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
          }),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
      });
    } catch (error) {
      this.logger.error(
        { error, orgId, actorId, settingsKey: SETTINGS_KEY, seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays },
        "Failed to persist news source scheduler settings",
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
          action: "news_source_scheduler_settings_update",
          metadata: toPrismaJsonValue({
            seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_source_scheduler_settings_update",
      },
    );

    return {
      source: "db",
      seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
    };
  }

  private toStrictSeedFreshnessWindowDays(value: unknown): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_SEED_FRESHNESS_WINDOW_DAYS ||
      parsed > MAX_SEED_FRESHNESS_WINDOW_DAYS
    ) {
      return null;
    }
    return parsed;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }
}
