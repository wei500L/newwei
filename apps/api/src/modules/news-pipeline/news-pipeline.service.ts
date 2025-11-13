import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@modular/utils";
import { CacheService } from "../cache/cache.service";
import { Crawl4aiClient, Crawl4aiArticle, Crawl4aiResponse } from "../crawl/crawl4ai.client";
import { TaskLogModel, ProcessedItemModel } from "@modular/mongo";
import { LiteLlmService } from "./litellm.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { NewsPromptBuilder } from "./news-prompt.builder";
import { CleanedNewsSchema, CleanedNews } from "./news-pipeline.schema";
import { CrawlCacheEntry, NormalizedNewsPayload, PipelineJobContext, RawPipelineItem } from "./news-pipeline.types";

@Injectable()
export class NewsPipelineService {
  private readonly logger = createLogger({ name: "news-pipeline" });
  private readonly crawlCachePrefix = "news:crawl:";

  constructor(
    private readonly crawlClient: Crawl4aiClient,
    private readonly liteLlm: LiteLlmService,
    private readonly configService: NewsPipelineConfigService,
    private readonly promptBuilder: NewsPromptBuilder,
    private readonly cache: CacheService
  ) {}

  async process(job: PipelineJobContext, raw: RawPipelineItem) {
    const payload = this.normalizePayload(raw.payload);
    await this.logStage(job, "normalize", "completed", {
      url: payload.url,
      forceRefresh: payload.forceRefresh
    });

    const article = await this.fetchArticle(payload, job);
    await this.logStage(job, "crawl", "completed", {
      url: article.sourceUrl,
      fromCache: article.fromCache,
      runId: article.runId
    });

    const cleaned = await this.cleanArticle(payload, article, job);
    await this.logStage(job, "llm", "completed", {
      model: cleaned.metadata.llmModel,
      totalTokens: cleaned.metadata.totalTokens
    });

    const processed = await ProcessedItemModel.create({
      rawItemId: raw.id,
      itemMetaId: job.itemMetaId,
      status: cleaned.status === "ok" ? "completed" : "failed",
      tags: this.buildTags(payload, cleaned),
      result: cleaned,
      error: cleaned.status === "error" ? cleaned.error ?? "cleaning failed" : undefined
    });

    await this.logStage(job, "persist", "completed", {
      processedId: processed._id.toString()
    });

    const document = processed.toJSON() as { id?: string };
    return {
      ...document,
      id: document.id ?? processed._id.toString()
    };
  }

  private async fetchArticle(payload: NormalizedNewsPayload, job: PipelineJobContext) {
    const cacheKey = this.cacheKey(payload.url);
    if (!payload.forceRefresh) {
      const cached = await this.cache.get<CrawlCacheEntry>(cacheKey);
      if (cached?.markdown) {
        return {
          sourceUrl: payload.url,
          markdown: cached.markdown,
          markdownWithCitations: cached.markdownWithCitations,
          referencesMarkdown: cached.referencesMarkdown,
          metadata: cached.metadata ?? {},
          publishedAt: cached.publishedAt ?? null,
          runId: cached.runId ?? null,
          fetchedAt: cached.fetchedAt ?? null,
          fromCache: true
        };
      }
    }

    const crawlResponse = await this.executeCrawl(payload);
    const article = this.pickSuccessfulArticle(crawlResponse);
    if (!article) {
      throw new Error("crawl4ai returned no successful article");
    }
    const normalized = this.normalizeArticle(article, payload.url);
    await this.cache.set(cacheKey, normalized, this.configService.config.pipeline.cacheTtlSeconds);
    return {
      ...normalized,
      fromCache: false
    };
  }

  private async executeCrawl(payload: NormalizedNewsPayload) {
    const cfg = this.configService.config.crawl4ai;
    const options = {
      ...cfg.crawlerDefaults,
      cleanMarkdown: cfg.cleanMarkdown ?? cfg.crawlerDefaults.cleanMarkdown,
      markdownOptions: cfg.markdown ?? cfg.crawlerDefaults.markdownOptions,
      userAgent: cfg.crawlerDefaults.userAgent ?? cfg.userAgent,
      ...payload.crawlOptions,
      userAgent: payload.crawlOptions?.userAgent ?? cfg.userAgent
    };
    const request = {
      url: payload.url,
      options
    };
    return this.retry(async () => this.crawlClient.crawl(request), 3, 2_000);
  }

  private pickSuccessfulArticle(response: Crawl4aiResponse) {
    if (!response.results || response.results.length === 0) {
      return null;
    }
    return response.results.find((article) => article.success !== false) ?? response.results[0];
  }

  private normalizeArticle(article: Crawl4aiArticle, url: string) {
    const markdown = this.extractMarkdown(article);
    if (!markdown) {
      throw new Error("Crawl result missing markdown");
    }
    return {
      sourceUrl: article.url ?? url,
      markdown,
      markdownWithCitations: typeof article.markdown === "object" ? (article.markdown as any).markdown_with_citations : undefined,
      referencesMarkdown: typeof article.markdown === "object" ? (article.markdown as any).references_markdown : undefined,
      metadata: article.metadata ?? {},
      publishedAt: article.publishedAt ?? null,
      runId: article.success === false ? null : (article as any).runId ?? null,
      fetchedAt: new Date().toISOString()
    };
  }

