import { CrawlResultContentModel, TaskLogModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { CrawlResult, CrawlTask } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { EnvService } from "../config/config.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { ItemsService } from "../items/items.service";

import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import type {
  CrawlExecutionSummary,
  CrawlLinkAnalysis,
  Crawl4aiTablePayload,
  CrawlMediaCollection,
  CrawlMediaItem,
  CrawlMediaSource,
  CrawlMemoryStats,
  CrawlResultTable,
  CrawlStoredMediaAsset,
  CrawlTableCell,
  CrawlTaskOptions,
  CrawlTaskResult
} from "./crawl.types";
import { coerceDate, hashMarkdown } from "./crawl.utils";
import type { Crawl4aiArticle } from "./crawl4ai.client";
import { buildLinkAnalysis } from "./link-analysis";


const logger = createLogger({ name: "crawl-result-service" });

interface CrawlMediaConfig {
  fetchTimeoutMs: number;
  maxBytes: number;
  maxPerResult: number;
}

@Injectable()
export class CrawlResultService {
  private readonly mediaReservedKeys = new Set([
    "src",
    "url",
    "href",
    "alt",
    "title",
    "desc",
    "description",
    "caption",
    "type",
    "media_type",
    "mediaType",
    "format",
    "mime",
    "mimeType",
    "width",
    "height",
    "score",
    "poster",
    "thumbnail",
    "sizes",
    "srcset",
    "srcSet",
    "sources",
    "picture_sources",
    "pictureSources",
    "responsive_images",
    "responsiveImages"
  ]);
  private readonly mediaConfig: CrawlMediaConfig;
  private itemsService?: ItemsService | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    @Inject(MONGO_CONNECTION) private readonly mongo: MongoConnection,
    private readonly moduleRef: ModuleRef
  ) {
    void this.mongo;
    this.mediaConfig = env.crawl4aiConfig.media;
  }

  private resolveItemsService(): ItemsService | null {
    if (this.itemsService !== undefined) {
      return this.itemsService;
    }
    try {
      this.itemsService = this.moduleRef.get(ItemsService, { strict: false });
    } catch (error) {
      logger.warn({ err: error }, "ItemsService unavailable; skipping crawl ingestion");
      this.itemsService = null;
    }
    return this.itemsService;
  }

  async persistResults(
    task: CrawlTask,
    items: Crawl4aiArticle[],
    options: CrawlTaskOptions,
    runId?: string,
    memory?: CrawlMemoryStats,
    ingestToItems?: { orgId: string; userId: string }
  ): Promise<CrawlExecutionSummary> {
    const startTime = Date.now();

    if (!items || items.length === 0) {
      return {
        inserted: 0,
        skipped: 0,
        runId
      };
    }

    let inserted = 0;
    let skipped = 0;
    let latestResultAt: Date | undefined;
    let itemsQueued = 0;
    let itemsQueueFailed = 0;
    const itemsService = ingestToItems ? this.resolveItemsService() : null;
    const shouldStoreMedia = options.storeMedia ?? false;

    // Phase 1: Pre-compute all content hashes and extract markdown
    const itemsWithHash: {
      item: Crawl4aiArticle;
      markdown: string;
      markdownResult: ReturnType<CrawlResultService["extractMarkdownResult"]>;
      hash: string;
    }[] = [];

    for (const item of items) {
      const markdownResult = this.extractMarkdownResult(item.markdown);
      const markdown = markdownResult.primary ?? "";
      if (!markdown) {
        skipped += 1;
        continue;
      }
      const hash = hashMarkdown(markdown);
      itemsWithHash.push({ item, markdown, markdownResult, hash });
    }

    if (itemsWithHash.length === 0) {
      logger.debug({ duration: Date.now() - startTime, skipped }, "persistResults completed (all items skipped)");
      return {
        inserted: 0,
        skipped,
        runId
      };
    }

    // Phase 2: Batch query existing records with findMany
    const allHashes = itemsWithHash.map((i) => i.hash);
    const existingRecords = await this.prisma.crawlResult.findMany({
      where: {
        taskId: task.id,
        contentHash: { in: allHashes }
      }
    });
    const existingMap = new Map(existingRecords.map((r) => [r.contentHash, r]));

    logger.debug(
      { hashCount: allHashes.length, existingCount: existingRecords.length },
      "persistResults batch hash lookup complete"
    );

    // Phase 3: Separate new items from existing ones
    const newItems: typeof itemsWithHash = [];
    const existingItems: { item: Crawl4aiArticle; existing: CrawlResult }[] = [];

    for (const entry of itemsWithHash) {
      const existing = existingMap.get(entry.hash);
      if (existing) {
        skipped += 1;
        existingItems.push({ item: entry.item, existing });
      } else {
        newItems.push(entry);
      }
    }

    // Phase 4: Batch create new CrawlResult records
    interface NewRecordData {
      taskId: string;
      sourceUrl: string;
      fetchedAt: Date;
      markdownRef: string;
      contentHash: string;
      metadata: ReturnType<typeof toPrismaJsonValue>;
      entry: (typeof itemsWithHash)[0];
    }

    const newRecordsData: NewRecordData[] = newItems.map((entry) => {
      const fetchedAt = coerceDate(entry.item.publishedAt) ?? new Date();
      if (!latestResultAt || fetchedAt > latestResultAt) {
        latestResultAt = fetchedAt;
      }
      return {
        taskId: task.id,
        sourceUrl: entry.item.url ?? task.targetUrl,
        fetchedAt,
        markdownRef: "",
        contentHash: entry.hash,
        metadata: toPrismaJsonValue(entry.item.metadata ?? {}),
        entry
      };
    });

    if (newRecordsData.length > 0) {
      // Batch create Prisma records
      await this.prisma.crawlResult.createMany({
        data: newRecordsData.map((r) => ({
          taskId: r.taskId,
          sourceUrl: r.sourceUrl,
          fetchedAt: r.fetchedAt,
          markdownRef: r.markdownRef,
          contentHash: r.contentHash,
          metadata: r.metadata
        })),
        skipDuplicates: true
      });

      // Query back created records for IDs
      const createdRecords = await this.prisma.crawlResult.findMany({
        where: {
          taskId: task.id,
          contentHash: { in: newRecordsData.map((r) => r.contentHash) }
        }
      });
      const createdMap = new Map(createdRecords.map((r) => [r.contentHash, r]));

      logger.debug({ newCount: newRecordsData.length, createdCount: createdRecords.length }, "persistResults batch create complete");

      // Phase 5: Batch create MongoDB content documents
      const contentDocsData: {
        taskId: string;
        resultId: string;
        markdown: string;
        rawMarkdown: string;
        markdownWithCitations?: string;
        referencesMarkdown?: string;
        fitMarkdown?: string;
        metadata: Record<string, unknown>;
        sourceUrl: string;
        crawlRunId?: string;
        linkAnalysis?: CrawlLinkAnalysis;
        tables: CrawlResultTable[] | null;
        media?: CrawlMediaCollection | null;
        mediaAssets?: CrawlStoredMediaAsset[] | null;
      }[] = [];

      for (const recordData of newRecordsData) {
        const created = createdMap.get(recordData.contentHash);
        if (!created) {
          continue;
        }

        const { entry } = recordData;
        const linkAnalysis = this.extractLinkAnalysisFromResult(entry.item);
        const media = shouldStoreMedia ? this.normalizeMediaCollection(entry.item.media) : undefined;
        const mediaAssets = shouldStoreMedia ? await this.collectMediaAssets(media) : undefined;
        const tables = this.normalizeTablesFromResult(entry.item);

        contentDocsData.push({
          taskId: task.id,
          resultId: created.id,
          markdown: entry.markdown,
          rawMarkdown: entry.markdownResult.raw ?? entry.markdown,
          markdownWithCitations: entry.markdownResult.citations,
          referencesMarkdown: entry.markdownResult.references,
          fitMarkdown: entry.markdownResult.fit,
          metadata: entry.item.metadata ?? {},
          sourceUrl: entry.item.url ?? task.targetUrl,
          crawlRunId: runId,
          linkAnalysis,
          tables: tables ?? null,
          ...(shouldStoreMedia
            ? {
                media: media ?? null,
                mediaAssets: mediaAssets ?? null
              }
            : {})
        });
      }

      // Batch insert MongoDB documents
      const insertedDocs = await CrawlResultContentModel.insertMany(contentDocsData);

      logger.debug({ docCount: insertedDocs.length }, "persistResults batch MongoDB insert complete");

      // Phase 6: Batch update markdownRef references
      const markdownRefUpdates = contentDocsData.map((doc, index) => ({
        resultId: doc.resultId,
        markdownRef: insertedDocs[index]?._id?.toString() ?? ""
      }));

      if (markdownRefUpdates.length > 0) {
        await this.prisma.$transaction(
          markdownRefUpdates.map((u) =>
            this.prisma.crawlResult.update({
              where: { id: u.resultId },
              data: { markdownRef: u.markdownRef }
            })
          )
        );
      }

      inserted = createdRecords.length;
    }

    // Phase 7: Batch items ingestion with concurrency limiting
    if (ingestToItems && itemsService) {
      const allResultIds: string[] = [
        ...existingItems.map((e) => e.existing.id),
        ...newRecordsData
          .map((r) => {
            const created = existingMap.get(r.contentHash) ??
              (newRecordsData.length > 0 ? undefined : undefined);
            return created?.id;
          })
          .filter((id): id is string => Boolean(id))
      ];

      // Get IDs for newly created records
      if (newRecordsData.length > 0) {
        const createdRecords = await this.prisma.crawlResult.findMany({
          where: {
            taskId: task.id,
            contentHash: { in: newRecordsData.map((r) => r.contentHash) }
          },
          select: { id: true }
        });
        allResultIds.push(...createdRecords.map((r) => r.id));
      }

      // Deduplicate IDs
      const uniqueResultIds = [...new Set(allResultIds)];

      // Process ingestion with concurrency limit of 10
      const CONCURRENCY_LIMIT = 10;
      for (let i = 0; i < uniqueResultIds.length; i += CONCURRENCY_LIMIT) {
        const batch = uniqueResultIds.slice(i, i + CONCURRENCY_LIMIT);
        const results = await Promise.allSettled(
          batch.map((id) =>
            itemsService.createFromCrawlResult(ingestToItems.orgId, ingestToItems.userId, id)
          )
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            itemsQueued += 1;
          } else {
            itemsQueueFailed += 1;
            logger.warn(
              { err: result.reason, taskId: task.id, orgId: task.orgId },
              "Failed to ingest crawl result into Items"
            );
          }
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info(
      { duration, inserted, skipped, itemsQueued, itemsQueueFailed },
      "persistResults completed"
    );

    return {
      inserted,
      skipped,
      ...(ingestToItems ? { itemsQueued, itemsQueueFailed } : {}),
      lastFetchedAt: latestResultAt,
      runId,
      memory
    };
  }

  async attachResultContent(results: CrawlResult[]): Promise<CrawlTaskResult[]> {
    if (results.length === 0) {
      return [];
    }

    const ids = results.map((result) => result.id);
    const docs = await CrawlResultContentModel.find({ resultId: { $in: ids } })
      .lean()
      .exec();
    const docMap = new Map(docs.map((doc) => [doc.resultId as string, doc]));

    return results.map((result) => {
      const doc = docMap.get(result.id);
      return {
        id: result.id,
        sourceUrl: result.sourceUrl,
        fetchedAt: result.fetchedAt,
        markdown: (doc?.markdown as string) ?? "",
        metadata: (result.metadata as Record<string, unknown> | null) ?? doc?.metadata ?? null,
        markdownWithCitations: this.ensureString(doc?.markdownWithCitations),
        referencesMarkdown: this.ensureString(doc?.referencesMarkdown),
        fitMarkdown: this.ensureString(doc?.fitMarkdown),
        linkAnalysis: (doc?.linkAnalysis as CrawlLinkAnalysis | undefined) ?? null,
        media: (doc?.media as CrawlMediaCollection | undefined) ?? null,
        mediaAssets: (doc?.mediaAssets as CrawlStoredMediaAsset[] | undefined) ?? null,
        tables: (doc?.tables as CrawlResultTable[] | undefined) ?? null
      };
    });
  }

  async getLatestMemoryStats(orgId: string, taskId: string): Promise<CrawlMemoryStats | null> {
    const log = await TaskLogModel.findOne({
      queue: CRAWL_QUEUE_NAME,
      jobId: taskId,
      orgId,
      stage: "complete"
    })
      .sort({ createdAt: -1 })
      .lean();

    const stats = log?.data?.memory as CrawlMemoryStats | undefined;
    return stats ?? null;
  }

  async getLatestExecutionSummary(orgId: string, taskId: string): Promise<CrawlExecutionSummary | null> {
    const log = await TaskLogModel.findOne({
      queue: CRAWL_QUEUE_NAME,
      jobId: taskId,
      orgId,
      stage: "complete"
    })
      .sort({ createdAt: -1 })
      .lean();

    const data = log?.data && typeof log.data === "object" && !Array.isArray(log.data) ? (log.data as any) : null;
    if (!data) {
      return null;
    }

    const inserted = typeof data.inserted === "number" && Number.isFinite(data.inserted) ? data.inserted : null;
    const skipped = typeof data.skipped === "number" && Number.isFinite(data.skipped) ? data.skipped : null;
    if (inserted === null || skipped === null) {
      return null;
    }

    const summary: CrawlExecutionSummary = {
      inserted,
      skipped
    };

    if (typeof data.itemsQueued === "number" && Number.isFinite(data.itemsQueued)) {
      summary.itemsQueued = data.itemsQueued;
    }
    if (typeof data.itemsQueueFailed === "number" && Number.isFinite(data.itemsQueueFailed)) {
      summary.itemsQueueFailed = data.itemsQueueFailed;
    }
    if (data.lastFetchedAt instanceof Date) {
      summary.lastFetchedAt = data.lastFetchedAt;
    } else if (typeof data.lastFetchedAt === "string") {
      const parsed = new Date(data.lastFetchedAt);
      if (!Number.isNaN(parsed.getTime())) {
        summary.lastFetchedAt = parsed;
      }
    }
    if (typeof data.runId === "string") {
      summary.runId = data.runId;
    }
    if (typeof data.retryableFailures === "number" && Number.isFinite(data.retryableFailures)) {
      summary.retryableFailures = data.retryableFailures;
    }

    return summary;
  }

  async deleteTaskResults(taskId: string, orgId: string) {
    await Promise.all([
      CrawlResultContentModel.deleteMany({ taskId }).exec(),
      TaskLogModel.deleteMany({ orgId, jobId: { $regex: `^${taskId}` } }).exec()
    ]);
  }

  extractMarkdownResult(markdown: unknown) {
    if (!markdown) {
      return { primary: undefined } as const;
    }
    if (typeof markdown === "string") {
      const normalized = this.normalizeMarkdownCandidate(markdown);
      return {
        primary: normalized,
        raw: normalized
      } as const;
    }
    if (typeof markdown !== "object") {
      return { primary: undefined } as const;
    }

    const record = markdown as Record<string, unknown>;
    const raw = this.normalizeMarkdownCandidate(
      this.ensureString(record.raw_markdown) ??
        this.ensureString(record.rawMarkdown) ??
        this.ensureString(record.markdown)
    );
    const citations = this.normalizeMarkdownCandidate(
      this.ensureString(record.markdown_with_citations) ?? this.ensureString(record.markdownWithCitations)
    );
    const citationsBody = citations ? this.stripCitationReferenceSection(citations) : undefined;
    const references = this.normalizeMarkdownCandidate(
      this.ensureString(record.references_markdown) ?? this.ensureString(record.referencesMarkdown)
    );
    const fit = this.normalizeMarkdownCandidate(
      this.ensureString(record.fit_markdown) ?? this.ensureString(record.fitMarkdown)
    );
    const textFallback = this.normalizeMarkdownCandidate(this.ensureString(record.text));

    const candidates: {
      source: "raw" | "citations" | "fit" | "references" | "text";
      value: string;
    }[] = [];

    if (citationsBody) {
      candidates.push({ source: "citations", value: citationsBody });
    }
    if (raw) {
      candidates.push({ source: "raw", value: raw });
    }
    if (fit) {
      candidates.push({ source: "fit", value: fit });
    }
    if (references) {
      candidates.push({ source: "references", value: references });
    }
    if (textFallback) {
      candidates.push({ source: "text", value: textFallback });
    }

    const maxNonReferenceLength = candidates
      .filter((candidate) => candidate.source !== "references")
      .reduce((maxLength, candidate) => Math.max(maxLength, candidate.value.length), 0);

    const scoredCandidates = candidates
      .map((candidate) => {
        return {
          ...candidate,
          score: this.scoreMarkdownCandidate(candidate.value, candidate.source, maxNonReferenceLength)
        };
      })
      .sort((left, right) => right.score - left.score || right.value.length - left.value.length);

    let bestCandidate = scoredCandidates[0];
    const richerCandidate = this.selectRicherPrimaryCandidate(scoredCandidates);
    if (bestCandidate && richerCandidate && this.shouldPreferRicherCandidate(bestCandidate, richerCandidate)) {
      bestCandidate = richerCandidate;
    }

    const fallback = bestCandidate?.value ?? citationsBody ?? raw ?? fit ?? references ?? textFallback;

    return {
      primary: fallback,
      raw: raw ?? fallback,
      citations,
      references,
      fit
    } as const;
  }

  private scoreMarkdownCandidate(
    markdown: string,
    source: "raw" | "citations" | "fit" | "references" | "text",
    maxCandidateLength: number
  ): number {
    const trimmed = markdown.trim();
    if (!trimmed) {
      return Number.NEGATIVE_INFINITY;
    }

    if (this.isLikelyBotChallengeMarkdown(trimmed)) {
      return -5000;
    }

    const carriageReturn = String.fromCharCode(13);
    const newLine = String.fromCharCode(10);
    const tab = String.fromCharCode(9);
    const paragraphSeparator = newLine + newLine;

    const normalizedSpaces = trimmed
      .replaceAll(carriageReturn, " ")
      .replaceAll(newLine, " ")
      .replaceAll(tab, " ");

    const wordCount = normalizedSpaces
      .split(" ")
      .map((word) => word.trim())
      .filter((word) => word.length > 0).length;

    const headingCount = trimmed
      .split(newLine)
      .map((line) => line.trimStart())
      .filter((line) => line.startsWith("#")).length;

    const citationCount = this.countOccurrences(trimmed, "[^");
    const markdownLinkCount = this.countOccurrences(trimmed, "](");
    const paragraphCount = trimmed
      .split(paragraphSeparator)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;

    let score =
      Math.min(wordCount, 12000) +
      headingCount * 8 +
      citationCount * 3 +
      Math.min(paragraphCount, 160) * 2 -
      markdownLinkCount * 3;

    score -= this.estimateNavigationNoisePenalty(trimmed);

    const coverageRatio =
      maxCandidateLength > 0 ? Math.min(2, trimmed.length / maxCandidateLength) : 1;

    if (source === "citations") {
      score += 30;
    }
    if (source === "fit") {
      score -= 60;
      if (maxCandidateLength >= 1200 && coverageRatio < 0.45) {
        score -= 260;
      }
    }
    if (source === "references") {
      score -= 140;
    }
    if (source === "text") {
      score -= 20;
    }
    if ((source === "raw" || source === "citations") && coverageRatio >= 0.45) {
      score += Math.round(Math.min((coverageRatio - 0.45) * 180, 120));
    }

    return score;
  }

  private selectRicherPrimaryCandidate(
    candidates: {
      source: "raw" | "citations" | "fit" | "references" | "text";
      value: string;
      score: number;
    }[]
  ) {
    const richerCandidates = candidates.filter(
      (candidate) =>
        (candidate.source === "citations" || candidate.source === "raw") &&
        !this.isLikelyBotChallengeMarkdown(candidate.value)
    );

    if (richerCandidates.length === 0) {
      return undefined;
    }

    return richerCandidates.sort((left, right) => right.value.length - left.value.length || right.score - left.score)[0];
  }

  private shouldPreferRicherCandidate(
    current: {
      source: "raw" | "citations" | "fit" | "references" | "text";
      value: string;
      score: number;
    },
    richer: {
      source: "raw" | "citations" | "fit" | "references" | "text";
      value: string;
      score: number;
    }
  ) {
    const currentTrimmed = current.value.trim();
    const richerTrimmed = richer.value.trim();
    if (!currentTrimmed || !richerTrimmed) {
      return false;
    }

    const currentIsChallenge = this.isLikelyBotChallengeMarkdown(currentTrimmed);
    const richerIsChallenge = this.isLikelyBotChallengeMarkdown(richerTrimmed);
    if (currentIsChallenge && !richerIsChallenge) {
      return true;
    }

    const currentLength = currentTrimmed.length;
    const richerLength = richerTrimmed.length;

    if (current.source === "fit" && richerLength >= 1600 && currentLength <= 800) {
      return true;
    }

    if (richerLength >= 1200 && currentLength < richerLength * 0.33 && current.score - richer.score <= 420) {
      return true;
    }

    return false;
  }

  private stripCitationReferenceSection(markdown: string): string {
    const newLine = String.fromCharCode(10);
    const lines = markdown.split(newLine);
    const referenceStartIndex = lines.findIndex((line) => /^\[\^[^\]]+\]:/.test(line.trim()));
    if (referenceStartIndex <= 0) {
      return markdown;
    }
    const body = lines.slice(0, referenceStartIndex).join(newLine).trim();
    return body.length > 0 ? body : markdown;
  }

  private estimateNavigationNoisePenalty(markdown: string): number {
    const newLine = String.fromCharCode(10);
    const lines = markdown
      .split(newLine)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 10) {
      return 0;
    }

    const noiseLikeLines = lines.filter((line) => {
      if (line.length > 80) {
        return false;
      }
      const hasSentencePunctuation = [".", "!", "?", "。", "！", "？"].some((token) => line.includes(token));
      if (hasSentencePunctuation) {
        return false;
      }
      return (
        line.startsWith("- ") ||
        line.startsWith("* ") ||
        line.startsWith("• ") ||
        line.includes("|") ||
        line.includes("›") ||
        line.includes("»") ||
        line.includes("⟨") ||
        line.includes("https://") ||
        line.includes("http://")
      );
    }).length;

    const ratio = noiseLikeLines / lines.length;
    if (ratio < 0.35) {
      return 0;
    }

    return Math.round(ratio * 1200);
  }

  private countOccurrences(value: string, needle: string): number {
    if (!value || !needle) {
      return 0;
    }
    let count = 0;
    let fromIndex = 0;
    while (fromIndex < value.length) {
      const next = value.indexOf(needle, fromIndex);
      if (next === -1) {
        break;
      }
      count += 1;
      fromIndex = next + needle.length;
    }
    return count;
  }

  public isLikelyBotChallengeMarkdown(markdown: string): boolean {
    const normalized = markdown.toLowerCase();

    const strongIndicators = [
      "verification required",
      "please enable js and disable any ad blocker",
      "please enable javascript",
      "checking your browser before accessing",
      "you are being rate limited"
    ];

    if (strongIndicators.some((indicator) => normalized.includes(indicator))) {
      return true;
    }

    const weakIndicators = [
      "captcha",
      "cloudflare",
      "datadome",
      "are you human",
      "access denied",
      "security check",
      "automated requests",
      "bot detection"
    ];

    const weakHits = weakIndicators.reduce(
      (total, indicator) => total + (normalized.includes(indicator) ? 1 : 0),
      0
    );

    return weakHits >= 2 && normalized.length < 12000;
  }

  private normalizeMarkdownCandidate(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  extractLinkAnalysisFromResult(item: Crawl4aiArticle): CrawlLinkAnalysis | undefined {

    const direct = buildLinkAnalysis(item.links);
    if (direct) {
      return direct;
    }
    if (!item.metadata || typeof item.metadata !== "object") {
      return undefined;
    }
    const metadata = item.metadata as Record<string, unknown>;
    const candidateKeys = ["links", "link_summary", "linkSummary", "linkAnalysis"];
    for (const key of candidateKeys) {
      const entry = metadata[key];
      const analysis = buildLinkAnalysis(entry);
      if (analysis) {
        return analysis;
      }
    }
    return undefined;
  }

  private normalizeMediaCollection(media: unknown): CrawlMediaCollection | undefined {
    if (!media || typeof media !== "object" || Array.isArray(media)) {
      return undefined;
    }
    const normalized: CrawlMediaCollection = {};
    for (const [kind, value] of Object.entries(media as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const items = value
        .map((entry) => this.normalizeMediaItem(entry))
        .filter((entry): entry is CrawlMediaItem => Boolean(entry));
      if (items.length > 0) {
        normalized[kind] = items;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeMediaItem(value: unknown): CrawlMediaItem | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const item: CrawlMediaItem = {};
    const src = this.pickString(record, ["src", "url", "href"]);
    if (src) {
      item.src = src;
    }
    const alt = this.pickString(record, ["alt"]);
    if (alt) {
      item.alt = alt;
    }
    const title = this.pickString(record, ["title"]);
    if (title) {
      item.title = title;
    }
    const desc = this.pickString(record, ["desc", "description", "caption"]);
    if (desc) {
      item.desc = desc;
    }
    const type = this.pickString(record, ["type", "media_type", "mediaType"]);
    if (type) {
      item.type = type;
    }
    const format = this.pickString(record, ["format", "mime", "mimeType"]);
    if (format) {
      item.format = format;
    }
    const poster = this.pickString(record, ["poster", "thumbnail"]);
    if (poster) {
      item.poster = poster;
    }
    const sizes = this.pickString(record, ["sizes"]);
    if (sizes) {
      item.sizes = sizes;
    }
    const width = this.pickNumber(record, ["width"]);
    if (width !== undefined) {
      item.width = width;
    }
    const height = this.pickNumber(record, ["height"]);
    if (height !== undefined) {
      item.height = height;
    }
    const score = this.pickNumber(record, ["score"]);
    if (score !== undefined) {
      item.score = score;
    }
    const srcset = this.normalizeStringList(record.srcset ?? record.srcSet);
    if (srcset) {
      item.srcset = srcset;
    }
    const pictureSources = this.normalizeMediaSources(
      record.sources ?? record.picture_sources ?? record.pictureSources
    );
    if (pictureSources) {
      item.pictureSources = pictureSources;
    }
    const responsiveSources = this.normalizeMediaSources(
      record.responsive_images ?? record.responsiveImages
    );
    if (responsiveSources) {
      item.responsiveSources = responsiveSources;
    }
    const extras = this.extractMediaExtras(record);
    if (Object.keys(extras).length > 0) {
      item.raw = extras;
    }
    return Object.keys(item).length > 0 ? item : undefined;
  }

  private normalizeMediaSources(value: unknown): CrawlMediaSource[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const sources = value
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return undefined;
        }
        const record = entry as Record<string, unknown>;
        const source: CrawlMediaSource = {};
        const srcset = this.pickString(record, ["srcset", "srcSet"]);
        if (srcset) {
          source.srcset = srcset;
        }
        const src = this.pickString(record, ["src", "url", "href"]);
        if (src) {
          source.src = src;
        }
        const type = this.pickString(record, ["type"]);
        if (type) {
          source.type = type;
        }
        const media = this.pickString(record, ["media"]);
        if (media) {
          source.media = media;
        }
        const sizes = this.pickString(record, ["sizes"]);
        if (sizes) {
          source.sizes = sizes;
        }
        return Object.keys(source).length > 0 ? source : undefined;
      })
      .filter((entry): entry is CrawlMediaSource => Boolean(entry));
    return sources.length > 0 ? sources : undefined;
  }

  private normalizeStringList(value: unknown): string[] | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? [trimmed] : undefined;
    }
    if (Array.isArray(value)) {
      const normalized = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
      return normalized.length > 0 ? normalized.slice(0, 20) : undefined;
    }
    return undefined;
  }

  private extractMediaExtras(record: Record<string, unknown>) {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (this.mediaReservedKeys.has(key)) {
        continue;
      }
      if (value !== undefined) {
        extras[key] = value;
      }
    }
    return extras;
  }

  private async collectMediaAssets(
    media?: CrawlMediaCollection
  ): Promise<CrawlStoredMediaAsset[] | undefined> {
    if (!media || this.mediaConfig.maxPerResult <= 0) {
      return undefined;
    }
    const entries = this.flattenMediaEntries(media);
    if (entries.length === 0) {
      return undefined;
    }
    const assets: CrawlStoredMediaAsset[] = [];
    const seenSources = new Set<string>();
    for (const { kind, item } of entries) {
      if (assets.length >= this.mediaConfig.maxPerResult) {
        break;
      }
      const candidate = this.pickMediaUrl(item);
      if (!candidate) {
        continue;
      }
      if (candidate.startsWith("data:")) {
        const inlineAsset = this.buildInlineMediaAsset(candidate, kind, item);
        if (inlineAsset) {
          assets.push(inlineAsset);
        }
        continue;
      }
      if (!this.isHttpUrl(candidate) || seenSources.has(candidate)) {
        continue;
      }
      seenSources.add(candidate);
      const asset = await this.fetchMediaAsset(candidate, kind, item);
      if (asset) {
        assets.push(asset);
      }
    }
    return assets.length > 0 ? assets : undefined;
  }

  private flattenMediaEntries(media: CrawlMediaCollection) {
    const entries: { kind: string; item: CrawlMediaItem }[] = [];
    for (const [kind, items] of Object.entries(media)) {
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items) {
        if (item) {
          entries.push({ kind, item });
        }
      }
    }
    return entries;
  }

  private pickMediaUrl(item: CrawlMediaItem) {
    if (typeof item.src === "string" && item.src.length > 0) {
      return item.src;
    }
    if (typeof item.poster === "string" && item.poster.length > 0) {
      return item.poster;
    }
    return undefined;
  }

  private buildInlineMediaAsset(
    dataUri: string,
    kind: string,
    item: CrawlMediaItem
  ): CrawlStoredMediaAsset | undefined {
    const maxBytes = this.mediaConfig.maxBytes;
    if (maxBytes <= 0) {
      return undefined;
    }

    const maxDataUriChars = 1024 + this.maxBase64PayloadLength(maxBytes);
    if (dataUri.length > maxDataUriChars) {
      logger.debug(
        { kind, length: dataUri.length, max: maxDataUriChars },
        "Skipped inline media asset exceeding max length"
      );
      return undefined;
    }

    const commaIndex = dataUri.indexOf(",");
    if (commaIndex < 0) {
      return undefined;
    }

    const meta = dataUri.slice("data:".length, commaIndex);
    const payload = dataUri.slice(commaIndex + 1);
    const metaParts = meta.split(";");
    const isBase64 = metaParts.some((part) => part.trim().toLowerCase() === "base64");
    if (!isBase64) {
      return undefined;
    }
    const mime = metaParts[0]?.trim() ?? "";

    const estimatedBytes = this.estimateBase64DecodedBytes(payload);
    if (!estimatedBytes) {
      return undefined;
    }
    if (estimatedBytes > maxBytes) {
      logger.debug(
        { kind, estimatedBytes, maxBytes },
        "Skipped inline media asset exceeding max bytes"
      );
      return undefined;
    }

    try {
      const buffer = Buffer.from(payload, "base64");
      if (buffer.length > maxBytes) {
        logger.debug(
          { kind, size: buffer.length, maxBytes },
          "Skipped inline media asset exceeding max bytes"
        );
        return undefined;
      }
      return {
        id: hashMarkdown(`${dataUri.slice(0, 64)}:${buffer.length}`),
        kind,
        sourceUrl: dataUri,
        bytes: buffer.length,
        contentType: mime || undefined,
        dataUri,
        width: item.width,
        height: item.height,
        alt: item.alt,
        title: item.title,
        desc: item.desc,
        poster: item.poster,
        format: item.format,
        metadata: item.raw
      };
    } catch (error) {
      logger.warn({ error }, "Failed to parse inline media asset");
      return undefined;
    }
  }

  private maxBase64PayloadLength(maxBytes: number): number {
    return Math.ceil(maxBytes / 3) * 4;
  }

  private estimateBase64DecodedBytes(payload: string): number | undefined {
    let effectiveLength = 0;
    let sawValidChar = false;

    for (let idx = 0; idx < payload.length; idx += 1) {
      const code = payload.charCodeAt(idx);
      if (this.isWhitespaceCharCode(code)) {
        continue;
      }
      sawValidChar = true;
      if (
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122) || // a-z
        (code >= 48 && code <= 57) || // 0-9
        code === 43 || // +
        code === 47 || // /
        code === 61 // =
      ) {
        effectiveLength += 1;
        continue;
      }
      return undefined;
    }

    if (!sawValidChar || effectiveLength === 0) {
      return undefined;
    }

    let padding = 0;
    for (let idx = payload.length - 1; idx >= 0; idx -= 1) {
      const code = payload.charCodeAt(idx);
      if (this.isWhitespaceCharCode(code)) {
        continue;
      }
      if (code === 61 && padding < 2) {
        padding += 1;
        continue;
      }
      break;
    }

    const decoded = Math.floor((effectiveLength * 3) / 4) - padding;
    return decoded > 0 ? decoded : undefined;
  }

  private isWhitespaceCharCode(code: number): boolean {
    return code === 9 || code === 10 || code === 13 || code === 32;
  }

  private async fetchMediaAsset(
    url: string,
    kind: string,
    item: CrawlMediaItem
  ): Promise<CrawlStoredMediaAsset | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mediaConfig.fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal
      });
      if (!response.ok) {
        logger.debug({ url, status: response.status }, "Failed to download media asset");
        return undefined;
      }
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isNaN(contentLength) && contentLength > this.mediaConfig.maxBytes) {
          logger.debug({ url, contentLength }, "Skipped media asset exceeding max bytes");
          return undefined;
        }
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.byteLength > this.mediaConfig.maxBytes) {
        logger.debug({ url, size: buffer.byteLength }, "Skipped media asset exceeding max bytes");
        return undefined;
      }
      const contentType = response.headers.get("content-type") ?? item.format ?? undefined;
      const dataUri = `data:${contentType ?? "application/octet-stream"};base64,${buffer.toString("base64")}`;
      return {
        id: hashMarkdown(`${url}:${buffer.length}`),
        kind,
        sourceUrl: url,
        bytes: buffer.length,
        contentType,
        dataUri,
        width: item.width,
        height: item.height,
        alt: item.alt,
        title: item.title,
        desc: item.desc,
        poster: item.poster,
        format: item.format,
        metadata: item.raw
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      logger.warn({ url, error: message }, "Failed to download media asset");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isHttpUrl(value: string) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private pickNumber(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
    if (!source) {
      return undefined;
    }
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number") {
        return value;
      }
    }
    return undefined;
  }

  private pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!source) {
      return undefined;
    }
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private ensureString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private normalizeTablesFromResult(item: Crawl4aiArticle): CrawlResultTable[] | undefined {
    const sources = this.extractTablePayloads(item);
    if (sources.length === 0) {
      return undefined;
    }
    const normalized = sources
      .map((table, index) => this.normalizeTablePayload(table, index))
      .filter((entry): entry is CrawlResultTable => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }

  private extractTablePayloads(item: Crawl4aiArticle): Crawl4aiTablePayload[] {
    const payloads: Crawl4aiTablePayload[] = [];
    if (Array.isArray(item.tables)) {
      payloads.push(
        ...item.tables.filter((entry): entry is Crawl4aiTablePayload => Boolean(entry && typeof entry === "object"))
      );
    }
    if (item.media && typeof item.media === "object") {
      const tables = (item.media as { tables?: unknown }).tables;
      if (Array.isArray(tables)) {
        payloads.push(
          ...tables.filter((entry: unknown): entry is Crawl4aiTablePayload =>
            Boolean(entry && typeof entry === "object")
          )
        );
      }
    }
    return payloads;
  }

  private normalizeTablePayload(table: Crawl4aiTablePayload, index: number): CrawlResultTable | undefined {
    if (!table || typeof table !== "object") {
      return undefined;
    }
    const rowsResult = this.extractTableRows(table);
    if (rowsResult.rows.length === 0) {
      return undefined;
    }
    const headers = this.normalizeTableHeaders(table.headers, rowsResult.inferredHeaders, rowsResult.rows[0]?.length ?? 0);
    const normalizedRows = rowsResult.rows.map((row) => this.alignTableRow(row, headers.length));
    const records = normalizedRows.map((row) => this.buildTableRecord(headers, row));
    const metadata = this.normalizeTableMetadata(table.metadata);
    return {
      id: table.id?.toString() ?? `table-${index + 1}`,
      caption: this.ensureString(table.caption),
      headers,
      rows: normalizedRows,
      rowCount: normalizedRows.length,
      columnCount: headers.length,
      source: this.ensureString(table.source_xpath ?? table.sourceXPath ?? (metadata?.source_xpath as string | undefined)),
      metadata: metadata ?? undefined,
      dataFrame: {
        columns: headers,
        rows: records
      }
    };
  }

  private extractTableRows(
    table: Crawl4aiTablePayload
  ): { rows: CrawlTableCell[][]; inferredHeaders?: string[] } {
    if (Array.isArray(table.rows)) {
      const normalized = table.rows
        .map((row: unknown) => this.normalizeTableRow(row))
        .filter((row: CrawlTableCell[]): row is CrawlTableCell[] => row.length > 0);
      return { rows: normalized };
    }
    if (Array.isArray(table.data)) {
      const columns = this.collectColumnsFromRecords(table.data);
      if (!columns.length) {
        return { rows: [] };
      }
      const rows = table.data.map((record: unknown) =>
        columns.map((column) => this.normalizeTableCell(record ? (record as Record<string, unknown>)[column] : undefined))
      );
      return { rows, inferredHeaders: columns };
    }
    return { rows: [] };
  }

  private normalizeTableRow(row: unknown): CrawlTableCell[] {
    if (!Array.isArray(row)) {
      return [];
    }
    return row.map((cell) => this.normalizeTableCell(cell));
  }

  private collectColumnsFromRecords(records: Record<string, CrawlTableCell>[] | undefined) {
    if (!records) {
      return [] as string[];
    }
    const columns: string[] = [];
    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }
      for (const key of Object.keys(record)) {
        const trimmed = key.trim();
        if (!trimmed) {
          continue;
        }
        if (!columns.includes(trimmed)) {
          columns.push(trimmed.slice(0, 64));
        }
      }
      if (columns.length >= 50) {
        break;
      }
    }
    return columns;
  }

  private normalizeTableHeaders(
    headers?: unknown,
    inferred?: string[],
    fallbackSize?: number
  ): string[] {
    const fromHeaders = Array.isArray(headers)
      ? headers
          .map((header) => (typeof header === "string" ? header.trim() : ""))
          .filter((header) => header.length > 0)
          .map((header) => header.slice(0, 64))
      : [];
    let base = fromHeaders;
    if (base.length === 0 && inferred && inferred.length > 0) {
      base = inferred;
    }
    if (base.length === 0 && fallbackSize && fallbackSize > 0) {
      base = Array.from({ length: fallbackSize }, (_, idx) => `column_${idx + 1}`);
    }
    if (base.length === 0) {
      base = ["column_1"];
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    base.forEach((header, idx) => {
      const safe = header && header.length > 0 ? header : `column_${idx + 1}`;
      let candidate = safe;
      let suffix = 1;
      while (seen.has(candidate)) {
        candidate = `${safe}_${suffix}`;
        suffix += 1;
      }
      seen.add(candidate);
      normalized.push(candidate);
    });
    return normalized;
  }

  private alignTableRow(row: CrawlTableCell[], size: number) {
    const next = row.slice(0, size);
    while (next.length < size) {
      next.push(null);
    }
    return next;
  }

  private buildTableRecord(headers: string[], row: CrawlTableCell[]) {
    return headers.reduce<Record<string, CrawlTableCell>>((acc, header, index) => {
      acc[header] = row[index] ?? null;
      return acc;
    }, {});
  }

  private normalizeTableMetadata(metadata?: Record<string, unknown>) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return undefined;
    }
    try {
      return JSON.parse(JSON.stringify(metadata));
    } catch {
      return undefined;
    }
  }

  private normalizeTableCell(value: unknown): CrawlTableCell {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return "[object]";
      }
    }
    return String(value);
  }
}
