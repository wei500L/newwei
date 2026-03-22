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
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { CrawlMediaAssetService } from "./crawl-media-asset.service";
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
import {
  buildCanonicalUrlFingerprint,
  extractOrgContentDedupeWindowHoursFromTaskConfig,
  extractUrlQueryParamAllowlistFromTaskConfig,
} from "./url-fingerprint";
const logger = createLogger({ name: "crawl-result-service" });
const RESULT_PERSIST_CONCURRENCY_LIMIT = 6;

interface CrawlMediaConfig {
  fetchTimeoutMs: number;
  maxBytes: number;
  maxPerResult: number;
}

interface DownloadedMediaAsset {
  kind: string;
  sourceUrl: string;
  bytes: number;
  contentType?: string;
  data: Buffer;
  width?: number;
  height?: number;
  alt?: string;
  title?: string;
  desc?: string;
  poster?: string;
  format?: string;
  metadata?: Record<string, unknown>;
}

interface HashedCrawlResultItem {
  item: Crawl4aiArticle;
  markdown: string;
  markdownResult: ReturnType<CrawlResultService["extractMarkdownResult"]>;
  hash: string;
  sourceUrl: string;
  canonicalSourceUrl: string | null;
  sourceUrlFingerprint: string | null;
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
  private crawlMediaAssetService?: CrawlMediaAssetService | null;

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

