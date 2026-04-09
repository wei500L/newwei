import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import axios from "axios";
import { createHash } from "node:crypto";

import { CacheService } from "../cache/cache.service";
import {
  SituationMonitorSettingsService,
  type SituationMonitorTranslationRuntimeConfig,
} from "../system-settings/situation-monitor-settings.service";

import type { SituationMonitorInsightsResponse } from "./situation-monitor.service";
import type { SituationMonitorHeadline, SituationMonitorFedNewsItem } from "./situation-monitor.types";

const logger = createLogger({ name: "situation-monitor-translation" });

const TRANSLATION_CACHE_KEY_PREFIX = "situation-monitor:translation:v3:zh-cn:multi";
const TRANSLATION_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 2;
const DEFAULT_TRANSLATION_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSLATION_MAX_RETRIES = 2;
const RETRY_BACKOFF_BASE_MS = 300;
type FallbackSourceLang = "zh-CN" | "en" | "ja" | "ko" | "fr" | "de";

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
export class SituationMonitorTranslationService {
  private readonly semaphore = new AsyncSemaphore(DEFAULT_TRANSLATION_MAX_CONCURRENCY);

  constructor(
    private readonly cache: CacheService,
    private readonly settings: SituationMonitorSettingsService,
  ) {}

  async applyZhTranslationsBestEffort(
    insights: SituationMonitorInsightsResponse,
  ): Promise<{ applied: boolean; error?: string }> {
    const targets = this.collectTranslationTargets(insights);
    if (targets.size === 0) {
      return { applied: true };
    }

    try {
      const runtime = await this.settings.getTranslationRuntimeConfig();
      this.semaphore.setLimit(runtime.maxConcurrency);
      this.assertRuntimeConfig(runtime);

      const translated = await this.translateHashesToZh(targets, runtime);
      this.applyTranslationMap(insights, translated);
      return { applied: true };
    } catch (error) {
      logger.warn(
        {
          error,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Failed to apply zh-CN translations for situation monitor (best-effort)",
      );
      return {
        applied: false,
        error: error instanceof Error ? error.message : "Failed to translate via translation APIs.",
      };
    }
  }

  async translateTextsToZhBestEffort(texts: Iterable<string>): Promise<Map<string, string>> {
    const targets = new Map<string, string>();
    for (const text of texts) {
      const normalized = normalizeText(text);
      if (!normalized) {
        continue;
      }
      targets.set(sha256(normalized), normalized);
    }

    if (targets.size === 0) {
      return new Map();
    }

    try {
      const runtime = await this.settings.getTranslationRuntimeConfig();
      this.semaphore.setLimit(runtime.maxConcurrency);
      this.assertRuntimeConfig(runtime);

      const translatedByHash = await this.translateHashesToZh(targets, runtime);
      const translatedByText = new Map<string, string>();
      for (const [hash, original] of targets.entries()) {
        const translated = translatedByHash.get(hash);
        if (translated) {
          translatedByText.set(original, translated);
        }
      }
      return translatedByText;
    } catch (error) {
      logger.warn(
        {
          error,
          count: targets.size,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Failed to translate texts to zh-CN for situation monitor (best-effort)",
      );
      return new Map();
    }
  }

  private collectTranslationTargets(insights: SituationMonitorInsightsResponse): Map<string, string> {
    const targets = new Map<string, string>();

    const collect = (text: unknown) => {
      const normalized = normalizeText(text);
      if (!normalized) {
        return;
      }
      targets.set(sha256(normalized), normalized);
    };

    if (insights.headlines) {
      for (const list of Object.values(insights.headlines)) {
        for (const entry of list) {
          collect(entry.title);
          collect(entry.summary);
          if (Array.isArray(entry.keyPoints)) {
            for (const point of entry.keyPoints) {
              collect(point);
            }
          }
        }
      }
    }

    if (insights.clusters) {
      for (const list of Object.values(insights.clusters)) {
        for (const cluster of list) {
          collect(cluster.lead.title);
          collect(cluster.lead.summary);
          if (Array.isArray(cluster.lead.keyPoints)) {
            for (const point of cluster.lead.keyPoints) {
              collect(point);
            }
          }
          for (const entry of cluster.items ?? []) {
            collect(entry.title);
            collect(entry.summary);
            if (Array.isArray(entry.keyPoints)) {
              for (const point of entry.keyPoints) {
                collect(point);
              }
            }
          }
        }
      }
    }

    if (Array.isArray(insights.alerts)) {
      for (const entry of insights.alerts) {
        collect(entry.title);
        collect(entry.summary);
        if (Array.isArray(entry.keyPoints)) {
          for (const point of entry.keyPoints) {
            collect(point);
          }
        }
      }
    }

    if (Array.isArray(insights.leaders)) {
      for (const leader of insights.leaders) {
        for (const entry of leader.headlines ?? []) {
          collect(entry.title);
        }
      }
    }

    if (Array.isArray(insights.situations)) {
      for (const panel of insights.situations) {
        collect(panel.title);
        collect(panel.subtitle);
        for (const entry of panel.headlines ?? []) {
          collect(entry.title);
        }
      }
    }

    if (insights.fed?.news) {
      for (const entry of insights.fed.news) {
        collect(entry.title);
        collect(entry.description);
        collect(entry.typeLabel);
      }
    }

    if (insights.correlation) {
      const correlation = insights.correlation;
      for (const entry of correlation.emergingPatterns ?? []) {
        collect(entry.name);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.momentumSignals ?? []) {
        collect(entry.name);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.crossSourceCorrelations ?? []) {
        collect(entry.name);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
      for (const entry of correlation.predictiveSignals ?? []) {
        collect(entry.name);
        collect(entry.prediction);
        for (const headline of entry.headlines ?? []) {
          collect(headline.title);
        }
      }
    }

    if (insights.correlationSummary) {
      collect(insights.correlationSummary.status);
    }

    if (insights.narrative) {
      const narrative = insights.narrative;
      const buckets = [
        narrative.emergingFringe,
        narrative.fringeToMainstream,
        narrative.narrativeWatch,
        narrative.disinfoSignals,
      ];
      for (const list of buckets) {
        for (const entry of list ?? []) {
          collect(entry.name);
          for (const headline of entry.headlines ?? []) {
            collect(headline.title);
          }
        }
      }
    }

    if (insights.narrativeSummary) {
      collect(insights.narrativeSummary.status);
    }

    if (insights.mainCharacterSummary) {
      collect(insights.mainCharacterSummary.status);
    }

    return targets;
  }

  private async translateHashesToZh(
    targets: Map<string, string>,
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): Promise<Map<string, string>> {
    const translated = new Map<string, string>();
    const missing: { id: string; text: string }[] = [];

    for (const [hash, text] of targets.entries()) {
      const cached = await this.cache.get<string>(this.translationCacheKey(hash));
      if (cached) {
        translated.set(hash, cached);
        continue;
      }
      missing.push({ id: hash, text });
    }

    if (missing.length === 0) {
      return translated;
    }

    const tasks = missing.map((entry) =>
      this.semaphore.withPermit(async () => {
        const zh = await this.requestZhTranslation(entry.text, runtime);
        if (!zh || !targets.has(entry.id)) {
          return;
        }
        translated.set(entry.id, zh);
        await this.cache.set(this.translationCacheKey(entry.id), zh, TRANSLATION_CACHE_TTL_SECONDS);
      }),
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) {
      throw failed.reason instanceof Error ? failed.reason : new Error("Failed to translate via translation APIs");
    }

    return translated;
  }

  private assertRuntimeConfig(runtime: SituationMonitorTranslationRuntimeConfig) {
    if (!runtime.enabled && !runtime.fallbackEnabled) {
      throw new Error("Translation APIs are disabled");
    }

    const deepLxReady = this.canUseDeepLx(runtime);
    const fallbackReady = this.canUseFallback(runtime);
    if (deepLxReady || fallbackReady) {
      return;
    }

    const deepLxConfigError = this.buildDeepLxConfigError(runtime);
    const fallbackConfigError = this.buildFallbackConfigError(runtime);
    if (deepLxConfigError && fallbackConfigError) {
      throw new Error(`${deepLxConfigError}; ${fallbackConfigError}`);
    }
    throw new Error(deepLxConfigError ?? fallbackConfigError ?? "No translation API is available");
  }

  private async requestZhTranslation(
    text: string,
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): Promise<string> {
    let deepLxErrorMessage: string | undefined;
    if (this.canUseDeepLx(runtime)) {
      try {
        return await this.requestViaDeepLx(text, runtime);
      } catch (error) {
        deepLxErrorMessage = this.toNetworkErrorMessage(error, "DeepLX");
      }
    } else {
      deepLxErrorMessage = this.buildDeepLxConfigError(runtime);
    }

    if (!this.canUseFallback(runtime)) {
      throw new Error(deepLxErrorMessage ?? this.buildFallbackConfigError(runtime) ?? "No translation API is available");
    }

    const sourceLang = this.detectFallbackSourceLang(text);
    if (sourceLang === "zh-CN") {
      return text;
    }
    if (!sourceLang) {
      const fallbackSkipped = "Fallback translation API skipped: unsupported source language";
      if (deepLxErrorMessage) {
        throw new Error(`${deepLxErrorMessage}; ${fallbackSkipped}`);
      }
      throw new Error(fallbackSkipped);
    }

    try {
      return await this.requestViaFallbackApi(text, sourceLang, runtime);
    } catch (error) {
      const fallbackErrorMessage = this.toNetworkErrorMessage(error, "Fallback translation API");
      if (deepLxErrorMessage) {
        throw new Error(`${deepLxErrorMessage}; ${fallbackErrorMessage}`);
      }
      throw new Error(fallbackErrorMessage);
    }
  }

  private async requestViaDeepLx(
    text: string,
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): Promise<string> {
    const apiKey = normalizeText(runtime.apiKey);
    const baseUrl = normalizeText(runtime.baseUrl).replace(/\/+$/, "");
    if (!apiKey) {
      throw new Error("DeepLX translation API key is not configured");
    }
    if (!baseUrl) {
      throw new Error("DeepLX translation API base URL is not configured");
    }

    const timeoutMs = Math.max(1_000, Math.trunc(runtime.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS));
    const maxRetries = Math.max(0, Math.trunc(runtime.maxRetries ?? DEFAULT_TRANSLATION_MAX_RETRIES));
    const maxAttempts = maxRetries + 1;
    const url = this.buildDeepLxTranslateUrl(baseUrl, apiKey);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.post(
          url,
          { text, source_lang: "auto", target_lang: "ZH" },
          {
            timeout: timeoutMs,
            headers: { "content-type": "application/json" },
            validateStatus: () => true,
          },
        );

        if (response.status < 200 || response.status >= 300) {
          const message = this.buildHttpErrorMessage("DeepLX", response.status, response.data);
          if (attempt < maxAttempts && this.canRetryStatus(response.status)) {
            await sleep(RETRY_BACKOFF_BASE_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        const code = this.extractNumericCode(response.data);
        if (typeof code === "number" && code !== 200) {
          const message = this.buildCodeErrorMessage("DeepLX", code, response.data);
          if (attempt < maxAttempts && this.canRetryStatus(code)) {
            await sleep(RETRY_BACKOFF_BASE_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        const translated = this.extractDeepLxTranslatedText(response.data);
        if (!translated) {
          throw new Error("DeepLX response missing translated text");
        }
        return translated;
      } catch (error) {
        const message = this.toNetworkErrorMessage(error, "DeepLX");
        if (attempt < maxAttempts && this.isRetryableNetworkError(error)) {
          await sleep(RETRY_BACKOFF_BASE_MS * attempt);
          continue;
        }
        throw new Error(message);
      }
    }

    throw new Error("DeepLX request failed");
  }

  private async requestViaFallbackApi(
    text: string,
    sourceLang: Exclude<FallbackSourceLang, "zh-CN">,
    runtime: SituationMonitorTranslationRuntimeConfig,
  ): Promise<string> {
    const baseUrl = normalizeText(runtime.fallbackBaseUrl).replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("Fallback translation API base URL is not configured");
    }

    const timeoutMs = Math.max(1_000, Math.trunc(runtime.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS));
    const maxRetries = Math.max(0, Math.trunc(runtime.maxRetries ?? DEFAULT_TRANSLATION_MAX_RETRIES));
    const maxAttempts = maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.post(
          baseUrl,
          { source_lang: sourceLang, target_lang: "zh-CN", text_list: [text] },
          {
            timeout: timeoutMs,
            headers: { "content-type": "application/json" },
            validateStatus: () => true,
          },
        );

        if (response.status < 200 || response.status >= 300) {
          const message = this.buildHttpErrorMessage("Fallback translation API", response.status, response.data);
          if (attempt < maxAttempts && this.canRetryStatus(response.status)) {
            await sleep(RETRY_BACKOFF_BASE_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        const translated = this.extractFallbackTranslatedText(response.data);
        if (!translated) {
          throw new Error("Fallback translation API response missing translated text");
        }
        return translated;
      } catch (error) {
        const message = this.toNetworkErrorMessage(error, "Fallback translation API");
        if (attempt < maxAttempts && this.isRetryableNetworkError(error)) {
          await sleep(RETRY_BACKOFF_BASE_MS * attempt);
          continue;
        }
        throw new Error(message);
      }
    }

    throw new Error("Fallback translation API request failed");
  }

  private canUseDeepLx(runtime: SituationMonitorTranslationRuntimeConfig): boolean {
    return runtime.enabled && Boolean(normalizeText(runtime.baseUrl)) && Boolean(normalizeText(runtime.apiKey));
  }

  private canUseFallback(runtime: SituationMonitorTranslationRuntimeConfig): boolean {
    return runtime.fallbackEnabled && Boolean(normalizeText(runtime.fallbackBaseUrl));
  }

  private buildDeepLxConfigError(runtime: SituationMonitorTranslationRuntimeConfig): string | undefined {
    if (!runtime.enabled) {
      return "DeepLX translation API is disabled";
    }
    if (!normalizeText(runtime.baseUrl)) {
      return "DeepLX translation API base URL is not configured";
    }
    if (!normalizeText(runtime.apiKey)) {
      return "DeepLX translation API key is not configured";
    }
    return undefined;
  }

  private buildFallbackConfigError(runtime: SituationMonitorTranslationRuntimeConfig): string | undefined {
    if (!runtime.fallbackEnabled) {
      return "Fallback translation API is disabled";
    }
    if (!normalizeText(runtime.fallbackBaseUrl)) {
      return "Fallback translation API base URL is not configured";
    }
    return undefined;
  }

  private detectFallbackSourceLang(text: string): FallbackSourceLang | null {
    const normalized = normalizeText(text);
    if (!normalized) {
      return null;
    }

    if (/[\u3040-\u30ff]/u.test(normalized)) {
      return "ja";
    }
    if (/[\uac00-\ud7af\u1100-\u11ff]/u.test(normalized)) {
      return "ko";
    }
    if (/[\u4e00-\u9fff]/u.test(normalized)) {
      return "zh-CN";
    }

    const lower = normalized.toLowerCase();
    if (
      /[àâçéèêëîïôûùüÿœæ]/i.test(normalized)
      || /\b(le|la|les|des|du|de|une|un|bonjour|merci|avec|pour|dans|est|sont)\b/u.test(lower)
    ) {
      return "fr";
    }

    if (
      /[äöüß]/i.test(normalized)
      || /\b(der|die|das|und|ist|mit|nicht|ein|eine|für|auf|von|den)\b/u.test(lower)
    ) {
      return "de";
    }

    if (/[a-z]/i.test(normalized)) {
      return "en";
    }

    return null;
  }

  private buildDeepLxTranslateUrl(baseUrl: string, apiKey: string): string {
    return `${baseUrl}/${encodeURIComponent(apiKey)}/translate`;
  }

  private extractNumericCode(payload: unknown): number | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const rawCode = (payload as Record<string, unknown>).code;
    if (typeof rawCode !== "number" || !Number.isFinite(rawCode)) {
      return undefined;
    }
    return Math.trunc(rawCode);
  }

  private extractDeepLxTranslatedText(payload: unknown): string {
    if (typeof payload === "string") {
      return normalizeText(payload);
    }
    if (!payload || typeof payload !== "object") {
      return "";
    }
    const record = payload as Record<string, unknown>;
    const primary = normalizeText(record.data);
    if (primary) {
      return primary;
    }
    const fallback = normalizeText(record.translation);
    if (fallback) {
      return fallback;
    }
    if (Array.isArray(record.alternatives)) {
      for (const entry of record.alternatives) {
        const alternative = normalizeText(entry);
        if (alternative) {
          return alternative;
        }
      }
    }
    return "";
  }

  private extractFallbackTranslatedText(payload: unknown): string {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    const translations = (payload as Record<string, unknown>).translations;
    if (!Array.isArray(translations)) {
      return "";
    }
    for (const entry of translations) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const text = normalizeText((entry as Record<string, unknown>).text);
      if (text) {
        return text;
      }
    }
    return "";
  }

  private canRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private buildHttpErrorMessage(provider: string, status: number, payload: unknown): string {
    const detail = this.extractErrorDetail(payload);
    return detail
      ? `${provider} request failed (HTTP ${status}): ${detail}`
      : `${provider} request failed (HTTP ${status})`;
  }

  private buildCodeErrorMessage(provider: string, code: number, payload: unknown): string {
    const detail = this.extractErrorDetail(payload);
    return detail
      ? `${provider} request failed (code ${code}): ${detail}`
      : `${provider} request failed (code ${code})`;
  }

  private extractErrorDetail(payload: unknown): string | undefined {
    if (typeof payload === "string") {
      const message = normalizeText(payload);
      return message ? this.truncateMessage(message) : undefined;
    }
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const record = payload as Record<string, unknown>;
    const candidates = [record.message, record.error, record.msg, record.detail];
    for (const entry of candidates) {
      const message = normalizeText(entry);
      if (message) {
        return this.truncateMessage(message);
      }
    }
    return undefined;
  }

  private toNetworkErrorMessage(error: unknown, provider: string): string {
    if (error instanceof Error && error.message.startsWith(provider)) {
      return error.message;
    }
    if (axios.isAxiosError(error)) {
      if (error.response?.status) {
        return this.buildHttpErrorMessage(provider, error.response.status, error.response.data);
      }
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        return `${provider} request timed out`;
      }
      const message = normalizeText(error.message);
      return message
        ? `${provider} request failed: ${this.truncateMessage(message)}`
        : `${provider} request failed`;
    }
    if (error instanceof Error) {
      return normalizeText(error.message) || `${provider} request failed`;
    }
    return `${provider} request failed`;
  }

  private isRetryableNetworkError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    const status = error.response?.status;
    if (typeof status === "number") {
      return this.canRetryStatus(status);
    }
    if (!error.code) {
      return true;
    }
    const code = error.code.toUpperCase();
    return code === "ECONNABORTED"
      || code === "ETIMEDOUT"
      || code === "ECONNRESET"
      || code === "EAI_AGAIN"
      || code === "ENOTFOUND"
      || code === "ERR_NETWORK";
  }

  private truncateMessage(message: string): string {
    return message.length > 200 ? `${message.slice(0, 200)}...` : message;
  }

  private applyTranslationMap(insights: SituationMonitorInsightsResponse, translated: Map<string, string>) {
    const translateText = (text: unknown): string | null => {
      const normalized = normalizeText(text);
      if (!normalized) {
        return null;
      }
      const hash = sha256(normalized);
      return translated.get(hash) ?? null;
    };

    const translateKeyPoints = (points: unknown): string[] | null => {
      if (!Array.isArray(points)) {
        return null;
      }
      const out: string[] = [];
      let anyTranslated = false;
      for (const point of points) {
        const normalized = normalizeText(point);
        if (!normalized) {
          continue;
        }
        const zh = translateText(normalized);
        if (zh) {
          anyTranslated = true;
          out.push(zh);
        } else {
          out.push(normalized);
        }
      }
      return anyTranslated ? out : null;
    };

    const applyHeadline = (entry: SituationMonitorHeadline) => {
      const titleZh = translateText(entry.title);
      if (titleZh) {
        entry.titleZh = titleZh;
      }
      const summaryZh = translateText(entry.summary);
      if (summaryZh) {
        entry.summaryZh = summaryZh;
      }
      const keyPointsZh = translateKeyPoints(entry.keyPoints);
      if (keyPointsZh) {
        entry.keyPointsZh = keyPointsZh;
      }
    };

    const applyFedNews = (entry: SituationMonitorFedNewsItem) => {
      const titleZh = translateText(entry.title);
      if (titleZh) {
        entry.titleZh = titleZh;
      }
      const descriptionZh = translateText(entry.description);
      if (descriptionZh) {
        entry.descriptionZh = descriptionZh;
      }
      const typeLabelZh = translateText(entry.typeLabel);
      if (typeLabelZh) {
        entry.typeLabelZh = typeLabelZh;
      }
    };

    if (insights.headlines) {
      for (const list of Object.values(insights.headlines)) {
        for (const entry of list) {
          applyHeadline(entry);
        }
      }
    }

    if (insights.clusters) {
      for (const list of Object.values(insights.clusters)) {
        for (const cluster of list) {
          applyHeadline(cluster.lead);
          for (const entry of cluster.items ?? []) {
            applyHeadline(entry);
          }
        }
      }
    }

    if (Array.isArray(insights.alerts)) {
      for (const entry of insights.alerts) {
        applyHeadline(entry);
      }
    }

    if (Array.isArray(insights.leaders)) {
      for (const leader of insights.leaders) {
        for (const entry of leader.headlines ?? []) {
          const titleZh = translateText(entry.title);
          if (titleZh) {
            entry.titleZh = titleZh;
          }
        }
      }
    }

    if (Array.isArray(insights.situations)) {
      for (const panel of insights.situations) {
        const titleZh = translateText(panel.title);
        if (titleZh) {
          panel.titleZh = titleZh;
        }
        const subtitleZh = translateText(panel.subtitle);
        if (subtitleZh) {
          panel.subtitleZh = subtitleZh;
        }
        for (const entry of panel.headlines ?? []) {
          const entryTitleZh = translateText(entry.title);
          if (entryTitleZh) {
            entry.titleZh = entryTitleZh;
          }
        }
      }
    }

    if (insights.fed?.news) {
      for (const entry of insights.fed.news) {
        applyFedNews(entry);
      }
    }

    if (insights.correlation) {
      const correlation = insights.correlation;
      const applyHeadlineRef = (ref: { title: string; titleZh?: string }) => {
        const titleZh = translateText(ref.title);
        if (titleZh) {
          ref.titleZh = titleZh;
        }
      };
      const applyNameRef = (ref: { name: string; nameZh?: string }) => {
        const nameZh = translateText(ref.name);
        if (nameZh) {
          ref.nameZh = nameZh;
        }
      };
      for (const entry of correlation.emergingPatterns ?? []) {
        applyNameRef(entry);
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.momentumSignals ?? []) {
        applyNameRef(entry);
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.crossSourceCorrelations ?? []) {
        applyNameRef(entry);
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
      for (const entry of correlation.predictiveSignals ?? []) {
        applyNameRef(entry);
        const predictionZh = translateText(entry.prediction);
        if (predictionZh) {
          entry.predictionZh = predictionZh;
        }
        for (const ref of entry.headlines ?? []) {
          applyHeadlineRef(ref);
        }
      }
    }

    if (insights.correlationSummary) {
      const statusZh = translateText(insights.correlationSummary.status);
      if (statusZh) {
        insights.correlationSummary.statusZh = statusZh;
      }
    }

    if (insights.narrative) {
      const narrative = insights.narrative;
      const applyNarrativeHeadline = (ref: { title: string; titleZh?: string }) => {
        const titleZh = translateText(ref.title);
        if (titleZh) {
          ref.titleZh = titleZh;
        }
      };
      const applyNarrativeName = (ref: { name: string; nameZh?: string }) => {
        const nameZh = translateText(ref.name);
        if (nameZh) {
          ref.nameZh = nameZh;
        }
      };
      const buckets = [
        narrative.emergingFringe,
        narrative.fringeToMainstream,
        narrative.narrativeWatch,
        narrative.disinfoSignals,
      ];
      for (const list of buckets) {
        for (const entry of list ?? []) {
          applyNarrativeName(entry);
          for (const headline of entry.headlines ?? []) {
            applyNarrativeHeadline(headline);
          }
        }
      }
    }

    if (insights.narrativeSummary) {
      const statusZh = translateText(insights.narrativeSummary.status);
      if (statusZh) {
        insights.narrativeSummary.statusZh = statusZh;
      }
    }

    if (insights.mainCharacterSummary) {
      const statusZh = translateText(insights.mainCharacterSummary.status);
      if (statusZh) {
        insights.mainCharacterSummary.statusZh = statusZh;
      }
    }
  }

  private translationCacheKey(hash: string) {
    return `${TRANSLATION_CACHE_KEY_PREFIX}:${hash}`;
  }
}
