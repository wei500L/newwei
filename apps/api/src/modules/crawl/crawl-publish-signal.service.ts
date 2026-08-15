import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { load } from "cheerio";

import {
  hasArticleLeadPathSegment,
  hasBlockedDetailPathSegments,
  isLikelyPathCategoryToken,
  ssrfSafeFetch,
} from "./crawl-execution.helpers";
import type {
  CandidatePublishSignal,
  CandidatePublishSignalFetchResult,
  DetailCandidateConfidenceBuckets,
  PublishSignalEnrichmentResult,
  PublishSignalEnrichmentSettings,
  PublishSignalSoftFailureBreakdown,
  PublishSignalSoftFailureReason,
} from "./crawl-execution.types";
import { CrawlSettingsService } from "./crawl-settings.service";

const logger = createLogger({ name: "crawl-execution-service" });

@Injectable()
export class CrawlPublishSignalService {
  private readonly defaultDetailPublishSignalHeadFetchTimeoutMs = 1_500;
  private readonly defaultDetailPublishSignalHeadFetchConcurrency = 2;
  private readonly defaultDetailPublishSignalHeadFetchMaxReadBytes = 8_000_000;

  constructor(private readonly crawlSettings: CrawlSettingsService) {}

  resolvePublishSignalTopK(
    candidateLimit: number,
    maxDetailUrls: number,
    candidatePoolSize: number,
  ): number {
    if (candidatePoolSize <= 0) {
      return 0;
    }
    const desired = Math.max(
      3,
      Math.min(18, Math.max(candidateLimit + 2, maxDetailUrls)),
    );
    return Math.max(0, Math.min(candidatePoolSize, desired));
  }