  private resolveCrawlMediaAssetService(): CrawlMediaAssetService | null {
    if (this.crawlMediaAssetService !== undefined) {
      return this.crawlMediaAssetService;
    }
    try {
      this.crawlMediaAssetService = this.moduleRef.get(CrawlMediaAssetService, { strict: false });
    } catch (error) {
      logger.warn({ err: error }, "CrawlMediaAssetService unavailable; media persistence disabled");
      this.crawlMediaAssetService = null;
    }
    return this.crawlMediaAssetService;
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
    let reusedResultId: string | undefined;
    let reusedResultFetchedAt: Date | undefined;
    let taskReuseCount = 0;
    let orgReuseCount = 0;
    let batchDuplicateCount = 0;
    let itemsQueued = 0;
    let itemsQueueFailed = 0;
    const itemsService = ingestToItems ? this.resolveItemsService() : null;
    const shouldStoreMedia = options.storeMedia ?? false;
    const urlQueryParamAllowlist = extractUrlQueryParamAllowlistFromTaskConfig(
      task.config,
    );
    const orgContentDedupeWindowHours =
      extractOrgContentDedupeWindowHoursFromTaskConfig(task.config);
    const orgContentDedupeSince =
      orgContentDedupeWindowHours > 0
        ? new Date(Date.now() - orgContentDedupeWindowHours * 60 * 60 * 1000)
        : null;

    const itemsWithHash: HashedCrawlResultItem[] = [];

    for (const item of items) {
      const markdownResult = this.extractMarkdownResult(item.markdown);
      const markdown = markdownResult.primary ?? "";
      if (!markdown) {
        skipped += 1;
        continue;
      }
      const hash = hashMarkdown(markdown);
      const sourceUrlRaw =
        typeof item.url === "string" && item.url.trim().length > 0
          ? item.url.trim()
          : task.targetUrl;
      const canonical = buildCanonicalUrlFingerprint(
        sourceUrlRaw,
        urlQueryParamAllowlist,
      );
      itemsWithHash.push({
        item,
        markdown,
        markdownResult,
        hash,
        sourceUrl: sourceUrlRaw,
        canonicalSourceUrl: canonical?.canonicalUrl ?? null,
        sourceUrlFingerprint: canonical?.fingerprint ?? null,
      });
    }

    if (itemsWithHash.length === 0) {
      logger.debug({ duration: Date.now() - startTime, skipped }, "persistResults completed (all items skipped)");
      return {
        inserted: 0,
        skipped,
        runId
      };
    }

    const allHashes = itemsWithHash.map((i) => i.hash);
    const existingTaskRecords = await this.prisma.crawlResult.findMany({
      where: {
        taskId: task.id,
        contentHash: { in: allHashes }
      }
    });
    const existingTaskMap = new Map(
      existingTaskRecords.map((record) => [record.contentHash, record]),
    );
    const existingOrgRecords = orgContentDedupeSince
      ? await this.prisma.crawlResult.findMany({
          where: {
            orgId: task.orgId,
            contentHash: { in: allHashes },
            fetchedAt: { gte: orgContentDedupeSince },
          },
          orderBy: { fetchedAt: "desc" },
        })
      : [];
    const existingOrgMap = new Map<string, CrawlResult>();
    for (const record of existingOrgRecords) {
      if (!existingOrgMap.has(record.contentHash)) {
        existingOrgMap.set(record.contentHash, record);
      }
    }

    const newItems: HashedCrawlResultItem[] = [];
    const existingItems: { item: Crawl4aiArticle; existing: CrawlResult }[] = [];
    const seenNewHashes = new Set<string>();
    const registerReusedResult = (existing: CrawlResult) => {
      if (
        !reusedResultFetchedAt ||
        existing.fetchedAt.getTime() > reusedResultFetchedAt.getTime()
      ) {
        reusedResultFetchedAt = existing.fetchedAt;
        reusedResultId = existing.id;
      }
    };

    for (const entry of itemsWithHash) {
      const existingByTask = existingTaskMap.get(entry.hash);
      if (existingByTask) {
        skipped += 1;
        taskReuseCount += 1;
        existingItems.push({ item: entry.item, existing: existingByTask });
        registerReusedResult(existingByTask);
        continue;
      }
      const existingByOrg = existingOrgMap.get(entry.hash);
      if (existingByOrg) {
        skipped += 1;
        orgReuseCount += 1;
        existingItems.push({ item: entry.item, existing: existingByOrg });
        registerReusedResult(existingByOrg);
        continue;
      }
      if (seenNewHashes.has(entry.hash)) {
        skipped += 1;
        batchDuplicateCount += 1;
        continue;
      }
      seenNewHashes.add(entry.hash);
      newItems.push(entry);
    }

    logger.debug(
      {
        hashCount: allHashes.length,
        existingTaskCount: existingTaskRecords.length,
        existingOrgCount: existingOrgRecords.length,
        newCount: newItems.length
      },
      "persistResults hash classification complete"
    );
    if (process.env.NODE_ENV !== "test") {
      void writeTaskLogBestEffort({
        queue: CRAWL_QUEUE_NAME,
        jobId: task.id,
        orgId: task.orgId,
        stage: "dedupe",
        status: "completed",
        message: "Crawl dedupe classification complete",
        data: {
          evaluatedCount: itemsWithHash.length,
          taskReuseCount,
          orgReuseCount,
          batchDuplicateCount,
          insertedCandidateCount: newItems.length,
          orgContentDedupeWindowHours,
          hasOrgContentDedupeWindow: Boolean(orgContentDedupeSince),
        },
      });
    }

    const createdResultIds: string[] = [];
    for (let i = 0; i < newItems.length; i += RESULT_PERSIST_CONCURRENCY_LIMIT) {
      const batch = newItems.slice(i, i + RESULT_PERSIST_CONCURRENCY_LIMIT);
      const batchResults = await Promise.allSettled(
        batch.map((entry) =>
          this.persistSingleResult(task, entry, shouldStoreMedia, runId, {
            orgContentDedupeSince,
            urlQueryParamAllowlist,
          }),
        ),
      );
      for (const result of batchResults) {
        if (result.status === "rejected") {
          throw result.reason;
        }
        const persisted = result.value;
        createdResultIds.push(persisted.resultId);
        if (!persisted.inserted) {
          skipped += 1;
          if (
            !reusedResultFetchedAt ||
            persisted.fetchedAt.getTime() > reusedResultFetchedAt.getTime()
          ) {
            reusedResultFetchedAt = persisted.fetchedAt;
            reusedResultId = persisted.resultId;
          }
          continue;
        }
        inserted += 1;
        if (!latestResultAt || persisted.fetchedAt > latestResultAt) {
          latestResultAt = persisted.fetchedAt;
        }
      }
    }

    if (ingestToItems && itemsService) {
      const uniqueResultIds = [
        ...new Set([
          ...existingItems.map((entry) => entry.existing.id),
          ...createdResultIds
        ])
      ];
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
      ...(reusedResultId ? { reusedResultId } : {}),
      ...(ingestToItems ? { itemsQueued, itemsQueueFailed } : {}),
      lastFetchedAt: latestResultAt ?? reusedResultFetchedAt,
      runId,
      memory
    };
  }

