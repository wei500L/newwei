import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export enum NewsExtractionPipelineMode {
  legacy = "legacy",
  staged = "staged",
}

export enum NewsExtractionProviderId {
  llm = "llm",
  external_http = "external_http",
}

export interface NewsExtractionPreflightGateSettings {
  enabled: boolean;
  minWordCount: number;
  rejectBotChallenge: boolean;
  rejectListLike: boolean;
}

export interface NewsExtractionPostCleanGateSettings {
  enabled: boolean;
  minQualityScore: number;
  minCleanedChars: number;
  requireSummary: boolean;
}

export interface NewsExtractionCapabilitiesSettings {
  entities: boolean;
  sentiment: boolean;
  kg: boolean;
}

export interface NewsExtractionProvidersSettings {
  clean: NewsExtractionProviderId;
  entities: NewsExtractionProviderId;
  sentiment: NewsExtractionProviderId;
  kg: NewsExtractionProviderId;
}

export interface NewsExtractionSettings {
  pipelineMode: NewsExtractionPipelineMode;
  preflightGate: NewsExtractionPreflightGateSettings;
  postCleanGate: NewsExtractionPostCleanGateSettings;
  capabilities: NewsExtractionCapabilitiesSettings;
  providers: NewsExtractionProvidersSettings;
}