  async getPublishSignalEnrichmentSettings(): Promise<PublishSignalEnrichmentSettings> {
    const fallback: PublishSignalEnrichmentSettings = {
      timeoutMs: this.defaultDetailPublishSignalHeadFetchTimeoutMs,
      concurrency: this.defaultDetailPublishSignalHeadFetchConcurrency,
      maxReadBytes: this.defaultDetailPublishSignalHeadFetchMaxReadBytes,
    };
    try {
      const settings = await this.crawlSettings.getSettings();
      return {
        timeoutMs:
          typeof settings.detailPublishSignalHeadFetchTimeoutMs === "number" &&
          Number.isFinite(settings.detailPublishSignalHeadFetchTimeoutMs)
            ? settings.detailPublishSignalHeadFetchTimeoutMs
            : fallback.timeoutMs,
        concurrency:
          typeof settings.detailPublishSignalHeadFetchConcurrency ===
            "number" &&
          Number.isFinite(settings.detailPublishSignalHeadFetchConcurrency)
            ? settings.detailPublishSignalHeadFetchConcurrency
            : fallback.concurrency,
        maxReadBytes:
          typeof settings.detailPublishSignalHeadFetchMaxReadBytes ===
            "number" &&
          Number.isFinite(settings.detailPublishSignalHeadFetchMaxReadBytes)
            ? settings.detailPublishSignalHeadFetchMaxReadBytes
            : fallback.maxReadBytes,
      };
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to load crawl settings for publish-signal enrichment; using defaults",
      );
      return fallback;
    }
  }

  async enrichCandidatePublishSignals(options: {
    urls: string[];
    requestTimeoutMs?: number;
    settings: PublishSignalEnrichmentSettings;
  }): Promise<PublishSignalEnrichmentResult> {
    const signals = new Map<string, CandidatePublishSignal>();
    const softFailures = this.createEmptyPublishSignalSoftFailureBreakdown();
    const uniqueUrls = Array.from(
      new Set(
        options.urls.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        ),
      ),
    );
    const timeoutMs = this.resolvePublishSignalFetchTimeoutMs(
      options.settings.timeoutMs,
      options.requestTimeoutMs,
    );
    const resolvedConcurrency = this.resolvePublishSignalFetchConcurrency(
      options.settings.concurrency,
    );
    const resolvedMaxReadBytes = this.resolvePublishSignalMaxReadBytes(
      options.settings.maxReadBytes,
    );
    const effectiveConcurrency =
      uniqueUrls.length > 0
        ? Math.max(1, Math.min(uniqueUrls.length, resolvedConcurrency))
        : 0;
    if (uniqueUrls.length === 0) {
      return {
        signals,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: false,
        effectiveTimeoutMs: timeoutMs,
        effectiveConcurrency,
        maxReadBytes: resolvedMaxReadBytes,
        truncatedResponses: 0,
        earlyStoppedResponses: 0,
        softFailures,
        softFailureCount: 0,
      };
    }
    if (!this.shouldEnrichCandidatePublishSignals()) {
      return {
        signals,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: true,
        effectiveTimeoutMs: timeoutMs,
        effectiveConcurrency,
        maxReadBytes: resolvedMaxReadBytes,
        truncatedResponses: 0,
        earlyStoppedResponses: 0,
        softFailures,
        softFailureCount: 0,
      };
    }
    let cursor = 0;
    let succeeded = 0;
    let failed = 0;
    let truncatedResponses = 0;
    let earlyStoppedResponses = 0;

    const worker = async () => {
      while (cursor < uniqueUrls.length) {
        const index = cursor;
        cursor += 1;
        const url = uniqueUrls[index];
        if (!url) {
          failed += 1;
          continue;
        }
        const fetched = await this.fetchCandidatePublishSignal(
          url,
          timeoutMs,
          resolvedMaxReadBytes,
        );
        if (fetched.truncated) {
          truncatedResponses += 1;
        }
        if (fetched.earlyStopped) {
          earlyStoppedResponses += 1;
        }
        const signal = fetched.signal;
        if (signal && signal.source !== "none") {
          signals.set(url, signal);
          succeeded += 1;
        } else {
          this.incrementPublishSignalSoftFailure(
            softFailures,
            fetched.failureReason ?? "no_publish_signal",
          );
          failed += 1;
        }
      }
    };

    await Promise.all(
      Array.from({ length: effectiveConcurrency }, () => worker()),
    );

    const softFailureCount = this.countPublishSignalSoftFailures(softFailures);
    if (softFailureCount > 0) {
      logger.warn(
        {
          attempted: uniqueUrls.length,
          succeeded,
          failed,
          truncatedResponses,
          earlyStoppedResponses,
          softFailures,
        },
        "Publish-signal enrichment completed with non-blocking soft failures",
      );
    }

    return {
      signals,
      attempted: uniqueUrls.length,
      succeeded,
      failed,
      skipped: false,
      effectiveTimeoutMs: timeoutMs,
      effectiveConcurrency,
      maxReadBytes: resolvedMaxReadBytes,
      truncatedResponses,
      earlyStoppedResponses,
      softFailures,
      softFailureCount,
    };
  }

  private shouldEnrichCandidatePublishSignals(): boolean {
    return process.env.NODE_ENV !== "test";
  }

  private resolvePublishSignalFetchTimeoutMs(
    configuredTimeoutMs: number,
    requestTimeoutMs?: number,
  ): number {
    const fromSettings =
      typeof configuredTimeoutMs === "number" &&
      Number.isFinite(configuredTimeoutMs) &&
      configuredTimeoutMs > 0
        ? Math.max(500, Math.min(10_000, Math.round(configuredTimeoutMs)))
        : this.defaultDetailPublishSignalHeadFetchTimeoutMs;
    if (
      typeof requestTimeoutMs === "number" &&
      Number.isFinite(requestTimeoutMs) &&
      requestTimeoutMs > 0
    ) {
      const requestBound = Math.max(
        500,
        Math.min(10_000, Math.round(requestTimeoutMs)),
      );
      return Math.min(fromSettings, requestBound);
    }
    return fromSettings;
  }

  private resolvePublishSignalFetchConcurrency(
    configuredConcurrency: number,
  ): number {
    if (
      typeof configuredConcurrency !== "number" ||
      !Number.isFinite(configuredConcurrency) ||
      configuredConcurrency <= 0
    ) {
      return this.defaultDetailPublishSignalHeadFetchConcurrency;
    }
    return Math.max(1, Math.min(8, Math.round(configuredConcurrency)));
  }

  private resolvePublishSignalMaxReadBytes(
    configuredMaxReadBytes: number,
  ): number {
    if (
      typeof configuredMaxReadBytes !== "number" ||
      !Number.isFinite(configuredMaxReadBytes) ||
      configuredMaxReadBytes <= 0
    ) {
      return this.defaultDetailPublishSignalHeadFetchMaxReadBytes;
    }
    return Math.max(
      1_048_576,
      Math.min(64_000_000, Math.round(configuredMaxReadBytes)),
    );
  }

  private async fetchCandidatePublishSignal(
    url: string,
    timeoutMs: number,
    maxReadBytes: number,
  ): Promise<CandidatePublishSignalFetchResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await ssrfSafeFetch(
          url,
          "GET",
          {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent":
              "Mozilla/5.0 (compatible; CrawlQualityProbe/1.0; +https://example.com)",
          },
          controller.signal,
        );
        if (!response) {
          return {
            truncated: false,
            earlyStopped: false,
            failureReason: "network_or_timeout",
          };
        }
        if (!response.ok) {
          return {
            truncated: false,
            earlyStopped: false,
            failureReason: "http_status",
          };
        }
        const contentType =
          response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType.length > 0 &&
          !contentType.includes("text/html") &&
          !contentType.includes("application/xhtml+xml")
        ) {
          return {
            truncated: false,
            earlyStopped: false,
            failureReason: "non_html",
          };
        }
        const readResult = await this.readPublishSignalHtmlWithSoftLimit(
          response,
          maxReadBytes,
        );
        if (!readResult.html || readResult.html.trim().length === 0) {
          return {
            truncated: readResult.truncated,
            earlyStopped: readResult.earlyStopped,
            failureReason: "empty_html",
          };
        }
        const signal = this.extractPublishSignalFromHtml(readResult.html);
        if (!signal || signal.source === "none") {
          return {
            truncated: readResult.truncated,
            earlyStopped: readResult.earlyStopped,
            failureReason: "no_publish_signal",
          };
        }
        return {
          signal,
          truncated: readResult.truncated,
          earlyStopped: readResult.earlyStopped,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return {
        truncated: false,
        earlyStopped: false,
        failureReason: "network_or_timeout",
      };
    }
  }

  private createEmptyPublishSignalSoftFailureBreakdown(): PublishSignalSoftFailureBreakdown {
    return {
      httpStatus: 0,
      nonHtml: 0,
      emptyHtml: 0,
      networkOrTimeout: 0,
      noPublishSignal: 0,
    };
  }

  private incrementPublishSignalSoftFailure(
    breakdown: PublishSignalSoftFailureBreakdown,
    reason: PublishSignalSoftFailureReason,
  ) {
    if (reason === "http_status") {
      breakdown.httpStatus += 1;
      return;
    }
    if (reason === "non_html") {
      breakdown.nonHtml += 1;
      return;
    }
    if (reason === "empty_html") {
      breakdown.emptyHtml += 1;
      return;
    }
    if (reason === "network_or_timeout") {
      breakdown.networkOrTimeout += 1;
      return;
    }
    breakdown.noPublishSignal += 1;
  }

  private countPublishSignalSoftFailures(
    breakdown: PublishSignalSoftFailureBreakdown,
  ): number {
    return (
      breakdown.httpStatus +
      breakdown.nonHtml +
      breakdown.emptyHtml +
      breakdown.networkOrTimeout +
      breakdown.noPublishSignal
    );
  }

  private async readPublishSignalHtmlWithSoftLimit(
    response: Response,
    maxBytes: number,
  ): Promise<{ html: string; truncated: boolean; earlyStopped: boolean }> {
    const limit =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.max(32_768, Math.min(64_000_000, Math.round(maxBytes)))
        : this.defaultDetailPublishSignalHeadFetchMaxReadBytes;
    if (!response.body) {
      const text = await response.text();
      if (text.length <= limit) {
        return { html: text, truncated: false, earlyStopped: false };
      }
      return {
        html: text.slice(0, limit),
        truncated: true,
        earlyStopped: false,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const headProbeBytes = Math.min(limit, 524_288);
    let bytesRead = 0;
    let html = "";
    let truncated = false;
    let earlyStopped = false;
    let shouldProbeHeadSignal = true;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }
        const remaining = limit - bytesRead;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (value.length > remaining) {
          html += decoder.decode(value.subarray(0, remaining), {
            stream: true,
          });
          bytesRead += remaining;
          truncated = true;
          break;
        }
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        if (shouldProbeHeadSignal) {
          const hasClosedHead = html.includes("</head>");
          if (hasClosedHead || bytesRead >= headProbeBytes) {
            shouldProbeHeadSignal = false;
            const headSignal = this.extractPublishSignalFromHtml(html, {
              includeTimeTag: false,
            });
            if (
              headSignal &&
              (headSignal.source === "meta" || headSignal.source === "jsonld")
            ) {
              earlyStopped = true;
              break;
            }
          }
        }
      }
      html += decoder.decode();
    } finally {
      if (truncated || earlyStopped) {
        try {
          await reader.cancel();
        } catch {
          // no-op
        }
      } else {
        try {
          reader.releaseLock();
        } catch {
          // no-op
        }
      }
    }
    return { html, truncated, earlyStopped };
  }

  private extractPublishSignalFromHtml(
    html: string,
    options?: { includeTimeTag?: boolean },
  ): CandidatePublishSignal | undefined {
    const $ = load(html);
    const head = $("head");
    const includeTimeTag = options?.includeTimeTag ?? true;
    const parseTimestamp = (value: unknown): number | undefined => {
      if (typeof value !== "string") {
        return undefined;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      const timestamp = Date.parse(trimmed);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return undefined;
      }
      return timestamp;
    };

    const resolveMetaTimestamp = (): number | undefined => {
      const selectors = [
        'meta[property="article:published_time"]',
        'meta[property="og:published_time"]',
        'meta[name="pubdate"]',
        'meta[name="publishdate"]',
        'meta[name="date"]',
        'meta[itemprop="datePublished"]',
      ];
      for (const selector of selectors) {
        const value = head.find(selector).attr("content");
        const timestamp = parseTimestamp(value);
        if (timestamp) {
          return timestamp;
        }
      }
      return undefined;
    };

    const metaTimestamp = resolveMetaTimestamp();
    if (metaTimestamp) {
      return {
        confidence: 0.95,
        source: "meta",
        timestamp: metaTimestamp,
      };
    }

    const scripts = head.find('script[type="application/ld+json"]');
    for (let index = 0; index < scripts.length && index < 8; index += 1) {
      const raw = scripts.eq(index).contents().text().trim();
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        const timestamp = this.findJsonLdPublishTimestamp(parsed);
        if (timestamp) {
          return {
            confidence: 0.92,
            source: "jsonld",
            timestamp,
          };
        }
      } catch {
        continue;
      }
    }

    if (includeTimeTag) {
      const timeValue = $("time[datetime]").first().attr("datetime");
      const timeTimestamp = parseTimestamp(timeValue);
      if (timeTimestamp) {
        return {
          confidence: 0.88,
          source: "time_tag",
          timestamp: timeTimestamp,
        };
      }
    }

    return undefined;
  }

  private findJsonLdPublishTimestamp(value: unknown): number | undefined {
    const parseTimestamp = (candidate: unknown): number | undefined => {
      if (typeof candidate !== "string") {
        return undefined;
      }
      const timestamp = Date.parse(candidate);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return undefined;
      }
      return timestamp;
    };

    if (Array.isArray(value)) {
      for (const item of value) {
        const timestamp = this.findJsonLdPublishTimestamp(item);
        if (timestamp) {
          return timestamp;
        }
      }
      return undefined;
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const published = parseTimestamp(record.datePublished);
    if (published) {
      return published;
    }
    const created = parseTimestamp(record.dateCreated);
    if (created) {
      return created;
    }
    const modified = parseTimestamp(record.dateModified);
    if (modified) {
      return modified;
    }

    for (const nested of Object.values(record)) {
      const timestamp = this.findJsonLdPublishTimestamp(nested);
      if (timestamp) {
        return timestamp;
      }
    }
    return undefined;
  }

  resolveCandidatePublishSignal(
    url: string,
    enriched?: CandidatePublishSignal,
  ): CandidatePublishSignal {
    const pathTimestamp = this.parseDateFromUrlPath(url);
    const pathSignal: CandidatePublishSignal = {
      confidence: this.estimatePublishTimeConfidenceFromCandidateUrl(url),
      source: "url_path",
      timestamp: pathTimestamp,
    };
    if (!enriched) {
      return pathSignal;
    }
    return enriched.confidence >= pathSignal.confidence ? enriched : pathSignal;
  }

  buildDetailCandidateConfidenceBuckets(
    signalByUrl: Map<string, CandidatePublishSignal>,
    candidateUrls: string[],
  ): DetailCandidateConfidenceBuckets {
    const buckets: DetailCandidateConfidenceBuckets = {
      lt04: 0,
      from04To06: 0,
      from06To08: 0,
      gte08: 0,
    };
    for (const url of candidateUrls) {
      const signal = signalByUrl.get(url);
      const confidence =
        signal?.confidence ??
        this.estimatePublishTimeConfidenceFromCandidateUrl(url);
      if (!Number.isFinite(confidence)) {
        continue;
      }
      if (confidence < 0.4) {
        buckets.lt04 += 1;
      } else if (confidence < 0.6) {
        buckets.from04To06 += 1;
      } else if (confidence < 0.8) {
        buckets.from06To08 += 1;
      } else {
        buckets.gte08 += 1;
      }
    }
    return buckets;
  }

  estimatePublishTimeConfidenceFromCandidateUrl(url: string): number {
    const fromPath = this.parseDateFromUrlPath(url);
    if (fromPath) {
      return 0.82;
    }
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      const lastSegment = (segments[segments.length - 1] ?? "").toLowerCase();
      if (/^\d{7,}$/.test(lastSegment)) {
        return 0.74;
      }
      if (
        segments.some(
          (segment) => segment === "article" || segment === "articles",
        )
      ) {
        return 0.6;
      }
      if (segments.length >= 3 && /[a-z0-9]-[a-z0-9]/i.test(lastSegment)) {
        return 0.56;
      }
      return 0.38;
    } catch {
      return 0.3;
    }
  }

  private parseDateFromUrlPath(url: string): number | undefined {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.toLowerCase();
      const toUtcTimestamp = (year: number, month: number, day: number) => {
        if (
          !Number.isFinite(year) ||
          !Number.isFinite(month) ||
          !Number.isFinite(day)
        ) {
          return undefined;
        }
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          return undefined;
        }
        const ts = Date.UTC(year, month - 1, day);
        if (!Number.isFinite(ts)) {
          return undefined;
        }
        const check = new Date(ts);
        if (
          check.getUTCFullYear() !== year ||
          check.getUTCMonth() !== month - 1 ||
          check.getUTCDate() !== day
        ) {
          return undefined;
        }
        return ts;
      };
      const slashDate = /\/(20\d{2})\/([01]\d)\/([0-3]\d)(?:\/|$)/.exec(path);
      if (slashDate) {
        return toUtcTimestamp(
          Number(slashDate[1]),
          Number(slashDate[2]),
          Number(slashDate[3]),
        );
      }
      const dashedDate = /(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)/.exec(path);
      if (dashedDate) {
        return toUtcTimestamp(
          Number(dashedDate[1]),
          Number(dashedDate[2]),
          Number(dashedDate[3]),
        );
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  detailRelevanceToScore(minRelevanceScore: number): number {
    if (minRelevanceScore <= 0) {
      return Number.NEGATIVE_INFINITY;
    }
    return minRelevanceScore * 300 - 120;
  }

  scoreDetailCandidateUrl(url: string, baseUrl?: string): number {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      const segments = pathname.split("/").filter((entry) => entry.length > 0);
      const segmentsLower = segments.map((entry) => entry.toLowerCase());
      const lastSegment = segments[segments.length - 1] ?? "";
      const lastSegmentLower = lastSegment.toLowerCase();
      const hasArticleLeadSegment =
        hasArticleLeadPathSegment(segmentsLower);
      const publishTimeConfidence =
        this.estimatePublishTimeConfidenceFromCandidateUrl(url);

      let score = 0;
      score += Math.round(publishTimeConfidence * 80);
      if (hasBlockedDetailPathSegments(segmentsLower)) {
        score -= 400;
      }
      if (/-\d{4}-\d{2}-\d{2}$/.test(lastSegment)) {
        score += 220;
      }
      if (/[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$/.test(lastSegment)) {
        score += 150;
      }
      if (/(?:^|-)id[a-z0-9]{7,}$/i.test(lastSegment)) {
        score += 130;
      }
      if (
        segments.some(
          (segment) => segment === "article" || segment === "articles",
        )
      ) {
        score += 100;
      }
      if (hasArticleLeadSegment) {
        score += 30;
      }
      if (segments.length >= 4 && /[a-z0-9]-[a-z0-9]/i.test(lastSegment)) {
        score += 80;
      }
      if (
        segments.length >= 2 &&
        lastSegment.length >= 18 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
        !isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        score += 65;
      }
      if (segments.length >= 2 && /^\d{7,}$/.test(lastSegment)) {
        score += 95;
      }
      if (
        segments.length >= 2 &&
        /^[a-z0-9]{8,}$/.test(lastSegmentLower) &&
        !isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        score += 35;
      }
      if (segments.length >= 3) {
        score += 18;
      }
      if (parsed.pathname.toLowerCase().includes("/world/")) {
        score += 16;
      }

      if (baseUrl) {
        try {
          const base = new URL(baseUrl);
          const baseSegments = base.pathname
            .replace(/\/+$/, "")
            .split("/")
            .filter((entry) => entry.length > 0)
            .map((entry) => entry.toLowerCase());
          if (baseSegments[0]) {
            if (baseSegments[0] === segmentsLower[0]) {
              score += 120;
            } else {
              score -= 90;
            }
          }
          if (baseSegments[1] && baseSegments[1] === segmentsLower[1]) {
            score += 30;
          }
        } catch {
          // Ignore scoring hints when base URL is malformed
        }
      }

      const likelySectionTail = new Set([
        "world",
        "business",
        "markets",
        "technology",
        "tech",
        "opinion",
        "sport",
        "sports",
        "news",
        "japan",
        "us",
        "china",
        "europe",
        "ukraine",
        "russia",
        "latest",
        "archive",
      ]);
      if (segments.length <= 3 && likelySectionTail.has(lastSegmentLower)) {
        score -= 180;
      }

      if (
        segmentsLower.some((segment) =>
          [
            "video",
            "videos",
            "photos",
            "photo",
            "gallery",
            "graphics",
            "podcast",
            "tag",
            "tags",
            "topic",
            "topics",
            "section",
            "sections",
            "authors",
            "author",
          ].includes(segment),
        )
      ) {
        score -= 150;
      }

      if (parsed.search.length > 0) {
        score -= 12;
      }
      return score;
    } catch {
      return Number.NEGATIVE_INFINITY;
    }
  }
}
