import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import {
  estimateFreshnessScore,
  inferFrontierPageType,
  normalizeCrawlSiteProfileConfig,
  resolveNodeQueueClass,
  scoreFrontierCandidate,
  shouldRejectFrontierUrl,
} from "./crawl-frontier.utils";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import { CrawlSiteProfileService } from "./crawl-site-profile.service";
import type {
  CrawlExecutionSummary,
  CrawlFrontierNodeRecord,
  CrawlFrontierPageType,
  CrawlPriorityClass,
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
  CrawlTaskOptions,
} from "./crawl.types";
import { Crawl4aiClient, type Crawl4aiArticle } from "./crawl4ai.client";
import {
  CreateCrawlFrontierRunDto,
  ListCrawlFrontierRunDto,
} from "./dto/crawl-frontier.dto";
import {
  buildCanonicalUrlFingerprint,
  resolveQueryParamAllowlist,
} from "./url-fingerprint";

interface FrontierCandidate {
  url: string;
  pageType: CrawlFrontierPageType;
  score: number;
  freshnessScore: number;
  metadata: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

@Injectable()
export class CrawlFrontierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: CrawlSiteProfileService,
    private readonly crawlClient: Crawl4aiClient,
    private readonly resultService: CrawlResultService,
    private readonly queueService: CrawlQueueService,
  ) {}

  async listRuns(orgId: string, query?: ListCrawlFrontierRunDto) {
    const where: Prisma.CrawlFrontierRunWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [
        { seedUrl: { contains: search } },
        { nativeRunId: { contains: search } },
      ];
    }
    if (query?.profileId) {
      where.profileId = query.profileId;
    }
    if (query?.status) {
      where.status = query.status;
    }
    return this.prisma.crawlFrontierRun.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      include: {
        profile: {
          select: {
            id: true,
            name: true,
            matchHost: true,
            executionMode: true,
            version: true,
          },
        },
      },
    });
  }

  async getRun(orgId: string, id: string) {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id },
      include: {
        profile: true,
        nodes: {
          orderBy: [{ depth: "asc" }, { discoveredAt: "asc" }],
        },
      },
    });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier run not found");
    }
    return {
      ...run,
      profile: run.profile
        ? {
            ...run.profile,
            config: normalizeCrawlSiteProfileConfig(run.profile.config),
          }
        : null,
      nodes: run.nodes.map((node) => this.mapNode(node)),
    };
  }

  async createRun(
    orgId: string,
    actorId: string,
    input: CreateCrawlFrontierRunDto,
  ) {
    const seedUrl = this.normalizeUrl(input.seedUrl);
    const profile = input.profileId
      ? await this.profiles.getProfile(orgId, input.profileId)
      : await this.profiles.findProfileForUrl(orgId, seedUrl);
    if (!profile) {
      throw new BadRequestException(
        "No active crawl site profile matches the provided seed URL",
      );
    }

    const layeredOptions = profile.config.layeredOptions;
    const keywords = Array.from(
      new Set([
        ...(input.keywords ?? []),
        ...(profile.config.keywords ?? []),
      ]),
    );
    const maxDepth = this.clampInt(
      input.maxDepth ?? layeredOptions?.maxDepth,
      1,
      8,
      3,
    );
    const maxPages = this.clampInt(
      input.maxPages ?? layeredOptions?.maxPages,
      1,
      500,
      60,
    );
    const executionMode =
      (input.executionMode as CrawlSiteExecutionMode | undefined) ??
      profile.executionMode;

    const syntheticTask = await this.prisma.crawlTask.create({
      data: {
        orgId,
        createdById: actorId,
        targetUrl: seedUrl,
        displayName: `Frontier: ${profile.name}`.slice(0, 80),
        status: "queued",
        concurrency: 1,
        keywords: toPrismaJsonValue(keywords),
        config: toPrismaJsonValue({
          frontier: true,
          frontierProfileId: profile.id,
          executionMode,
          urlQueryParamAllowlist: resolveQueryParamAllowlist(
            profile.config.urlQueryParamAllowlist,
          ),
          itemPayload: {
            metadata: {
              frontier: true,
              crawlSiteProfileId: profile.id,
            },
          },
        }),
      },
    });

    const run = await this.prisma.crawlFrontierRun.create({
      data: {
        orgId,
        profileId: profile.id,
        seedUrl,
        crawlTaskId: syntheticTask.id,
        executionMode,
        status: "queued",
        maxDepth,
        maxPages,
        keywords: toPrismaJsonValue(keywords),
        createdById: actorId,
        metadata: toPrismaJsonValue({
          profileVersion: profile.version,
        }),
      },
    });

    const rootNode = await this.prisma.crawlFrontierNode.create({
      data: {
        runId: run.id,
        orgId,
        url: seedUrl,
        pageType: "home",
        depth: 0,
        queueClass: "hot",
        status: "queued",
        queuedAt: new Date(),
        metadata: toPrismaJsonValue({
          seed: true,
          profileId: profile.id,
        }),
      },
    });

    await this.queueService.enqueueFrontierNode({
      orgId,
      taskId: syntheticTask.id,
      frontierRunId: run.id,
      frontierNodeId: rootNode.id,
      priorityClass: "hot",
    });

    return this.getRun(orgId, run.id);
  }

  async cancelRun(orgId: string, id: string) {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id },
    });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier run not found");
    }
    await this.prisma.crawlFrontierRun.update({
      where: { id },
      data: {
        status: "canceled",
        finishedAt: new Date(),
      },
    });
    await this.prisma.crawlFrontierNode.updateMany({
      where: {
        runId: id,
        status: { in: ["pending", "queued", "running"] },
      },
      data: {
        status: "canceled",
        updatedAt: new Date(),
      },
    });
    return this.getRun(orgId, id);
  }

  async retryNode(orgId: string, nodeId: string) {
    const node = await this.prisma.crawlFrontierNode.findUnique({
      where: { id: nodeId },
      include: { run: true },
    });
    if (!node || node.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier node not found");
    }
    if (!node.run.crawlTaskId) {
      throw new BadRequestException("Crawl frontier run is missing crawlTaskId");
    }
    await this.prisma.crawlFrontierNode.update({
      where: { id: node.id },
      data: {
        status: "queued",
        lastError: null,
        rejectionReason: null,
        queuedAt: new Date(),
      },
    });
    await this.prisma.crawlFrontierRun.update({
      where: { id: node.runId },
      data: {
        status: "queued",
        finishedAt: null,
      },
    });
    await this.queueService.enqueueFrontierNode({
      orgId,
      taskId: node.run.crawlTaskId,
      frontierRunId: node.runId,
      frontierNodeId: node.id,
      priorityClass: node.queueClass as CrawlPriorityClass,
    });
    return this.getRun(orgId, node.runId);
  }

  async processQueuedNode(
    nodeId: string,
    orgId: string,
    requestTimeoutMs?: number | null,
  ): Promise<CrawlExecutionSummary> {
    const node = await this.prisma.crawlFrontierNode.findUnique({
      where: { id: nodeId },
      include: {
        run: true,
      },
    });
    if (!node || node.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier node not found");
    }

    if (node.run.status === "canceled") {
      await this.prisma.crawlFrontierNode.update({
        where: { id: node.id },
        data: {
          status: "canceled",
        },
      });
      return { inserted: 0, skipped: 0 };
    }

    const profile = node.run.profileId
      ? await this.profiles.getProfile(orgId, node.run.profileId)
      : await this.profiles.findProfileForUrl(orgId, node.run.seedUrl);
    if (!profile) {
      throw new BadRequestException("Crawl frontier run cannot resolve site profile");
    }
    if (!node.run.crawlTaskId) {
      throw new BadRequestException("Crawl frontier run is missing crawlTaskId");
    }
    const task = await this.prisma.crawlTask.findUnique({
      where: { id: node.run.crawlTaskId },
    });
    if (!task || task.orgId !== orgId) {
      throw new BadRequestException("Synthetic crawl task not found for crawl frontier run");
    }

    await this.prisma.crawlFrontierRun.update({
      where: { id: node.runId },
      data: {
        status: "running",
        startedAt: node.run.startedAt ?? new Date(),
      },
    });
    await this.prisma.crawlFrontierNode.update({
      where: { id: node.id },
      data: {
        status: "running",
        attempts: { increment: 1 },
      },
    });

    try {
      const summary = await this.executeNode({
        node: this.mapNode(node),
        run: {
          ...node.run,
          keywords: coerceStringArray(node.run.keywords),
        },
        profile,
        task,
        requestTimeoutMs,
      });
      await this.refreshRunStatus(node.runId);
      return summary;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "crawl frontier node failed";
      await this.prisma.crawlFrontierNode.update({
        where: { id: node.id },
        data: {
          status: "failed",
          lastError: message,
        },
      });
      await this.prisma.crawlFrontierRun.update({
        where: { id: node.runId },
        data: {
          lastError: message,
        },
      });
      await this.refreshRunStatus(node.runId);
      throw error;
    }
  }

  private async executeNode(options: {
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
      executionMode: CrawlSiteExecutionMode;
      crawlTaskId: string | null;
      keywords?: string[];
      nativeRunId?: string | null;
    };
    profile: CrawlSiteProfileRecord;
    task: CrawlTask;
    requestTimeoutMs?: number | null;
  }) {
    const useNativeAtRoot =
      options.node.depth === 0 &&
      (options.run.executionMode === "native" ||
        options.run.executionMode === "hybrid") &&
      Boolean(options.profile.config.nativeOptions?.deepCrawlStrategy);

    if (useNativeAtRoot) {
      return this.executeNativeRootNode(options);
    }
    return this.executeLayeredNode(options);
  }

  private async executeLayeredNode(options: {
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
      executionMode: CrawlSiteExecutionMode;
      crawlTaskId: string | null;
      keywords?: string[];
    };
    profile: CrawlSiteProfileRecord;
    task: CrawlTask;
    requestTimeoutMs?: number | null;
  }) {
    const crawlOptions = this.buildLayeredCrawlOptions(
      options.profile.config,
      options.node.pageType,
    );
    const response = await this.crawlClient.crawl({
      url: options.node.url,
      keywords: options.run.keywords,
      options: crawlOptions,
      requestTimeoutMs:
        typeof options.requestTimeoutMs === "number"
          ? options.requestTimeoutMs
          : undefined,
    });

    const persisted = await this.persistFrontierResponse({
      response,
      node: options.node,
      runId: options.run.id,
      task: options.task,
      crawlOptions,
      executionMode: options.run.executionMode,
    });
    const selfMetadata =
      persisted.selfResult?.metadata && isPlainObject(persisted.selfResult.metadata)
        ? persisted.selfResult.metadata
        : null;

    await this.prisma.crawlFrontierNode.update({
      where: { id: options.node.id },
      data: {
        status: "completed",
        crawledAt: new Date(),
        canonicalUrl:
          typeof selfMetadata?.canonicalUrl === "string"
            ? selfMetadata.canonicalUrl
            : null,
        urlFingerprint:
          typeof selfMetadata?.urlFingerprint === "string"
            ? selfMetadata.urlFingerprint
            : options.node.urlFingerprint,
        crawlResultId: persisted.selfResult?.id ?? null,
        score: persisted.selfScore ?? options.node.score ?? null,
        freshnessScore:
          persisted.selfFreshnessScore ?? options.node.freshnessScore ?? null,
        lastError: null,
      },
    });

    if (
      options.node.pageType !== "article" &&
      options.node.depth < options.run.maxDepth
    ) {
      await this.discoverChildNodes({
        node: options.node,
        runId: options.run.id,
        taskId: options.task.id,
        maxDepth: options.run.maxDepth,
        maxPages: options.run.maxPages,
        profile: options.profile,
        results: response.results,
      });
    }

    return persisted.summary;
  }

  private async executeNativeRootNode(options: {
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
      executionMode: CrawlSiteExecutionMode;
      crawlTaskId: string | null;
      keywords?: string[];
    };
    profile: CrawlSiteProfileRecord;
    task: CrawlTask;
    requestTimeoutMs?: number | null;
  }) {
    const baseOptions = this.buildLayeredCrawlOptions(
      options.profile.config,
      options.node.pageType,
    );
    const response = await this.crawlClient.crawl({
      url: options.node.url,
      keywords: options.run.keywords,
      options: {
        ...baseOptions,
        deepCrawlStrategy:
          options.profile.config.nativeOptions?.deepCrawlStrategy,
        filterChain: options.profile.config.nativeOptions?.filterChain,
        urlScorer: options.profile.config.nativeOptions?.urlScorer,
        adaptiveCrawling: options.profile.config.nativeOptions?.adaptiveCrawling,
      },
      requestTimeoutMs:
        typeof options.requestTimeoutMs === "number"
          ? options.requestTimeoutMs
          : undefined,
    });

    const persisted = await this.persistFrontierResponse({
      response,
      node: options.node,
      runId: options.run.id,
      task: options.task,
      crawlOptions: baseOptions,
      executionMode: options.run.executionMode,
    });

    await this.prisma.crawlFrontierRun.update({
      where: { id: options.run.id },
      data: {
        nativeRunId: response.runId ?? undefined,
      },
    });

    const createdUrls = new Set<string>();
    for (const result of persisted.results) {
      const sourceUrl =
        typeof result.sourceUrl === "string" && result.sourceUrl.length > 0
          ? result.sourceUrl
          : "";
      if (!sourceUrl || sourceUrl === options.node.url || createdUrls.has(sourceUrl)) {
        continue;
      }
      createdUrls.add(sourceUrl);
      const pageType = inferFrontierPageType({
        url: sourceUrl,
        parentPageType: options.node.pageType,
        config: options.profile.config,
      });
      const canonical = buildCanonicalUrlFingerprint(
        sourceUrl,
        options.profile.config.urlQueryParamAllowlist,
      );
      await this.prisma.crawlFrontierNode.create({
        data: {
          runId: options.run.id,
          parentNodeId: options.node.id,
          orgId: options.node.orgId,
          url: sourceUrl,
          canonicalUrl: canonical?.canonicalUrl,
          urlFingerprint: canonical?.fingerprint,
          pageType,
          depth: Math.min(options.run.maxDepth, pageType === "article" ? 3 : 1),
          queueClass: resolveNodeQueueClass({
            pageType,
            freshnessScore: estimateFreshnessScore(sourceUrl),
          }),
          status: "completed",
          crawledAt: new Date(),
          crawlResultId: result.id,
          score: 1,
          freshnessScore: estimateFreshnessScore(sourceUrl),
          metadata: toPrismaJsonValue({
            nativeDiscovered: true,
          }),
        },
      });
    }

    await this.prisma.crawlFrontierNode.update({
      where: { id: options.node.id },
      data: {
        status: "completed",
        crawledAt: new Date(),
        crawlResultId: persisted.selfResult?.id ?? null,
        lastError: null,
      },
    });

    return persisted.summary;
  }

  private buildLayeredCrawlOptions(
    config: CrawlSiteProfileConfig,
    pageType: CrawlFrontierPageType,
  ): CrawlTaskOptions {
    const base = isPlainObject(config.crawlOptions)
      ? (config.crawlOptions as Record<string, unknown>)
      : {};
    const pageRule =
      isPlainObject(config.pageRules?.[pageType])
        ? (config.pageRules?.[pageType] as Record<string, unknown>)
        : {};
    const cleanMarkdown = {
      ...(isPlainObject(base.cleanMarkdown)
        ? (base.cleanMarkdown as Record<string, unknown>)
        : {}),
      ...(isPlainObject(pageRule.cleanMarkdown)
        ? (pageRule.cleanMarkdown as Record<string, unknown>)
        : {}),
    };
    const fallbackWordCount =
      pageType === "article"
        ? 140
        : pageType === "list"
          ? 60
          : 30;

    return {
      ...(base as CrawlTaskOptions),
      ...(pageRule as CrawlTaskOptions),
      cacheMode: "bypass",
      extractLinks: pageType !== "article",
      scoreLinks: pageType !== "article",
      excludeExternalLinks: true,
      onlyMainContent: pageType === "article",
      pageTypeHint: pageType === "article" ? "detail" : "list",
      autoExpandDetails: false,
      wordCountThreshold: this.clampInt(
        (pageRule.wordCountThreshold as number | undefined) ??
          (base.wordCountThreshold as number | undefined),
        0,
        5000,
        fallbackWordCount,
      ),
      cleanMarkdown:
        Object.keys(cleanMarkdown).length > 0
          ? (cleanMarkdown as CrawlTaskOptions["cleanMarkdown"])
          : undefined,
    };
  }

  private async persistFrontierResponse(options: {
    response: { runId?: string | null; results: Crawl4aiArticle[] };
    node: CrawlFrontierNodeRecord;
    runId: string;
    task: CrawlTask;
    crawlOptions: CrawlTaskOptions;
    executionMode: CrawlSiteExecutionMode;
  }) {
    const enrichedResults = options.response.results.map((result) => ({
      ...result,
      metadata: {
        ...(result.metadata ?? {}),
        frontierRunId: options.runId,
        frontierNodeId: options.node.id,
        frontierPageType: options.node.pageType,
        frontierDepth: options.node.depth,
        frontierExecutionMode: options.executionMode,
      },
    }));
    const summary = await this.resultService.persistResults(
      options.task,
      enrichedResults,
      options.crawlOptions,
      options.response.runId ?? undefined,
    );
    const sourceUrls = Array.from(
      new Set(
        enrichedResults
          .map((entry) => (typeof entry.url === "string" ? entry.url.trim() : ""))
          .filter((entry) => entry.length > 0),
      ),
    );
    const persistedResults = sourceUrls.length
      ? await this.prisma.crawlResult.findMany({
          where: {
            taskId: options.task.id,
            sourceUrl: { in: sourceUrls },
          },
          orderBy: { fetchedAt: "desc" },
        })
      : [];
    const resultBySourceUrl = new Map<string, (typeof persistedResults)[number]>();
    for (const result of persistedResults) {
      if (!resultBySourceUrl.has(result.sourceUrl)) {
        resultBySourceUrl.set(result.sourceUrl, result);
      }
    }
    const selfResult =
      resultBySourceUrl.get(options.node.url) ??
      persistedResults[0] ??
      null;
    return {
      summary,
      selfResult,
      selfScore: selfResult?.metadata && isPlainObject(selfResult.metadata)
        ? Number(selfResult.metadata.frontierScore ?? 0)
        : undefined,
      selfFreshnessScore:
        selfResult?.metadata && isPlainObject(selfResult.metadata)
          ? Number(selfResult.metadata.frontierFreshnessScore ?? 0)
          : undefined,
      results: persistedResults,
    };
  }

  private async discoverChildNodes(options: {
    node: CrawlFrontierNodeRecord;
    runId: string;
    taskId: string;
    maxDepth: number;
    maxPages: number;
    profile: CrawlSiteProfileRecord;
    results: Crawl4aiArticle[];
  }) {
    const candidates = this.extractCandidates(
      options.node,
      options.profile.config,
      options.results,
    );
    if (candidates.length === 0) {
      return;
    }

    const existingCount = await this.prisma.crawlFrontierNode.count({
      where: { runId: options.runId },
    });
    const remainingBudget = Math.max(0, options.maxPages - existingCount);
    if (remainingBudget === 0) {
      return;
    }

    const fingerprintCandidates = candidates
      .map((candidate) =>
        buildCanonicalUrlFingerprint(
          candidate.url,
          options.profile.config.urlQueryParamAllowlist,
        ),
      )
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const existingNodes = fingerprintCandidates.length
      ? await this.prisma.crawlFrontierNode.findMany({
          where: {
            runId: options.runId,
            OR: [
              {
                urlFingerprint: {
                  in: fingerprintCandidates
                    .map((entry) => entry.fingerprint)
                    .filter((entry) => entry.length > 0),
                },
              },
              {
                canonicalUrl: {
                  in: fingerprintCandidates
                    .map((entry) => entry.canonicalUrl)
                    .filter((entry) => entry.length > 0),
                },
              },
            ],
          },
          select: {
            canonicalUrl: true,
            urlFingerprint: true,
          },
        })
      : [];
    const seenFingerprints = new Set(
      existingNodes
        .map((entry) => entry.urlFingerprint ?? entry.canonicalUrl ?? "")
        .filter((entry) => entry.length > 0),
    );

    const paginationKeepCount = this.clampInt(
      options.profile.config.layeredOptions?.paginationKeepCount,
      1,
      10,
      3,
    );
    let created = 0;
    let listPagesCreated = 0;
    for (const candidate of candidates) {
      if (created >= remainingBudget) {
        break;
      }
      if (options.node.depth + 1 > options.maxDepth) {
        break;
      }
      const canonical = buildCanonicalUrlFingerprint(
        candidate.url,
        options.profile.config.urlQueryParamAllowlist,
      );
      const dedupeKey = canonical?.fingerprint ?? canonical?.canonicalUrl ?? candidate.url;
      if (seenFingerprints.has(dedupeKey)) {
        continue;
      }
      if (
        candidate.pageType === "list" &&
        listPagesCreated >= paginationKeepCount
      ) {
        continue;
      }
      const queueClass = resolveNodeQueueClass({
        pageType: candidate.pageType,
        freshnessScore: candidate.freshnessScore,
      });
      const node = await this.prisma.crawlFrontierNode.create({
        data: {
          runId: options.runId,
          parentNodeId: options.node.id,
          orgId: options.node.orgId,
          url: candidate.url,
          canonicalUrl: canonical?.canonicalUrl,
          urlFingerprint: canonical?.fingerprint,
          pageType: candidate.pageType,
          depth: options.node.depth + 1,
          queueClass,
          status: "queued",
          score: candidate.score,
          freshnessScore: candidate.freshnessScore,
          queuedAt: new Date(),
          metadata: toPrismaJsonValue(candidate.metadata),
        },
      });
      seenFingerprints.add(dedupeKey);
      created += 1;
      if (candidate.pageType === "list") {
        listPagesCreated += 1;
      }
      await this.queueService.enqueueFrontierNode({
        orgId: options.node.orgId,
        taskId: options.taskId,
        frontierRunId: options.runId,
        frontierNodeId: node.id,
        priorityClass: queueClass,
      });
    }
  }

  private extractCandidates(
    node: CrawlFrontierNodeRecord,
    config: CrawlSiteProfileConfig,
    results: Crawl4aiArticle[],
  ): FrontierCandidate[] {
    const byUrl = new Map<string, FrontierCandidate>();
    const sameDomainHost = new URL(node.url).hostname;
    for (const result of results) {
      const baseUrl =
        typeof result.url === "string" && result.url.trim().length > 0
          ? result.url.trim()
          : node.url;
      for (const links of Object.values(result.links ?? {})) {
        if (!Array.isArray(links)) {
          continue;
        }
        for (const link of links) {
          const href =
            typeof link.href === "string"
              ? link.href.trim()
              : typeof link.url === "string"
                ? link.url.trim()
                : "";
          if (!href) {
            continue;
          }
          let resolvedUrl = href;
          try {
            resolvedUrl = new URL(href, baseUrl).toString();
          } catch {
            continue;
          }
          if (resolvedUrl === node.url) {
            continue;
          }
          const rejectionReason = shouldRejectFrontierUrl({
            url: resolvedUrl,
            config,
            requireSameDomainHost: sameDomainHost,
          });
          if (rejectionReason) {
            continue;
          }
          const pageType = inferFrontierPageType({
            url: resolvedUrl,
            parentPageType: node.pageType,
            config,
          });
          const freshnessScore = estimateFreshnessScore(resolvedUrl);
          const rawScore =
            typeof link.totalScore === "number"
              ? link.totalScore
              : typeof link.total_score === "number"
                ? link.total_score
                : typeof link.contextualScore === "number"
                  ? link.contextualScore
                  : typeof link.contextual_score === "number"
                    ? link.contextual_score
                    : typeof link.intrinsicScore === "number"
                      ? link.intrinsicScore
                      : typeof link.intrinsic_score === "number"
                        ? link.intrinsic_score
                        : 0;
          const score = scoreFrontierCandidate({
            url: resolvedUrl,
            pageType,
            config,
            rawScore,
            linkText:
              typeof link.text === "string"
                ? link.text
                : typeof link.title === "string"
                  ? link.title
                  : undefined,
          });
          const existing = byUrl.get(resolvedUrl);
          if (!existing || score > existing.score) {
            byUrl.set(resolvedUrl, {
              url: resolvedUrl,
              pageType,
              score,
              freshnessScore,
              metadata: {
                discoveredFromNodeId: node.id,
                discoveredFromPageType: node.pageType,
                linkText: link.text ?? link.title ?? null,
                frontierScore: score,
                frontierFreshnessScore: freshnessScore,
              },
            });
          }
        }
      }
    }

    const threshold = config.layeredOptions?.scoreThreshold ?? 0.35;
    return Array.from(byUrl.values())
      .filter((entry) => entry.score >= threshold)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.freshnessScore - left.freshnessScore ||
          left.url.localeCompare(right.url),
      )
      .slice(0, config.layeredOptions?.maxChildrenPerNode ?? 24);
  }

  private async refreshRunStatus(runId: string) {
    const [run, nodes] = await Promise.all([
      this.prisma.crawlFrontierRun.findUnique({ where: { id: runId } }),
      this.prisma.crawlFrontierNode.findMany({
        where: { runId },
        select: {
          status: true,
          pageType: true,
          rejectionReason: true,
        },
      }),
    ]);
    if (!run) {
      return;
    }
    const nodeCount = nodes.length;
    const pageCount = nodes.filter((node) => node.status === "completed").length;
    const articleCount = nodes.filter(
      (node) => node.status === "completed" && node.pageType === "article",
    ).length;
    const failedCount = nodes.filter((node) => node.status === "failed").length;
    const duplicateCount = nodes.filter(
      (node) => node.rejectionReason === "duplicate",
    ).length;
    const activeCount = nodes.filter((node) =>
      node.status === "pending" ||
      node.status === "queued" ||
      node.status === "running"
    ).length;

    let status = run.status;
    if (run.status !== "canceled" && activeCount === 0) {
      status = pageCount > 0 ? "completed" : failedCount > 0 ? "failed" : run.status;
    }

    await this.prisma.crawlFrontierRun.update({
      where: { id: runId },
      data: {
        status,
        nodeCount,
        pageCount,
        articleCount,
        failedCount,
        duplicateCount,
        finishedAt:
          activeCount === 0 && status !== "running" && status !== "queued"
            ? new Date()
            : null,
      },
    });
  }

  private normalizeUrl(value: string) {
    try {
      return new URL(value).toString();
    } catch {
      throw new BadRequestException("seedUrl must be a valid absolute URL");
    }
  }

  private clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }

  private mapNode(
    node: {
      id: string;
      runId: string;
      parentNodeId: string | null;
      orgId: string;
      url: string;
      canonicalUrl: string | null;
      urlFingerprint: string | null;
      pageType: CrawlFrontierPageType;
      depth: number;
      queueClass: CrawlPriorityClass;
      status: CrawlFrontierNodeRecord["status"];
      score: number | null;
      freshnessScore: number | null;
      attempts: number;
      queuedAt: Date | null;
      crawledAt: Date | null;
      crawlResultId: string | null;
      rejectionReason: string | null;
      lastError: string | null;
      metadata: Prisma.JsonValue;
      discoveredAt: Date;
      createdAt: Date;
      updatedAt: Date;
    },
  ): CrawlFrontierNodeRecord {
    return {
      ...node,
      parentNodeId: node.parentNodeId ?? null,
      canonicalUrl: node.canonicalUrl ?? null,
      urlFingerprint: node.urlFingerprint ?? null,
      score: node.score ?? null,
      freshnessScore: node.freshnessScore ?? null,
      queuedAt: node.queuedAt ?? null,
      crawledAt: node.crawledAt ?? null,
      crawlResultId: node.crawlResultId ?? null,
      rejectionReason: node.rejectionReason ?? null,
      lastError: node.lastError ?? null,
      metadata: isPlainObject(node.metadata)
        ? (node.metadata as Record<string, unknown>)
        : null,
    };
  }
}