export interface NewsExtractionSettingsInput {
  pipelineMode?: NewsExtractionPipelineMode | null;
  preflightGate?: Partial<NewsExtractionPreflightGateSettings> | null;
  postCleanGate?: Partial<NewsExtractionPostCleanGateSettings> | null;
  capabilities?: Partial<NewsExtractionCapabilitiesSettings> | null;
  providers?: Partial<NewsExtractionProvidersSettings> | null;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsExtraction:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "news_extraction_settings:";
const MIN_WORD_COUNT = 0;
const MAX_WORD_COUNT = 10_000;
const MIN_CLEANED_CHARS = 0;
const MAX_CLEANED_CHARS = 100_000;
const MIN_SCORE = 0;
const MAX_SCORE = 1;

@Injectable()
export class NewsExtractionSettingsService {
  private readonly logger = createLogger({ name: "news-extraction-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getSettings(orgId: string): Promise<NewsExtractionSettings> {
    const cacheKey = this.cacheKey(orgId);
    try {
      return await this.cache.wrap(cacheKey, SETTINGS_CACHE_TTL_SECONDS, async () =>
        this.loadSettings(orgId),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news extraction settings from cache; falling back to database",
      );
    }

    try {
      const settings = await this.loadSettings(orgId);
      try {
        await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
      } catch (cacheError) {
        this.logger.warn(
          { err: cacheError, orgId },
          "Failed to write news extraction settings to cache",
        );
      }
      return settings;
    } catch (dbError) {
      this.logger.warn(
        { err: dbError, orgId },
        "Failed to load news extraction settings from database; using defaults",
      );
      return this.getFallbackSettings();
    }
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: NewsExtractionSettingsInput,
  ): Promise<NewsExtractionSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News extraction settings (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News extraction settings (org=${orgId})`,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_extraction_settings_update",
          metadata: toPrismaJsonValue(normalized),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_extraction_settings_update",
      },
    );

    try {
      await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write news extraction settings to cache",
      );
    }

    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<NewsExtractionSettings> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
    });
    const raw = record?.value as NewsExtractionSettingsInput | undefined;
    return this.normalizeSettings(raw ?? {});
  }

  private getFallbackSettings(): NewsExtractionSettings {
    return {
      pipelineMode: NewsExtractionPipelineMode.staged,
      preflightGate: {
        enabled: true,
        minWordCount: 120,
        rejectBotChallenge: true,
        rejectListLike: true,
      },
      postCleanGate: {
        enabled: true,
        minQualityScore: 0.35,
        minCleanedChars: 400,
        requireSummary: true,
      },
      capabilities: {
        entities: true,
        sentiment: true,
        kg: true,
      },
      providers: {
        clean: NewsExtractionProviderId.llm,
        entities: NewsExtractionProviderId.llm,
        sentiment: NewsExtractionProviderId.llm,
        kg: NewsExtractionProviderId.llm,
      },
    };
  }

  private normalizeSettings(
    value: NewsExtractionSettingsInput,
  ): NewsExtractionSettings {
    const defaults = this.getFallbackSettings();
    return {
      pipelineMode: this.normalizePipelineMode(
        value.pipelineMode,
        defaults.pipelineMode,
      ),
      preflightGate: {
        enabled:
          typeof value.preflightGate?.enabled === "boolean"
            ? value.preflightGate.enabled
            : defaults.preflightGate.enabled,
        minWordCount: this.clampInt(
          value.preflightGate?.minWordCount,
          MIN_WORD_COUNT,
          MAX_WORD_COUNT,
          defaults.preflightGate.minWordCount,
        ),
        rejectBotChallenge:
          typeof value.preflightGate?.rejectBotChallenge === "boolean"
            ? value.preflightGate.rejectBotChallenge
            : defaults.preflightGate.rejectBotChallenge,
        rejectListLike:
          typeof value.preflightGate?.rejectListLike === "boolean"
            ? value.preflightGate.rejectListLike
            : defaults.preflightGate.rejectListLike,
      },
      postCleanGate: {
        enabled:
          typeof value.postCleanGate?.enabled === "boolean"
            ? value.postCleanGate.enabled
            : defaults.postCleanGate.enabled,
        minQualityScore: this.clampFloat(
          value.postCleanGate?.minQualityScore,
          MIN_SCORE,
          MAX_SCORE,
          defaults.postCleanGate.minQualityScore,
        ),
        minCleanedChars: this.clampInt(
          value.postCleanGate?.minCleanedChars,
          MIN_CLEANED_CHARS,
          MAX_CLEANED_CHARS,
          defaults.postCleanGate.minCleanedChars,
        ),
        requireSummary:
          typeof value.postCleanGate?.requireSummary === "boolean"
            ? value.postCleanGate.requireSummary
            : defaults.postCleanGate.requireSummary,
      },
      capabilities: {
        entities:
          typeof value.capabilities?.entities === "boolean"
            ? value.capabilities.entities
            : defaults.capabilities.entities,
        sentiment:
          typeof value.capabilities?.sentiment === "boolean"
            ? value.capabilities.sentiment
            : defaults.capabilities.sentiment,
        kg:
          typeof value.capabilities?.kg === "boolean"
            ? value.capabilities.kg
            : defaults.capabilities.kg,
      },
      providers: {
        clean: this.normalizeProviderId(
          value.providers?.clean,
          defaults.providers.clean,
        ),
        entities: this.normalizeProviderId(
          value.providers?.entities,
          defaults.providers.entities,
        ),
        sentiment: this.normalizeProviderId(
          value.providers?.sentiment,
          defaults.providers.sentiment,
        ),
        kg: this.normalizeProviderId(
          value.providers?.kg,
          defaults.providers.kg,
        ),
      },
    };
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private normalizePipelineMode(
    value: unknown,
    fallback: NewsExtractionPipelineMode,
  ): NewsExtractionPipelineMode {
    return value === NewsExtractionPipelineMode.staged
      ? NewsExtractionPipelineMode.staged
      : value === NewsExtractionPipelineMode.legacy
        ? NewsExtractionPipelineMode.legacy
        : fallback;
  }

  private normalizeProviderId(
    value: unknown,
    fallback: NewsExtractionProviderId,
  ): NewsExtractionProviderId {
    return value === NewsExtractionProviderId.external_http
      ? NewsExtractionProviderId.external_http
      : value === NewsExtractionProviderId.llm
        ? NewsExtractionProviderId.llm
        : fallback;
  }

  private clampFloat(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ) {
    const numeric =
      typeof value === "number" && Number.isFinite(value) ? value : null;
    if (numeric === null) {
      return fallback;
    }
    if (numeric < min) {
      return min;
    }
    if (numeric > max) {
      return max;
    }
    return numeric;
  }

  private clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ) {
    const numeric =
      typeof value === "number" && Number.isFinite(value) ? value : null;
    if (numeric === null) {
      return fallback;
    }
    const rounded = Math.round(numeric);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }
}
