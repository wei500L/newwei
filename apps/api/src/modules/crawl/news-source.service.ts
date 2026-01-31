import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { NewsSourceType, PipelineJobStatus, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { CrawlMetadataService } from "./crawl-metadata.service";
import {
  CreateNewsSourceDto,
  ListNewsSourceDto,
  ScheduleNewsSourceDto,
  UpdateNewsSourceDto,
} from "./dto/news-source.dto";

const ACTIVE_PIPELINE_JOB_STATUSES: PipelineJobStatus[] = [
  PipelineJobStatus.pending,
  PipelineJobStatus.queued,
  PipelineJobStatus.running,
  PipelineJobStatus.delayed,
];

export interface NewsSourceSeedConfig {
  enabled: boolean;
  mode: "sitemap" | "rss";
  domain?: string;
  pattern?: string;
  feedUrl?: string;
  maxUrls: number;
  maxNewUrlsPerRun: number;
  query?: string;
  scoreThreshold: number;
  concurrency: number;
  dedupeWindowHours: number;
}

export interface NewsSourcePreviewCandidate {
  url: string;
  status: "success" | "failed";
  title?: string;
  description?: string;
  author?: string;
  relevanceScore?: number;
  alreadyCrawled: boolean;
  lastCrawlAt?: string | null;
  alreadyQueued?: boolean;
  inFlightStatus?: PipelineJobStatus | null;
  error?: string;
}

@Injectable()
export class NewsSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metadataService: CrawlMetadataService,
    private readonly env: EnvService,
    private readonly cache: CacheService
  ) {}

  async listSources(orgId: string, query?: ListNewsSourceDto) {
    const where: Prisma.NewsSourceWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { url: { contains: search } }
      ];
    }

    const sources = await this.prisma.newsSource.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      include: {
        jobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            url: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            error: true,
            metadata: true
          }
        },
        articles: {
          orderBy: { crawlAt: "desc" },
          take: 1,
          select: { id: true, url: true, crawlAt: true, titleGuess: true }
        }
      }
    });

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value);

    const crawlTaskIds = Array.from(
      new Set(
        sources
          .map((source) => source.jobs?.[0]?.metadata)
          .map((metadata) => (isRecord(metadata) ? metadata.crawlTaskId : null))
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      )
    );

    const crawlTasks =
      crawlTaskIds.length > 0
        ? await this.prisma.crawlTask.findMany({
            where: { orgId, id: { in: crawlTaskIds } },
            select: {
              id: true,
              status: true,
              lastError: true,
              lastRunAt: true,
              lastSuccessAt: true,
              lastResultAt: true
            }
          })
        : [];

    const crawlTaskById = new Map(crawlTasks.map((task) => [task.id, task]));

    const sourceIdSet = new Set(sources.map((source) => source.id));
    const activeNewsSourceCrawlTasks = await this.prisma.crawlTask.findMany({
      where: {
        orgId,
        status: { in: ["queued", "running"] },
        displayName: { startsWith: "NewsSource:" }
      },
      select: { status: true, displayName: true }
    });

    const queueCountsBySourceId = new Map<string, { queued: number; running: number }>();
    const extractSourceIdFromDisplayName = (displayName: string) => {
      const match = /^NewsSource:([^:]+):/.exec(displayName);
      return match?.[1] ?? null;
    };
    for (const task of activeNewsSourceCrawlTasks) {
      const displayName = task.displayName;
      if (typeof displayName !== "string" || displayName.length === 0) {
        continue;
      }
      const sourceId = extractSourceIdFromDisplayName(displayName);
      if (!sourceId || !sourceIdSet.has(sourceId)) {
        continue;
      }
      const entry = queueCountsBySourceId.get(sourceId) ?? { queued: 0, running: 0 };
      if (task.status === "queued") {
        entry.queued += 1;
      } else if (task.status === "running") {
        entry.running += 1;
      }
      queueCountsBySourceId.set(sourceId, entry);
    }

    const backpressureKeys = sources.map((source) => `news-source:backpressure:${source.id}`);
    const backpressureEntries = await this.cache.getMany<{
      until?: unknown;
      pendingJobs?: unknown;
      threshold?: unknown;
    }>(backpressureKeys);
    const backpressureUntilBySourceId = new Map<string, string>();
    const backpressurePendingJobsBySourceId = new Map<string, number>();
    const backpressureThresholdBySourceId = new Map<string, number>();
    for (const [index, entry] of backpressureEntries.entries()) {
      const until = entry?.until;
      if (typeof until !== "string" || until.length === 0) {
        continue;
      }

      const id = sources[index]?.id;
      if (typeof id !== "string" || id.length === 0) {
        continue;
      }

      backpressureUntilBySourceId.set(id, until);

      const pendingJobs = entry?.pendingJobs;
      if (typeof pendingJobs === "number" && Number.isFinite(pendingJobs)) {
        backpressurePendingJobsBySourceId.set(id, pendingJobs);
      }

      const threshold = entry?.threshold;
      if (typeof threshold === "number" && Number.isFinite(threshold)) {
        backpressureThresholdBySourceId.set(id, threshold);
      }
    }

    const backpressureCountKeys = sources.map(
      (source) => `news-source:backpressure-count:${source.id}`
    );
    const backpressureCounts = await this.cache.getMany<number>(backpressureCountKeys);
    const backpressureCountBySourceId = new Map<string, number>();
    for (const [index, value] of backpressureCounts.entries()) {
      const id = sources[index]?.id;
      if (typeof id === "string" && id.length > 0) {
        backpressureCountBySourceId.set(id, typeof value === "number" ? value : 0);
      }
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pipelineJobs24h =
      sources.length > 0
        ? await this.prisma.pipelineJob.findMany({
            where: {
              orgId,
              sourceId: { in: sources.map((source) => source.id) },
              createdAt: { gte: since }
            },
            select: {
              sourceId: true,
              status: true,
              startedAt: true,
              completedAt: true
            }
          })
        : [];

    const statsBySourceId = new Map<
      string,
      { completed: number; failed: number; durationSumMs: number; durationCount: number }
    >();
    for (const job of pipelineJobs24h) {
      const sourceId = job.sourceId;
      if (!sourceId) {
        continue;
      }
      const entry = statsBySourceId.get(sourceId) ?? {
        completed: 0,
        failed: 0,
        durationSumMs: 0,
        durationCount: 0
      };
      if (job.status === PipelineJobStatus.completed) {
        entry.completed += 1;
      } else if (job.status === PipelineJobStatus.failed) {
        entry.failed += 1;
      }
      if (job.startedAt && job.completedAt) {
        entry.durationSumMs += job.completedAt.getTime() - job.startedAt.getTime();
        entry.durationCount += 1;
      }
      statsBySourceId.set(sourceId, entry);
    }

    return sources.map((source) => {
      const { jobs, articles, ...rest } = source;
      const latestJob = jobs?.[0] ?? null;
      const latestArticle = articles?.[0] ?? null;
      const crawlTaskId = isRecord(latestJob?.metadata) ? latestJob?.metadata.crawlTaskId : null;
      const latestCrawlTask =
        typeof crawlTaskId === "string" && crawlTaskId.length > 0
          ? crawlTaskById.get(crawlTaskId) ?? null
          : null;
      const crawlTaskQueueCounts = queueCountsBySourceId.get(source.id) ?? { queued: 0, running: 0 };
      const backpressureUntil = backpressureUntilBySourceId.get(source.id) ?? null;
      const backpressurePendingJobs = backpressurePendingJobsBySourceId.get(source.id) ?? null;
      const backpressureThreshold = backpressureThresholdBySourceId.get(source.id) ?? null;
      const backpressureCount24h = backpressureCountBySourceId.get(source.id) ?? 0;
      const stats = statsBySourceId.get(source.id) ?? null;
      const totalFinished = stats ? stats.completed + stats.failed : 0;
      const successRate = totalFinished > 0 ? stats!.completed / totalFinished : null;
      const avgDurationMs =
        stats && stats.durationCount > 0 ? stats.durationSumMs / stats.durationCount : null;

      return {
        ...rest,
        latestJob,
        latestCrawlTask,
        latestArticle,
        crawlTaskQueuedCount: crawlTaskQueueCounts.queued,
        crawlTaskRunningCount: crawlTaskQueueCounts.running,
        backpressureUntil,
        backpressurePendingJobs,
        backpressureThreshold,
        backpressureCount24h,
        stats24h: {
          completed: stats?.completed ?? 0,
          failed: stats?.failed ?? 0,
          successRate,
          avgDurationMs,
        }
      };
    });
  }

  async createSource(orgId: string, input: CreateNewsSourceDto) {
    const name = input.name.trim();
    const url = input.url.trim();
    if (!name) {
      throw new BadRequestException("name is required");
    }
    if (!url) {
      throw new BadRequestException("url is required");
    }
    const language = this.normalizeOptionalString(input.language);
    const crawlTemplateId = this.normalizeOptionalNullableString(input.crawlTemplateId);
    if (crawlTemplateId) {
      await this.assertTemplateInOrg(orgId, crawlTemplateId);
    }
    const config = this.normalizeConfig(input.config);
    const isActive = input.isActive ?? true;
    const nextRunAt = isActive ? new Date() : null;

    return this.prisma.newsSource.create({
      data: {
        orgId,
        name,
        url,
        siteType: input.siteType ?? NewsSourceType.general,
        language,
        crawlTemplateId,
        frequencySeconds: input.frequencySeconds,
        priority: input.priority,
        isActive,
        config: config ? toPrismaJsonValue(config) : Prisma.DbNull,
        nextRunAt
      }
    });
  }

  async updateSource(orgId: string, id: string, input: UpdateNewsSourceDto) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const data: Prisma.NewsSourceUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException("name is required");
      }
      data.name = name;
    }
    if (input.url !== undefined) {
      const url = input.url.trim();
      if (!url) {
        throw new BadRequestException("url is required");
      }
      data.url = url;
    }
    if (input.siteType !== undefined) {
      data.siteType = input.siteType;
    }
    if (input.language !== undefined) {
      data.language = this.normalizeOptionalString(input.language);
    }
    if (input.crawlTemplateId !== undefined) {
      const crawlTemplateId = this.normalizeOptionalNullableString(input.crawlTemplateId);
      if (crawlTemplateId) {
        await this.assertTemplateInOrg(orgId, crawlTemplateId);
      }
      data.crawlTemplate = crawlTemplateId ? { connect: { id: crawlTemplateId } } : { disconnect: true };
    }
    if (input.frequencySeconds !== undefined) {
      data.frequencySeconds = input.frequencySeconds;
    }
    if (input.priority !== undefined) {
      data.priority = input.priority;
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.config !== undefined) {
      if (input.config === null) {
        data.config = Prisma.DbNull;
      } else if (input.config) {
        data.config = toPrismaJsonValue(this.normalizeConfig(input.config));
      }
    }

    const isActivating = input.isActive === true && !existing.isActive;
    const frequencyChanged =
      input.frequencySeconds !== undefined && input.frequencySeconds !== existing.frequencySeconds;

    if (input.isActive === false) {
      data.nextRunAt = null;
    } else if (isActivating || frequencyChanged) {
      data.nextRunAt = new Date();
    }
    if (isActivating) {
      data.circuitOpenUntil = null;
      data.consecutiveFailures = 0;
    }

    return this.prisma.newsSource.update({ where: { id }, data });
  }

  async deleteSource(orgId: string, id: string) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }
    await this.prisma.newsSource.delete({ where: { id } });
    return { ok: true };
  }

  async runNow(orgId: string, id: string) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }
    return this.prisma.newsSource.update({
      where: { id },
      data: {
        isActive: true,
        nextRunAt: new Date(),
        circuitOpenUntil: null
      }
    });
  }

  async schedule(orgId: string, id: string, input: ScheduleNewsSourceDto) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const nextRunAt = new Date(input.nextRunAt);
    if (Number.isNaN(nextRunAt.getTime())) {
      throw new BadRequestException("nextRunAt must be a valid ISO date string");
    }

    return this.prisma.newsSource.update({
      where: { id },
      data: {
        isActive: true,
        nextRunAt,
        circuitOpenUntil: null,
      },
    });
  }

  async preview(orgId: string, id: string) {
    const source = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const activeCutoff = new Date(
      Date.now() - this.env.newsSourceSchedulerConfig.inFlightLookbackMs
    );

    const config =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : null;

    const seedConfig = this.normalizeSeedConfig(config, source.url);
    const inFlightLimit = seedConfig?.enabled ? seedConfig.maxNewUrlsPerRun : 1;
    const inFlightCount = await this.countActivePipelineJobs(source.id, activeCutoff, inFlightLimit);
    const capacity = Math.max(0, inFlightLimit - inFlightCount);
    if (!seedConfig?.enabled) {
      const inFlight = await this.findActivePipelineJobs(source.id, [source.url], activeCutoff);
      const inFlightStatus = inFlight.get(source.url) ?? null;
      return {
        mode: "single",
        sourceId: source.id,
        url: source.url,
        name: source.name,
        candidates: [
          {
            url: source.url,
            status: "success",
            alreadyCrawled: false,
            alreadyQueued: Boolean(inFlightStatus),
            inFlightStatus
          } satisfies NewsSourcePreviewCandidate
        ],
        inFlightCount,
        inFlightLimit,
        scheduleCount: capacity > 0 ? 1 : 0,
        skippedCount: capacity > 0 ? 0 : 1,
        seed: seedConfig
      };
    }

    const discovery =
      seedConfig.mode === "rss"
        ? await this.metadataService.discoverRssUrls({
            feedUrl: seedConfig.feedUrl ?? source.url,
            maxUrls: seedConfig.maxUrls
          })
        : await this.metadataService.discoverSitemapUrls({
            domain: seedConfig.domain,
            pattern: seedConfig.pattern,
            maxUrls: seedConfig.maxUrls
          });

    const metadataResults =
      discovery.length > 0
        ? await this.metadataService.extract({
            source: "urls",
            urls: discovery,
            query: seedConfig.query,
            scoreThreshold: seedConfig.scoreThreshold,
            concurrency: seedConfig.concurrency,
            extractJsonLd: false,
            extractOpenGraph: false,
            extractStandardMeta: false
          })
        : [];

    const candidateUrls = metadataResults.map((result) => result.url);
    const [crawlLookup, activeLookup] = await Promise.all([
      this.findRecentCrawls(orgId, candidateUrls, seedConfig.dedupeWindowHours),
      this.findActivePipelineJobs(source.id, candidateUrls, activeCutoff),
    ]);

    const candidates: NewsSourcePreviewCandidate[] = metadataResults.map((result) => {
      const lastCrawlAt = crawlLookup.get(result.url)?.toISOString() ?? null;
      const inFlightStatus = activeLookup.get(result.url) ?? null;
      return {
        url: result.url,
        status: result.status,
        title: result.title,
        description: result.description,
        author: result.author,
        relevanceScore: result.relevanceScore,
        alreadyCrawled: Boolean(lastCrawlAt),
        lastCrawlAt,
        alreadyQueued: Boolean(inFlightStatus),
        inFlightStatus,
        error: result.status === "failed" ? result.error : undefined
      };
    });

    const availableToSchedule = candidates.filter(
      (candidate) => candidate.status === "success" && !candidate.alreadyCrawled && !candidate.alreadyQueued
    ).length;
    const scheduleCount = Math.min(availableToSchedule, capacity);
    const skippedCount = candidates.length - scheduleCount;

    return {
      mode: seedConfig.mode,
      sourceId: source.id,
      url: source.url,
      name: source.name,
      seed: seedConfig,
      candidates,
      availableToSchedule,
      inFlightCount,
      inFlightLimit,
      scheduleCount,
      skippedCount
    };
  }

  private normalizeOptionalString(value?: string | null) {
    if (value === undefined || value === null) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeOptionalNullableString(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async assertTemplateInOrg(orgId: string, templateId: string) {
    const template = await this.prisma.crawlTemplate.findUnique({
      where: { id: templateId },
      select: { orgId: true }
    });
    if (!template || template.orgId !== orgId) {
      throw new BadRequestException("Invalid crawlTemplateId");
    }
  }

  private normalizeConfig(config?: Record<string, unknown> | null) {
    if (!config) {
      return null;
    }
    if (typeof config !== "object" || Array.isArray(config)) {
      throw new BadRequestException("config must be an object");
    }
    return config;
  }

  private normalizeSeedConfig(config: Record<string, unknown> | null, sourceUrl: string): NewsSourceSeedConfig | null {
    const rawSeed =
      config?.seed && typeof config.seed === "object" && !Array.isArray(config.seed)
        ? (config.seed as Record<string, unknown>)
        : null;
    const enabled = rawSeed?.enabled === true;
    if (!enabled) {
      return null;
    }

    const modeRaw = typeof rawSeed?.mode === "string" ? rawSeed.mode.trim().toLowerCase() : "";
    const mode: NewsSourceSeedConfig["mode"] = modeRaw === "rss" ? "rss" : "sitemap";

    const domain = mode === "sitemap" ? this.normalizeSeedDomain(rawSeed?.domain, sourceUrl) : undefined;
    const pattern = typeof rawSeed?.pattern === "string" ? rawSeed.pattern.trim() : "";
    const feedUrl = mode === "rss" ? this.normalizeSeedFeedUrl(rawSeed?.feedUrl, sourceUrl) : undefined;
    const query = typeof rawSeed?.query === "string" ? rawSeed.query.trim() : "";

    const keywords = this.normalizeStringList(config?.keywords);
    const effectiveQuery = query.length > 0 ? query : keywords.length > 0 ? keywords.join(" ") : undefined;

    return {
      enabled: true,
      mode,
      domain,
      pattern: mode === "sitemap" && pattern.length > 0 ? pattern : undefined,
      feedUrl,
      maxUrls: this.clampInt(rawSeed?.maxUrls, 1, 200, 20),
      maxNewUrlsPerRun: this.clampInt(rawSeed?.maxNewUrlsPerRun, 1, 50, 10),
      query: effectiveQuery,
      scoreThreshold: this.clampFloat(rawSeed?.scoreThreshold, 0, 1, 0),
      concurrency: this.clampInt(rawSeed?.concurrency, 1, 10, 5),
      dedupeWindowHours: this.clampInt(rawSeed?.dedupeWindowHours, 0, 24 * 30, 24)
    };
  }

  private normalizeSeedDomain(domainOverride: unknown, sourceUrl: string) {
    const raw = typeof domainOverride === "string" ? domainOverride.trim() : "";
    const candidate = raw.length > 0 ? raw : sourceUrl;
    const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      return new URL(withProtocol).origin.replace(/\/+$/, "");
    } catch {
      try {
        return new URL(sourceUrl).origin.replace(/\/+$/, "");
      } catch {
        return undefined;
      }
    }
  }

  private normalizeSeedFeedUrl(feedUrlOverride: unknown, sourceUrl: string) {
    const raw = typeof feedUrlOverride === "string" ? feedUrlOverride.trim() : "";
    const candidate = raw.length > 0 ? raw : sourceUrl;
    const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      return new URL(withProtocol).toString();
    } catch {
      try {
        return new URL(sourceUrl).toString();
      } catch {
        return undefined;
      }
    }
  }

  private normalizeStringList(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.round(value);
    return Math.min(max, Math.max(min, rounded));
  }

  private clampFloat(value: unknown, min: number, max: number, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }

  private async findRecentCrawls(orgId: string, urls: string[], dedupeWindowHours: number) {
    const hours = Math.max(0, Math.min(24 * 30, Math.floor(dedupeWindowHours)));
    if (hours === 0 || urls.length === 0) {
      return new Map<string, Date>();
    }
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const records = await this.prisma.article.findMany({
      where: { orgId, url: { in: urls }, crawlAt: { gte: since } },
      select: { url: true, crawlAt: true }
    });

    const byUrl = new Map<string, Date>();
    for (const record of records) {
      const existing = byUrl.get(record.url);
      if (!existing || record.crawlAt > existing) {
        byUrl.set(record.url, record.crawlAt);
      }
    }
    return byUrl;
  }

  private async findActivePipelineJobs(sourceId: string, urls: string[], activeCutoff: Date) {
    if (urls.length === 0) {
      return new Map<string, PipelineJobStatus>();
    }
    const records = await this.prisma.pipelineJob.findMany({
      where: {
        sourceId,
        url: { in: urls },
        status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
        createdAt: { gte: activeCutoff },
      },
      select: { url: true, status: true, createdAt: true },
    });

    const byUrl = new Map<string, { status: PipelineJobStatus; createdAt: Date }>();
    for (const record of records) {
      const existing = byUrl.get(record.url);
      if (!existing || record.createdAt > existing.createdAt) {
        byUrl.set(record.url, { status: record.status, createdAt: record.createdAt });
      }
    }

    return new Map(Array.from(byUrl.entries()).map(([url, value]) => [url, value.status]));
  }

  private async countActivePipelineJobs(sourceId: string, activeCutoff: Date, limit: number) {
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const records = await this.prisma.pipelineJob.findMany({
      where: {
        sourceId,
        status: { in: ACTIVE_PIPELINE_JOB_STATUSES },
        createdAt: { gte: activeCutoff },
      },
      select: { id: true },
      take: capped,
    });
    return records.length;
  }
}
