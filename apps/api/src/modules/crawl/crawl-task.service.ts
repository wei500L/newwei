import { createLogger } from "@modular/utils";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { MongoOutboxStatus, MongoOutboxType, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { ActionRateLimitService } from "../cache/action-rate-limit.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { ItemsService } from "../items/items.service";

import { CrawlExecutionService } from "./crawl-execution.service";
import {
  CrawlQueueService,
  type EnqueueCrawlTaskOptions,
} from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import { CRAWL_HOT_PRIORITY_THRESHOLD } from "./crawl.constants";
import type {
  CrawlIngestBatchSummary,
  CrawlMarkdownFilter,
  CrawlPriorityClass,
  CrawlTaskOptions,
  CrawlTaskView,
} from "./crawl.types";
import { clampResultLimit, coerceDate, normalizeKeywords } from "./crawl.utils";
import { assertNoUnsupportedProxy } from "./crawl-config-policy";
import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";
import { CreateCrawlTaskDto } from "./dto/create-crawl-task.dto";
import {
  CrawlTaskDetailQueryDto,
  ListCrawlTaskDto,
} from "./dto/list-crawl-task.dto";

type CrawlTaskRecord = Prisma.CrawlTaskGetPayload<{
  include: {
    _count: {
      select: {
        results: true;
      };
    };
  };
}>;

type CrawlTaskOptionsInput = NonNullable<CreateCrawlTaskDto["options"]>;

const logger = createLogger({ name: "crawl-task-service" });
const CRAWL_RESULT_ITEM_INGEST_SELECT = {
  id: true,
  taskId: true,
  sourceUrl: true,
  fetchedAt: true,
  contentHash: true,
  metadata: true,
  task: {
    select: {
      id: true,
      displayName: true,
      targetUrl: true,
      keywords: true,
      config: true,
    },
  },
} satisfies Prisma.CrawlResultSelect;

@Injectable()
export class CrawlTaskService {
  private itemsService?: ItemsService | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly executionService: CrawlExecutionService,
    private readonly queueService: CrawlQueueService,
    private readonly resultService: CrawlResultService,
    private readonly actionRateLimit: ActionRateLimitService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private resolveItemsService(): ItemsService | null {
    if (this.itemsService !== undefined) {
      return this.itemsService;
    }
    try {
      this.itemsService = this.moduleRef.get(ItemsService, { strict: false });
    } catch (error) {
      logger.warn(
        { err: error },
        "ItemsService unavailable; cannot ingest crawl results into Items",
      );
      this.itemsService = null;
    }
    return this.itemsService;
  }

  async createTask(
    orgId: string,
    userId: string,
    dto: CreateCrawlTaskDto,
    ip?: string,
    actorPermissions?: string[],
  ) {
    if (
      dto.ingestToItems === true &&
      !actorPermissions?.includes("items.write")
    ) {
      throw new ForbiddenException(
        "items.write permission is required to ingest crawl results into Items",
      );
    }
    await this.actionRateLimit.enforceCrawlTaskCreate(orgId, userId, ip);

    const rawOptions = dto.options ?? undefined;
    const normalizedRawOptions = await this.normalizeActorOptions(
      orgId,
      userId,
      rawOptions,
    );
    assertNoUnsupportedProxy(normalizedRawOptions, "options");
    assertNoCrawl4aiLlmOptions(normalizedRawOptions, "options");

    const keywords = normalizeKeywords(dto.keywords);
    const timeRangeFrom = coerceDate(dto.timeRangeFrom);
    const timeRangeTo = coerceDate(dto.timeRangeTo);
    if (timeRangeFrom && timeRangeTo && timeRangeFrom > timeRangeTo) {
      throw new BadRequestException(
        "timeRangeFrom must be earlier than timeRangeTo",
      );
    }

    const normalizedOptions = this.executionService.normalizeOptions({
      ...(normalizedRawOptions as unknown as Partial<CrawlTaskOptions>),
      markdownFilter: this.normalizeMarkdownFilter(
        normalizedRawOptions?.markdownFilter,
      ),
    });

    const defaultConcurrency = this.env.crawl4aiConfig.maxConcurrency;
    const concurrency = Math.min(
      dto.concurrency ?? defaultConcurrency,
      defaultConcurrency,
    );
    const baseConfig = normalizedOptions as Record<string, unknown>;
    const configToStore =
      dto.ingestToItems === true
        ? { ...baseConfig, ingestToItems: true }
        : baseConfig;

    const created = await this.prisma.crawlTask.create({
      data: {
        orgId,
        createdById: userId,
        targetUrl: dto.url,
        displayName: dto.displayName,
        status: "pending",
        concurrency,
        keywords,
        timeRangeFrom,
        timeRangeTo,
        ...(configToStore ? { config: toPrismaJsonValue(configToStore) } : {}),
        runCount: 0,
      },
      include: { _count: { select: { results: true } } },
    });

    const auditMetadata: Record<string, unknown> = {
      targetUrl: dto.url,
      keywords,
      concurrency,
      ingestToItems: dto.ingestToItems === true,
    };

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "crawlTask",
          action: "create",
          metadata: toPrismaJsonValue(auditMetadata),
        },
      },
      { orgId, actorId: userId, resource: "crawlTask", action: "create" },
    );

    await this.queueService.enqueueTask(created.id, orgId, userId);
    await this.prisma.crawlTask.update({
      where: { id: created.id },
      data: { status: "queued" },
    });

    return this.toView(created);
  }

  async deleteTask(orgId: string, userId: string, taskId: string) {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id: taskId, orgId },
      include: { results: { select: { id: true } } },
    });
    if (!task) {
      throw new NotFoundException("Crawl task not found");
    }

    await this.queueService.removeQueuedJobs(taskId);
    const resultIds = task.results.map((result) => result.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.crawlResult.deleteMany({ where: { taskId } });
      await tx.crawlTask.delete({ where: { id: taskId } });
      await tx.mongoOutbox.create({
        data: {
          orgId,
          type: MongoOutboxType.cleanup_crawl_results,
          status: MongoOutboxStatus.pending,
          availableAt: new Date(),
          payload: {
            type: MongoOutboxType.cleanup_crawl_results,
            taskId,
            orgId,
          },
        },
      });
      await writeAuditLogBestEffort(
        tx,
        {
          data: {
            orgId,
            actorId: userId,
            resource: "crawlTask",
            action: "delete",
            metadata: {
              taskId,
              deletedResultCount: resultIds.length,
            },
          },
        },
        { orgId, actorId: userId, resource: "crawlTask", action: "delete" },
      );
    });

    return { taskId, deletedResultCount: resultIds.length };
  }

  async listTasks(orgId: string, filters: ListCrawlTaskDto) {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 10;
    const where: Prisma.CrawlTaskWhereInput = {
      orgId,
    };
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.search) {
      where.OR = [
        { targetUrl: { contains: filters.search } },
        { displayName: { contains: filters.search } },
      ];
    }

    const [tasks, total] = await Promise.all([
      this.prisma.crawlTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { results: true } } },
      }),
      this.prisma.crawlTask.count({ where }),
    ]);

    return {
      tasks: tasks.map((task) => this.toView(task)),
      total,
      page,
      pageSize,
    };
  }

  async getTask(
    orgId: string,
    id: string,
    query: CrawlTaskDetailQueryDto,
    accessScope?: { userId: string },
  ) {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id, orgId },
      include: { _count: { select: { results: true } } },
    });
    if (!task) {
      throw new NotFoundException("crawl task not found");
    }

    const limit = clampResultLimit(query.resultLimit);
    const resultWhere: Prisma.CrawlResultWhereInput = {
      taskId: id,
    };
    if (query.resultSearch) {
      resultWhere.OR = [{ sourceUrl: { contains: query.resultSearch } }];
    }

    const results = await this.prisma.crawlResult.findMany({
      where: resultWhere,
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    const hydrated = await this.resultService.attachResultContent(
      results,
      accessScope ? { orgId, userId: accessScope.userId } : undefined,
    );
    const hydratedWithItems =
      hydrated.length === 0
        ? hydrated
        : await (async () => {
            const externalIds = hydrated.map(
              (result) => `crawlResult:${result.id}`,
            );
            const itemMetas = await this.prisma.itemMeta.findMany({
              where: {
                orgId,
                externalId: { in: externalIds },
              },
              select: {
                id: true,
                externalId: true,
                status: true,
              },
            });
            const byExternalId = new Map(
              itemMetas.map((meta) => [meta.externalId, meta]),
            );
            return hydrated.map((result) => {
              const meta = byExternalId.get(`crawlResult:${result.id}`);
              return {
                ...result,
                itemId: meta?.id ?? null,
                itemStatus: meta?.status ?? null,
              };
            });
          })();
    const { memoryStats, lastRunSummary } =
      await this.resultService.getLatestRunDetails(orgId, id);

    return {
      task: {
        ...this.toView(task),
        results: hydratedWithItems,
        memoryStats,
        lastRunSummary,
      },
    };
  }

  async updateIngestToItems(
    orgId: string,
    userId: string,
    taskId: string,
    enabled: boolean,
    actorPermissions?: string[],
  ) {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id: taskId, orgId },
      include: { _count: { select: { results: true } } },
    });
    if (!task) {
      throw new NotFoundException("crawl task not found");
    }
    if (enabled === true && !actorPermissions?.includes("items.write")) {
      throw new ForbiddenException(
        "items.write permission is required to enable ingestToItems",
      );
    }

    const currentConfig =
      task.config &&
      typeof task.config === "object" &&
      !Array.isArray(task.config)
        ? (task.config as Record<string, unknown>)
        : null;
    const currentEnabled = currentConfig?.ingestToItems === true;
    if (enabled === currentEnabled) {
      return this.toView(task);
    }

    let nextConfig: Record<string, unknown> | null = currentConfig
      ? { ...currentConfig }
      : null;
    if (enabled) {
      nextConfig = {
        ...(nextConfig ?? {}),
        ingestToItems: true,
      };
    } else if (nextConfig && "ingestToItems" in nextConfig) {
      delete (nextConfig as { ingestToItems?: unknown }).ingestToItems;
      if (Object.keys(nextConfig).length === 0) {
        nextConfig = null;
      }
    }

    const updated = await this.prisma.crawlTask.update({
      where: { id: taskId },
      data: {
        config: nextConfig ? toPrismaJsonValue(nextConfig) : Prisma.DbNull,
      },
      include: { _count: { select: { results: true } } },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "crawlTask",
          action: "updateIngestToItems",
          metadata: toPrismaJsonValue({
            taskId,
            enabled,
          }),
        },
      },
      {
        orgId,
        actorId: userId,
        resource: "crawlTask",
        action: "updateIngestToItems",
      },
    );

    return this.toView(updated);
  }

  async ingestResultsToItems(
    orgId: string,
    userId: string,
    taskId: string,
    options?: {
      after?: string | null;
      limit?: number | null;
      onlyMissing?: boolean | null;
    },
  ): Promise<CrawlIngestBatchSummary> {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id: taskId, orgId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException("crawl task not found");
    }

    const itemsService = this.resolveItemsService();
    if (!itemsService) {
      throw new BadRequestException("ItemsService unavailable");
    }

    const normalizedAfter =
      typeof options?.after === "string" ? options.after.trim() : "";
    const take = (() => {
      const raw =
        typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.floor(options.limit)
          : 50;
      return Math.min(Math.max(raw, 1), 200);
    })();
    const onlyMissing = options?.onlyMissing !== false;

    const results = await this.prisma.crawlResult.findMany({
      where: { taskId },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: CRAWL_RESULT_ITEM_INGEST_SELECT,
      ...(normalizedAfter
        ? {
            skip: 1,
            cursor: { id: normalizedAfter },
          }
        : {}),
    });

    const hasMore = results.length > take;
    const page = results.slice(0, take);

    const externalIds = page.map((result) => `crawlResult:${result.id}`);
    const existing =
      onlyMissing && externalIds.length > 0
        ? await this.prisma.itemMeta.findMany({
            where: {
              orgId,
              externalId: { in: externalIds },
              mongoRef: { not: "" },
            },
            select: { externalId: true },
          })
        : [];
    const existingSet = new Set(existing.map((meta) => meta.externalId));

    let skippedExisting = 0;
    const candidates = page.filter((result) => {
      const externalId = `crawlResult:${result.id}`;
      if (onlyMissing && existingSet.has(externalId)) {
        skippedExisting += 1;
        return false;
      }
      return true;
    });

    const attempted = candidates.length;
    let ingested = 0;
    let failed = 0;

    const ingestResults =
      candidates.length > 0
        ? await itemsService.createFromCrawlResultsBatch(orgId, userId, {
            crawlResults: candidates,
          })
        : [];

    for (const result of ingestResults) {
      if (result.status === "fulfilled") {
        ingested += 1;
        continue;
      }
      failed += 1;
      logger.warn(
        { err: result.reason, orgId, taskId, crawlResultId: result.crawlResultId },
        "Failed to ingest crawl result into Items",
      );
    }

    return {
      taskId,
      scanned: page.length,
      attempted,
      ingested,
      skippedExisting,
      failed,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  async retryTask(
    orgId: string,
    userId: string,
    id: string,
    ip?: string,
    actorPermissions?: string[],
  ) {
    await this.actionRateLimit.enforceCrawlTaskCreate(orgId, userId, ip);
    const task = await this.prisma.crawlTask.findFirst({
      where: { id, orgId },
      include: { _count: { select: { results: true } } },
    });
    if (!task) {
      throw new NotFoundException("crawl task not found");
    }
    const config =
      task.config &&
      typeof task.config === "object" &&
      !Array.isArray(task.config)
        ? (task.config as Record<string, unknown>)
        : null;
    const ingestToItems = config?.ingestToItems === true;
    if (ingestToItems && !actorPermissions?.includes("items.write")) {
      throw new ForbiddenException(
        "items.write permission is required to ingest crawl results into Items",
      );
    }
    const enqueueOptions = this.extractEnqueueOptions(config);

    await this.prisma.crawlTask.update({
      where: { id },
      data: {
        status: "queued",
        lastError: null,
      },
    });
    await this.queueService.enqueueTask(id, orgId, userId, enqueueOptions);

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "crawlTask",
          action: "retry",
          metadata: { id },
        },
      },
      { orgId, actorId: userId, resource: "crawlTask", action: "retry" },
    );

    const refreshed = await this.prisma.crawlTask.findFirst({
      where: { id, orgId },
      include: { _count: { select: { results: true } } },
    });

    return this.toView(refreshed ?? task);
  }

  public toView(task: CrawlTaskRecord): CrawlTaskView {
    const config =
      task.config &&
      typeof task.config === "object" &&
      !Array.isArray(task.config)
        ? (task.config as Record<string, unknown>)
        : null;
    return {
      id: task.id,
      targetUrl: task.targetUrl,
      displayName: task.displayName,
      status: task.status,
      keywords: this.fromJsonArray(task.keywords),
      concurrency: task.concurrency,
      timeRangeFrom: task.timeRangeFrom,
      timeRangeTo: task.timeRangeTo,
      lastRunAt: task.lastRunAt,
      lastSuccessAt: task.lastSuccessAt,
      lastResultAt: task.lastResultAt,
      lastCursor: task.lastCursor,
      lastError: task.lastError,
      runCount: task.runCount,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      resultCount: task._count.results,
      config,
      memoryStats: undefined,
      lastRunSummary: undefined,
      lastServerMemoryMb: task.lastServerMemoryMb ?? null,
      lastPeakMemoryMb: task.lastPeakMemoryMb ?? null,
      lastMemoryEfficiency: task.lastMemoryEfficiency ?? null,
    };
  }

  private extractEnqueueOptions(
    config: Record<string, unknown> | null,
  ): EnqueueCrawlTaskOptions | undefined {
    if (!config) {
      return undefined;
    }

    const sourcePriorityRaw = config.sourcePriority;
    const sourcePriority =
      typeof sourcePriorityRaw === "number" &&
      Number.isFinite(sourcePriorityRaw)
        ? Math.round(sourcePriorityRaw)
        : undefined;

    const configuredPriorityClass = config.crawlPriorityClass;
    const priorityClassFromConfig: CrawlPriorityClass | undefined =
      configuredPriorityClass === "hot" || configuredPriorityClass === "normal"
        ? configuredPriorityClass
        : undefined;

    const inferredPriorityClass: CrawlPriorityClass | undefined =
      sourcePriority !== undefined
        ? sourcePriority >= CRAWL_HOT_PRIORITY_THRESHOLD
          ? "hot"
          : "normal"
        : undefined;

    const priorityClass = priorityClassFromConfig ?? inferredPriorityClass;
    if (priorityClass === undefined && sourcePriority === undefined) {
      return undefined;
    }

    return {
      ...(priorityClass ? { priorityClass } : {}),
      ...(sourcePriority !== undefined ? { sourcePriority } : {}),
    };
  }

  private fromJsonArray(value: Prisma.JsonValue | null): string[] {
    if (!value || !Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }

  private shouldRestrictJsExecution(
    options?: CrawlTaskOptionsInput | null,
  ): boolean {
    if (!options) {
      return false;
    }
    if (Array.isArray(options.jsCode) && options.jsCode.length > 0) {
      return true;
    }
    if (options.jsOnly) {
      return true;
    }
    const multiUrlConfigs = Array.isArray(options.multiUrlConfigs)
      ? options.multiUrlConfigs
      : [];
    for (const config of multiUrlConfigs) {
      const overrides = config?.options;
      if (!overrides) {
        continue;
      }
      if (Array.isArray(overrides.jsCode) && overrides.jsCode.length > 0) {
        return true;
      }
      if (overrides.jsOnly) {
        return true;
      }
    }
    return false;
  }

  private stripJsExecutionOptions(
    options: CrawlTaskOptionsInput,
  ): CrawlTaskOptionsInput {
    const sanitized: CrawlTaskOptionsInput = {
      ...options,
      jsCode: undefined,
      jsOnly: undefined,
    };
    if (
      !Array.isArray(options.multiUrlConfigs) ||
      options.multiUrlConfigs.length === 0
    ) {
      return sanitized;
    }
    sanitized.multiUrlConfigs = options.multiUrlConfigs.map((config) => {
      if (!config?.options) {
        return config;
      }
      return {
        ...config,
        options: {
          ...config.options,
          jsCode: undefined,
          jsOnly: undefined,
        },
      };
    });
    return sanitized;
  }

  private async isActorAdmin(orgId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          orgId,
          userId,
        },
      },
      select: {
        role: { select: { name: true } },
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!membership) {
      return false;
    }
    if (membership.role.name === "admin") {
      return true;
    }
    return membership.roles.some((link) => link.role.name === "admin");
  }

  private async normalizeActorOptions(
    orgId: string,
    userId: string,
    options?: CrawlTaskOptionsInput | null,
  ): Promise<CrawlTaskOptionsInput | undefined> {
    if (!options) {
      return undefined;
    }
    if (!this.shouldRestrictJsExecution(options)) {
      return options;
    }
    const isAdmin = await this.isActorAdmin(orgId, userId);
    if (isAdmin) {
      return options;
    }
    return this.stripJsExecutionOptions(options);
  }

  private normalizeMarkdownFilter(
    value?: CrawlTaskOptionsInput["markdownFilter"],
  ): CrawlMarkdownFilter | undefined {
    if (!value) {
      return undefined;
    }
    if (value.type === "bm25") {
      const query =
        typeof value.userQuery === "string" ? value.userQuery.trim() : "";
      if (!query) {
        return undefined;
      }
      return {
        type: "bm25",
        userQuery: query,
        bm25Threshold:
          typeof value.bm25Threshold === "number"
            ? value.bm25Threshold
            : undefined,
        language:
          typeof value.language === "string"
            ? value.language.trim()
            : undefined,
      };
    }
    return {
      type: "pruning",
      threshold: value.threshold,
      thresholdType: value.thresholdType,
      minWordThreshold: value.minWordThreshold,
    };
  }
}
