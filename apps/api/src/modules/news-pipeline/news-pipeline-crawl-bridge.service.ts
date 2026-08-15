import { CrawlResultContentModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";
import { CrawlExecutionService } from "../crawl/crawl-execution.service";
import { assertNoCrawl4aiLlmOptions } from "../crawl/crawl4ai-llm.guard";
import { buildCanonicalUrlFingerprint } from "../crawl/url-fingerprint";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import {
  extractSeedDedupeWindowHours,
  extractUrlQueryParamAllowlist,
  isLikelyBotChallengeMarkdown,
  selectBestMarkdownFromContentDoc,
} from "./news-pipeline-internal";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { type NormalizedNewsPayload } from "./news-pipeline.schema";

@Injectable()
export class NewsPipelineCrawlBridgeService {
  private readonly crawlActorByOrgId = new Map<string, string>();

  constructor(
    private readonly configService: NewsPipelineConfigService,
    private readonly prisma: PrismaService,
    private readonly crawlExecution: CrawlExecutionService,
  ) {}

  private buildCrawlTaskOptions(
    payload: NormalizedNewsPayload,
  ): Record<string, unknown> {
    const cfg = this.configService.config.crawl4ai;
    const options = {
      ...cfg.crawlerDefaults,
      cleanMarkdown: cfg.cleanMarkdown ?? cfg.crawlerDefaults.cleanMarkdown,
      markdownOptions: cfg.markdown ?? cfg.crawlerDefaults.markdownOptions,
      ...payload.crawlOptions,
      userAgent:
        payload.crawlOptions?.userAgent ??
        cfg.crawlerDefaults.userAgent ??
        cfg.userAgent,
    };
    assertNoCrawl4aiLlmOptions(options, "newsPipeline.crawlOptions");
    return options;
  }

  private async resolveCrawlActorId(orgId: string): Promise<string | null> {
    const cached = this.crawlActorByOrgId.get(orgId);
    if (cached) {
      return cached;
    }

    const membership = await this.prisma.membership.findFirst({
      where: { orgId },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });

    const userId =
      typeof membership?.userId === "string" ? membership.userId : "";
    if (!userId) {
      return null;
    }

    this.crawlActorByOrgId.set(orgId, userId);
    return userId;
  }

  async findRecentStoredCrawlResultId(options: {
    orgId: string;
    url: string;
    since: Date;
    queryParamAllowlist?: string[];
  }): Promise<string | null> {
    const canonical = buildCanonicalUrlFingerprint(
      options.url,
      options.queryParamAllowlist,
    );

    if (canonical) {
      const fingerprintMatch = await this.prisma.crawlResult.findFirst({
        where: {
          orgId: options.orgId,
          sourceUrlFingerprint: canonical.fingerprint,
          fetchedAt: { gte: options.since },
        },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      });
      if (fingerprintMatch?.id) {
        return fingerprintMatch.id;
      }
    }

    const fallback = await this.prisma.crawlResult.findFirst({
      where: {
        sourceUrl: options.url,
        fetchedAt: { gte: options.since },
        orgId: options.orgId,
      },
      orderBy: { fetchedAt: "desc" },
      select: { id: true },
    });
    return fallback?.id ?? null;
  }

  async crawlViaCrawlTask(options: {
    orgId: string;
    url: string;
    payload: NormalizedNewsPayload;
  }): Promise<{ crawlResultId: string; crawlTaskId: string }> {
    const crawlOptions = this.buildCrawlTaskOptions(options.payload);
    const urlQueryParamAllowlist = extractUrlQueryParamAllowlist(
      options.payload,
    );
    const orgContentDedupeWindowHours = extractSeedDedupeWindowHours(
      options.payload,
    );
    const crawlTaskConfig: Record<string, unknown> = {
      ...crawlOptions,
      ...(urlQueryParamAllowlist.length > 0 ? { urlQueryParamAllowlist } : {}),
      ...(typeof orgContentDedupeWindowHours === "number"
        ? { orgContentDedupeWindowHours }
        : {}),
    };
    const displayNameLabel = options.payload.sourceName?.trim()
      ? options.payload.sourceName.trim()
      : (() => {
          try {
            return new URL(options.url).hostname;
          } catch {
            return options.url;
          }
        })();
    const displayName = `NewsPipeline: ${displayNameLabel}`.slice(0, 80);

    const existingTask = await this.prisma.crawlTask.findFirst({
      where: {
        orgId: options.orgId,
        targetUrl: options.url,
        OR: [
          { displayName: { startsWith: "NewsPipeline:" } },
          { displayName: { startsWith: "NewsSource:" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    let crawlTaskId: string;
    if (existingTask) {
      crawlTaskId = existingTask.id;
      await this.prisma.crawlTask.update({
        where: { id: crawlTaskId },
        data: {
          displayName,
          keywords: toPrismaJsonValue(options.payload.keywords),
          config: toPrismaJsonValue(crawlTaskConfig),
        },
        select: { id: true },
      });
    } else {
      const actorId = await this.resolveCrawlActorId(options.orgId);
      if (!actorId) {
        throw new Error("crawl task actor unavailable");
      }

      const createdTask = await this.prisma.crawlTask.create({
        data: {
          orgId: options.orgId,
          createdById: actorId,
          targetUrl: options.url,
          displayName,
          status: "pending",
          concurrency: 1,
          keywords: toPrismaJsonValue(options.payload.keywords),
          config: toPrismaJsonValue(crawlTaskConfig),
        },
        select: { id: true },
      });
      crawlTaskId = createdTask.id;
    }

    const executionSummary = await this.crawlExecution.runTask(
      crawlTaskId,
      options.orgId,
    );
    const reusedResultId =
      typeof executionSummary.reusedResultId === "string" &&
      executionSummary.reusedResultId.trim().length > 0
        ? executionSummary.reusedResultId.trim()
        : null;

    const preferredResult =
      (reusedResultId
        ? await this.prisma.crawlResult.findFirst({
            where: {
              id: reusedResultId,
              orgId: options.orgId,
            },
            select: { id: true },
          })
        : null) ??
      (await this.prisma.crawlResult.findFirst({
        where: { taskId: crawlTaskId, sourceUrl: options.url },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      })) ??
      (await this.prisma.crawlResult.findFirst({
        where: { taskId: crawlTaskId },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      }));

    if (!preferredResult) {
      throw new Error("crawl task produced no results");
    }

    const crawlResultId = await this.selectBestPipelineCrawlResultId({
      orgId: options.orgId,
      crawlTaskId,
      preferredResultId: preferredResult.id,
      preferredSourceUrl: options.url,
    });

    return { crawlResultId, crawlTaskId };
  }

  private async selectBestPipelineCrawlResultId(options: {
    orgId: string;
    crawlTaskId: string;
    preferredResultId: string;
    preferredSourceUrl: string;
  }): Promise<string> {
    const findMany = (
      this.prisma.crawlResult as {
        findMany?: (args: unknown) => Promise<unknown>;
      }
    ).findMany;
    if (typeof findMany !== "function") {
      return options.preferredResultId;
    }

    const rows = (await findMany({
      where: {
        taskId: options.crawlTaskId,
        task: { orgId: options.orgId },
      },
      orderBy: { fetchedAt: "desc" },
      take: 12,
      select: {
        id: true,
        sourceUrl: true,
      },
    })) as
      | {
          id?: unknown;
          sourceUrl?: unknown;
        }[]
      | null;

    if (!Array.isArray(rows) || rows.length === 0) {
      return options.preferredResultId;
    }

    const contentByResultId =
      await this.loadPipelineCrawlResultCandidateContent(
        rows
          .map((row) => (typeof row.id === "string" ? row.id : ""))
          .filter((candidateId) => candidateId.length > 0),
      );

    let bestId = options.preferredResultId;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      const candidateId = typeof row.id === "string" ? row.id : "";
      if (!candidateId) {
        continue;
      }
      const candidateSourceUrl =
        typeof row.sourceUrl === "string" ? row.sourceUrl : "";

      const score = await this.scorePipelineCrawlResultCandidate({
        sourceUrl: candidateSourceUrl,
        contentDoc: contentByResultId.get(candidateId),
        preferredSourceUrl: options.preferredSourceUrl,
      });

      if (score > bestScore) {
        bestScore = score;
        bestId = candidateId;
      }
    }

    if (bestId !== options.preferredResultId) {
      await writeTaskLogBestEffort({
        queue: "news_pipeline",
        jobId: options.crawlTaskId,
        orgId: options.orgId,
        stage: "crawl",
        status: "completed",
        message: "Selected alternative crawl result for higher content quality",
        data: {
          preferredResultId: options.preferredResultId,
          selectedResultId: bestId,
          preferredSourceUrl: options.preferredSourceUrl,
        },
      });
    }

    return bestId;
  }

  private async loadPipelineCrawlResultCandidateContent(resultIds: string[]) {
    const normalizedIds = [
      ...new Set(resultIds.map((resultId) => resultId.trim()).filter(Boolean)),
    ];
    if (normalizedIds.length === 0) {
      return new Map<string, Record<string, unknown>>();
    }

    const docs = await CrawlResultContentModel.find(
      { resultId: { $in: normalizedIds } },
      {
        resultId: 1,
        markdown: 1,
        markdownWithCitations: 1,
        rawMarkdown: 1,
        fitMarkdown: 1,
      },
    ).lean();

    const byResultId = new Map<string, Record<string, unknown>>();
    if (!Array.isArray(docs)) {
      return byResultId;
    }

    for (const doc of docs) {
      if (!doc || typeof doc !== "object") {
        continue;
      }
      const record = doc as Record<string, unknown>;
      const resultId =
        typeof record.resultId === "string" ? record.resultId.trim() : "";
      if (!resultId) {
        continue;
      }
      byResultId.set(resultId, record);
    }

    return byResultId;
  }

  private async scorePipelineCrawlResultCandidate(options: {
    sourceUrl: string;
    contentDoc?: Record<string, unknown>;
    preferredSourceUrl: string;
  }): Promise<number> {
    if (!options.contentDoc) {
      return Number.NEGATIVE_INFINITY;
    }

    const selectedMarkdown = selectBestMarkdownFromContentDoc(
      options.contentDoc,
    );
    if (!selectedMarkdown) {
      return Number.NEGATIVE_INFINITY;
    }

    const normalized = selectedMarkdown.trim();
    if (!normalized) {
      return Number.NEGATIVE_INFINITY;
    }

    const words = normalized
      .split(/\s+/)
      .filter((entry) => entry.length > 0).length;
    const paragraphs = normalized
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;
    const isChallenge = isLikelyBotChallengeMarkdown(normalized);

    let score =
      Math.min(normalized.length, 24_000) +
      Math.min(words, 12_000) +
      Math.min(paragraphs, 200) * 4;

    if (options.sourceUrl === options.preferredSourceUrl) {
      score += 120;
    }

    if (isChallenge) {
      score -= 16_000;
    }

    return score;
  }
}