  private async persistSingleResult(
    task: CrawlTask,
    entry: HashedCrawlResultItem,
    shouldStoreMedia: boolean,
    runId?: string,
    options?: {
      orgContentDedupeSince: Date | null;
      urlQueryParamAllowlist: string[];
    },
  ): Promise<{ resultId: string; fetchedAt: Date; inserted: boolean }> {
    const sourceUrl = entry.sourceUrl;
    const metadataRecord: Record<string, unknown> = {
      ...(entry.item.metadata ?? {}),
      ...(entry.canonicalSourceUrl
        ? { canonicalUrl: entry.canonicalSourceUrl }
        : {}),
      ...(entry.sourceUrlFingerprint
        ? { urlFingerprint: entry.sourceUrlFingerprint }
        : {}),
      ...(entry.canonicalSourceUrl &&
      entry.canonicalSourceUrl !== sourceUrl
        ? { originalUrl: sourceUrl }
        : {}),
      ...(options?.urlQueryParamAllowlist &&
      options.urlQueryParamAllowlist.length > 0
        ? {
            urlQueryParamAllowlist: options.urlQueryParamAllowlist,
          }
        : {}),
    };
    const fetchedAt = coerceDate(entry.item.publishedAt) ?? new Date();
    const metadata = toPrismaJsonValue(metadataRecord);
    let stage = "create_result";
    let resultId: string | undefined;
    let created: CrawlResult | undefined;

    try {
      try {
        created = await this.prisma.crawlResult.create({
          data: {
            taskId: task.id,
            orgId: task.orgId,
            sourceUrl,
            sourceUrlFingerprint: entry.sourceUrlFingerprint,
            fetchedAt,
            markdownRef: "",
            contentHash: entry.hash,
            metadata
          }
        });
      } catch (error) {
        if (this.isUniqueConstraintConflict(error)) {
          const existing = await this.prisma.crawlResult.findUnique({
            where: {
              taskId_contentHash: {
                taskId: task.id,
                contentHash: entry.hash
              }
            }
          });
          if (existing) {
            logger.warn(
              {
                taskId: task.id,
                orgId: task.orgId,
                resultId: existing.id,
                sourceUrl,
                contentHash: entry.hash
              },
              "Detected duplicate crawl result insert race; skipping entry"
            );
            return {
              resultId: existing.id,
              fetchedAt: existing.fetchedAt,
              inserted: false
            };
          }
        }
        throw error;
      }
      resultId = created.id;

      if (options?.orgContentDedupeSince) {
        stage = "check_org_dedupe_race";
        const existingWithinWindow = await this.prisma.crawlResult.findMany({
          where: {
            orgId: task.orgId,
            contentHash: entry.hash,
            fetchedAt: { gte: options.orgContentDedupeSince },
            NOT: { id: created.id },
          },
          select: { id: true, fetchedAt: true, createdAt: true },
        });
        if (existingWithinWindow.length > 0) {
          const winner = this.selectOrgDedupeWinner(
            {
              id: created.id,
              fetchedAt: created.fetchedAt,
              createdAt: created.createdAt,
            },
            existingWithinWindow,
          );

          if (winner.id !== created.id) {
            logger.warn(
              {
                taskId: task.id,
                orgId: task.orgId,
                duplicateResultId: winner.id,
                transientResultId: created.id,
                sourceUrl,
                contentHash: entry.hash,
              },
              "Detected org-level duplicate crawl result insert race; rolling back transient row",
            );
            await this.rollbackPersistedResult(task, created.id);
            return {
              resultId: winner.id,
              fetchedAt: winner.fetchedAt,
              inserted: false,
            };
          }
        }
      }

      const linkAnalysis = this.extractLinkAnalysisFromResult(entry.item);
      const media = shouldStoreMedia ? this.normalizeMediaCollection(entry.item.media) : undefined;
      const tables = this.normalizeTablesFromResult(entry.item);

      stage = "store_media";
      if (shouldStoreMedia && media) {
        await this.collectMediaAssets(task, created.id, media);
      }

      stage = "store_content";
      await CrawlResultContentModel.updateOne(
        { resultId: created.id },
        {
          $setOnInsert: {
            taskId: task.id,
            resultId: created.id,
            markdown: entry.markdown,
            rawMarkdown: entry.markdownResult.raw ?? entry.markdown,
            markdownWithCitations: entry.markdownResult.citations,
            referencesMarkdown: entry.markdownResult.references,
            fitMarkdown: entry.markdownResult.fit,
            metadata: entry.item.metadata ?? {},
            sourceUrl,
            crawlRunId: runId,
            linkAnalysis,
            tables: tables ?? null,
            ...(shouldStoreMedia
              ? {
                  media: media ?? null
                }
              : {})
          }
        },
        { upsert: true }
      ).exec();

      const persistedDoc = await CrawlResultContentModel.findOne(
        { resultId: created.id },
        { _id: 1 }
      )
        .lean()
        .exec();
      const markdownRef = persistedDoc?._id ? String(persistedDoc._id) : "";
      if (!markdownRef) {
        throw new Error("Missing markdownRef after crawl content persistence");
      }

      stage = "update_markdown_ref";
      await this.prisma.crawlResult.update({
        where: { id: created.id },
        data: { markdownRef }
      });

      return { resultId: created.id, fetchedAt, inserted: true };
    } catch (error) {
      logger.error(
        {
          err: error,
          taskId: task.id,
          orgId: task.orgId,
          sourceUrl,
          contentHash: entry.hash,
          resultId,
          stage
        },
        "Failed to persist crawl result entry"
      );
      if (resultId) {
        await this.rollbackPersistedResult(task, resultId);
      }
      throw error;
    }
  }