  private extractMarkdown(article: Crawl4aiArticle) {
    if (!article) {
      return "";
    }
    if (typeof article.markdown === "string") {
      return article.markdown;
    }
    if (article.markdown && typeof article.markdown === "object") {
      const record = article.markdown as Record<string, unknown>;
      return (
        (typeof record.fit_markdown === "string" ? record.fit_markdown : undefined) ??
        (typeof record.raw_markdown === "string" ? record.raw_markdown : undefined) ??
        (typeof record.markdown === "string" ? record.markdown : undefined) ??
        (typeof record.text === "string" ? record.text : undefined) ??
        ""
      );
    }
    return article.text ?? "";
  }

  private async cleanArticle(payload: NormalizedNewsPayload, article: ReturnType<typeof this.normalizeArticle> & { fromCache: boolean }, job: PipelineJobContext) {
    const pipelineCfg = this.configService.config.pipeline;
    const truncated = article.markdown.slice(0, pipelineCfg.maxInputChars);
    const response = await this.liteLlm.acompletion({
      messages: [
        { role: "system", content: this.promptBuilder.buildSystemPrompt(payload.language) },
        {
          role: "user",
          content: this.promptBuilder.buildUserPrompt({
            url: article.sourceUrl,
            markdown: truncated,
            metadata: {
              ...payload.metadata,
              publishedAt: article.publishedAt,
              sourceName: payload.sourceName
            },
            keywords: payload.keywords,
            summaryHints: payload.summaryHints,
            language: payload.language,
            cacheHit: article.fromCache
          })
        }
      ],
      response_format: this.promptBuilder.buildResponseFormat(),
      metadata: {
        jobId: job.jobId,
        source: "news-pipeline"
      }
    });

    const cleaned = this.parseResponse(response);
    return {
      ...cleaned,
      metadata: {
        ...cleaned.metadata,
        crawlRunId: article.runId,
        fetchedAt: article.fetchedAt,
        llmModel: response.model,
        totalTokens: response.usage?.total_tokens ?? null
      }
    };
  }

  private parseResponse(response: Awaited<ReturnType<LiteLlmService["acompletion"]>>): CleanedNews {
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LiteLLM returned empty content");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      this.logger.error({ error }, "Failed to parse LiteLLM JSON output");
      throw new Error("LiteLLM return was not valid JSON");
    }
    return CleanedNewsSchema.parse(parsed);
  }

  private buildTags(payload: NormalizedNewsPayload, cleaned: CleanedNews) {
    const derived = new Set<string>();
    payload.tags.forEach((tag) => derived.add(tag));
    cleaned.keywords.forEach((keyword) => derived.add(keyword.toLowerCase()));
    return Array.from(derived).slice(0, 20);
  }

  private normalizePayload(payload: Record<string, unknown>): NormalizedNewsPayload {
    const url = typeof payload.url === "string" ? payload.url.trim() : "";
    if (!url) {
      throw new Error("raw payload must include url");
    }
    const keywords = Array.isArray(payload.keywords)
      ? payload.keywords.map((keyword) => (typeof keyword === "string" ? keyword.trim() : "")).filter(Boolean)
      : [];
    const tags = Array.isArray(payload.tags)
      ? payload.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean)
      : [];
    const summaryHints = Array.isArray(payload.summaryHints)
      ? payload.summaryHints.map((hint) => (typeof hint === "string" ? hint.trim() : "")).filter(Boolean)
      : [];
    const crawlOptions =
      typeof payload.crawlOptions === "object" && payload.crawlOptions ? (payload.crawlOptions as Partial<NormalizedNewsPayload["crawlOptions"]>) : undefined;

    return {
      url,
      language: typeof payload.language === "string" ? payload.language : undefined,
      sourceName: typeof payload.sourceName === "string" ? payload.sourceName : undefined,
      keywords,
      tags,
      metadata: typeof payload.metadata === "object" && payload.metadata ? (payload.metadata as Record<string, unknown>) : {},
      crawlOptions,
      forceRefresh: Boolean(payload.forceRefresh),
      summaryHints
    };
  }

  private cacheKey(url: string) {
    const hash = createHash("sha256").update(url).digest("hex");
    return `${this.crawlCachePrefix}${hash}`;
  }

  private async retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number) {
    let tries = 0;
    let lastError: unknown;
    while (tries < attempts) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        tries += 1;
        if (tries >= attempts) {
          throw error;
        }
        await sleep(delayMs * tries);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("operation failed");
  }

  private async logStage(
    job: PipelineJobContext,
    stage: string,
    status: "pending" | "processing" | "completed" | "failed",
    data?: Record<string, unknown>,
    error?: unknown
  ) {
    await TaskLogModel.create({
      queue: job.queue,
      jobId: job.jobId,
      stage,
      status,
      data,
      error: error
        ? {
            message: error instanceof Error ? error.message : String(error)
          }
        : undefined
    });
  }
}
