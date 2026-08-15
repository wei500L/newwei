import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { pickString, ssrfSafeFetch } from "./crawl-execution.helpers";
import type {
  ConditionalPreflightOutcome,
  ConditionalPreflightResult,
  ConditionalRequestSettings,
  CrawlResultHttpValidationState,
} from "./crawl-execution.types";
import { CrawlSettingsService } from "./crawl-settings.service";
import type { CrawlTaskOptions } from "./crawl.types";
import type { Crawl4aiArticle } from "./crawl4ai.client";
import { buildCanonicalUrlFingerprint } from "./url-fingerprint";

const logger = createLogger({ name: "crawl-execution-service" });

@Injectable()
export class CrawlConditionalPreflightService {
  private readonly defaultConditionalRequestEnabled = true;
  private readonly defaultConditionalRequestTimeoutMs = 5_000;
  private readonly defaultConditionalRequestMaxRetries = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crawlSettings: CrawlSettingsService,
  ) {}

  async findLatestResultHttpValidationState(options: {
    taskId: string;
    targetUrl: string;
    urlQueryParamAllowlist: string[];
  }): Promise<CrawlResultHttpValidationState | null> {
    const normalizedTargetUrl = options.targetUrl.trim();
    const canonical = buildCanonicalUrlFingerprint(
      normalizedTargetUrl,
      options.urlQueryParamAllowlist,
    );
    const where: Prisma.CrawlResultWhereInput = {
      taskId: options.taskId,
    };
    const matchers: Prisma.CrawlResultWhereInput[] = [];
    if (canonical) {
      matchers.push({
        sourceUrlFingerprint: canonical.fingerprint,
      });
      matchers.push({
        sourceUrl: canonical.canonicalUrl,
      });
    }
    if (normalizedTargetUrl.length > 0) {
      matchers.push({
        sourceUrl: normalizedTargetUrl,
      });
    }
    if (matchers.length === 0) {
      return null;
    }
    where.OR = matchers;

    const latest = await this.prisma.crawlResult.findFirst({
      where,
      orderBy: { fetchedAt: "desc" },
      select: {
        id: true,
        fetchedAt: true,
        metadata: true,
      },
    });
    if (!latest) {
      return null;
    }

    const metadata =
      latest.metadata &&
      typeof latest.metadata === "object" &&
      !Array.isArray(latest.metadata)
        ? (latest.metadata as Record<string, unknown>)
        : undefined;
    const etag = pickString(metadata, ["httpEtag", "etag"]);
    const lastModified = pickString(metadata, [
      "httpLastModified",
      "lastModified",
      "last-modified",
    ]);

    return {
      resultId: latest.id,
      fetchedAt: latest.fetchedAt,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  }

  shouldRunConditionalPreflight(enabled: boolean): boolean {
    return enabled && process.env.NODE_ENV !== "test";
  }

  async runConditionalPreflight(options: {
    targetUrl: string;
    options: CrawlTaskOptions;
    requestTimeoutMs?: number;
    etag?: string;
    lastModified?: string;
    timeoutMs: number;
    maxRetries: number;
  }): Promise<ConditionalPreflightOutcome> {
    const timeoutMs = this.resolveConditionalPreflightTimeoutMs(
      options.timeoutMs,
      options.requestTimeoutMs,
    );
    const maxRetries = this.resolveConditionalPreflightMaxRetries(
      options.maxRetries,
    );
    const headers = this.buildConditionalPreflightHeaders(options.options, {
      etag: options.etag,
      lastModified: options.lastModified,
    });

    const maxAttempts = Math.max(1, maxRetries + 1);
    let failures = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const head = await this.requestConditionalUrlStatus(
        options.targetUrl,
        "HEAD",
        headers,
        timeoutMs,
      );
      if (!head) {
        failures += 1;
        continue;
      }

      if (head.status === 403 || head.status === 405 || head.status === 501) {
        const get = await this.requestConditionalUrlStatus(
          options.targetUrl,
          "GET",
          headers,
          timeoutMs,
        );
        if (!get) {
          failures += 1;
          continue;
        }
        if (
          this.shouldRetryConditionalPreflightStatus(get.status) &&
          attempt < maxAttempts
        ) {
          failures += 1;
          continue;
        }
        return {
          status: "completed",
          result: get,
          attempts: attempt,
          failures,
        };
      }

      if (
        this.shouldRetryConditionalPreflightStatus(head.status) &&
        attempt < maxAttempts
      ) {
        failures += 1;
        continue;
      }

      return {
        status: "completed",
        result: head,
        attempts: attempt,
        failures,
      };
    }

    return {
      status: "failed",
      attempts: maxAttempts,
      failures,
    };
  }

  private resolveConditionalPreflightTimeoutMs(
    configuredTimeoutMs: number,
    requestTimeoutMs?: number,
  ): number {
    const boundedConfiguredTimeoutMs = Math.max(
      500,
      Math.min(60_000, Math.round(configuredTimeoutMs)),
    );
    if (
      typeof requestTimeoutMs !== "number" ||
      !Number.isFinite(requestTimeoutMs) ||
      requestTimeoutMs <= 0
    ) {
      return boundedConfiguredTimeoutMs;
    }
    return Math.max(
      500,
      Math.min(boundedConfiguredTimeoutMs, Math.round(requestTimeoutMs)),
    );
  }

  private resolveConditionalPreflightMaxRetries(value: number): number {
    return Math.max(0, Math.min(5, Math.round(value)));
  }

  private shouldRetryConditionalPreflightStatus(status: number): boolean {
    return (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
  }

  async getConditionalRequestSettings(): Promise<ConditionalRequestSettings> {
    const fallback: ConditionalRequestSettings = {
      enabled: this.defaultConditionalRequestEnabled,
      timeoutMs: this.defaultConditionalRequestTimeoutMs,
      maxRetries: this.defaultConditionalRequestMaxRetries,
    };
    try {
      const settings = await this.crawlSettings.getSettings();
      return {
        enabled:
          typeof settings.conditionalRequestEnabled === "boolean"
            ? settings.conditionalRequestEnabled
            : fallback.enabled,
        timeoutMs:
          typeof settings.conditionalRequestTimeoutMs === "number" &&
          Number.isFinite(settings.conditionalRequestTimeoutMs)
            ? settings.conditionalRequestTimeoutMs
            : fallback.timeoutMs,
        maxRetries:
          typeof settings.conditionalRequestMaxRetries === "number" &&
          Number.isFinite(settings.conditionalRequestMaxRetries)
            ? settings.conditionalRequestMaxRetries
            : fallback.maxRetries,
      };
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to load crawl settings for conditional requests; using defaults",
      );
      return fallback;
    }
  }

  private buildConditionalPreflightHeaders(
    options: CrawlTaskOptions,
    validators: { etag?: string; lastModified?: string },
  ): Record<string, string> {
    const userAgent =
      typeof options.userAgent === "string" &&
      options.userAgent.trim().length > 0
        ? options.userAgent.trim()
        : "Mozilla/5.0 (compatible; CrawlConditionalProbe/1.0; +https://example.com)";
    const headers: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": userAgent,
    };
    if (validators.etag) {
      headers["if-none-match"] = validators.etag;
    }
    if (validators.lastModified) {
      headers["if-modified-since"] = validators.lastModified;
    }
    return headers;
  }

  private async requestConditionalUrlStatus(
    url: string,
    method: "HEAD" | "GET",
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<ConditionalPreflightResult | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await ssrfSafeFetch(
          url,
          method,
          headers,
          controller.signal,
        );
        if (!response) {
          return null;
        }
        if (method === "GET" && response.body) {
          await response.body.cancel().catch(() => undefined);
        }
        return {
          status: response.status,
          etag: response.headers.get("etag")?.trim() || undefined,
          lastModified:
            response.headers.get("last-modified")?.trim() || undefined,
          method,
          checkedAt: new Date().toISOString(),
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      logger.debug(
        { error, url, method },
        "HTTP validator preflight request failed",
      );
      return null;
    }
  }

  buildHttpValidationMetadata(
    preflightResult: ConditionalPreflightResult | null,
  ): Record<string, unknown> | null {
    if (!preflightResult) {
      return null;
    }
    const metadata: Record<string, unknown> = {
      httpValidationStatus: preflightResult.status,
      httpValidationMethod: preflightResult.method,
      httpValidationCheckedAt: preflightResult.checkedAt,
    };
    if (preflightResult.etag) {
      metadata.httpEtag = preflightResult.etag;
    }
    if (preflightResult.lastModified) {
      metadata.httpLastModified = preflightResult.lastModified;
    }
    return metadata;
  }

  attachHttpValidationMetadata(
    successes: Crawl4aiArticle[],
    metadata: Record<string, unknown> | null,
    targetUrl?: string,
  ): Crawl4aiArticle[] {
    if (!metadata || successes.length === 0) {
      return successes;
    }
    const targetFingerprint = targetUrl
      ? buildCanonicalUrlFingerprint(targetUrl, [])
      : null;
    return successes.map((article) => {
      // The preflight etag/lastModified describe the TARGET url only; writing
      // them onto detail-expansion articles pollutes their metadata and makes
      // the 304 reuse decision unstable (a detail row could masquerade as the
      // target's validation state).
      if (targetFingerprint) {
        const articleUrl =
          typeof article.url === "string" ? article.url.trim() : "";
        if (articleUrl.length > 0) {
          const articleFingerprint = buildCanonicalUrlFingerprint(
            articleUrl,
            [],
          );
          if (
            !articleFingerprint ||
            articleFingerprint.fingerprint !== targetFingerprint.fingerprint
          ) {
            return article;
          }
        }
      }
      const articleMetadata =
        article.metadata &&
        typeof article.metadata === "object" &&
        !Array.isArray(article.metadata)
          ? article.metadata
          : {};
      return {
        ...article,
        metadata: {
          ...articleMetadata,
          ...metadata,
        },
      };
    });
  }

  normalizeRequestTimeoutMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.max(1_000, Math.round(value));
  }
}