  private async rollbackPersistedResult(task: CrawlTask, resultId: string): Promise<void> {
    const mediaAssetService = this.resolveCrawlMediaAssetService();
    if (mediaAssetService) {
      try {
        await mediaAssetService.deleteAssetsByResultId(resultId);
      } catch (error) {
        logger.error(
          {
            err: error,
            taskId: task.id,
            orgId: task.orgId,
            resultId
          },
          "Failed to cleanup crawl media assets during rollback"
        );
      }
    }

    try {
      await CrawlResultContentModel.deleteOne({ resultId }).exec();
    } catch (error) {
      logger.error(
        {
          err: error,
          taskId: task.id,
          orgId: task.orgId,
          resultId
        },
        "Failed to cleanup crawl result content document during rollback"
      );
    }

    try {
      await this.prisma.crawlResult.delete({
        where: { id: resultId }
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          taskId: task.id,
          orgId: task.orgId,
          resultId
        },
        "Failed to cleanup crawl result row during rollback"
      );
    }
  }

  private selectOrgDedupeWinner(
    created: Pick<CrawlResult, "id" | "fetchedAt" | "createdAt">,
    existing: Array<Pick<CrawlResult, "id" | "fetchedAt" | "createdAt">>,
  ): Pick<CrawlResult, "id" | "fetchedAt"> {
    const candidates = [created, ...existing];
    candidates.sort((left, right) => {
      const createdAtDelta =
        left.createdAt.getTime() - right.createdAt.getTime();
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }
      return left.id.localeCompare(right.id);
    });
    const [winner = created] = candidates;
    return {
      id: winner.id,
      fetchedAt: winner.fetchedAt,
    };
  }

  private isUniqueConstraintConflict(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const record = error as { code?: unknown; meta?: unknown; message?: unknown };
    if (record.code === "P2002") {
      return true;
    }
    const message = typeof record.message === "string" ? record.message : "";
    return message.includes("Unique constraint failed");
  }

  async attachResultContent(
    results: CrawlResult[],
    accessScope?: { orgId: string; userId: string }
  ): Promise<CrawlTaskResult[]> {
    if (results.length === 0) {
      return [];
    }

    const ids = results.map((result) => result.id);
    const mediaAssetService = this.resolveCrawlMediaAssetService();
    const docs = await CrawlResultContentModel.find({ resultId: { $in: ids } })
      .lean()
      .exec();
    const docMap = new Map(docs.map((doc) => [doc.resultId as string, doc]));
    const mediaAssetsByResultId =
      mediaAssetService && accessScope
        ? await mediaAssetService.listAssetsByResultIds(ids, accessScope)
        : new Map<string, CrawlStoredMediaAsset[]>();

    return results.map((result) => {
      const doc = docMap.get(result.id);
      const storedAssets = mediaAssetsByResultId.get(result.id);
      const legacyAssets = (doc?.mediaAssets as CrawlStoredMediaAsset[] | undefined) ?? null;
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
        mediaAssets: storedAssets ?? legacyAssets,
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
    if (
      typeof data.reusedResultId === "string" &&
      data.reusedResultId.trim().length > 0
    ) {
      summary.reusedResultId = data.reusedResultId.trim();
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

  public isLowSignalMarkdown(markdown: string): boolean {
    const normalized = this.normalizeMarkdownCandidate(markdown);
    if (!normalized) {
      return true;
    }

    if (this.isReferenceOnlyMarkdown(normalized)) {
      return true;
    }

    const words = normalized.split(/\s+/).filter((entry) => entry.length > 0).length;
    const lines = normalized
      .split(/\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const meaningfulLines = lines.filter((line) => !this.isReferenceLine(line));
    const sentenceLikeLines = meaningfulLines.filter((line) => /[.!?。！？]/.test(line));

    if (words <= 8 && meaningfulLines.length <= 2) {
      return true;
    }

    if (words <= 16 && sentenceLikeLines.length === 0 && meaningfulLines.length <= 3) {
      return true;
    }

    return false;
  }

  private isReferenceOnlyMarkdown(markdown: string): boolean {
    const lines = markdown
      .split(/\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (lines.length === 0) {
      return true;
    }

    const headingOnly = lines.every((line) => this.isReferenceLine(line));
    if (!headingOnly) {
      return false;
    }

    return lines.some((line) => /^#{1,6}\s*references\b/i.test(line) || /^references\b/i.test(line));
  }

  private isReferenceLine(line: string): boolean {
    if (line.length === 0) {
      return true;
    }

    if (/^#{1,6}\s*references\b/i.test(line) || /^references\b/i.test(line)) {
      return true;
    }
    if (/^\[[^\]]+\]:\s*\S+/i.test(line)) {
      return true;
    }
    if (/^\[\^[^\]]+\]:\s*\S+/i.test(line)) {
      return true;
    }
    if (/^[-*]\s*\[[^\]]+\]\(\S+\)/.test(line)) {
      return true;
    }
    if (/^https?:\/\/\S+$/i.test(line)) {
      return true;
    }
    return false;
  }

  private normalizeMarkdownCandidate(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const withoutControlChars = value
      .replace(/\r\n?/g, "\n")
      .replaceAll("\u0000", "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "");

    const lines = withoutControlChars.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
    const dedupedLines: string[] = [];
    let previousCompact = "";
    let repeatedCount = 0;

    for (const line of lines) {
      const compact = line.trim();
      if (compact.length > 0 && compact === previousCompact && compact.length <= 80) {
        repeatedCount += 1;
        if (repeatedCount >= 2) {
          continue;
        }
      } else {
        previousCompact = compact;
        repeatedCount = 0;
      }
      dedupedLines.push(line);
    }

    const cleanedLines = this.dropLowValueNoiseLines(dedupedLines);

    const normalized = cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private dropLowValueNoiseLines(lines: string[]): string[] {
    if (lines.length === 0) {
      return lines;
    }

    const kept: string[] = [];
    let removedCount = 0;
    const firstHeadingIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));

    for (const [index, line] of lines.entries()) {
      const compact = line.trim();
      if (!compact) {
        kept.push(line);
        continue;
      }

      if (firstHeadingIndex >= 0 && index < firstHeadingIndex && this.isLikelyPreambleNoiseLine(compact)) {
        removedCount += 1;
        continue;
      }

      if (this.isLikelyNoiseLine(compact)) {
        removedCount += 1;
        continue;
      }

      kept.push(line);
    }

    const denseLines = lines.filter((line) => line.trim().length > 0).length;
    if (denseLines <= 0) {
      return kept;
    }

    const removalRatio = removedCount / denseLines;
    const keptDenseLines = kept.filter((line) => line.trim().length > 0).length;
    const keptBodyLines = kept.filter((line) => {
      const compact = line.trim();
      return compact.length > 0 && !/^#{1,6}\s+/.test(compact);
    }).length;

    if (keptDenseLines === 0 || keptBodyLines === 0) {
      return lines;
    }

    if (keptDenseLines <= 2 && removalRatio > 0.75) {
      return lines;
    }

    return kept;
  }

  private isLikelyPreambleNoiseLine(compact: string): boolean {
    const normalized = compact.toLowerCase().replace(/\s+/g, " ");

    if (/^(?:[⟨<]\d+[⟩>]\s*)+$/.test(compact)) {
      return true;
    }

    if (normalized === "menu") {
      return true;
    }

    if (normalized === "politico pro" || /^politico pro\s*[⟨<]\d+[⟩>]$/i.test(compact)) {
      return true;
    }

    if (this.isLikelyNavigationLinkLine(compact)) {
      return true;
    }

    return false;
  }

  private isLikelyNavigationLinkLine(compact: string): boolean {
    if (!/^(?:\[[^\]]+\]\(\S+\)\s*)+$/.test(compact)) {
      return false;
    }

    const visible = compact
      .replace(/\[([^\]]+)\]\(\S+\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    if (!visible) {
      return true;
    }

    return /(skip to (main )?content|menu|log in|sign in|subscribe|politico pro|my account|account|home|search)/.test(
      visible
    );
  }

  private isLikelyNoiseLine(compact: string): boolean {
    const lower = compact.toLowerCase();
    const normalized = lower.replace(/\s+/g, " ");

    if (/^\s*skip to (main )?content\s*(?:[⟨<]\d+[⟩>])?\s*$/i.test(compact)) {
      return true;
    }

    if (/^\s*menu\s*(?:[⟨<]\d+[⟩>])\s*$/i.test(compact)) {
      return true;
    }

    if (/^\s*politico pro\s*(?:[⟨<]\d+[⟩>])?\s*$/i.test(compact) && lower !== "politico pro") {
      return true;
    }

    if (/^\s*by\s+.+[⟨<]\d+[⟩>]\s*$/i.test(compact)) {
      return true;
    }

    if (/^\s*\[\s*\]\(https?:\/\/[^)]+\)\s*$/.test(compact) || this.isLikelyNavigationLinkLine(compact)) {
      return true;
    }

    if (/^advertisement$/i.test(compact) || /^sponsored$/i.test(compact)) {
      return true;
    }

    if (normalized.startsWith("free article usually reserved for subscribers")) {
      return true;
    }

    if (
      normalized === "listen" ||
      normalized === "ai generated text-to-speech" ||
      normalized === "ai-generated text-to-speech"
    ) {
      return true;
    }

    if (
      compact.length <= 80 &&
      /^(subscribe|sign in|log in|get unlimited access|already a subscriber|create an account)/i.test(compact)
    ) {
      return true;
    }

    if (
      compact.length <= 120 &&
      /^(accept|agree|manage)( all)? (cookies|privacy|consent)/i.test(compact)
    ) {
      return true;
    }

    if (
      compact.length <= 140 &&
      /^(privacy policy|cookie policy|terms of service|terms & conditions|all rights reserved)$/i.test(compact)
    ) {
      return true;
    }

    return false;
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
    task: CrawlTask,
    resultId: string,
    media?: CrawlMediaCollection
  ): Promise<void> {
    if (!media || this.mediaConfig.maxPerResult <= 0) {
      return;
    }
    const mediaAssetService = this.resolveCrawlMediaAssetService();
    if (!mediaAssetService) {
      logger.warn({ taskId: task.id, orgId: task.orgId, resultId }, "CrawlMediaAssetService is unavailable");
      return;
    }
    const entries = this.flattenMediaEntries(media);
    if (entries.length === 0) {
      return;
    }
    let storedCount = 0;
    let failedCount = 0;
    const seenSources = new Set<string>();
    for (const { kind, item } of entries) {
      if (storedCount >= this.mediaConfig.maxPerResult) {
        break;
      }
      const candidate = this.pickMediaUrl(item);
      if (!candidate) {
        continue;
      }
      let downloaded: DownloadedMediaAsset | undefined;
      if (candidate.startsWith("data:")) {
        downloaded = this.buildInlineMediaAsset(candidate, kind, item);
      } else {
        if (!this.isHttpUrl(candidate) || seenSources.has(candidate)) {
          continue;
        }
        seenSources.add(candidate);
        downloaded = await this.fetchMediaAsset(candidate, kind, item);
      }

      if (!downloaded) {
        continue;
      }
      try {
        await mediaAssetService.storeAsset({
          orgId: task.orgId,
          taskId: task.id,
          resultId,
          kind: downloaded.kind,
          sourceUrl: downloaded.sourceUrl,
          bytes: downloaded.bytes,
          data: downloaded.data,
          contentType: downloaded.contentType,
          width: downloaded.width,
          height: downloaded.height,
          alt: downloaded.alt,
          title: downloaded.title,
          desc: downloaded.desc,
          poster: downloaded.poster,
          format: downloaded.format,
          metadata: downloaded.metadata
        });
      } catch (error) {
        failedCount += 1;
        logger.error(
          {
            err: error,
            taskId: task.id,
            orgId: task.orgId,
            resultId,
            kind: downloaded.kind,
            sourceUrl: downloaded.sourceUrl
          },
          "Failed to store crawl media asset"
        );
        continue;
      }
      storedCount += 1;
    }
    if (failedCount > 0) {
      logger.warn(
        {
          taskId: task.id,
          orgId: task.orgId,
          resultId,
          storedCount,
          failedCount
        },
        "Stored crawl media with partial failures"
      );
    }
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
  ): DownloadedMediaAsset | undefined {
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
        kind,
        sourceUrl: "data-uri:inline",
        bytes: buffer.length,
        data: buffer,
        contentType: mime || undefined,
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
  ): Promise<DownloadedMediaAsset | undefined> {
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
      return {
        kind,
        sourceUrl: url,
        bytes: buffer.length,
        data: buffer,
        contentType,
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
