import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { MongoOutboxStatus, MongoOutboxType } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { ActionRateLimitService } from "../cache/action-rate-limit.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import {
  collectCrawlTaskConfigSensitiveFields,
  CrawlTaskConfigEncryptionRequiredError,
  decodeCrawlTaskConfigKey,
  protectCrawlTaskConfigForStorage,
  redactCrawlTaskConfigForView
} from "./crawl-config-secrets";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import type { CrawlMarkdownFilter, CrawlTaskView } from "./crawl.types";
import { clampResultLimit, coerceDate, normalizeKeywords } from "./crawl.utils";
import { CreateCrawlTaskDto } from "./dto/create-crawl-task.dto";
import { CrawlTaskDetailQueryDto, ListCrawlTaskDto } from "./dto/list-crawl-task.dto";

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

@Injectable()
export class CrawlTaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly executionService: CrawlExecutionService,
    private readonly queueService: CrawlQueueService,
    private readonly resultService: CrawlResultService,
    private readonly actionRateLimit: ActionRateLimitService
  ) {}

  async createTask(orgId: string, userId: string, dto: CreateCrawlTaskDto, ip?: string) {
    await this.actionRateLimit.enforceCrawlTaskCreate(orgId, userId, ip);

    const rawOptions = dto.options ?? undefined;
    const normalizedRawOptions = await this.normalizeActorOptions(orgId, userId, rawOptions);

    const keywords = normalizeKeywords(dto.keywords);
    const timeRangeFrom = coerceDate(dto.timeRangeFrom);
    const timeRangeTo = coerceDate(dto.timeRangeTo);
    if (timeRangeFrom && timeRangeTo && timeRangeFrom > timeRangeTo) {
      throw new BadRequestException("timeRangeFrom must be earlier than timeRangeTo");
    }

    const normalizedOptions = this.executionService.normalizeOptions({
      includeImages: normalizedRawOptions?.includeImages,
      storeMedia: normalizedRawOptions?.storeMedia,
      onlyMainContent: normalizedRawOptions?.onlyMainContent,
      extractLinks: normalizedRawOptions?.extractLinks,
      scanFullPage: normalizedRawOptions?.scanFullPage,
      adjustViewportToContent: normalizedRawOptions?.adjustViewportToContent,
      scrollDelayMs: normalizedRawOptions?.scrollDelayMs,
      enableUndetectedBrowser: normalizedRawOptions?.enableUndetectedBrowser,
      enableStealthMode: normalizedRawOptions?.enableStealthMode,
      useManagedBrowser: normalizedRawOptions?.useManagedBrowser,
      userDataDir: normalizedRawOptions?.userDataDir,
      simulateUser: normalizedRawOptions?.simulateUser,
      overrideNavigator: normalizedRawOptions?.overrideNavigator,
      jsCode: normalizedRawOptions?.jsCode,
      jsOnly: normalizedRawOptions?.jsOnly,
      sessionId: normalizedRawOptions?.sessionId,
      storageState: normalizedRawOptions?.storageState,
      proxyUrl: normalizedRawOptions?.proxyUrl,
      proxyConfig: normalizedRawOptions?.proxyConfig,
      additionalUrls: normalizedRawOptions?.additionalUrls,
      multiUrlConfigs: normalizedRawOptions?.multiUrlConfigs,
      markdownOptions: normalizedRawOptions?.markdownOptions,
      markdownFilter: this.normalizeMarkdownFilter(normalizedRawOptions?.markdownFilter),
      markdownStrategy: normalizedRawOptions?.markdownStrategy,
      cleanMarkdown: normalizedRawOptions?.cleanMarkdown,
      scoreLinks: normalizedRawOptions?.scoreLinks,
      linkPreview: normalizedRawOptions?.linkPreview
    });
    const configSensitiveFields = collectCrawlTaskConfigSensitiveFields(
      normalizedOptions as Record<string, unknown>
    );

    const defaultConcurrency = this.env.crawl4aiConfig.maxConcurrency;
    const concurrency = Math.min(dto.concurrency ?? defaultConcurrency, defaultConcurrency);
    const encryptionKeyRaw = this.env.crawlTaskConfigEncryptionKey;
    const encryptionKey = encryptionKeyRaw ? decodeCrawlTaskConfigKey(encryptionKeyRaw) : undefined;
    let protectedConfig: Record<string, unknown> | null = normalizedOptions as Record<string, unknown>;
    try {
      protectedConfig = protectCrawlTaskConfigForStorage(
        normalizedOptions as Record<string, unknown>,
        encryptionKey
      ).config;
    } catch (error) {
      if (error instanceof CrawlTaskConfigEncryptionRequiredError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

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
        ...(protectedConfig ? { config: toPrismaJsonValue(protectedConfig) } : {}),
        runCount: 0
      },
      include: { _count: { select: { results: true } } }
    });

    const auditMetadata: Record<string, unknown> = {
      targetUrl: dto.url,
      keywords,
      concurrency
    };
    if (configSensitiveFields.length > 0) {
      auditMetadata.configSensitiveFields = configSensitiveFields;
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "crawlTask",
          action: "create",
          metadata: toPrismaJsonValue(auditMetadata)
        }
      },
      { orgId, actorId: userId, resource: "crawlTask", action: "create" }
    );

    await this.queueService.enqueueTask(created.id, orgId, userId);
    await this.prisma.crawlTask.update({ where: { id: created.id }, data: { status: "queued" } });

    return this.toView(created);
  }

  async deleteTask(orgId: string, userId: string, taskId: string) {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id: taskId, orgId },
      include: { results: { select: { id: true } } }
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
            orgId
          }
        }
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
              deletedResultCount: resultIds.length
            }
          }
        },
        { orgId, actorId: userId, resource: "crawlTask", action: "delete" }
      );
    });

    return { taskId, deletedResultCount: resultIds.length };
  }

  async listTasks(orgId: string, filters: ListCrawlTaskDto) {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 10;
    const where: Prisma.CrawlTaskWhereInput = {
      orgId
    };
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.search) {
      where.OR = [
        { targetUrl: { contains: filters.search } },
        { displayName: { contains: filters.search } }
      ];
    }

    const [tasks, total] = await Promise.all([
      this.prisma.crawlTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { results: true } } }
      }),
      this.prisma.crawlTask.count({ where })
    ]);

    return {
      tasks: tasks.map((task) => this.toView(task)),
      total,
      page,
      pageSize
    };
  }

  async getTask(orgId: string, id: string, query: CrawlTaskDetailQueryDto) {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id, orgId },
      include: { _count: { select: { results: true } } }
    });
    if (!task) {
      throw new NotFoundException("crawl task not found");
    }

    const limit = clampResultLimit(query.resultLimit);
    const resultWhere: Prisma.CrawlResultWhereInput = {
      taskId: id
    };
    if (query.resultSearch) {
      resultWhere.OR = [{ sourceUrl: { contains: query.resultSearch } }];
    }

    const results = await this.prisma.crawlResult.findMany({
      where: resultWhere,
      orderBy: { fetchedAt: "desc" },
      take: limit
    });

    const hydrated = await this.resultService.attachResultContent(results);
    const memoryStats = await this.resultService.getLatestMemoryStats(orgId, id);

    return {
      task: {
        ...this.toView(task),
        results: hydrated,
        memoryStats
      }
    };
  }

  async retryTask(orgId: string, userId: string, id: string, ip?: string) {
    await this.actionRateLimit.enforceCrawlTaskCreate(orgId, userId, ip);
    const task = await this.prisma.crawlTask.findFirst({
      where: { id, orgId },
      include: { _count: { select: { results: true } } }
    });
    if (!task) {
      throw new NotFoundException("crawl task not found");
    }

    await this.prisma.crawlTask.update({
      where: { id },
      data: {
        status: "queued",
        lastError: null
      }
    });
    await this.queueService.enqueueTask(id, orgId, userId);

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId: userId,
          resource: "crawlTask",
          action: "retry",
          metadata: { id }
        }
      },
      { orgId, actorId: userId, resource: "crawlTask", action: "retry" }
    );

    const refreshed = await this.prisma.crawlTask.findFirst({
      where: { id, orgId },
      include: { _count: { select: { results: true } } }
    });

    return this.toView(refreshed ?? task);
  }

  public toView(task: CrawlTaskRecord): CrawlTaskView {
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
      config: redactCrawlTaskConfigForView((task.config as Record<string, unknown> | null) ?? null),
      memoryStats: undefined,
      lastServerMemoryMb: task.lastServerMemoryMb ?? null,
      lastPeakMemoryMb: task.lastPeakMemoryMb ?? null,
      lastMemoryEfficiency: task.lastMemoryEfficiency ?? null
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

  private shouldRestrictJsExecution(options?: CrawlTaskOptionsInput | null): boolean {
    if (!options) {
      return false;
    }
    if (Array.isArray(options.jsCode) && options.jsCode.length > 0) {
      return true;
    }
    if (options.jsOnly) {
      return true;
    }
    const multiUrlConfigs = Array.isArray(options.multiUrlConfigs) ? options.multiUrlConfigs : [];
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

  private stripJsExecutionOptions(options: CrawlTaskOptionsInput): CrawlTaskOptionsInput {
    const sanitized: CrawlTaskOptionsInput = {
      ...options,
      jsCode: undefined,
      jsOnly: undefined
    };
    if (!Array.isArray(options.multiUrlConfigs) || options.multiUrlConfigs.length === 0) {
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
          jsOnly: undefined
        }
      };
    });
    return sanitized;
  }

  private async isActorAdmin(orgId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          orgId,
          userId
        }
      },
      select: {
        role: { select: { name: true } },
        roles: { select: { role: { select: { name: true } } } }
      }
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
    options?: CrawlTaskOptionsInput | null
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

  private normalizeMarkdownFilter(value?: CrawlTaskOptionsInput["markdownFilter"]): CrawlMarkdownFilter | undefined {
    if (!value) {
      return undefined;
    }
    return {
      type: "pruning",
      threshold: value.threshold,
      thresholdType: value.thresholdType,
      minWordThreshold: value.minWordThreshold
    };
  }
}
