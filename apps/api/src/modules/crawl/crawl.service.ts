import { Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import type { CrawlResult, CrawlTask, CrawlTaskStatus, Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { createLogger } from "@modular/utils";
import { PrismaService } from "../config/prisma.service";
import { EnvService } from "../config/config.service";
import { CRAWL_QUEUE, CRAWL_QUEUE_NAME } from "./crawl.constants";
import {
  CrawlJobData,
  CrawlExecutionSummary,
  CrawlTaskOptions,
  CrawlMemoryStats,
  CrawlProxyConfig,
  CrawlMultiUrlConfig,
  CrawlUrlMatcher,
  CrawlStrategyOverrides
} from "./crawl.types";
import { CreateCrawlTaskDto } from "./dto/create-crawl-task.dto";
import { CrawlTaskDetailQueryDto, ListCrawlTaskDto } from "./dto/list-crawl-task.dto";
import { normalizeKeywords, clampResultLimit, coerceDate, hashMarkdown } from "./crawl.utils";
import { Crawl4aiClient, Crawl4aiArticle, Crawl4aiRequest } from "./crawl4ai.client";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { TaskLogModel, CrawlResultContentModel } from "@modular/mongo";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import type { MongoConnection } from "@modular/mongo";

const logger = createLogger({ name: "crawl-service" });

type CrawlTaskRecord = Prisma.CrawlTaskGetPayload<{
  include: {
    _count: {
      select: {
        results: true;
      };
    };
  };
}>;

export interface CrawlTaskResult {
  id: string;
  sourceUrl: string;
  fetchedAt: Date;
  markdown: string;
  metadata?: Record<string, unknown> | null;
  markdownWithCitations?: string | null;
  referencesMarkdown?: string | null;
  fitMarkdown?: string | null;
}

export interface CrawlTaskView {
  id: string;
  targetUrl: string;
  displayName?: string | null;
  status: CrawlTaskStatus;
  keywords: string[];
  concurrency: number;
  timeRangeFrom?: Date | null;
  timeRangeTo?: Date | null;
  lastRunAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastResultAt?: Date | null;
  lastCursor?: string | null;
  lastError?: string | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
  resultCount: number;
  config?: Record<string, unknown> | null;
  results?: CrawlTaskResult[];
  memoryStats?: CrawlMemoryStats | null;
  lastServerMemoryMb?: number | null;
  lastPeakMemoryMb?: number | null;
  lastMemoryEfficiency?: number | null;
}

@Injectable()
export class CrawlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    @Inject(CRAWL_QUEUE) private readonly crawlQueue: Queue<CrawlJobData>,
    private readonly crawlClient: Crawl4aiClient,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection
  ) {
    void this._mongo;
  }

  async createTask(orgId: string, userId: string, dto: CreateCrawlTaskDto) {
    const keywords = normalizeKeywords(dto.keywords);
    const timeRangeFrom = coerceDate(dto.timeRangeFrom);
    const timeRangeTo = coerceDate(dto.timeRangeTo);
    if (timeRangeFrom && timeRangeTo && timeRangeFrom > timeRangeTo) {
      throw new BadRequestException("timeRangeFrom must be earlier than timeRangeTo");
    }

    const normalizedOptions = this.normalizeOptions({
      includeImages: dto.options?.includeImages,
      onlyMainContent: dto.options?.onlyMainContent,
      extractLinks: dto.options?.extractLinks,
      scanFullPage: dto.options?.scanFullPage,
      scrollDelayMs: dto.options?.scrollDelayMs,
      enableUndetectedBrowser: dto.options?.enableUndetectedBrowser,
      enableStealthMode: dto.options?.enableStealthMode,
      simulateUser: dto.options?.simulateUser,
      overrideNavigator: dto.options?.overrideNavigator,
      proxyUrl: dto.options?.proxyUrl,
      proxyConfig: dto.options?.proxyConfig as CrawlProxyConfig | undefined,
      additionalUrls: dto.options?.additionalUrls,
      multiUrlConfigs: dto.options?.multiUrlConfigs as CrawlMultiUrlConfig[] | undefined
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

    await this.enqueueTask(created.id, orgId, userId);
    return this.toView(created);
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

    const hydrated = await this.attachResultContent(results);
    const memoryStats = await this.getLatestMemoryStats(id);

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
    await this.enqueueTask(id, orgId, userId);

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

  async enqueueTask(taskId: string, orgId: string, triggeredById?: string) {
    await this.crawlQueue.add(
      "crawl-task",
      { taskId, orgId, triggeredById },
      {
        jobId: `${taskId}:${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: false
      }
    );
    await this.prisma.crawlTask.update({
      where: { id: taskId },
      data: { status: "queued" }
    });
  }

  async runTask(taskId: string, orgId: string, triggeredById?: string): Promise<CrawlExecutionSummary> {
    const task = await this.prisma.crawlTask.findFirst({ where: { id: taskId, orgId } });
    if (!task) {
      logger.warn({ taskId }, "Attempted to run missing crawl task");
      return {
        inserted: 0,
        skipped: 0
      };
    }

    await this.prisma.crawlTask.update({
      where: { id: task.id },
      data: {
        status: "running",
        lastRunAt: new Date()
      }
    });

    await TaskLogModel.create({
      queue: CRAWL_QUEUE_NAME,
      jobId: taskId,
      stage: "start",
      status: "processing",
      message: "crawl task started",
      data: { taskId, triggeredById }
    });

    try {
      const payload = this.buildRequestPayload(task);
      const response = await this.crawlClient.crawl(payload);
      if (response.warnings && response.warnings.length > 0) {
        await TaskLogModel.create({
          queue: CRAWL_QUEUE_NAME,
          jobId: taskId,
          stage: "crawler",
          status: "completed",
          message: "crawl4ai warnings",
          data: { warnings: response.warnings }
        });
      }
      const summary = await this.persistResults(
        task,
        response.results ?? [],
        response.runId ?? undefined,
        this.extractMemoryStats(response)
      );

      await this.prisma.crawlTask.update({
        where: { id: task.id },
        data: {
          status: "completed",
          runCount: { increment: 1 },
          lastSuccessAt: new Date(),
          lastResultAt: summary.lastFetchedAt ?? task.lastResultAt,
          lastCursor: response.nextCursor ?? task.lastCursor,
          lastError: null,
          lastServerMemoryMb: summary.memory?.serverMemoryMb ?? task.lastServerMemoryMb,
          lastPeakMemoryMb: summary.memory?.peakMemoryMb ?? task.lastPeakMemoryMb,
          lastMemoryEfficiency: summary.memory?.efficiencyPercent ?? task.lastMemoryEfficiency
        }
      });

      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        stage: "complete",
        status: "completed",
        data: summary
      });

      return summary;
    } catch (error) {
      const message =
        error instanceof Crawl4aiRequestException ? error.message : "crawl job failed";
      await this.prisma.crawlTask.update({
        where: { id: task.id },
        data: {
          status: "failed",
          lastError: message
        }
      });
      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        stage: "error",
        status: "failed",
        error: {
          message
        }
      });
      throw error;
    }
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

  private buildRequestPayload(task: CrawlTask): Crawl4aiRequest {
    const keywords = this.fromJsonArray(task.keywords);
    const options = this.extractOptions(task.config);
    const urls = this.buildUrlList(task.targetUrl, options);
    return {
      url: task.targetUrl,
      urls,
      keywords,
      options
    };
  }

  private extractOptions(config: Prisma.JsonValue | null): CrawlTaskOptions {
    if (!config || typeof config !== "object") {
      return this.normalizeOptions();
    }
    const value = config as Record<string, unknown>;
    return this.normalizeOptions({
      includeImages: typeof value.includeImages === "boolean" ? value.includeImages : undefined,
      onlyMainContent: typeof value.onlyMainContent === "boolean" ? value.onlyMainContent : undefined,
      extractLinks: typeof value.extractLinks === "boolean" ? value.extractLinks : undefined,
      cacheMode: typeof value.cacheMode === "string" ? (value.cacheMode as CrawlTaskOptions["cacheMode"]) : undefined,
      scanFullPage: typeof value.scanFullPage === "boolean" ? value.scanFullPage : undefined,
      scrollDelayMs: typeof value.scrollDelayMs === "number" ? value.scrollDelayMs : undefined,
      enableUndetectedBrowser:
        typeof value.enableUndetectedBrowser === "boolean" ? value.enableUndetectedBrowser : undefined,
      enableStealthMode: typeof value.enableStealthMode === "boolean" ? value.enableStealthMode : undefined,
      simulateUser: typeof value.simulateUser === "boolean" ? value.simulateUser : undefined,
      overrideNavigator: typeof value.overrideNavigator === "boolean" ? value.overrideNavigator : undefined,
      proxyUrl: typeof value.proxyUrl === "string" ? value.proxyUrl : undefined,
      proxyConfig: this.parseProxyConfig(value.proxyConfig),
      additionalUrls: this.parseUrlArray(value.additionalUrls),
      multiUrlConfigs: this.parseMultiUrlConfigs(value.multiUrlConfigs),
      markdownOptions: this.parseMarkdownOptions(value.markdownOptions),
      markdownFilter: this.parseMarkdownFilter(value.markdownFilter)
    });
  }

  private normalizeOptions(options?: Partial<CrawlTaskOptions>): CrawlTaskOptions {
    const scanFullPage = options?.scanFullPage ?? false;
    let scrollDelayMs: number | undefined;
    if (scanFullPage) {
      scrollDelayMs =
        typeof options?.scrollDelayMs === "number"
          ? this.clampScrollDelay(options.scrollDelayMs)
          : 200;
    }
    const simulateUser =
      options?.simulateUser ??
      (options?.enableStealthMode ? true : false);
    const overrideNavigator =
      options?.overrideNavigator ??
      (options?.enableStealthMode ? true : false);
    const proxyConfig = this.normalizeProxyConfig(options?.proxyConfig);
    const proxyUrl = proxyConfig ? undefined : this.normalizeProxyUrl(options?.proxyUrl);
    const additionalUrls = this.normalizeUrlList(options?.additionalUrls);
    const multiUrlConfigs = this.normalizeMultiUrlConfigs(options?.multiUrlConfigs);
    const markdownOptions = this.normalizeMarkdownOptions(options?.markdownOptions);
    const markdownFilter = this.normalizeMarkdownFilter(options?.markdownFilter);

    return {
      includeImages: options?.includeImages ?? false,
      onlyMainContent: options?.onlyMainContent ?? true,
      extractLinks: options?.extractLinks ?? false,
      cacheMode: options?.cacheMode ?? "bypass",
      scanFullPage,
      scrollDelayMs,
      enableUndetectedBrowser: options?.enableUndetectedBrowser ?? false,
      enableStealthMode: options?.enableStealthMode ?? false,
      simulateUser,
      overrideNavigator,
      proxyConfig,
      proxyUrl,
      additionalUrls,
      multiUrlConfigs,
      markdownOptions,
      markdownFilter
    };
  }

  private clampScrollDelay(value: number) {
    if (Number.isNaN(value)) {
      return 200;
    }
    return Math.max(0, Math.min(5000, Math.round(value)));
  }

  private normalizeProxyUrl(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeProxyConfig(value?: CrawlProxyConfig | null): CrawlProxyConfig | undefined {
    if (!value) {
      return undefined;
    }
    const server = typeof value.server === "string" ? value.server.trim() : "";
    if (!server) {
      return undefined;
    }
    const username = typeof value.username === "string" ? value.username.trim() : "";
    const password = typeof value.password === "string" ? value.password.trim() : "";
    return {
      server,
      username: username.length > 0 ? username : undefined,
      password: password.length > 0 ? password : undefined
    };
  }

  private parseProxyConfig(value: unknown): CrawlProxyConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const server = typeof record.server === "string" ? record.server : undefined;
    if (!server) {
      return undefined;
    }
    return this.normalizeProxyConfig({
      server,
      username: typeof record.username === "string" ? record.username : undefined,
      password: typeof record.password === "string" ? record.password : undefined
    });
  }

  private normalizeUrlList(urls?: string[] | null): string[] | undefined {
    if (!urls || urls.length === 0) {
      return undefined;
    }
    const normalized = urls
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return undefined;
    }
    return Array.from(new Set(normalized));
  }

  private normalizeMultiUrlConfigs(configs?: CrawlMultiUrlConfig[] | null): CrawlMultiUrlConfig[] | undefined {
    if (!configs || configs.length === 0) {
      return undefined;
    }
    const normalized = configs
      .map((config) => this.normalizeMultiUrlConfig(config))
      .filter((entry): entry is CrawlMultiUrlConfig => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeMultiUrlConfig(config?: CrawlMultiUrlConfig | null): CrawlMultiUrlConfig | undefined {
    if (!config || typeof config !== "object") {
      return undefined;
    }
    const name = typeof config.name === "string" ? config.name.trim() : undefined;
    const matcher = this.normalizeMatcher(config.matcher);
    const urls = this.normalizeUrlList(config.urls ?? undefined);
    const options = this.normalizeStrategyOverrides(config.options);
    if (!matcher && (!urls || urls.length === 0)) {
      return undefined;
    }
    return {
      name,
      matcher,
      urls,
      options
    };
  }

  private normalizeMatcher(matcher?: CrawlUrlMatcher | null): CrawlUrlMatcher | undefined {
    if (!matcher) {
      return undefined;
    }
    const patterns = Array.isArray(matcher.patterns)
      ? matcher.patterns
          .map((pattern) => (typeof pattern === "string" ? pattern.trim() : ""))
          .filter((pattern) => pattern.length > 0)
      : [];
    if (patterns.length === 0) {
      return undefined;
    }
    return {
      matchMode: matcher.matchMode,
      patterns: patterns
    };
  }

  private normalizeStrategyOverrides(
    overrides?: CrawlStrategyOverrides | null
  ): CrawlStrategyOverrides | undefined {
    if (!overrides) {
      return undefined;
    }
    const normalized: CrawlStrategyOverrides = {};
    if (overrides.cacheMode) {
      normalized.cacheMode = overrides.cacheMode;
    }
    if (typeof overrides.onlyMainContent === "boolean") {
      normalized.onlyMainContent = overrides.onlyMainContent;
    }
    if (typeof overrides.extractLinks === "boolean") {
      normalized.extractLinks = overrides.extractLinks;
    }
    if (typeof overrides.scanFullPage === "boolean") {
      normalized.scanFullPage = overrides.scanFullPage;
    }
    if (typeof overrides.scrollDelayMs === "number") {
      normalized.scrollDelayMs = this.clampScrollDelay(overrides.scrollDelayMs);
    }
    if (typeof overrides.simulateUser === "boolean") {
      normalized.simulateUser = overrides.simulateUser;
    }
    if (typeof overrides.overrideNavigator === "boolean") {
      normalized.overrideNavigator = overrides.overrideNavigator;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeMarkdownOptions(
    options?: CrawlMarkdownOptions | null
  ): CrawlMarkdownOptions | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: CrawlMarkdownOptions = {};
    if (
      options.contentSource &&
      ["raw_html", "cleaned_html", "fit_html"].includes(options.contentSource)
    ) {
      normalized.contentSource = options.contentSource as CrawlMarkdownContentSource;
    }
    if (typeof options.ignoreLinks === "boolean") {
      normalized.ignoreLinks = options.ignoreLinks;
    }
    if (typeof options.escapeHtml === "boolean") {
      normalized.escapeHtml = options.escapeHtml;
    }
    if (typeof options.bodyWidth === "number" && Number.isFinite(options.bodyWidth)) {
      const clamped = Math.max(40, Math.min(200, Math.round(options.bodyWidth)));
      normalized.bodyWidth = clamped;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeMarkdownFilter(filter?: CrawlMarkdownFilter | null): CrawlMarkdownFilter | undefined {
    if (!filter || filter.type !== "pruning") {
      return undefined;
    }
    const normalized: CrawlMarkdownFilter = { type: "pruning" };
    if (typeof filter.threshold === "number" && Number.isFinite(filter.threshold)) {
      normalized.threshold = Math.max(0, Math.min(1, filter.threshold));
    }
    return normalized;
  }

  private parseUrlArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeUrlList(
      value.map((entry) => (typeof entry === "string" ? entry : "")).filter((entry): entry is string => Boolean(entry))
    );
  }

  private parseMultiUrlConfigs(value: unknown): CrawlMultiUrlConfig[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeMultiUrlConfigs(
      value.map((entry) => (typeof entry === "object" ? (entry as CrawlMultiUrlConfig) : undefined)).filter(Boolean)
    );
  }

  private parseMarkdownOptions(value: unknown): CrawlMarkdownOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeMarkdownOptions({
      contentSource: typeof record.contentSource === "string" ? (record.contentSource as CrawlMarkdownContentSource) : undefined,
      ignoreLinks: typeof record.ignoreLinks === "boolean" ? record.ignoreLinks : undefined,
      escapeHtml: typeof record.escapeHtml === "boolean" ? record.escapeHtml : undefined,
      bodyWidth: typeof record.bodyWidth === "number" ? record.bodyWidth : undefined
    });
  }

  private parseMarkdownFilter(value: unknown): CrawlMarkdownFilter | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (type !== "pruning") {
      return undefined;
    }
    return this.normalizeMarkdownFilter({
      type: "pruning",
      threshold: typeof record.threshold === "number" ? record.threshold : undefined
    });
  }

  private buildUrlList(baseUrl: string, options: CrawlTaskOptions): string[] {
    const accumulator = [baseUrl];
    if (options.additionalUrls) {
      accumulator.push(...options.additionalUrls);
    }
    if (options.multiUrlConfigs) {
      for (const config of options.multiUrlConfigs) {
        if (config.urls) {
          accumulator.push(...config.urls);
        }
      }
    }
    return Array.from(new Set(accumulator.filter((entry) => typeof entry === "string" && entry.length > 0)));
  }

  private normalizeMarkdownResult(markdown: unknown) {
    if (!markdown) {
      return { primary: undefined };
    }
    if (typeof markdown === "string") {
      return {
        primary: markdown,
        raw: markdown
      };
    }
    if (typeof markdown !== "object") {
      return { primary: undefined };
    }
    const record = markdown as Record<string, unknown>;
    const raw =
      this.ensureString(record.raw_markdown) ??
      this.ensureString(record.rawMarkdown) ??
      this.ensureString(record.markdown);
    const citations =
      this.ensureString(record.markdown_with_citations) ?? this.ensureString(record.markdownWithCitations);
    const references =
      this.ensureString(record.references_markdown) ?? this.ensureString(record.referencesMarkdown);
    const fit = this.ensureString(record.fit_markdown) ?? this.ensureString(record.fitMarkdown);
    const fallback = raw ?? citations ?? fit ?? references ?? this.ensureString(record.text);
    return {
      primary: fallback,
      raw: raw ?? fallback,
      citations,
      references,
      fit
    };
  }

  private ensureString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private async persistResults(
    task: CrawlTask,
    items: Crawl4aiArticle[],
    runId?: string,
    memory?: CrawlMemoryStats
  ): Promise<CrawlExecutionSummary> {
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

    for (const item of items) {
      const markdownResult = this.normalizeMarkdownResult(item.markdown);
      const markdown = markdownResult.primary ?? "";
      if (!markdown) {
        skipped += 1;
        continue;
      }
      const hash = hashMarkdown(markdown);
      const existing = await this.prisma.crawlResult.findFirst({
        where: {
          taskId: task.id,
          contentHash: hash
        }
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      const fetchedAt = coerceDate(item.publishedAt) ?? new Date();
      const created = await this.prisma.crawlResult.create({
        data: {
          taskId: task.id,
          sourceUrl: item.url ?? task.targetUrl,
          fetchedAt,
          markdownRef: "",
          contentHash: hash,
          metadata: item.metadata ?? {}
        }
      });
      const contentDoc = await CrawlResultContentModel.create({
        taskId: task.id,
        resultId: created.id,
        markdown,
        rawMarkdown: markdownResult.raw ?? markdown,
        markdownWithCitations: markdownResult.citations,
        referencesMarkdown: markdownResult.references,
        fitMarkdown: markdownResult.fit,
        metadata: item.metadata ?? {},
        sourceUrl: item.url ?? task.targetUrl,
        crawlRunId: runId
      });
      await this.prisma.crawlResult.update({
        where: { id: created.id },
        data: { markdownRef: contentDoc.id }
      });
      inserted += 1;
      if (!latestResultAt || fetchedAt > latestResultAt) {
        latestResultAt = fetchedAt;
      }
    }

    return {
      inserted,
      skipped,
      lastFetchedAt: latestResultAt,
      runId,
      memory
    };
  }

  private async attachResultContent(results: CrawlResult[]): Promise<CrawlTaskResult[]> {
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
        fitMarkdown: this.ensureString(doc?.fitMarkdown)
      };
    });
  }

  private async getLatestMemoryStats(taskId: string): Promise<CrawlMemoryStats | null> {
    const log = await TaskLogModel.findOne({
      queue: CRAWL_QUEUE_NAME,
      jobId: taskId,
      stage: "complete"
    })
      .sort({ createdAt: -1 })
      .lean();
    const stats = log?.data?.memory as CrawlMemoryStats | undefined;
    return stats ?? null;
  }

  private extractMemoryStats(response: Crawl4aiResponse): CrawlMemoryStats | undefined {
    if (
      response.serverMemoryMb === undefined &&
      response.peakMemoryMb === undefined &&
      response.memoryEfficiency === undefined
    ) {
      return undefined;
    }
    return {
      serverMemoryMb: response.serverMemoryMb,
      peakMemoryMb: response.peakMemoryMb,
      efficiencyPercent: response.memoryEfficiency
    };
  }
}
