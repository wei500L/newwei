import { ProcessedItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";

import {
  RssTranslationField,
  RssTranslationProvider,
  TranslateRssItemsInput,
} from "../../graphql/dto/item.input";
import { CacheService } from "../cache/cache.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import { SituationMonitorTranslationService } from "../situation-monitor/situation-monitor-translation.service";
import { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";
import { RssTranslationMetricsService } from "../system-settings/rss-translation-metrics.service";
import {
  SituationMonitorSettingsService,
  type SituationMonitorTranslationRuntimeConfig,
} from "../system-settings/situation-monitor-settings.service";

const logger = createLogger({ name: "items-rss-translation" });

const RSS_TRANSLATION_CACHE_PREFIX = "rss:translation:v1";
const RSS_TRANSLATION_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_TARGET_LANGUAGE = "zh-CN";
const DEFAULT_TRANSLATION_FIELDS: RssTranslationField[] = [
  RssTranslationField.title,
  RssTranslationField.summary,
  RssTranslationField.key_points,
];
const MARKDOWN_CHUNK_MAX_CHARS = 1_600;
const MAX_TRANSLATION_ITEM_IDS = 50;
const MAX_TEXT_CHARS = 12_000;
const MAX_MARKDOWN_CHARS = 120_000;
const MAX_MARKDOWN_CHUNKS = 80;
const DEFAULT_LLM_TRANSLATION_CONCURRENCY = 2;
const MAX_LLM_TRANSLATION_CONCURRENCY = 20;

interface ProcessedTranslationRecord {
  itemMetaId: string;
  result?: unknown;
  createdAt: Date;
}

interface RssTranslationFieldsPayload {
  title?: string;
  summary?: string;
  keyPoints: string[];
  cleanedMarkdown?: string;
}

interface RssTranslationMetricsAccumulator {
  requestCount: number;
  itemCount: number;
  textCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  translatedCount: number;
  failureCount: number;
  skipTooLongCount: number;
}

export interface RssTranslationProviderStatus {
  provider: RssTranslationProvider;
  available: boolean;
  message?: string;
  targetLanguageSupported: boolean;
}

export interface RssItemTranslation {
  itemId: string;
  title?: string;
  summary?: string;
  keyPoints?: string[];
  cleanedMarkdown?: string;
}

export interface TranslateRssItemsResult {
  provider: RssTranslationProvider;
  targetLanguage: string;
  translations: RssItemTranslation[];
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeTargetLanguage(value?: string | null): string {
  const normalized = normalizeNonEmptyString(value);
  return normalized ?? DEFAULT_TARGET_LANGUAGE;
}

function isChineseTargetLanguage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized.startsWith("zh-")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseProcessedResult(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parseProcessedResult(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

class AsyncSemaphore {
  private limit: number;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  setLimit(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.drain();
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}

@Injectable()
export class ItemsRssTranslationService {
  private readonly llmTranslationSemaphore = new AsyncSemaphore(
    DEFAULT_LLM_TRANSLATION_CONCURRENCY,
  );

  constructor(
    private readonly cache: CacheService,
    private readonly situationMonitorTranslation: SituationMonitorTranslationService,
    private readonly situationMonitorSettings: SituationMonitorSettingsService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
    private readonly liteLlm: LiteLlmService,
    @Optional() private readonly metrics?: RssTranslationMetricsService,
  ) {}

  async getProviderStatuses(
    targetLanguage?: string,
  ): Promise<RssTranslationProviderStatus[]> {
    const normalizedTarget = normalizeTargetLanguage(targetLanguage);
    const [deeplxStatus, llmStatus] = await Promise.all([
      this.getDeepLxStatus(normalizedTarget),
      this.getLlmStatus(),
    ]);
    return [deeplxStatus, llmStatus];
  }

  async translate(
    orgId: string,
    input: TranslateRssItemsInput,
  ): Promise<TranslateRssItemsResult> {
    const provider = input.provider ?? RssTranslationProvider.deeplx;
    const targetLanguage = normalizeTargetLanguage(input.targetLanguage);
    const itemIds = this.normalizeItemIds(input.itemIds);
    const fields = this.normalizeFields(input.fields);

    if (itemIds.length === 0 || fields.length === 0) {
      return {
        provider,
        targetLanguage,
        translations: [],
      };
    }

    const metrics = this.createMetricsAccumulator(itemIds.length);
    const startedAt = Date.now();

    try {
      await this.assertProviderAvailable(provider, targetLanguage);

      const llmModel =
        provider === RssTranslationProvider.llm
          ? normalizeNonEmptyString(
              (await this.llmGatewaySettings.getActiveConfig())?.model,
            )
          : undefined;
      const llmConcurrency =
        provider === RssTranslationProvider.llm
          ? await this.resolveConfiguredLlmTranslationConcurrency()
          : undefined;
      if (provider === RssTranslationProvider.llm) {
        this.llmTranslationSemaphore.setLimit(
          llmConcurrency ?? DEFAULT_LLM_TRANSLATION_CONCURRENCY,
        );
      }

      const records = await this.fetchLatestProcessedRecords(orgId, itemIds);
      const translationResults = await Promise.allSettled(
        itemIds.map(async (itemId) => {
          const result = records.get(itemId);
          if (!result) {
            return { itemId };
          }
          return this.translateRecordFields(result, {
            itemId,
            orgId,
            provider,
            targetLanguage,
            llmModel,
            llmConcurrency,
            fields,
            metrics,
          });
        }),
      );
      // Skip rejected items instead of failing the whole batch: a single
      // provider error must not discard translations that already succeeded.
      // Per-item failure is already counted in `metrics.failureCount`.
      const translations = translationResults.flatMap((result) =>
        result.status === "rejected" ? [] : [result.value],
      );

      return {
        provider,
        targetLanguage,
        translations,
      };
    } catch (error) {
      if (metrics.failureCount === 0) {
        metrics.failureCount = 1;
      }
      throw error;
    } finally {
      await this.recordMetricsBestEffort(
        orgId,
        provider,
        targetLanguage,
        metrics,
        Date.now() - startedAt,
      );
    }
  }

  private async getDeepLxStatus(
    targetLanguage: string,
  ): Promise<RssTranslationProviderStatus> {
    if (!isChineseTargetLanguage(targetLanguage)) {
      return {
        provider: RssTranslationProvider.deeplx,
        available: false,
        message:
          "DeepLX API translation currently supports Chinese (zh-CN) target language only.",
        targetLanguageSupported: false,
      };
    }

    const runtime =
      await this.situationMonitorSettings.getTranslationRuntimeConfig();
    const deepLxReady = this.canUseDeepLx(runtime);
    const fallbackReady = this.canUseFallback(runtime);

    if (deepLxReady) {
      return {
        provider: RssTranslationProvider.deeplx,
        available: true,
        targetLanguageSupported: true,
      };
    }

    if (fallbackReady) {
      return {
        provider: RssTranslationProvider.deeplx,
        available: true,
        message:
          "DeepLX primary endpoint is unavailable; fallback translation API is configured and will be used.",
        targetLanguageSupported: true,
      };
    }

    const reasons: string[] = [];
    const deepLxConfigError = this.buildDeepLxConfigError(runtime);
    const fallbackConfigError = this.buildFallbackConfigError(runtime);
    if (deepLxConfigError) {
      reasons.push(deepLxConfigError);
    }
    if (fallbackConfigError) {
      reasons.push(fallbackConfigError);
    }

    return {
      provider: RssTranslationProvider.deeplx,
      available: false,
      message:
        reasons.join(" ") ||
        "DeepLX or fallback translation API is not available in Situation Monitor settings.",
      targetLanguageSupported: true,
    };
  }

  private canUseDeepLx(
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): boolean {
    return Boolean(
      runtime.enabled &&
        normalizeNonEmptyString(runtime.baseUrl) &&
        normalizeNonEmptyString(runtime.apiKey),
    );
  }

  private canUseFallback(
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): boolean {
    return Boolean(
      runtime.fallbackEnabled &&
        normalizeNonEmptyString(runtime.fallbackBaseUrl),
    );
  }

  private buildDeepLxConfigError(
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): string | undefined {
    if (!runtime.enabled) {
      return "DeepLX translation API is disabled in Situation Monitor settings.";
    }
    if (!normalizeNonEmptyString(runtime.baseUrl)) {
      return "DeepLX translation API base URL is not configured.";
    }
    if (!normalizeNonEmptyString(runtime.apiKey)) {
      return "DeepLX translation API key is not configured.";
    }
    return undefined;
  }

  private buildFallbackConfigError(
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): string | undefined {
    if (!runtime.fallbackEnabled) {
      return "Fallback translation API is disabled in Situation Monitor settings.";
    }
    if (!normalizeNonEmptyString(runtime.fallbackBaseUrl)) {
      return "Fallback translation API base URL is not configured.";
    }
    return undefined;
  }

  private toSafeInt(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.max(0, Math.trunc(numeric));
  }

  private createMetricsAccumulator(
    itemCount: number,
  ): RssTranslationMetricsAccumulator {
    return {
      requestCount: 1,
      itemCount: this.toSafeInt(itemCount),
      textCount: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      translatedCount: 0,
      failureCount: 0,
      skipTooLongCount: 0,
    };
  }

  private async recordMetricsBestEffort(
    orgId: string,
    provider: RssTranslationProvider,
    targetLanguage: string,
    metrics: RssTranslationMetricsAccumulator,
    latencyMs: number,
  ) {
    if (!this.metrics) {
      return;
    }

    try {
      await this.metrics.recordDaily({
        orgId,
        provider,
        targetLanguage,
        requestCount: this.toSafeInt(metrics.requestCount),
        itemCount: this.toSafeInt(metrics.itemCount),
        textCount: this.toSafeInt(metrics.textCount),
        cacheHitCount: this.toSafeInt(metrics.cacheHitCount),
        cacheMissCount: this.toSafeInt(metrics.cacheMissCount),
        translatedCount: this.toSafeInt(metrics.translatedCount),
        failureCount: this.toSafeInt(metrics.failureCount),
        skipTooLongCount: this.toSafeInt(metrics.skipTooLongCount),
        totalLatencyMs: this.toSafeInt(latencyMs),
        maxLatencyMs: this.toSafeInt(latencyMs),
      });
    } catch (error) {
      logger.warn(
        { error, orgId, provider, targetLanguage },
        "Failed to record RSS translation metrics",
      );
    }
  }

  private async getLlmStatus(): Promise<RssTranslationProviderStatus> {
    const activeConfig = await this.llmGatewaySettings.getActiveConfig();
    if (!activeConfig) {
      return {
        provider: RssTranslationProvider.llm,
        available: false,
        message: "No enabled LLM gateway profile is active.",
        targetLanguageSupported: true,
      };
    }
    return {
      provider: RssTranslationProvider.llm,
      available: true,
      targetLanguageSupported: true,
    };
  }

  private async assertProviderAvailable(
    provider: RssTranslationProvider,
    targetLanguage: string,
  ) {
    const statuses = await this.getProviderStatuses(targetLanguage);
    const selected = statuses.find((entry) => entry.provider === provider);
    if (selected?.available) {
      return;
    }
    throw new BadRequestException(
      selected?.message ??
        `Translation provider '${provider}' is currently unavailable.`,
    );
  }

  private async fetchLatestProcessedRecords(
    orgId: string,
    itemIds: string[],
  ): Promise<Map<string, RssTranslationFieldsPayload>> {
    const records = (await ProcessedItemModel.find(
      {
        orgId,
        status: "completed",
        itemMetaId: { $in: itemIds },
      },
      {
        itemMetaId: 1,
        result: 1,
        createdAt: 1,
      },
    )
      .sort({ createdAt: -1 })
      .lean()) as unknown as ProcessedTranslationRecord[];

    const latest = new Map<string, RssTranslationFieldsPayload>();
    for (const record of records) {
      if (!record?.itemMetaId || latest.has(record.itemMetaId)) {
        continue;
      }
      const parsed = parseProcessedResult(record.result);
      if (!parsed) {
        latest.set(record.itemMetaId, { keyPoints: [] });
        continue;
      }
      latest.set(record.itemMetaId, {
        title:
          normalizeNonEmptyString(parsed.title) ??
          normalizeNonEmptyString(parsed.headline),
        summary:
          normalizeNonEmptyString(parsed.summary) ??
          normalizeNonEmptyString(parsed.abstract),
        keyPoints: normalizeStringList(parsed.key_points),
        cleanedMarkdown: normalizeNonEmptyString(parsed.cleaned_markdown),
      });
    }

    return latest;
  }

  private normalizeItemIds(itemIds: string[]): string[] {
    const normalized = itemIds
      .map((itemId) => itemId.trim())
      .filter((itemId) => itemId.length > 0);
    const deduplicated = Array.from(new Set(normalized));
    if (deduplicated.length > MAX_TRANSLATION_ITEM_IDS) {
      throw new BadRequestException(
        `RSS translation accepts at most ${MAX_TRANSLATION_ITEM_IDS} itemIds per request.`,
      );
    }
    return deduplicated;
  }

  private normalizeFields(
    fields?: RssTranslationField[],
  ): RssTranslationField[] {
    const source =
      fields && fields.length > 0 ? fields : DEFAULT_TRANSLATION_FIELDS;
    return Array.from(new Set(source));
  }

  private async translateRecordFields(
    payload: RssTranslationFieldsPayload,
    options: {
      itemId: string;
      orgId: string;
      provider: RssTranslationProvider;
      targetLanguage: string;
      llmModel?: string;
      llmConcurrency?: number;
      fields: RssTranslationField[];
      metrics: RssTranslationMetricsAccumulator;
    },
  ): Promise<RssItemTranslation> {
    const translated: RssItemTranslation = { itemId: options.itemId };

    if (options.fields.includes(RssTranslationField.title) && payload.title) {
      translated.title = await this.translateText(payload.title, options);
    }

    if (
      options.fields.includes(RssTranslationField.summary) &&
      payload.summary
    ) {
      translated.summary = await this.translateText(payload.summary, options);
    }

    if (
      options.fields.includes(RssTranslationField.key_points) &&
      payload.keyPoints.length > 0
    ) {
      translated.keyPoints = await this.translateTextList(
        payload.keyPoints,
        options,
      );
    }

    if (
      options.fields.includes(RssTranslationField.cleaned_markdown) &&
      payload.cleanedMarkdown
    ) {
      translated.cleanedMarkdown = await this.translateMarkdown(
        payload.cleanedMarkdown,
        options,
      );
    }

    return translated;
  }

  private async translateMarkdown(
    markdown: string,
    options: {
      orgId: string;
      provider: RssTranslationProvider;
      targetLanguage: string;
      llmModel?: string;
      llmConcurrency?: number;
      metrics: RssTranslationMetricsAccumulator;
    },
  ): Promise<string> {
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      options.metrics.skipTooLongCount += 1;
      return markdown;
    }
    const chunks = this.splitMarkdownIntoChunks(markdown);
    if (chunks.length > MAX_MARKDOWN_CHUNKS) {
      options.metrics.skipTooLongCount += 1;
      return markdown;
    }
    const translated = await this.translateTextList(chunks, options);
    return translated.join("\n\n").trim();
  }

  private splitMarkdownIntoChunks(markdown: string): string[] {
    const paragraphs = markdown
      .split(/\n{2,}/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (paragraphs.length === 0) {
      return [markdown];
    }

    const chunks: string[] = [];
    let current = "";

    const flushCurrent = () => {
      const normalized = current.trim();
      if (normalized.length > 0) {
        chunks.push(normalized);
      }
      current = "";
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length > MARKDOWN_CHUNK_MAX_CHARS) {
        flushCurrent();
        this.splitLongChunk(paragraph).forEach((entry) => {
          if (entry.length > 0) {
            chunks.push(entry);
          }
        });
        continue;
      }

      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (candidate.length > MARKDOWN_CHUNK_MAX_CHARS) {
        flushCurrent();
        current = paragraph;
      } else {
        current = candidate;
      }
    }

    flushCurrent();
    return chunks.length > 0 ? chunks : [markdown];
  }

  private splitLongChunk(text: string): string[] {
    const parts = text
      .split(/\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (parts.length === 0) {
      return [text];
    }

    const chunks: string[] = [];
    let current = "";
    for (const part of parts) {
      if (part.length > MARKDOWN_CHUNK_MAX_CHARS) {
        if (current.trim().length > 0) {
          chunks.push(current.trim());
          current = "";
        }
        for (
          let index = 0;
          index < part.length;
          index += MARKDOWN_CHUNK_MAX_CHARS
        ) {
          chunks.push(
            part.slice(index, index + MARKDOWN_CHUNK_MAX_CHARS).trim(),
          );
        }
        continue;
      }

      const candidate = current ? `${current}\n${part}` : part;
      if (candidate.length > MARKDOWN_CHUNK_MAX_CHARS) {
        if (current.trim().length > 0) {
          chunks.push(current.trim());
        }
        current = part;
      } else {
        current = candidate;
      }
    }

    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  private async translateText(
    text: string,
    options: {
      orgId: string;
      provider: RssTranslationProvider;
      targetLanguage: string;
      llmModel?: string;
      llmConcurrency?: number;
      metrics: RssTranslationMetricsAccumulator;
    },
  ): Promise<string> {
    const [translated] = await this.translateTextList([text], options);
    return translated ?? text;
  }

  private async translateTextList(
    texts: string[],
    options: {
      orgId: string;
      provider: RssTranslationProvider;
      targetLanguage: string;
      llmModel?: string;
      llmConcurrency?: number;
      metrics: RssTranslationMetricsAccumulator;
    },
  ): Promise<string[]> {
    const normalizedInputs = texts
      .map((text) => normalizeNonEmptyString(text))
      .filter((text): text is string => Boolean(text));

    if (normalizedInputs.length === 0) {
      return [];
    }

    options.metrics.textCount += normalizedInputs.length;
    const translatedByText = new Map<string, string>();
    const inputsForTranslation: string[] = [];
    normalizedInputs.forEach((text) => {
      if (text.length <= MAX_TEXT_CHARS) {
        inputsForTranslation.push(text);
        return;
      }
      options.metrics.skipTooLongCount += 1;
      translatedByText.set(text, text);
    });

    if (inputsForTranslation.length === 0) {
      return normalizedInputs.map((text) => translatedByText.get(text) ?? text);
    }

    const uniqueInputs = Array.from(new Set(inputsForTranslation));
    const cacheKeys = uniqueInputs.map((text) =>
      this.buildCacheKey(
        options.provider,
        options.targetLanguage,
        text,
        options.llmModel,
      ),
    );
    const cached = await this.cache.getMany<string>(cacheKeys);
    const missingTexts: string[] = [];

    uniqueInputs.forEach((text, index) => {
      const cachedValue = normalizeNonEmptyString(cached[index]);
      if (cachedValue) {
        options.metrics.cacheHitCount += 1;
        translatedByText.set(text, cachedValue);
      } else {
        options.metrics.cacheMissCount += 1;
        missingTexts.push(text);
      }
    });

    if (missingTexts.length > 0) {
      const translatedMissing =
        options.provider === RssTranslationProvider.deeplx
          ? await this.translateMissingViaDeepLx(missingTexts)
          : await this.translateMissingViaLlm(
              missingTexts,
              options.targetLanguage,
              options.llmModel,
              options.llmConcurrency,
              options.orgId,
            );

      await Promise.all(
        missingTexts.map(async (text) => {
          const translated = normalizeNonEmptyString(
            translatedMissing.get(text),
          );
          if (!translated) {
            // Best-effort: don't cache failures, so a later request can retry.
            options.metrics.failureCount += 1;
            translatedByText.set(text, text);
            return;
          }

          options.metrics.translatedCount += 1;
          translatedByText.set(text, translated);
          await this.cache.set(
            this.buildCacheKey(
              options.provider,
              options.targetLanguage,
              text,
              options.llmModel,
            ),
            translated,
            RSS_TRANSLATION_CACHE_TTL_SECONDS,
          );
        }),
      );
    }

    return normalizedInputs.map((text) => translatedByText.get(text) ?? text);
  }

  private async translateMissingViaDeepLx(
    texts: string[],
  ): Promise<Map<string, string>> {
    const translated =
      await this.situationMonitorTranslation.translateTextsToZhBestEffort(
        texts,
      );
    const mapped = new Map<string, string>();
    texts.forEach((text) => {
      const value = normalizeNonEmptyString(translated.get(text));
      if (value) {
        mapped.set(text, value);
      }
    });
    return mapped;
  }

  private async translateMissingViaLlm(
    texts: string[],
    targetLanguage: string,
    llmModel?: string,
    configuredConcurrency?: number,
    orgId?: string,
  ): Promise<Map<string, string>> {
    const mapped = new Map<string, string>();
    this.llmTranslationSemaphore.setLimit(
      this.normalizeConfiguredLlmTranslationConcurrency(configuredConcurrency),
    );

    await Promise.all(
      texts.map(async (text) => {
        if (!text) {
          return;
        }
        try {
          const translated = await this.translateSingleTextViaLlm(
            text,
            targetLanguage,
            llmModel,
            orgId,
          );
          mapped.set(text, translated);
        } catch (error) {
          logger.warn(
            {
              error,
              provider: "llm",
              targetLanguage,
              preview: text.slice(0, 120),
            },
            "Failed to translate RSS text via LLM; using original text",
          );
        }
      }),
    );
    return mapped;
  }

  private async resolveConfiguredLlmTranslationConcurrency(): Promise<number> {
    try {
      const configured =
        await this.situationMonitorSettings.getTranslationMaxConcurrency();
      return this.normalizeConfiguredLlmTranslationConcurrency(configured);
    } catch (error) {
      logger.warn(
        { error },
        "Failed to load Situation Monitor translation max concurrency; using default for RSS LLM translation",
      );
      return DEFAULT_LLM_TRANSLATION_CONCURRENCY;
    }
  }

  private normalizeConfiguredLlmTranslationConcurrency(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_LLM_TRANSLATION_CONCURRENCY;
    }
    return Math.max(
      1,
      Math.min(MAX_LLM_TRANSLATION_CONCURRENCY, Math.trunc(numeric)),
    );
  }

  private async translateSingleTextViaLlm(
    text: string,
    targetLanguage: string,
    llmModel?: string,
    orgId?: string,
  ): Promise<string> {
    const response = await this.llmTranslationSemaphore.withPermit(() =>
      this.liteLlm.acompletion({
        orgId,
        model: llmModel,
        messages: [
          {
            role: "system",
            content:
              "You are a professional translation engine. Translate accurately, preserve markdown structure, links, numbers, and named entities. Return only the translated text without commentary.",
          },
          {
            role: "user",
            content: [
              `Target language: ${targetLanguage}`,
              "If the source text is already in target language, return the original text.",
              "Text:",
              text,
            ].join("\n"),
          },
        ],
        temperature: 0,
        max_tokens: Math.max(
          512,
          Math.min(4_000, Math.ceil(text.length * 1.6)),
        ),
        metadata: {
          source: "rss_translation",
          targetLanguage,
        },
        maxRetries: 1,
      }),
    );

    const content = normalizeNonEmptyString(
      response.choices?.[0]?.message?.content,
    );
    if (!content) {
      throw new Error("LLM translation response is empty");
    }
    return content;
  }

  private buildCacheKey(
    provider: RssTranslationProvider,
    targetLanguage: string,
    text: string,
    llmModel?: string,
  ): string {
    const language = targetLanguage.trim().toLowerCase();
    const providerKey =
      provider === RssTranslationProvider.llm
        ? `llm:${(llmModel ?? "default").trim().toLowerCase()}`
        : "deeplx";
    return `${RSS_TRANSLATION_CACHE_PREFIX}:${providerKey}:${language}:${sha256(text)}`;
  }
}
