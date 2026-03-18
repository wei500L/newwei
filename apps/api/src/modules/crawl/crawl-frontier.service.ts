import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import {
  classifyFrontierFailureKind,
  computeFrontierPageTypeBudgets,
  estimateFreshnessScore,
  inferFrontierPageType,
  isUtilityFrontierLinkText,
  normalizeCrawlSiteProfileConfig,
  prioritizeFrontierCandidates,
  resolveFreshnessBucket,
  resolveLocaleScopeLanguage,
  resolveNodeQueueClass,
  scoreFrontierCandidate,
  shouldRejectFrontierUrl,
  toRegistrableDomain,
} from "./crawl-frontier.utils";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import { CrawlSiteProfileService } from "./crawl-site-profile.service";
import type {
  CrawlBrowserHeader,
  CrawlDeepCrawlComponent,
  CrawlExecutionSummary,
  CrawlFrontierNodeRecord,
  CrawlFrontierPageType,
  CrawlPriorityClass,
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
  CrawlTaskOptions,
} from "./crawl.types";
import {
  Crawl4aiClient,
  type Crawl4aiArticle,
  type Crawl4aiResponse,
} from "./crawl4ai.client";
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

interface FrontierCandidateExtraction {
  candidates: FrontierCandidate[];
  diagnostics: {
    candidateStats: {
      scanned: number;
      unique: number;
      accepted: number;
      selected: number;
      rejected: number;
      trimmed: number;
    };
    rejectionCounts: Record<string, number>;
    acceptedPageTypeCounts: Record<CrawlFrontierPageType, number>;
    warningFlags: string[];
    syntheticListActivated: boolean;
  };
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

function bumpCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeMetadataRecords(
  ...records: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function toNumericRecord(
  value: unknown,
): Record<string, number> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = typeof entry === "number" ? entry : Number(entry);
    if (Number.isFinite(parsed)) {
      result[key] = parsed;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function uniqueStringList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = Array.from(
    new Set(
      lists.flatMap((list) =>
        (list ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      ),
    ),
  );
  return merged.length > 0 ? merged : undefined;
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

function mergeBrowserHeaders(
  ...headerSets: Array<CrawlBrowserHeader[] | undefined>
): CrawlBrowserHeader[] | undefined {
  const merged = new Map<string, CrawlBrowserHeader>();
  for (const headerSet of headerSets) {
    for (const header of headerSet ?? []) {
      const name = typeof header?.name === "string" ? header.name.trim() : "";
      const value = typeof header?.value === "string" ? header.value.trim() : "";
      if (!name || !value) {
        continue;
      }
      merged.set(normalizeHeaderName(name), { name, value });
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
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
    const runs = await this.prisma.crawlFrontierRun.findMany({
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
    return runs.map((run) => this.mapRun(run));
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
      ...this.mapRun(run),
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
          pageTypeBudgets: computeFrontierPageTypeBudgets({
            maxDepth,
        maxPages,
      }),
      sourceTier: profile.config.sourceTier ?? "tier2",
      hostScope:
        profile.config.hostScope ??
        ((profile.config.allowedHosts?.length ?? 0) > 0 &&
        (profile.config.allowedDomains?.length ?? 0) === 0
          ? "strict_hosts"
          : "registrable_domain"),
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
          sourceTier: profile.config.sourceTier ?? "tier2",
          discoveryPath: ["home"],
          frontierPath: ["home"],
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
        metadata: toPrismaJsonValue(
          mergeMetadataRecords(
            isPlainObject(node.metadata)
              ? (node.metadata as Record<string, unknown>)
              : undefined,
            {
              failureKind: null,
              warningFlags: [],
              retryQueuedAt: new Date().toISOString(),
            },
          ),
        ),
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
      const failureKind = classifyFrontierFailureKind(message);
      await this.prisma.crawlFrontierNode.update({
        where: { id: node.id },
        data: {
          status: "failed",
          lastError: message,
          metadata: toPrismaJsonValue(
            mergeMetadataRecords(
              this.mapNode(node).metadata,
              {
                failureKind,
                warningFlags: uniqueStringList(
                  coerceStringArray(
                    isPlainObject(node.metadata)
                      ? (node.metadata as Record<string, unknown>).warningFlags
                      : undefined,
                  ),
                  failureKind ? [failureKind] : undefined,
                ) ?? [],
              },
            ),
          ),
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
    const runtimeMetadata = this.buildNodeRuntimeMetadata({
      node: options.node,
      profile: options.profile,
      response,
      selfMetadata,
      crawlOptions,
    });
    const discoveryMetadata =
      options.node.pageType !== "article" &&
      options.node.depth < options.run.maxDepth
        ? await this.discoverChildNodes({
            node: options.node,
            runId: options.run.id,
            taskId: options.task.id,
            maxDepth: options.run.maxDepth,
            maxPages: options.run.maxPages,
            profile: options.profile,
            results: response.results,
          })
        : undefined;

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
        metadata: toPrismaJsonValue(
          mergeMetadataRecords(
            options.node.metadata,
            runtimeMetadata,
            discoveryMetadata,
          ),
        ),
      },
    });

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
    const nativeComponents = this.resolveNativeCrawlComponents(
      options.profile.config,
      options.node.url,
    );
    const response = await this.crawlClient.crawl({
      url: options.node.url,
      keywords: options.run.keywords,
      options: {
        ...baseOptions,
        deepCrawlStrategy: nativeComponents.deepCrawlStrategy,
        filterChain: nativeComponents.filterChain,
        urlScorer: nativeComponents.urlScorer,
        adaptiveCrawling: nativeComponents.adaptiveCrawling,
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
    const selfMetadata =
      persisted.selfResult?.metadata && isPlainObject(persisted.selfResult.metadata)
        ? persisted.selfResult.metadata
        : null;
    const runtimeMetadata = this.buildNodeRuntimeMetadata({
      node: options.node,
      profile: options.profile,
      response,
      selfMetadata,
      crawlOptions: baseOptions,
    });

    await this.prisma.crawlFrontierRun.update({
      where: { id: options.run.id },
      data: {
        nativeRunId: response.runId ?? undefined,
      },
    });

    const sameDomainHost = new URL(options.node.url).hostname;
    const pageTypeBudgets = computeFrontierPageTypeBudgets({
      maxDepth: options.run.maxDepth,
      maxPages: options.run.maxPages,
    });
    const existingNodesForRun = await this.prisma.crawlFrontierNode.findMany({
      where: { runId: options.run.id },
      select: {
        canonicalUrl: true,
        urlFingerprint: true,
        pageType: true,
      },
    });
    const seenFingerprints = new Set(
      existingNodesForRun
        .map((entry) => entry.urlFingerprint ?? entry.canonicalUrl ?? "")
        .filter((entry) => entry.length > 0),
    );
    const countsByPageType = this.createPageTypeCountRecord();
    for (const entry of existingNodesForRun) {
      countsByPageType[entry.pageType] += 1;
    }

    const scannedSourceUrls = new Set<string>();
    const rejectionCounts: Record<string, number> = {};
    const acceptedPageTypeCounts = this.createPageTypeCountRecord();
    const selectedPageTypeCounts = this.createPageTypeCountRecord();
    const nativeWarningFlags = new Set<string>();
    const rootSelfCanonical = buildCanonicalUrlFingerprint(
      options.node.url,
      options.profile.config.urlQueryParamAllowlist,
    );
    const rootSelfKey =
      rootSelfCanonical?.fingerprint ??
      rootSelfCanonical?.canonicalUrl ??
      options.node.url;
    const remainingBudget = Math.max(
      0,
      options.run.maxPages - existingNodesForRun.length,
    );
    const rawResultByUrl = new Map<string, Crawl4aiArticle>();
    for (const entry of response.results) {
      if (typeof entry.url === "string" && entry.url.trim().length > 0) {
        rawResultByUrl.set(entry.url.trim(), entry);
      }
    }
    let acceptedCount = 0;
    let createdCount = 0;

    for (const result of persisted.results) {
      const sourceUrl =
        typeof result.sourceUrl === "string" && result.sourceUrl.length > 0
          ? result.sourceUrl
          : "";
      if (!sourceUrl) {
        bumpCount(rejectionCounts, "invalid_source_url");
        continue;
      }
      if (scannedSourceUrls.has(sourceUrl)) {
        bumpCount(rejectionCounts, "duplicate_source_url");
        continue;
      }
      scannedSourceUrls.add(sourceUrl);
      if (sourceUrl === options.node.url) {
        bumpCount(rejectionCounts, "self_url");
        continue;
      }
      const rejectionReason = shouldRejectFrontierUrl({
        url: sourceUrl,
        config: options.profile.config,
        requireSameDomainHost: sameDomainHost,
      });
      if (rejectionReason) {
        bumpCount(rejectionCounts, rejectionReason);
        continue;
      }

      const canonical = buildCanonicalUrlFingerprint(
        sourceUrl,
        options.profile.config.urlQueryParamAllowlist,
      );
      const dedupeKey =
        canonical?.fingerprint ?? canonical?.canonicalUrl ?? sourceUrl;
      if (dedupeKey === rootSelfKey) {
        bumpCount(rejectionCounts, "self_canonical");
        continue;
      }
      if (seenFingerprints.has(dedupeKey)) {
        bumpCount(rejectionCounts, "duplicate");
        continue;
      }

      const pageType = inferFrontierPageType({
        url: sourceUrl,
        parentPageType: options.node.pageType,
        config: options.profile.config,
      });
      acceptedPageTypeCounts[pageType] += 1;
      acceptedCount += 1;
      if (createdCount >= remainingBudget) {
        bumpCount(rejectionCounts, "run_budget_exhausted");
        break;
      }
      if (countsByPageType[pageType] >= pageTypeBudgets[pageType]) {
        bumpCount(rejectionCounts, "page_type_budget");
        continue;
      }

      const freshnessScore = estimateFreshnessScore(
        sourceUrl,
        options.profile.config,
      );
      const score = scoreFrontierCandidate({
        url: sourceUrl,
        pageType,
        parentPageType: options.node.pageType,
        config: options.profile.config,
        rawScore: 1,
        freshnessScore,
      });
      const rawResult = rawResultByUrl.get(sourceUrl);
      const statusCode =
        typeof rawResult?.statusCode === "number"
          ? rawResult.statusCode
          : typeof rawResult?.status_code === "number"
            ? rawResult.status_code
            : null;
      const crawlError =
        typeof rawResult?.error === "string"
          ? rawResult.error
          : typeof rawResult?.errorMessage === "string"
            ? rawResult.errorMessage
            : typeof rawResult?.error_message === "string"
              ? rawResult.error_message
              : null;
      let failureKind = classifyFrontierFailureKind(crawlError);
      if (
        !failureKind &&
        typeof statusCode === "number" &&
        [401, 403, 429].includes(statusCode)
      ) {
        failureKind = "challenge_detected";
      }
      const warningFlags = uniqueStringList(
        failureKind ? [failureKind] : undefined,
        typeof statusCode === "number" && statusCode >= 400
          ? [`http_${statusCode}`]
          : undefined,
      ) ?? [];
      for (const flag of warningFlags) {
        nativeWarningFlags.add(flag);
      }

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
            freshnessScore,
          }),
          status: "completed",
          crawledAt: new Date(),
          crawlResultId: result.id,
          score,
          freshnessScore,
          metadata: toPrismaJsonValue({
            nativeDiscovered: true,
            sourceTier: options.profile.config.sourceTier ?? "tier2",
            discoveryPath: ["home", pageType],
            frontierPath: ["home", pageType],
            failureKind,
            warningFlags,
            freshnessBucket: resolveFreshnessBucket(freshnessScore),
          }),
        },
      });
      seenFingerprints.add(dedupeKey);
      countsByPageType[pageType] += 1;
      selectedPageTypeCounts[pageType] += 1;
      createdCount += 1;
    }

    const minAcceptedResults =
      options.profile.config.nativeOptions?.minAcceptedResults ?? 0;
    const minArticleResults =
      options.profile.config.nativeOptions?.minArticleResults ?? 0;
    const shouldFallbackToLayered =
      options.run.executionMode === "hybrid" &&
      options.profile.config.nativeOptions?.fallbackToLayered !== false &&
      (createdCount === 0 ||
        (minAcceptedResults > 0 && createdCount < minAcceptedResults) ||
        (minArticleResults > 0 && selectedPageTypeCounts.article < minArticleResults));
    if (shouldFallbackToLayered) {
      nativeWarningFlags.add("native_fallback_layered");
    }
    if (createdCount === 0) {
      nativeWarningFlags.add("native_zero_accepted");
    }

    const rootResults = response.results.filter(
      (entry) =>
        typeof entry.url === "string" &&
        entry.url.trim().length > 0 &&
        entry.url.trim() === options.node.url,
    );
    const fallbackDiscoveryMetadata = shouldFallbackToLayered
      ? await this.discoverChildNodes({
          node: options.node,
          runId: options.run.id,
          taskId: options.task.id,
          maxDepth: options.run.maxDepth,
          maxPages: options.run.maxPages,
          profile: options.profile,
          results: rootResults.length > 0 ? rootResults : response.results.slice(0, 1),
        })
      : undefined;
    const fallbackCandidateStats = toNumericRecord(
      fallbackDiscoveryMetadata?.candidateStats,
    );
    const fallbackRejectionCounts = toNumericRecord(
      fallbackDiscoveryMetadata?.rejectionCounts,
    );
    const combinedCandidateStats = {
      scanned:
        scannedSourceUrls.size + (fallbackCandidateStats?.scanned ?? 0),
      unique:
        scannedSourceUrls.size + (fallbackCandidateStats?.unique ?? 0),
      accepted:
        acceptedCount + (fallbackCandidateStats?.accepted ?? 0),
      selected:
        createdCount + (fallbackCandidateStats?.selected ?? 0),
      rejected:
        Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0) +
        (fallbackCandidateStats?.rejected ?? 0),
      trimmed:
        Math.max(0, acceptedCount - createdCount) +
        (fallbackCandidateStats?.trimmed ?? 0),
    };
    const combinedRejectionCounts: Record<string, number> = {
      ...rejectionCounts,
    };
    for (const [key, value] of Object.entries(fallbackRejectionCounts ?? {})) {
      combinedRejectionCounts[key] =
        (combinedRejectionCounts[key] ?? 0) + value;
    }
    const combinedWarningFlags =
      uniqueStringList(
        coerceStringArray(runtimeMetadata.warningFlags),
        Array.from(nativeWarningFlags),
        coerceStringArray(fallbackDiscoveryMetadata?.warningFlags),
      ) ?? [];
    const nativeDiagnostics = {
      candidateStats: combinedCandidateStats,
      rejectionCounts: combinedRejectionCounts,
      nativeCandidateStats: {
        scanned: scannedSourceUrls.size,
        unique: scannedSourceUrls.size,
        accepted: acceptedCount,
        selected: createdCount,
        rejected: Object.values(rejectionCounts).reduce(
          (sum, value) => sum + value,
          0,
        ),
        trimmed: Math.max(0, acceptedCount - createdCount),
      },
      nativeAcceptedPageTypeCounts: acceptedPageTypeCounts,
      nativeSelectedPageTypeCounts: selectedPageTypeCounts,
      nativeRejectionCounts: rejectionCounts,
      nativeWarningFlags: Array.from(nativeWarningFlags),
      nativeAcceptedResults: createdCount,
      nativeAcceptedArticles: selectedPageTypeCounts.article,
      nativeFallbackActivated: shouldFallbackToLayered,
    };

    await this.prisma.crawlFrontierNode.update({
      where: { id: options.node.id },
      data: {
        status: "completed",
        crawledAt: new Date(),
        crawlResultId: persisted.selfResult?.id ?? null,
        lastError: null,
        metadata: toPrismaJsonValue(
          mergeMetadataRecords(
            options.node.metadata,
            runtimeMetadata,
            fallbackDiscoveryMetadata,
            {
              nativeDiscovered: true,
              sourceTier: options.profile.config.sourceTier ?? "tier2",
              discoveryPath: ["home"],
              frontierPath: ["home"],
              warningFlags: combinedWarningFlags,
              nativeStrategyType:
                nativeComponents.deepCrawlStrategy?.type ?? null,
              nativeStrategyResolvedFrom:
                nativeComponents.strategyResolvedFrom ?? null,
              nativeStrategyAutoResolved:
                nativeComponents.strategyAutoResolved,
              nativeFilterChainType:
                nativeComponents.filterChain?.type ?? null,
              nativeUrlScorerType:
                nativeComponents.urlScorer?.type ?? null,
              nativeAdaptiveType:
                nativeComponents.adaptiveCrawling?.type ?? null,
              nativeFilterChainSynthesized:
                nativeComponents.filterChainSynthesized,
              nativeUrlScorerSynthesized:
                nativeComponents.urlScorerSynthesized,
            },
            nativeDiagnostics,
          ),
        ),
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
    const shouldApplyFrontierDomScoping =
      pageType === "category" || pageType === "list";
    const explicitCssSelector =
      typeof pageRule.cssSelector === "string" &&
      pageRule.cssSelector.trim().length > 0
        ? pageRule.cssSelector.trim()
        : typeof base.cssSelector === "string" && base.cssSelector.trim().length > 0
          ? base.cssSelector.trim()
          : undefined;
    const defaultDomScopeSelector =
      !shouldApplyFrontierDomScoping
        ? undefined
        : uniqueStringList(config.domLinkScopes)?.join(", ");
    const generatedDomPruneScript =
      !shouldApplyFrontierDomScoping
        ? undefined
        : this.buildDomPruneJsCode(config.domLinkExcludeSelectors);
    const explicitWaitForSelector =
      typeof pageRule.waitForSelector === "string" &&
      pageRule.waitForSelector.trim().length > 0
        ? pageRule.waitForSelector.trim()
        : typeof base.waitForSelector === "string" &&
            base.waitForSelector.trim().length > 0
          ? base.waitForSelector.trim()
          : undefined;
    const explicitWaitForScript =
      typeof pageRule.waitForScript === "string" &&
      pageRule.waitForScript.trim().length > 0
        ? pageRule.waitForScript.trim()
        : typeof base.waitForScript === "string" &&
            base.waitForScript.trim().length > 0
          ? base.waitForScript.trim()
          : undefined;
    const explicitLinkPreview =
      isPlainObject(pageRule.linkPreview)
        ? (pageRule.linkPreview as CrawlTaskOptions["linkPreview"])
        : isPlainObject(base.linkPreview)
          ? (base.linkPreview as CrawlTaskOptions["linkPreview"])
          : undefined;
    const explicitMarkdownFilter =
      isPlainObject(pageRule.markdownFilter)
        ? (pageRule.markdownFilter as unknown as CrawlTaskOptions["markdownFilter"])
        : isPlainObject(base.markdownFilter)
          ? (base.markdownFilter as unknown as CrawlTaskOptions["markdownFilter"])
          : undefined;
    const explicitLocale =
      typeof pageRule.locale === "string" && pageRule.locale.trim().length > 0
        ? pageRule.locale.trim()
        : typeof base.locale === "string" && base.locale.trim().length > 0
          ? base.locale.trim()
          : undefined;
    const autoLinkPreview =
      explicitLinkPreview || pageType === "article"
        ? undefined
        : this.buildAutoLinkPreviewConfig(config, pageType);
    const autoMarkdownFilter =
      explicitMarkdownFilter ?? this.buildAutoMarkdownFilter(config, pageType);
    const jsCode = uniqueStringList(
      coerceStringArray(base.jsCode),
      coerceStringArray(pageRule.jsCode),
      generatedDomPruneScript ? [generatedDomPruneScript] : undefined,
    );
    const browserHeaders = this.buildBrowserHeaders(config, base, pageRule);
    const locale = explicitLocale ?? config.localeScope?.locale;
    const userAgentGenerator = this.buildUserAgentGenerator(config, base, pageRule);

    return {
      ...(base as CrawlTaskOptions),
      ...(pageRule as CrawlTaskOptions),
      cacheMode: "bypass",
      extractLinks: pageType !== "article",
      scoreLinks: pageType !== "article",
      linkPreview: explicitLinkPreview ?? autoLinkPreview,
      excludeExternalLinks: true,
      onlyMainContent: pageType === "article",
      pageTypeHint: pageType === "article" ? "detail" : "list",
      autoExpandDetails: false,
      cssSelector: explicitCssSelector ?? defaultDomScopeSelector,
      waitForSelector:
        explicitWaitForScript || explicitWaitForSelector
          ? explicitWaitForSelector
          : defaultDomScopeSelector,
      waitForScript: explicitWaitForScript,
      jsCode,
      markdownFilter: explicitMarkdownFilter ?? autoMarkdownFilter,
      browserHeaders,
      locale,
      userAgentGenerator,
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

  private buildAutoMarkdownFilter(
    config: CrawlSiteProfileConfig,
    pageType: CrawlFrontierPageType,
  ): CrawlTaskOptions["markdownFilter"] | undefined {
    if (pageType === "article") {
      return undefined;
    }
    const queryKeywords = uniqueStringList(
      config.priorityKeywords,
      config.keywords,
      config.pageTypeSignals?.category?.keywords,
      config.pageTypeSignals?.list?.keywords,
      config.pageTypeSignals?.article?.keywords,
    )?.slice(0, 10);
    if (!queryKeywords || queryKeywords.length === 0) {
      return undefined;
    }
    const language = this.resolveMarkdownFilterLanguage(config);
    return {
      type: "bm25",
      userQuery: queryKeywords.join(" "),
      bm25Threshold: 0.9,
      language: language ?? undefined,
    };
  }

  private resolveMarkdownFilterLanguage(
    config: CrawlSiteProfileConfig,
  ): string | undefined {
    const language = resolveLocaleScopeLanguage(config);
    if (!language) {
      return undefined;
    }
    const mapping: Record<string, string> = {
      en: "english",
      zh: "chinese",
      es: "spanish",
      fr: "french",
      de: "german",
      pt: "portuguese",
      ar: "arabic",
      ru: "russian",
      hi: "hindi",
      ja: "japanese",
      ko: "korean",
      tr: "turkish",
      it: "italian",
      nl: "dutch",
      id: "indonesian",
      vi: "vietnamese",
    };
    return mapping[language];
  }

  private buildBrowserHeaders(
    config: CrawlSiteProfileConfig,
    base: Record<string, unknown>,
    pageRule: Record<string, unknown>,
  ): CrawlTaskOptions["browserHeaders"] {
    const explicitHeaders = mergeBrowserHeaders(
      Array.isArray(base.browserHeaders)
        ? (base.browserHeaders as CrawlBrowserHeader[])
        : undefined,
      Array.isArray(pageRule.browserHeaders)
        ? (pageRule.browserHeaders as CrawlBrowserHeader[])
        : undefined,
    );
    const acceptLanguages = uniqueStringList(config.localeScope?.acceptLanguages);
    if (!acceptLanguages || acceptLanguages.length === 0) {
      return explicitHeaders;
    }
    const hasAcceptLanguage = Boolean(
      explicitHeaders?.some(
        (header) => normalizeHeaderName(header.name) === "accept-language",
      ),
    );
    if (hasAcceptLanguage) {
      return explicitHeaders;
    }
    return mergeBrowserHeaders(explicitHeaders, [
      {
        name: "Accept-Language",
        value: acceptLanguages.join(","),
      },
    ]);
  }

  private buildUserAgentGenerator(
    config: CrawlSiteProfileConfig,
    base: Record<string, unknown>,
    pageRule: Record<string, unknown>,
  ): CrawlTaskOptions["userAgentGenerator"] | undefined {
    const pageValue = isPlainObject(pageRule.userAgentGenerator)
      ? (pageRule.userAgentGenerator as CrawlTaskOptions["userAgentGenerator"])
      : undefined;
    const baseValue = isPlainObject(base.userAgentGenerator)
      ? (base.userAgentGenerator as CrawlTaskOptions["userAgentGenerator"])
      : undefined;
    const locale = config.localeScope?.locale?.trim();
    const merged = {
      ...(baseValue ?? {}),
      ...(pageValue ?? {}),
    };
    if (
      !locale ||
      (typeof merged.locale === "string" && merged.locale.trim().length > 0)
    ) {
      return Object.keys(merged).length > 0 ? merged : undefined;
    }
    return {
      ...merged,
      locale,
    };
  }

  private buildAutoLinkPreviewConfig(
    config: CrawlSiteProfileConfig,
    pageType: CrawlFrontierPageType,
  ): CrawlTaskOptions["linkPreview"] | undefined {
    if (pageType === "article") {
      return undefined;
    }
    const includePatterns = uniqueStringList(
      config.urlPatterns?.category,
      config.urlPatterns?.list,
      config.urlPatterns?.article,
    );
    const excludePatterns = uniqueStringList(
      config.urlPatterns?.exclude,
      config.pageTypeSignals?.deny?.patterns,
      config.localeScope?.denyUrlPatterns,
    );
    const queryKeywords = uniqueStringList(
      config.priorityKeywords,
      config.keywords,
      config.pageTypeSignals?.category?.keywords,
      config.pageTypeSignals?.list?.keywords,
      config.pageTypeSignals?.article?.keywords,
    )?.slice(0, 8);
    const query = queryKeywords?.join(" ");
    if (!includePatterns && !excludePatterns && !query) {
      return undefined;
    }
    const maxLinks =
      pageType === "home" ? 72 : pageType === "category" ? 48 : 32;
    const concurrency = pageType === "home" ? 6 : 4;
    const scoreThreshold = Number(
      Math.max(
        0.05,
        Math.min(0.4, (config.layeredOptions?.scoreThreshold ?? 0.35) - 0.1),
      ).toFixed(3),
    );
    return {
      includeInternal: true,
      includeExternal: false,
      maxLinks,
      concurrency,
      timeoutSeconds: 5,
      query,
      scoreThreshold,
      includePatterns,
      excludePatterns,
    };
  }

  private buildDomPruneJsCode(selectors?: string[]): string | undefined {
    const normalized = uniqueStringList(selectors);
    if (!normalized || normalized.length === 0) {
      return undefined;
    }
    const encodedSelectors = JSON.stringify(normalized);
    return `(() => {
  const selectors = ${encodedSelectors};
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector).forEach((node) => node.remove());
    } catch (error) {
      console.warn("crawl-frontier-dom-prune", selector, error);
    }
  }
})();`;
  }

  private resolveNativeCrawlComponents(
    config: CrawlSiteProfileConfig,
    rootUrl: string,
  ): {
    deepCrawlStrategy?: CrawlDeepCrawlComponent;
    filterChain?: CrawlDeepCrawlComponent;
    urlScorer?: CrawlDeepCrawlComponent;
    adaptiveCrawling?: CrawlDeepCrawlComponent;
    strategyResolvedFrom?: string;
    strategyAutoResolved: boolean;
    filterChainSynthesized: boolean;
    urlScorerSynthesized: boolean;
  } {
    const nativeOptions = config.nativeOptions;
    const baseStrategy = nativeOptions?.deepCrawlStrategy;
    if (!baseStrategy) {
      return {
        strategyAutoResolved: false,
        filterChainSynthesized: false,
        urlScorerSynthesized: false,
      };
    }
    const { resolvedType, strategyResolvedFrom, strategyAutoResolved } =
      this.resolveNativeStrategyType(baseStrategy, config);
    const synthesizedFilterChain = nativeOptions.filterChain
      ? undefined
      : this.buildNativeFilterChain(config, rootUrl);
    const synthesizedUrlScorer = nativeOptions.urlScorer
      ? undefined
      : this.buildNativeUrlScorer(config);
    const filterChain = nativeOptions.filterChain ?? synthesizedFilterChain;
    const urlScorer = nativeOptions.urlScorer ?? synthesizedUrlScorer;
    const adaptiveCrawling = nativeOptions.adaptiveCrawling;
    const params = isPlainObject(baseStrategy.params)
      ? { ...baseStrategy.params }
      : {};
    if (params.max_depth === undefined) {
      params.max_depth = config.layeredOptions?.maxDepth ?? 3;
    }
    if (params.max_pages === undefined) {
      params.max_pages = config.layeredOptions?.maxPages ?? 60;
    }
    if (filterChain && params.filter_chain === undefined) {
      params.filter_chain = filterChain;
    }
    if (urlScorer && params.url_scorer === undefined) {
      params.url_scorer = urlScorer;
    }
    if (adaptiveCrawling && params.adaptive_crawling === undefined) {
      params.adaptive_crawling = adaptiveCrawling;
    }
    return {
      deepCrawlStrategy: {
        type: resolvedType,
        params,
      },
      filterChain,
      urlScorer,
      adaptiveCrawling,
      strategyResolvedFrom,
      strategyAutoResolved,
      filterChainSynthesized:
        Boolean(filterChain) && !Boolean(nativeOptions.filterChain),
      urlScorerSynthesized:
        Boolean(urlScorer) && !Boolean(nativeOptions.urlScorer),
    };
  }

  private resolveNativeStrategyType(
    strategy: CrawlDeepCrawlComponent,
    config: CrawlSiteProfileConfig,
  ): {
    resolvedType: string;
    strategyResolvedFrom?: string;
    strategyAutoResolved: boolean;
  } {
    const rawType = strategy.type.trim();
    const normalizedType = rawType.toLowerCase();
    if (normalizedType !== "auto" && normalizedType !== "autodeepcrawlstrategy") {
      return {
        resolvedType: rawType,
        strategyAutoResolved: false,
      };
    }
    const hasArticleSignals = Boolean(
      config.urlPatterns?.article?.length ||
        config.pageTypeSignals?.article?.patterns?.length ||
        config.pageTypeSignals?.article?.keywords?.length,
    );
    const freshnessSensitive =
      (config.priorityKeywords?.length ?? 0) >= 4 ||
      Boolean(config.freshnessRules) ||
      (config.layeredOptions?.scoreThreshold ?? 0.35) >= 0.45 ||
      (config.nativeOptions?.minArticleResults ?? 0) > 0;
    return {
      resolvedType:
        freshnessSensitive && hasArticleSignals
          ? "BestFirstCrawlingStrategy"
          : "BFSDeepCrawlStrategy",
      strategyResolvedFrom: rawType,
      strategyAutoResolved: true,
    };
  }

  private buildNativeFilterChain(
    config: CrawlSiteProfileConfig,
    rootUrl: string,
  ): CrawlDeepCrawlComponent | undefined {
    const filters: CrawlDeepCrawlComponent[] = [];
    const allowedDomains = uniqueStringList(config.allowedDomains);
    const blockedDomains = uniqueStringList(config.blockedDomains);
    const allowedHostPatterns = uniqueStringList(
      config.allowedHosts?.map((host) => {
        const normalized = host.trim();
        return normalized.length > 0 ? `https://${normalized}/*` : "";
      }),
    );
    try {
      const parsedRoot = new URL(rootUrl);
      const baseHostPattern = `${parsedRoot.protocol}//${parsedRoot.hostname}/*`;
      if (
        config.hostScope === "strict_hosts" ||
        ((config.allowedHosts?.length ?? 0) > 0 &&
          (config.allowedDomains?.length ?? 0) === 0)
      ) {
        filters.push({
          type: "URLPatternFilter",
          params: {
            patterns: uniqueStringList(allowedHostPatterns, [baseHostPattern]),
          },
        });
      }
      if (!allowedDomains && config.hostScope !== "strict_hosts") {
        const registrableDomain = toRegistrableDomain(parsedRoot.hostname);
        if (registrableDomain) {
          filters.push({
            type: "DomainFilter",
            params: {
              allowed_domains: [registrableDomain],
              blocked_domains: blockedDomains,
            },
          });
        }
      }
    } catch {
      // Ignore malformed root URL and fall back to configured domains only.
    }
    if (allowedDomains || blockedDomains) {
      filters.push({
        type: "DomainFilter",
        params: {
          allowed_domains: allowedDomains,
          blocked_domains: blockedDomains,
        },
      });
    }
    filters.push({
      type: "ContentTypeFilter",
      params: {
        allowed_types: ["text/html"],
      },
    });
    const includePatterns = uniqueStringList(
      config.urlPatterns?.home,
      config.urlPatterns?.category,
      config.urlPatterns?.list,
      config.urlPatterns?.article,
    );
    if (includePatterns) {
      filters.push({
        type: "URLPatternFilter",
        params: {
          patterns: includePatterns,
        },
      });
    }
    return filters.length > 0
      ? {
          type: "FilterChain",
          params: {
            filters,
          },
        }
      : undefined;
  }

  private buildNativeUrlScorer(
    config: CrawlSiteProfileConfig,
  ): CrawlDeepCrawlComponent | undefined {
    const keywords = uniqueStringList(
      config.priorityKeywords,
      config.keywords,
      config.pageTypeSignals?.article?.keywords,
      config.pageTypeSignals?.list?.keywords,
      config.pageTypeSignals?.category?.keywords,
    )?.slice(0, 32);
    if (!keywords || keywords.length === 0) {
      return undefined;
    }
    const priorityKeywordCount = config.priorityKeywords?.length ?? 0;
    const weight =
      config.sourceTier === "tier1"
        ? 1.25
        : priorityKeywordCount >= 5
          ? 1.15
          : 1;
    return {
      type: "KeywordRelevanceScorer",
      params: {
        keywords,
        weight: Number(weight.toFixed(2)),
      },
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

  private createPageTypeCountRecord(): Record<CrawlFrontierPageType, number> {
    return {
      home: 0,
      category: 0,
      list: 0,
      article: 0,
    };
  }

  private shouldUseSyntheticList(
    parentPageType: CrawlFrontierPageType,
    candidates: FrontierCandidate[],
  ) {
    if (parentPageType !== "home" && parentPageType !== "category") {
      return false;
    }
    const articleCount = candidates.filter((entry) => entry.pageType === "article").length;
    const listCount = candidates.filter((entry) => entry.pageType === "list").length;
    return articleCount > 0 && listCount === 0;
  }

  private deriveSyntheticListLabel(url: string, linkText?: string) {
    try {
      const parsed = new URL(url);
      const label = parsed.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment))
        .find((segment) => {
          const normalized = segment.trim().toLowerCase();
          if (!normalized) {
            return false;
          }
          if (/^\d{1,4}$/.test(normalized)) {
            return false;
          }
          return ![
            "article",
            "articles",
            "story",
            "stories",
            "content",
            "liveblog",
          ].includes(normalized);
        });
      if (label) {
        return label.replace(/[-_]+/g, " ");
      }
    } catch {
      // fall through to link text
    }
    const normalizedText = linkText?.trim();
    if (normalizedText) {
      return normalizedText.split(/\s+/).slice(0, 6).join(" ");
    }
    return "direct discovery";
  }

  private buildNodeRuntimeMetadata(options: {
    node: CrawlFrontierNodeRecord;
    profile: CrawlSiteProfileRecord;
    response: Crawl4aiResponse;
    selfMetadata?: Record<string, unknown> | null;
    crawlOptions: CrawlTaskOptions;
  }): Record<string, unknown> {
    const selfResponse =
      options.response.results.find(
        (entry) =>
          typeof entry.url === "string" &&
          entry.url.trim().length > 0 &&
          entry.url.trim() === options.node.url,
      ) ?? options.response.results[0];
    const statusCode =
      typeof selfResponse?.statusCode === "number"
        ? selfResponse.statusCode
        : typeof selfResponse?.status_code === "number"
          ? selfResponse.status_code
          : null;
    const crawlError =
      typeof selfResponse?.error === "string"
        ? selfResponse.error
        : typeof selfResponse?.errorMessage === "string"
          ? selfResponse.errorMessage
          : typeof selfResponse?.error_message === "string"
            ? selfResponse.error_message
            : null;
    const warningFlags: string[] = [];
    let failureKind = classifyFrontierFailureKind(crawlError);
    if (
      !failureKind &&
      typeof statusCode === "number" &&
      [401, 403, 429].includes(statusCode)
    ) {
      failureKind = "challenge_detected";
    }
    if (failureKind) {
      warningFlags.push(failureKind);
    }
    if (typeof statusCode === "number" && statusCode >= 400) {
      warningFlags.push(`http_${statusCode}`);
    }
    const freshnessScore = estimateFreshnessScore(options.node.url, options.profile.config);
    const crawlOptionsDiagnostics = this.buildCrawlOptionsDiagnostics(
      options.profile.config,
      options.node.pageType,
      options.crawlOptions,
    );
    return {
      sourceTier: options.profile.config.sourceTier ?? "tier2",
      failureKind,
      warningFlags,
      httpStatus: statusCode,
      crawlError,
      freshnessBucket: resolveFreshnessBucket(freshnessScore),
      discoveryPath:
        options.node.metadata && Array.isArray(options.node.metadata.discoveryPath)
          ? options.node.metadata.discoveryPath
          : [options.node.pageType],
      frontierPath:
        options.node.metadata && Array.isArray(options.node.metadata.frontierPath)
          ? options.node.metadata.frontierPath
          : [options.node.pageType],
      canonicalUrl:
        typeof options.selfMetadata?.canonicalUrl === "string"
          ? options.selfMetadata.canonicalUrl
          : undefined,
      urlFingerprint:
        typeof options.selfMetadata?.urlFingerprint === "string"
          ? options.selfMetadata.urlFingerprint
          : undefined,
      ...crawlOptionsDiagnostics,
    };
  }

  private buildCrawlOptionsDiagnostics(
    config: CrawlSiteProfileConfig,
    pageType: CrawlFrontierPageType,
    crawlOptions: CrawlTaskOptions,
  ): Record<string, unknown> {
    const pageRule = isPlainObject(config.pageRules?.[pageType])
      ? (config.pageRules?.[pageType] as Record<string, unknown>)
      : {};
    const base = isPlainObject(config.crawlOptions)
      ? (config.crawlOptions as Record<string, unknown>)
      : {};
    const hasManualLinkPreview =
      isPlainObject(pageRule.linkPreview) || isPlainObject(base.linkPreview);
    const hasManualCssSelector =
      (typeof pageRule.cssSelector === "string" &&
        pageRule.cssSelector.trim().length > 0) ||
      (typeof base.cssSelector === "string" && base.cssSelector.trim().length > 0);
    const hasManualWaitFor =
      (typeof pageRule.waitForSelector === "string" &&
        pageRule.waitForSelector.trim().length > 0) ||
      (typeof base.waitForSelector === "string" &&
        base.waitForSelector.trim().length > 0) ||
      (typeof pageRule.waitForScript === "string" &&
        pageRule.waitForScript.trim().length > 0) ||
      (typeof base.waitForScript === "string" &&
        base.waitForScript.trim().length > 0);
    const hasManualMarkdownFilter =
      isPlainObject(pageRule.markdownFilter) || isPlainObject(base.markdownFilter);
    const hasManualLocale =
      (typeof pageRule.locale === "string" && pageRule.locale.trim().length > 0) ||
      (typeof base.locale === "string" && base.locale.trim().length > 0);
    const baseHeaders = mergeBrowserHeaders(
      Array.isArray(base.browserHeaders)
        ? (base.browserHeaders as CrawlBrowserHeader[])
        : undefined,
      Array.isArray(pageRule.browserHeaders)
        ? (pageRule.browserHeaders as CrawlBrowserHeader[])
        : undefined,
    );
    const hasManualAcceptLanguage = Boolean(
      baseHeaders?.some(
        (header) => normalizeHeaderName(header.name) === "accept-language",
      ),
    );
    return {
      linkPreviewMode: crawlOptions.linkPreview
        ? hasManualLinkPreview
          ? "manual"
          : "auto"
        : null,
      linkPreviewQuery:
        crawlOptions.linkPreview?.query && crawlOptions.linkPreview.query.trim().length > 0
          ? crawlOptions.linkPreview.query.trim()
          : null,
      domScopeMode: crawlOptions.cssSelector
        ? hasManualCssSelector
          ? "manual"
          : "auto"
        : null,
      waitForMode:
        crawlOptions.waitForSelector || crawlOptions.waitForScript
          ? hasManualWaitFor
            ? "manual"
            : "auto"
          : null,
      markdownFilterMode: crawlOptions.markdownFilter
        ? hasManualMarkdownFilter
          ? "manual"
          : "auto"
        : null,
      markdownFilterType:
        crawlOptions.markdownFilter?.type && crawlOptions.markdownFilter.type.trim().length > 0
          ? crawlOptions.markdownFilter.type.trim()
          : null,
      localeMode: crawlOptions.locale
        ? hasManualLocale
          ? "manual"
          : "auto"
        : null,
      localeValue:
        typeof crawlOptions.locale === "string" && crawlOptions.locale.trim().length > 0
          ? crawlOptions.locale.trim()
          : null,
      acceptLanguageMode: hasManualAcceptLanguage
        ? "manual"
        : crawlOptions.browserHeaders?.some(
              (header) => normalizeHeaderName(header.name) === "accept-language",
            )
          ? "auto"
          : null,
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
  }): Promise<Record<string, unknown> | undefined> {
    const extraction = this.extractCandidates(
      options.node,
      options.profile.config,
      options.results,
    );
    const childDepth = options.node.depth + 1;
    if (childDepth > options.maxDepth) {
      return {
        ...extraction.diagnostics,
        warningFlags: uniqueStringList(
          extraction.diagnostics.warningFlags,
          ["depth_exhausted"],
        ) ?? [],
      };
    }
    if (extraction.candidates.length === 0) {
      return extraction.diagnostics;
    }

    const pageTypeBudgets = computeFrontierPageTypeBudgets({
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
    });
    const existingNodesForRun = await this.prisma.crawlFrontierNode.findMany({
      where: { runId: options.runId },
      select: {
        canonicalUrl: true,
        urlFingerprint: true,
        pageType: true,
      },
    });
    const existingCount = existingNodesForRun.length;
    const remainingBudget = Math.max(0, options.maxPages - existingCount);
    const rejectionCounts = {
      ...extraction.diagnostics.rejectionCounts,
    };
    if (remainingBudget === 0) {
      bumpCount(rejectionCounts, "run_budget_exhausted");
      return {
        ...extraction.diagnostics,
        rejectionCounts,
        candidateStats: {
          ...extraction.diagnostics.candidateStats,
          selected: 0,
          rejected: Object.values(rejectionCounts).reduce(
            (sum, value) => sum + value,
            0,
          ),
        },
      };
    }

    const seenFingerprints = new Set(
      existingNodesForRun
        .map((entry) => entry.urlFingerprint ?? entry.canonicalUrl ?? "")
        .filter((entry) => entry.length > 0),
    );
    const countsByPageType: Record<CrawlFrontierPageType, number> = {
      home: 0,
      category: 0,
      list: 0,
      article: 0,
    };
    for (const entry of existingNodesForRun) {
      countsByPageType[entry.pageType] += 1;
    }

    const paginationKeepCount = this.clampInt(
      options.profile.config.layeredOptions?.paginationKeepCount,
      1,
      10,
      3,
    );
    let created = 0;
    let listPagesCreated = 0;
    const selectedPageTypeCounts = this.createPageTypeCountRecord();
    const prioritizedCandidates = prioritizeFrontierCandidates({
      parentPageType: options.node.pageType,
      candidates: extraction.candidates,
    });
    for (const candidate of prioritizedCandidates) {
      if (created >= remainingBudget) {
        bumpCount(rejectionCounts, "run_budget_exhausted");
        break;
      }
      if (countsByPageType[candidate.pageType] >= pageTypeBudgets[candidate.pageType]) {
        bumpCount(rejectionCounts, "page_type_budget");
        continue;
      }
      const canonical = buildCanonicalUrlFingerprint(
        candidate.url,
        options.profile.config.urlQueryParamAllowlist,
      );
      const dedupeKey = canonical?.fingerprint ?? canonical?.canonicalUrl ?? candidate.url;
      if (seenFingerprints.has(dedupeKey)) {
        bumpCount(rejectionCounts, "duplicate");
        continue;
      }
      if (
        candidate.pageType === "list" &&
        listPagesCreated >= paginationKeepCount
      ) {
        bumpCount(rejectionCounts, "pagination_limit");
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
          depth: childDepth,
          queueClass,
          status: "queued",
          score: candidate.score,
          freshnessScore: candidate.freshnessScore,
          queuedAt: new Date(),
          metadata: toPrismaJsonValue(
            mergeMetadataRecords(candidate.metadata, {
              sourceTier: options.profile.config.sourceTier ?? "tier2",
            }),
          ),
        },
      });
      seenFingerprints.add(dedupeKey);
      countsByPageType[candidate.pageType] += 1;
      selectedPageTypeCounts[candidate.pageType] += 1;
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
    return {
      ...extraction.diagnostics,
      rejectionCounts,
      selectedPageTypeCounts,
      candidateStats: {
        ...extraction.diagnostics.candidateStats,
        selected: created,
        rejected: Object.values(rejectionCounts).reduce(
          (sum, value) => sum + value,
          0,
        ),
      },
      warningFlags: uniqueStringList(
        extraction.diagnostics.warningFlags,
        created === 0 ? ["no_child_nodes_created"] : undefined,
      ) ?? [],
    };
  }

  private extractCandidates(
    node: CrawlFrontierNodeRecord,
    config: CrawlSiteProfileConfig,
    results: Crawl4aiArticle[],
  ): FrontierCandidateExtraction {
    const byUrl = new Map<string, FrontierCandidate>();
    const rejectionCounts: Record<string, number> = {};
    const sameDomainHost = new URL(node.url).hostname;
    const selfCanonical = buildCanonicalUrlFingerprint(
      node.url,
      config.urlQueryParamAllowlist,
    );
    const selfKey =
      selfCanonical?.fingerprint ?? selfCanonical?.canonicalUrl ?? node.url;
    let scannedLinks = 0;
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
          scannedLinks += 1;
          let resolvedUrl = href;
          try {
            resolvedUrl = new URL(href, baseUrl).toString();
          } catch {
            bumpCount(rejectionCounts, "invalid_url");
            continue;
          }
          if (resolvedUrl === node.url) {
            bumpCount(rejectionCounts, "self_url");
            continue;
          }
          const linkText =
            typeof link.text === "string"
              ? link.text
              : typeof link.title === "string"
                ? link.title
                : undefined;
          if (isUtilityFrontierLinkText(linkText)) {
            bumpCount(rejectionCounts, "utility_link_text");
            continue;
          }
          const rejectionReason = shouldRejectFrontierUrl({
            url: resolvedUrl,
            config,
            requireSameDomainHost: sameDomainHost,
            linkText,
          });
          if (rejectionReason) {
            bumpCount(rejectionCounts, rejectionReason);
            continue;
          }
          const candidateCanonical = buildCanonicalUrlFingerprint(
            resolvedUrl,
            config.urlQueryParamAllowlist,
          );
          const candidateKey =
            candidateCanonical?.fingerprint ??
            candidateCanonical?.canonicalUrl ??
            resolvedUrl;
          if (candidateKey === selfKey) {
            bumpCount(rejectionCounts, "self_canonical");
            continue;
          }
          const pageType = inferFrontierPageType({
            url: resolvedUrl,
            parentPageType: node.pageType,
            config,
            linkText,
          });
          const freshnessScore = estimateFreshnessScore(resolvedUrl, config);
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
            parentPageType: node.pageType,
            parentUrl: node.url,
            config,
            rawScore,
            linkText,
            freshnessScore,
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
                linkText: linkText ?? null,
                frontierScore: score,
                frontierFreshnessScore: freshnessScore,
              },
            });
          }
        }
      }
    }

    const threshold = config.layeredOptions?.scoreThreshold ?? 0.35;
    const accepted = Array.from(byUrl.values()).filter(
      (entry) => entry.score >= threshold,
    );
    const lowScoreCount = Math.max(0, byUrl.size - accepted.length);
    if (lowScoreCount > 0) {
      rejectionCounts.low_score = lowScoreCount;
    }
    const acceptedPageTypeCounts = this.createPageTypeCountRecord();
    for (const candidate of accepted) {
      acceptedPageTypeCounts[candidate.pageType] += 1;
    }
    const prioritized = prioritizeFrontierCandidates({
      parentPageType: node.pageType,
      candidates: accepted,
    });
    const maxChildren = config.layeredOptions?.maxChildrenPerNode ?? 24;
    const trimmed = Math.max(0, prioritized.length - maxChildren);
    if (trimmed > 0) {
      rejectionCounts.max_children_trimmed = trimmed;
    }
    const selected = prioritized.slice(0, maxChildren);
    const syntheticListActivated =
      this.shouldUseSyntheticList(node.pageType, selected);
    const candidates = selected.map((candidate) => {
      const baseMetadata = mergeMetadataRecords(candidate.metadata, {
        sourceTier: config.sourceTier ?? "tier2",
        freshnessBucket: resolveFreshnessBucket(candidate.freshnessScore),
      });
      if (
        syntheticListActivated &&
        candidate.pageType === "article" &&
        (node.pageType === "home" || node.pageType === "category")
      ) {
        return {
          ...candidate,
          metadata: mergeMetadataRecords(baseMetadata, {
            syntheticList: true,
            syntheticListLabel: this.deriveSyntheticListLabel(
              candidate.url,
              candidate.metadata.linkText as string | undefined,
            ),
            discoveryPath: [node.pageType, "synthetic_list", "article"],
            frontierPath: [node.pageType, "synthetic_list", "article"],
          }) ?? {},
        };
      }
      return {
        ...candidate,
        metadata: mergeMetadataRecords(baseMetadata, {
          discoveryPath: [node.pageType, candidate.pageType],
          frontierPath: [node.pageType, candidate.pageType],
        }) ?? {},
      };
    });
    return {
      candidates,
      diagnostics: {
        candidateStats: {
          scanned: scannedLinks,
          unique: byUrl.size,
          accepted: accepted.length,
          selected: candidates.length,
          rejected: Object.values(rejectionCounts).reduce(
            (sum, value) => sum + value,
            0,
          ),
          trimmed,
        },
        rejectionCounts,
        acceptedPageTypeCounts,
        warningFlags: syntheticListActivated
          ? ["synthetic_list_activated"]
          : [],
        syntheticListActivated,
      },
    };
  }

  private async refreshRunStatus(runId: string) {
    const [run, nodes] = await Promise.all([
      this.prisma.crawlFrontierRun.findUnique({ where: { id: runId } }),
      this.prisma.crawlFrontierNode.findMany({
        where: { runId },
        select: {
          status: true,
          pageType: true,
          depth: true,
          rejectionReason: true,
          lastError: true,
          metadata: true,
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
    const rootOnlyNoExpansion =
      activeCount === 0 &&
      nodeCount <= 1 &&
      pageCount <= 1 &&
      articleCount === 0 &&
      failedCount === 0;
    const coverageByPageType = this.createPageTypeCountRecord();
    const coverageByDepth: Record<string, number> = {};
    const candidateStats = {
      scanned: 0,
      unique: 0,
      accepted: 0,
      selected: 0,
      rejected: 0,
      trimmed: 0,
    };
    const rejectionCounts: Record<string, number> = {};
    const warningFlags = new Set<string>();
    const failureKindCounts: Record<string, number> = {};
    let rootDiagnosis: Record<string, unknown> | undefined;

    for (const node of nodes) {
      coverageByPageType[node.pageType] += 1;
      coverageByDepth[String(node.depth)] =
        (coverageByDepth[String(node.depth)] ?? 0) + 1;
      if (node.rejectionReason) {
        bumpCount(rejectionCounts, node.rejectionReason);
      }
      const metadata = isPlainObject(node.metadata)
        ? (node.metadata as Record<string, unknown>)
        : undefined;
      if (metadata) {
        const nodeCandidateStats = toNumericRecord(metadata.candidateStats);
        for (const key of Object.keys(candidateStats) as Array<
          keyof typeof candidateStats
        >) {
          candidateStats[key] += nodeCandidateStats?.[key] ?? 0;
        }
        const nodeRejectionCounts = toNumericRecord(metadata.rejectionCounts);
        for (const [key, value] of Object.entries(nodeRejectionCounts ?? {})) {
          rejectionCounts[key] = (rejectionCounts[key] ?? 0) + value;
        }
        for (const flag of coerceStringArray(metadata.warningFlags) ?? []) {
          warningFlags.add(flag);
        }
        const failureKind =
          typeof metadata.failureKind === "string" &&
          metadata.failureKind.trim().length > 0
            ? metadata.failureKind.trim()
            : classifyFrontierFailureKind(node.lastError);
        if (failureKind) {
          bumpCount(failureKindCounts, failureKind);
        }
        if (node.depth === 0) {
          rootDiagnosis = {
            failureKind: failureKind ?? null,
            warningFlags: coerceStringArray(metadata.warningFlags) ?? [],
            candidateStats: nodeCandidateStats ?? null,
            rejectionCounts: nodeRejectionCounts ?? null,
            lastError: node.lastError ?? null,
            nativeStrategyType:
              typeof metadata.nativeStrategyType === "string"
                ? metadata.nativeStrategyType
                : null,
            nativeStrategyResolvedFrom:
              typeof metadata.nativeStrategyResolvedFrom === "string"
                ? metadata.nativeStrategyResolvedFrom
                : null,
            nativeStrategyAutoResolved:
              typeof metadata.nativeStrategyAutoResolved === "boolean"
                ? metadata.nativeStrategyAutoResolved
                : null,
            nativeFilterChainType:
              typeof metadata.nativeFilterChainType === "string"
                ? metadata.nativeFilterChainType
                : null,
            nativeUrlScorerType:
              typeof metadata.nativeUrlScorerType === "string"
                ? metadata.nativeUrlScorerType
                : null,
            nativeAdaptiveType:
              typeof metadata.nativeAdaptiveType === "string"
                ? metadata.nativeAdaptiveType
                : null,
            nativeFilterChainSynthesized:
              typeof metadata.nativeFilterChainSynthesized === "boolean"
                ? metadata.nativeFilterChainSynthesized
                : null,
            nativeUrlScorerSynthesized:
              typeof metadata.nativeUrlScorerSynthesized === "boolean"
                ? metadata.nativeUrlScorerSynthesized
                : null,
            linkPreviewMode:
              typeof metadata.linkPreviewMode === "string"
                ? metadata.linkPreviewMode
                : null,
            linkPreviewQuery:
              typeof metadata.linkPreviewQuery === "string"
                ? metadata.linkPreviewQuery
                : null,
            domScopeMode:
              typeof metadata.domScopeMode === "string"
                ? metadata.domScopeMode
                : null,
            waitForMode:
              typeof metadata.waitForMode === "string"
                ? metadata.waitForMode
                : null,
            markdownFilterMode:
              typeof metadata.markdownFilterMode === "string"
                ? metadata.markdownFilterMode
                : null,
            markdownFilterType:
              typeof metadata.markdownFilterType === "string"
                ? metadata.markdownFilterType
                : null,
            localeMode:
              typeof metadata.localeMode === "string"
                ? metadata.localeMode
                : null,
            localeValue:
              typeof metadata.localeValue === "string"
                ? metadata.localeValue
                : null,
            acceptLanguageMode:
              typeof metadata.acceptLanguageMode === "string"
                ? metadata.acceptLanguageMode
                : null,
          };
        }
      }
    }

    let status = run.status;
    let lastError = run.lastError ?? null;
    let failureKind =
      Object.entries(failureKindCounts).sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0]?.[0] ?? null;
    if (run.status !== "canceled" && activeCount === 0) {
      if (rootOnlyNoExpansion) {
        status = "failed";
        failureKind =
          (rootDiagnosis?.failureKind as string | null | undefined) ??
          (warningFlags.has("challenge_detected")
            ? "challenge_detected"
            : "no_frontier_candidates");
        lastError =
          failureKind === "challenge_detected"
            ? "challenge_detected"
            : "no_frontier_candidates_discovered";
      } else {
        status = pageCount > 0 ? "completed" : failedCount > 0 ? "failed" : run.status;
        if (status === "completed" && failedCount === 0) {
          lastError = null;
        } else if (!lastError && failureKind) {
          lastError = failureKind;
        }
      }
    }
    if (status === "completed" && failedCount === 0) {
      failureKind = null;
    }
    const metadata = mergeMetadataRecords(
      isPlainObject(run.metadata) ? (run.metadata as Record<string, unknown>) : undefined,
      {
        candidateStats,
        rejectionCounts,
        warningFlags: Array.from(warningFlags),
        failureKind,
        coverage: {
          byPageType: coverageByPageType,
          byDepth: coverageByDepth,
        },
        rootDiagnosis: rootDiagnosis ?? null,
      },
    );

    await this.prisma.crawlFrontierRun.update({
      where: { id: runId },
      data: {
        status,
        lastError,
        metadata: toPrismaJsonValue(metadata),
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

  private mapRun<
    T extends {
      metadata?: Prisma.JsonValue | null;
    },
  >(run: T): Omit<T, "metadata"> & { metadata: Record<string, unknown> | null } {
    return {
      ...run,
      metadata:
        run.metadata && isPlainObject(run.metadata)
          ? (run.metadata as Record<string, unknown>)
          : null,
    };
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
