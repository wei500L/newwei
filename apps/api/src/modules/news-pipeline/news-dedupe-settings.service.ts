import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { NewsPipelineConfigService } from "./news-pipeline.config";
import {
  DEFAULT_NEWS_DEDUPE_PROMPT_VERSION,
  DEFAULT_NEWS_DEDUPE_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_NEWS_DEDUPE_USER_PROMPT_TEMPLATE,
} from "./news-dedupe-llm";

export interface NewsDedupeCategoryThreshold {
  category: string;
  threshold: number;
}

export interface NewsDedupeSettings {
  defaultThreshold: number;
  categoryThresholds: NewsDedupeCategoryThreshold[];
  useEmbeddings: boolean;
  llmJudgeInstructions: string | null;
  llmJudgeModel: string | null;
  llmJudgeMaxComparisons: number;
  llmJudgeCandidateChars: number;
  llmJudgePromptVersion: string;
  llmJudgeSystemPromptTemplate: string;
  llmJudgeUserPromptTemplate: string;
}

export interface NewsDedupeSettingsInput {
  defaultThreshold: number;
  categoryThresholds: NewsDedupeCategoryThreshold[];
  useEmbeddings: boolean;
  llmJudgeInstructions: string | null;
  llmJudgeModel: string | null;
  llmJudgeMaxComparisons: number | null;
  llmJudgeCandidateChars: number | null;
  llmJudgePromptVersion: string | null;
  llmJudgeSystemPromptTemplate: string | null;
  llmJudgeUserPromptTemplate: string | null;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsDedupe:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "news_dedupe_settings:";

const MAX_CATEGORY_THRESHOLDS = 100;
const MAX_CATEGORY_LENGTH = 120;
const MIN_THRESHOLD = 0;
const MAX_THRESHOLD = 1;
const MAX_LLM_JUDGE_INSTRUCTIONS_LENGTH = 2_000;
const MAX_LLM_JUDGE_MODEL_LENGTH = 120;
const DEFAULT_LLM_JUDGE_MAX_COMPARISONS = 12;
const MIN_LLM_JUDGE_MAX_COMPARISONS = 1;
const MAX_LLM_JUDGE_MAX_COMPARISONS = 30;
const DEFAULT_LLM_JUDGE_CANDIDATE_CHARS = 1_200;
const MIN_LLM_JUDGE_CANDIDATE_CHARS = 200;
const MAX_LLM_JUDGE_CANDIDATE_CHARS = 5_000;
const MAX_LLM_JUDGE_PROMPT_VERSION_LENGTH = 80;
const MAX_LLM_JUDGE_PROMPT_TEMPLATE_LENGTH = 12_000;

@Injectable()
export class NewsDedupeSettingsService {
  private readonly logger = createLogger({ name: "news-dedupe-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly pipelineConfig: NewsPipelineConfigService,
  ) {}

  async getSettings(orgId: string): Promise<NewsDedupeSettings> {
    const cacheKey = this.cacheKey(orgId);
    try {
      return await this.cache.wrap(cacheKey, SETTINGS_CACHE_TTL_SECONDS, async () =>
        this.loadSettings(orgId),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news dedupe settings from cache; falling back to database",
      );
    }

    try {
      const settings = await this.loadSettings(orgId);
      try {
        await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
      } catch (cacheError) {
        this.logger.warn(
          { err: cacheError, orgId },
          "Failed to write news dedupe settings to cache",
        );
      }
      return settings;
    } catch (dbError) {
      this.logger.warn(
        { err: dbError, orgId },
        "Failed to load news dedupe settings from database; using defaults",
      );
      return this.getFallbackSettings();
    }
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: NewsDedupeSettingsInput,
  ): Promise<NewsDedupeSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News dedupe settings (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News dedupe settings (org=${orgId})`,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_dedupe_settings_update",
          metadata: toPrismaJsonValue({
            defaultThreshold: normalized.defaultThreshold,
            categories: normalized.categoryThresholds.length,
            useEmbeddings: normalized.useEmbeddings,
            llmJudgeInstructionsConfigured: Boolean(normalized.llmJudgeInstructions),
            llmJudgeModelConfigured: Boolean(normalized.llmJudgeModel),
            llmJudgeMaxComparisons: normalized.llmJudgeMaxComparisons,
            llmJudgeCandidateChars: normalized.llmJudgeCandidateChars,
            llmJudgePromptVersion: normalized.llmJudgePromptVersion,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_dedupe_settings_update",
      },
    );

    try {
      await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error, orgId }, "Failed to write news dedupe settings to cache");
    }

    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  resolveBaseThreshold(
    settings: NewsDedupeSettings,
    options: { category?: string | null; topics?: string[] | null },
  ): { threshold: number; matchedCategory?: string } {
    const map = new Map<string, NewsDedupeCategoryThreshold>();
    for (const entry of settings.categoryThresholds) {
      const key = this.normalizeTopicKey(entry.category);
      if (!key) {
        continue;
      }
      map.set(key, entry);
    }

    const candidates: string[] = [];
    if (typeof options.category === "string" && options.category.trim()) {
      candidates.push(options.category);
    }
    if (Array.isArray(options.topics)) {
      for (const topic of options.topics) {
        if (typeof topic === "string" && topic.trim()) {
          candidates.push(topic);
        }
      }
    }

    let best: NewsDedupeCategoryThreshold | null = null;
    for (const candidate of candidates) {
      const key = this.normalizeTopicKey(candidate);
      if (!key) {
        continue;
      }
      const match = map.get(key);
      if (!match) {
        continue;
      }
      if (!best || match.threshold > best.threshold) {
        best = match;
      }
    }

    return best
      ? { threshold: best.threshold, matchedCategory: best.category }
      : { threshold: settings.defaultThreshold };
  }

  private async loadSettings(orgId: string): Promise<NewsDedupeSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
    });
    const raw = record?.value as Partial<NewsDedupeSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): NewsDedupeSettings {
    return {
      defaultThreshold: this.pipelineConfig.config.pipeline.summaryDedupThreshold,
      categoryThresholds: [],
      useEmbeddings: true,
      llmJudgeInstructions: null,
      llmJudgeModel: null,
      llmJudgeMaxComparisons: DEFAULT_LLM_JUDGE_MAX_COMPARISONS,
      llmJudgeCandidateChars: DEFAULT_LLM_JUDGE_CANDIDATE_CHARS,
      llmJudgePromptVersion: DEFAULT_NEWS_DEDUPE_PROMPT_VERSION,
      llmJudgeSystemPromptTemplate: DEFAULT_NEWS_DEDUPE_SYSTEM_PROMPT_TEMPLATE,
      llmJudgeUserPromptTemplate: DEFAULT_NEWS_DEDUPE_USER_PROMPT_TEMPLATE,
    };
  }

  private normalizeSettings(
    value: Partial<NewsDedupeSettingsInput>,
    fallback?: NewsDedupeSettings,
  ): NewsDedupeSettings {
    const defaults = fallback ?? this.getFallbackSettings();
    const defaultThreshold = this.clampFloat(
      (value as { defaultThreshold?: unknown }).defaultThreshold,
      MIN_THRESHOLD,
      MAX_THRESHOLD,
      defaults.defaultThreshold,
    );
    const useEmbeddings =
      typeof (value as { useEmbeddings?: unknown }).useEmbeddings === "boolean"
        ? Boolean((value as { useEmbeddings?: unknown }).useEmbeddings)
        : defaults.useEmbeddings;
    const llmJudgeInstructions = this.cleanLlmJudgeInstructions(
      (value as { llmJudgeInstructions?: unknown }).llmJudgeInstructions,
    );
    const llmJudgeModel = this.cleanLlmJudgeModel(
      (value as { llmJudgeModel?: unknown }).llmJudgeModel,
    );
    const llmJudgeMaxComparisons = this.clampInt(
      (value as { llmJudgeMaxComparisons?: unknown }).llmJudgeMaxComparisons,
      MIN_LLM_JUDGE_MAX_COMPARISONS,
      MAX_LLM_JUDGE_MAX_COMPARISONS,
      defaults.llmJudgeMaxComparisons,
    );
    const llmJudgeCandidateChars = this.clampInt(
      (value as { llmJudgeCandidateChars?: unknown }).llmJudgeCandidateChars,
      MIN_LLM_JUDGE_CANDIDATE_CHARS,
      MAX_LLM_JUDGE_CANDIDATE_CHARS,
      defaults.llmJudgeCandidateChars,
    );
    const llmJudgePromptVersion =
      this.cleanPromptVersion(
        (value as { llmJudgePromptVersion?: unknown }).llmJudgePromptVersion,
      ) ?? defaults.llmJudgePromptVersion;
    const llmJudgeSystemPromptTemplate =
      this.cleanPromptTemplate(
        (value as { llmJudgeSystemPromptTemplate?: unknown }).llmJudgeSystemPromptTemplate,
      ) ?? defaults.llmJudgeSystemPromptTemplate;
    const llmJudgeUserPromptTemplate =
      this.cleanPromptTemplate(
        (value as { llmJudgeUserPromptTemplate?: unknown }).llmJudgeUserPromptTemplate,
      ) ?? defaults.llmJudgeUserPromptTemplate;

    const rawList = Array.isArray(value.categoryThresholds)
      ? value.categoryThresholds
      : [];
    const normalizedMap = new Map<string, NewsDedupeCategoryThreshold>();

    for (const rawEntry of rawList) {
      const category =
        rawEntry && typeof rawEntry === "object" && "category" in rawEntry
          ? this.cleanCategory((rawEntry as { category?: unknown }).category)
          : null;
      if (!category) {
        continue;
      }

      const thresholdRaw =
        rawEntry && typeof rawEntry === "object" && "threshold" in rawEntry
          ? (rawEntry as { threshold?: unknown }).threshold
          : null;
      const threshold = this.clampFloat(
        thresholdRaw,
        MIN_THRESHOLD,
        MAX_THRESHOLD,
        defaultThreshold,
      );

      const key = this.normalizeTopicKey(category);
      if (!key) {
        continue;
      }
      normalizedMap.set(key, { category, threshold });

      if (normalizedMap.size >= MAX_CATEGORY_THRESHOLDS) {
        break;
      }
    }

    const categoryThresholds = Array.from(normalizedMap.values()).sort((a, b) =>
      a.category.localeCompare(b.category),
    );

    return {
      defaultThreshold,
      categoryThresholds,
      useEmbeddings,
      llmJudgeInstructions,
      llmJudgeModel,
      llmJudgeMaxComparisons,
      llmJudgeCandidateChars,
      llmJudgePromptVersion,
      llmJudgeSystemPromptTemplate,
      llmJudgeUserPromptTemplate,
    };
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cleanCategory(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_CATEGORY_LENGTH ? trimmed.slice(0, MAX_CATEGORY_LENGTH) : trimmed;
  }

  private cleanLlmJudgeInstructions(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_LLM_JUDGE_INSTRUCTIONS_LENGTH
      ? trimmed.slice(0, MAX_LLM_JUDGE_INSTRUCTIONS_LENGTH)
      : trimmed;
  }

  private cleanLlmJudgeModel(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_LLM_JUDGE_MODEL_LENGTH
      ? trimmed.slice(0, MAX_LLM_JUDGE_MODEL_LENGTH)
      : trimmed;
  }

  private cleanPromptVersion(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_LLM_JUDGE_PROMPT_VERSION_LENGTH
      ? trimmed.slice(0, MAX_LLM_JUDGE_PROMPT_VERSION_LENGTH)
      : trimmed;
  }

  private cleanPromptTemplate(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_LLM_JUDGE_PROMPT_TEMPLATE_LENGTH
      ? trimmed.slice(0, MAX_LLM_JUDGE_PROMPT_TEMPLATE_LENGTH)
      : trimmed;
  }

  private normalizeTopicKey(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.replace(/\s+/g, " ").toLowerCase();
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private clampFloat(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
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

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
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
