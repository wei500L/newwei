import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../config/prisma.service";
import { EnvService } from "../config/config.service";
import { ActionRateLimitService } from "../cache/action-rate-limit.service";
import { clampResultLimit, coerceDate, normalizeKeywords } from "./crawl.utils";
import { CreateCrawlTaskDto } from "./dto/create-crawl-task.dto";
import { CrawlTaskDetailQueryDto, ListCrawlTaskDto } from "./dto/list-crawl-task.dto";
import { CrawlExecutionService } from "./crawl-execution.service";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import type { CrawlTaskView } from "./crawl.types";

type CrawlTaskRecord = Prisma.CrawlTaskGetPayload<{
  include: {
    _count: {
      select: {
        results: true;
      };
    };
  };
}>;

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

  async createTask(orgId: string, userId: string, dto: CreateCrawlTaskDto) {
    await this.actionRateLimit.enforceCrawlTaskCreate(orgId, userId);

    const keywords = normalizeKeywords(dto.keywords);
    const timeRangeFrom = coerceDate(dto.timeRangeFrom);
    const timeRangeTo = coerceDate(dto.timeRangeTo);
    if (timeRangeFrom && timeRangeTo && timeRangeFrom > timeRangeTo) {
      throw new BadRequestException("timeRangeFrom must be earlier than timeRangeTo");
    }

    const normalizedOptions = this.executionService.normalizeOptions({
      includeImages: dto.options?.includeImages,
      storeMedia: dto.options?.storeMedia,
      onlyMainContent: dto.options?.onlyMainContent,
      extractLinks: dto.options?.extractLinks,
      scanFullPage: dto.options?.scanFullPage,
      adjustViewportToContent: dto.options?.adjustViewportToContent,
      scrollDelayMs: dto.options?.scrollDelayMs,
      enableUndetectedBrowser: dto.options?.enableUndetectedBrowser,
      enableStealthMode: dto.options?.enableStealthMode,
      useManagedBrowser: dto.options?.useManagedBrowser,
      userDataDir: dto.options?.userDataDir,
      simulateUser: dto.options?.simulateUser,
      overrideNavigator: dto.options?.overrideNavigator,
      sessionId: dto.options?.sessionId,
      storageState: dto.options?.storageState,
      proxyUrl: dto.options?.proxyUrl,
      proxyConfig: dto.options?.proxyConfig,
      additionalUrls: dto.options?.additionalUrls,
      multiUrlConfigs: dto.options?.multiUrlConfigs,
      markdownOptions: dto.options?.markdownOptions,
      markdownFilter: dto.options?.markdownFilter,
      markdownStrategy: dto.options?.markdownStrategy,
      cleanMarkdown: dto.options?.cleanMarkdown,
      scoreLinks: dto.options?.scoreLinks,
      linkPreview: dto.options?.linkPreview
    });

    const defaultConcurrency = this.env.crawl4aiConfig.maxConcurrency;
    const concurrency = Math.min(dto.concurrency ?? defaultConcurrency, defaultConcurrency);
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
        config: normalizedOptions,
        runCount: 0
      },
      include: { _count: { select: { results: true } } }
    });

    await this.prisma.auditLog.create({
      data: {
        orgId,
        actorId: userId,
        resource: "crawlTask",
        action: "create",
        metadata: {
          targetUrl: dto.url,
          keywords,
          concurrency
        }
      }
    });

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
      await tx.auditLog.create({
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
      });
    });

    await this.resultService.deleteTaskResults(taskId, orgId);

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
        { targetUrl: { contains: filters.search, mode: "insensitive" } },
        { displayName: { contains: filters.search, mode: "insensitive" } }
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
      resultWhere.OR = [{ sourceUrl: { contains: query.resultSearch, mode: "insensitive" } }];
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

  async retryTask(orgId: string, userId: string, id: string) {
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

    await this.prisma.auditLog.create({
      data: {
        orgId,
        actorId: userId,
        resource: "crawlTask",
        action: "retry",
        metadata: { id }
      }
    });

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
      config: (task.config as Record<string, unknown> | null) ?? null,
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
}
