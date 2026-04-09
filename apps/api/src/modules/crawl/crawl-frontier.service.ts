import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import {
  CrawlFrontierLlmService,
  type FrontierLlmCandidate,
} from "./crawl-frontier-llm.service";
import {
  classifyFrontierFailureKind,
  computeFrontierPageTypeBudgets,
  estimateFreshnessScore,
  inferFrontierPageType,
  normalizeCrawlSiteProfileConfig,
  resolveEffectiveLlmAssistConfig,
  resolveFreshnessBucket,
  resolveLocaleScopeLanguage,
  scoreFrontierCandidate,
  toRegistrableDomain,
} from "./crawl-frontier.utils";
import {
  CrawlMetadataService,
  type CrawlDiscoveryCandidate,
} from "./crawl-metadata.service";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlResultService } from "./crawl-result.service";
import { CrawlSiteProfileService } from "./crawl-site-profile.service";
import {
  CrawlStrategyLayeredExecutorService,
  type CrawlStrategyLayeredCandidate as FrontierCandidate,
  type CrawlStrategyLayeredCandidateDecision as FrontierCandidateDecision,
  type CrawlStrategyLayeredCandidateExtraction as FrontierCandidateExtraction,
  type CrawlStrategyLayeredTraceCandidate as FrontierTraceCandidate,
} from "./crawl-strategy-layered-executor.service";
import {
  CrawlStrategyRootExecutorService,
  type CrawlStrategyRootSeedDiscoveryOutcome as SeedDiscoveryOutcome,
} from "./crawl-strategy-root-executor.service";
import { CrawlStrategyRunRecorderService } from "./crawl-strategy-run-recorder.service";
import { CrawlStrategyWorkflowService } from "./crawl-strategy-workflow.service";
import { CrawlStrategyWorkflowRunKind } from "./crawl-strategy.types";
import type {
  CrawlStrategyParameterSource,
  CrawlStrategyWorkflowDefinition,
  CrawlStrategyWorkflowOrigin,
} from "./crawl-strategy.types";
import type {
  CrawlBrowserHeader,
  CrawlDeepCrawlComponent,
  CrawlExecutionSummary,
  CrawlFrontierCandidatePayload,
  CrawlFrontierLlmJudgeJobPayload,
  CrawlFrontierLlmLearnJobPayload,
  CrawlFrontierNodeRecord,
  CrawlFrontierPageType,
  CrawlPriorityClass,
  CrawlSeedDiscoveryConfig,
  CrawlSeedStrategy,
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
import { resolveQueryParamAllowlist } from "./url-fingerprint";

interface FrontierLifecycleNode {
  id: string;
  url: string;
  pageType: CrawlFrontierPageType;
  status: string;
  score?: number | null;
  freshnessScore?: number | null;
  metadata?: Record<string, unknown> | null;
}

interface FrontierLifecycleRun {
  id: string;
  orgId: string;
  seedUrl: string;
  maxDepth: number;
  maxPages: number;
  nodeCount: number;
  keywords?: unknown;
  metadata?: Record<string, unknown> | null;
  createdById: string;
  profile: CrawlSiteProfileRecord;
  nodes: FrontierLifecycleNode[];
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function bumpCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeMetadataRecords(
  ...records: (Record<string, unknown> | null | undefined)[]
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

function uniqueStringList(...lists: (string[] | undefined)[]): string[] | undefined {
  const merged = Array.from(
    new Set(
      lists.flatMap((list) =>
        (list ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      ),
    ),
  );
  return merged.length > 0 ? merged : undefined;
}

function collectNodeWarningFlags(
  metadata: Record<string, unknown> | null | undefined,
  lastError?: string | null,
): string[] {
  const failureKind =
    typeof metadata?.failureKind === "string" && metadata.failureKind.trim().length > 0
      ? metadata.failureKind.trim()
      : classifyFrontierFailureKind(lastError);
  return (
    uniqueStringList(
      coerceStringArray(metadata?.warningFlags),
      asBoolean(metadata?.llmJudgeEnabled) &&
        asBoolean(metadata?.llmJudgeAttempted) &&
        asBoolean(metadata?.llmJudgeParsed) === false
        ? ["llm_judge_parse_failed"]
        : undefined,
      asBoolean(metadata?.llmJudgeEnabled) &&
        asBoolean(metadata?.llmJudgeAttempted) &&
        Boolean(asString(metadata?.llmJudgeError))
        ? ["llm_judge_failed"]
        : undefined,
      failureKind ? [failureKind] : undefined,
    ) ?? []
  );
}

function resolvePendingLlmJudgeJobs(
  metadata: Record<string, unknown> | null | undefined,
): number {
  const count = toFiniteNumber(metadata?.pendingLlmJudgeJobs);
  if (count === null) {
    return 0;
  }
  return Math.max(0, Math.round(count));
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

function mergeBrowserHeaders(
  ...headerSets: (CrawlBrowserHeader[] | undefined)[]
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
    private readonly strategyWorkflows: CrawlStrategyWorkflowService,
    private readonly layeredExecutor: CrawlStrategyLayeredExecutorService,
    private readonly rootExecutor: CrawlStrategyRootExecutorService,
    private readonly strategyRecorder: CrawlStrategyRunRecorderService,
    private readonly crawlClient: Crawl4aiClient,
    private readonly resultService: CrawlResultService,
    private readonly queueService: CrawlQueueService,
    private readonly metadataService: CrawlMetadataService,
    @Optional()
    private readonly frontierLlm?: CrawlFrontierLlmService,
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
    if (query?.executionMode) {
      where.executionMode = query.executionMode;
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
    return runs
      .map((run) => this.mapRun(run))
      .filter((run) => this.matchesRunQueryFilters(run, query));
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
    const mappedRun = this.mapRun(run);
    const mappedNodes = run.nodes.map((node) => this.mapNode(node));
    return {
      ...mappedRun,
      profile: run.profile
        ? {
            ...run.profile,
            config: normalizeCrawlSiteProfileConfig(run.profile.config),
          }
        : null,
      nodes: mappedNodes,
      summary: await this.buildRunAdminSummary(orgId, mappedRun, mappedNodes),
    };
  }

  async getNode(orgId: string, id: string) {
    const node = await this.prisma.crawlFrontierNode.findUnique({
      where: { id },
      include: {
        run: {
          include: {
            profile: true,
          },
        },
      },
    });
    if (!node || node.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier node not found");
    }
    const mappedNode = this.mapNode(node);
    const runProfile = node.run.profile
      ? {
          id: node.run.profile.id,
          name: node.run.profile.name,
          matchHost: node.run.profile.matchHost,
          executionMode: node.run.profile.executionMode,
          isActive: node.run.profile.isActive,
        }
      : null;

    const crawlResult =
      node.crawlResultId && node.crawlResultId.trim().length > 0
        ? await this.prisma.crawlResult.findUnique({
            where: { id: node.crawlResultId },
            select: {
              id: true,
              orgId: true,
              sourceUrl: true,
              fetchedAt: true,
              markdownRef: true,
              contentHash: true,
              metadata: true,
            },
          })
        : null;
    const resolvedCrawlResult =
      crawlResult && crawlResult.orgId === orgId ? crawlResult : null;
    const article = resolvedCrawlResult
      ? await this.prisma.article.findFirst({
          where: {
            orgId,
            contentHash: resolvedCrawlResult.contentHash,
          },
          include: {
            processed: true,
          },
        })
      : null;
    const articleMetadata =
      article?.metadata && isPlainObject(article.metadata)
        ? (article.metadata as Record<string, unknown>)
        : null;
    const repairSummary = this.buildNodeRepairSummary(articleMetadata);
    const extractionSummary = this.buildNodeExtractionSummary({
      article,
      processedArticle: article?.processed ?? null,
    });

    return {
      ...mappedNode,
      run: {
        id: node.run.id,
        seedUrl: node.run.seedUrl,
        status: node.run.status,
        executionMode: node.run.executionMode,
        profile: runProfile,
      },
      crawlResult: resolvedCrawlResult
        ? {
            id: resolvedCrawlResult.id,
            sourceUrl: resolvedCrawlResult.sourceUrl,
            fetchedAt: resolvedCrawlResult.fetchedAt,
            markdownRef: resolvedCrawlResult.markdownRef,
            contentHash: resolvedCrawlResult.contentHash,
            metadata:
              resolvedCrawlResult.metadata &&
              isPlainObject(resolvedCrawlResult.metadata)
                ? (resolvedCrawlResult.metadata as Record<string, unknown>)
                : null,
          }
        : null,
      article: article
        ? {
            id: article.id,
            url: article.url,
            titleGuess: article.titleGuess ?? null,
            sourceLabel: article.sourceLabel ?? null,
            language: article.language ?? null,
            crawlAt: article.crawlAt,
            metadata: articleMetadata,
            llmRepair:
              articleMetadata && isPlainObject(articleMetadata.llmRepair)
                ? (articleMetadata.llmRepair as Record<string, unknown>)
                : null,
          }
        : null,
      processedArticle: article?.processed
        ? {
            id: article.processed.id,
            status: article.processed.status,
            title: article.processed.title ?? null,
            subtitle: article.processed.subtitle ?? null,
            author: article.processed.author ?? null,
            source: article.processed.source ?? null,
            publishedAt: article.processed.publishedAt ?? null,
            category: article.processed.category ?? null,
            qualityScore: article.processed.qualityScore ?? null,
            llmModel: article.processed.llmModel ?? null,
            llmPromptVersion: article.processed.llmPromptVersion ?? null,
            language: article.processed.language ?? null,
            location: article.processed.location ?? null,
            processedAt: article.processed.processedAt,
            removedNoiseTypes: article.processed.removedNoiseTypes ?? null,
            topics: article.processed.topics ?? null,
            keyPoints: article.processed.keyPoints ?? null,
            entities: article.processed.entities ?? null,
            kgRelations: article.processed.kgRelations ?? null,
          }
        : null,
      repairSummary,
      extractionSummary,
      llmLogFilters: this.buildLlmLogFilters({
        runId: node.run.id,
        nodeId: node.id,
        profileId: runProfile?.id,
        includeRepair: Boolean(
          articleMetadata && isPlainObject(articleMetadata.llmRepair),
        ),
      }),
    };
  }

  async getRunWorkflowRun(orgId: string, runId: string) {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id: runId },
      select: {
        orgId: true,
        workflowRunId: true,
      },
    });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier run not found");
    }
    if (!run.workflowRunId) {
      throw new NotFoundException("Crawl frontier workflow run not found");
    }
    return this.strategyRecorder.getRun(orgId, run.workflowRunId);
  }

  async listRunWorkflowCandidates(orgId: string, runId: string) {
    const workflowRun = await this.getRunWorkflowRun(orgId, runId);
    return workflowRun.candidates;
  }

  async getRunWorkflowCandidateExplanation(
    orgId: string,
    runId: string,
    candidateId: string,
  ) {
    const workflowRun = await this.getRunWorkflowRun(orgId, runId);
    const candidate = workflowRun.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      throw new NotFoundException("Workflow candidate not found");
    }
    return candidate;
  }

  async createRun(
    orgId: string,
    actorId: string,
    input: CreateCrawlFrontierRunDto,
  ) {
    const seedUrl = this.normalizeUrl(input.seedUrl);
    const profile = await this.resolveEffectiveProfileForUrl({
      orgId,
      profileId: input.profileId,
      seedUrl,
    });
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

    const runId = await this.createRunFromProfile({
      orgId,
      actorId,
      seedUrl,
      profile,
      executionMode,
      maxDepth,
      maxPages,
      keywords,
      runMetadata: {
        runRole:
          profile.config.llmAssist?.shadow?.role === "shadow" ? "shadow" : "active",
        llmAssist: (() => {
          const llmAssist = resolveEffectiveLlmAssistConfig(
            profile.config,
            "judge",
          );
          return llmAssist
            ? {
                enabled: true,
                recallMode: llmAssist.recallMode ?? "high_recall",
                synthesized: profile.config.llmAssist?.enabled !== true,
              }
            : null;
        })(),
      },
    });

    return this.getRun(orgId, runId);
  }

  private async resolveEffectiveProfileForUrl(options: {
    orgId: string;
    profileId?: string | null;
    seedUrl: string;
  }) {
    const baseProfile = options.profileId
      ? await this.profiles.getProfile(options.orgId, options.profileId)
      : await this.profiles.findProfileForUrl(options.orgId, options.seedUrl);
    if (!baseProfile) {
      return null;
    }
    const overlay = await this.strategyWorkflows.compileProfileOverlay({
      orgId: options.orgId,
      baseExecutionMode: baseProfile.executionMode,
      baseConfig: baseProfile.config,
      workflowId: baseProfile.workflowId,
      workflowVersionId: baseProfile.workflowVersionId,
      workflowBindingMode: baseProfile.workflowBindingMode,
    });
    return this.strategyWorkflows.applyProfileOverlay({
      profile: baseProfile,
      overlay,
    });
  }

  private async createRunFromProfile(options: {
    orgId: string;
    actorId: string;
    seedUrl: string;
    profile: CrawlSiteProfileRecord;
    executionMode: CrawlSiteExecutionMode;
    maxDepth: number;
    maxPages: number;
    keywords?: string[];
    runMetadata?: Record<string, unknown>;
  }) {
    const seedUrl = this.normalizeUrl(options.seedUrl);

    const syntheticTask = await this.prisma.crawlTask.create({
      data: {
        orgId: options.orgId,
        createdById: options.actorId,
        targetUrl: seedUrl,
        displayName: `Frontier: ${options.profile.name}`.slice(0, 80),
        status: "queued",
        concurrency: 1,
        keywords: toPrismaJsonValue(options.keywords ?? []),
        config: toPrismaJsonValue({
          frontier: true,
          frontierProfileId: options.profile.id,
          executionMode: options.executionMode,
          workflowId: options.profile.workflowId ?? null,
          workflowVersionId: options.profile.workflowVersionId ?? null,
          workflowBindingMode: options.profile.workflowBindingMode ?? "published",
          urlQueryParamAllowlist: resolveQueryParamAllowlist(
            options.profile.config.urlQueryParamAllowlist,
          ),
          itemPayload: {
            metadata: {
              frontier: true,
              crawlSiteProfileId: options.profile.id,
            },
          },
        }),
      },
    });

    const run = await this.prisma.crawlFrontierRun.create({
      data: {
        orgId: options.orgId,
        profileId: options.profile.id,
        seedUrl,
        crawlTaskId: syntheticTask.id,
        executionMode: options.executionMode,
        status: "queued",
        maxDepth: options.maxDepth,
        maxPages: options.maxPages,
        keywords: toPrismaJsonValue(options.keywords ?? []),
        createdById: options.actorId,
        metadata: toPrismaJsonValue({
          profileVersion: options.profile.version,
          pageTypeBudgets: computeFrontierPageTypeBudgets({
            maxDepth: options.maxDepth,
            maxPages: options.maxPages,
          }),
          seedStrategy: this.resolveSeedStrategy(options.profile.config),
          seedDiscoveryMode: options.profile.config.seedDiscovery?.mode ?? "robots",
          topologyBudgetPages:
            options.profile.config.seedDiscovery?.topologyBudgetPages ?? null,
          topologyBudgetDepth:
            options.profile.config.seedDiscovery?.topologyBudgetDepth ?? null,
          sourceTier: options.profile.config.sourceTier ?? "tier2",
          hostScope:
            options.profile.config.hostScope ??
            ((options.profile.config.allowedHosts?.length ?? 0) > 0 &&
            (options.profile.config.allowedDomains?.length ?? 0) === 0
              ? "strict_hosts"
              : "registrable_domain"),
          workflowId: options.profile.workflowId ?? null,
          workflowVersionId: options.profile.workflowVersionId ?? null,
          workflowBindingMode: options.profile.workflowBindingMode ?? "published",
          ...(options.runMetadata ?? {}),
        }),
      },
    });

    const workflowRun = await this.createWorkflowRunForFrontier({
      orgId: options.orgId,
      actorId: options.actorId,
      frontierRunId: run.id,
      seedUrl,
      profile: options.profile,
      executionMode: options.executionMode,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      keywords: options.keywords,
    });

    await this.updateRunMetadata(run.id, {
      workflowRunId: workflowRun.id,
      workflowOrigin: workflowRun.workflowOrigin,
      workflowGraphNodeCount: workflowRun.definition.nodes.length,
      workflowGraphEdgeCount: workflowRun.definition.edges.length,
    });

    const rootNode = await this.prisma.crawlFrontierNode.create({
      data: {
        runId: run.id,
        orgId: options.orgId,
        url: seedUrl,
        pageType: "home",
        depth: 0,
        queueClass: "hot",
        status: "queued",
        queuedAt: new Date(),
        metadata: toPrismaJsonValue({
          seed: true,
          profileId: options.profile.id,
          seedStrategy: this.resolveSeedStrategy(options.profile.config),
          seedOrigin: "frontier_root",
          sourceTier: options.profile.config.sourceTier ?? "tier2",
          discoveryPath: ["home"],
          frontierPath: ["home"],
          workflowRunId: workflowRun.id,
          workflowOrigin: workflowRun.workflowOrigin,
          runRole:
            typeof options.runMetadata?.runRole === "string"
              ? options.runMetadata.runRole
              : "active",
        }),
      },
    });

    await this.queueService.enqueueFrontierNode({
      orgId: options.orgId,
      taskId: syntheticTask.id,
      frontierRunId: run.id,
      frontierNodeId: rootNode.id,
      priorityClass: "hot",
    });

    return run.id;
  }

  async cancelRun(orgId: string, id: string) {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id },
      select: {
        id: true,
        orgId: true,
      },
    });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier run not found");
    }
    await this.cancelRunRecords([id]);
    return this.getRun(orgId, id);
  }

  async cancelRuns(orgId: string, ids: string[]) {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) {
      throw new BadRequestException("ids must contain at least one run id");
    }
    const runs = await this.prisma.crawlFrontierRun.findMany({
      where: {
        orgId,
        id: {
          in: uniqueIds,
        },
      },
      select: {
        id: true,
      },
    });
    const canceledIds = runs.map((run) => run.id);
    if (canceledIds.length > 0) {
      await this.cancelRunRecords(canceledIds);
    }
    return {
      canceledIds,
      canceledCount: canceledIds.length,
    };
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
    await this.requeueNodeRecord(node, orgId);
    return this.getRun(orgId, node.runId);
  }

  async retryNodes(orgId: string, ids: string[]) {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) {
      throw new BadRequestException("ids must contain at least one node id");
    }
    const nodes = await this.prisma.crawlFrontierNode.findMany({
      where: {
        orgId,
        id: {
          in: uniqueIds,
        },
      },
      include: {
        run: true,
      },
    });
    const retriedIds: string[] = [];
    const skippedIds: string[] = [];
    const runIds = new Set<string>();
    for (const node of nodes) {
      if (!node.run.crawlTaskId) {
        skippedIds.push(node.id);
        continue;
      }
      await this.requeueNodeRecord(node, orgId);
      retriedIds.push(node.id);
      runIds.add(node.runId);
    }
    return {
      retriedIds,
      retriedCount: retriedIds.length,
      skippedIds,
      skippedCount: skippedIds.length,
      runIds: Array.from(runIds),
    };
  }

  private async cancelRunRecords(runIds: string[]): Promise<void> {
    const finishedAt = new Date();
    const runs = await this.prisma.crawlFrontierRun.findMany({
      where: {
        id: {
          in: runIds,
        },
      },
      select: {
        id: true,
        workflowRunId: true,
      },
    });
    await Promise.all([
      this.prisma.crawlFrontierRun.updateMany({
        where: {
          id: {
            in: runIds,
          },
        },
        data: {
          status: "canceled",
          finishedAt,
        },
      }),
      this.prisma.crawlFrontierNode.updateMany({
        where: {
          runId: {
            in: runIds,
          },
          status: { in: ["pending", "queued", "running"] },
        },
        data: {
          status: "canceled",
          updatedAt: finishedAt,
        },
      }),
    ]);
    await Promise.all(
      runs
        .filter((run) => typeof run.workflowRunId === "string" && run.workflowRunId.length > 0)
        .map(async (run) => {
          await this.strategyRecorder.appendEvent(run.workflowRunId!, {
            level: "warn",
            eventType: "frontier_run_canceled",
            nodeType: "legacy.frontier_run",
            message: "Frontier run was canceled",
            details: {
              frontierRunId: run.id,
            },
            timestamp: finishedAt.toISOString(),
          });
          await this.strategyRecorder.markRunStatus(run.workflowRunId!, {
            status: "canceled",
            finishedAt,
          });
        }),
    );
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

    const profile = await this.resolveEffectiveProfileForUrl({
      orgId,
      profileId: node.run.profileId,
      seedUrl: node.run.seedUrl,
    });
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
    if (node.run.workflowRunId) {
      await this.strategyRecorder.markRunStatus(node.run.workflowRunId, {
        status: "running",
      });
      await this.strategyRecorder.appendEvent(node.run.workflowRunId, {
        level: "info",
        eventType: "frontier_node_started",
        nodeId: node.id,
        nodeType: "legacy.frontier_node",
        message: "Frontier node execution started",
        details: {
          url: node.url,
          pageType: node.pageType,
          depth: node.depth,
          queueClass: node.queueClass,
        },
        timestamp: new Date().toISOString(),
      });
    }
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
          workflowRunId: node.run.workflowRunId,
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
      const mappedNode = this.mapNode(node);
      if (
        this.shouldDemoteHotRetryToNormal({
          node: mappedNode,
          failureKind,
        })
      ) {
        const queuedAt = new Date();
        await this.prisma.crawlFrontierNode.update({
          where: { id: node.id },
          data: {
            status: "queued",
            queueClass: "normal",
            queuedAt,
            lastError: null,
            metadata: toPrismaJsonValue(
              mergeMetadataRecords(mappedNode.metadata, {
                retryDemotedToNormal: true,
                retryDemotedFromQueue: mappedNode.queueClass,
                retryDemotedAt: queuedAt.toISOString(),
                retryDemotedFailureKind: failureKind,
                retryDemotedLastError: message,
                warningFlags: uniqueStringList(
                  collectNodeWarningFlags(mappedNode.metadata, mappedNode.lastError),
                  failureKind ? [failureKind] : undefined,
                  ["retry_demoted_to_normal"],
                ) ?? [],
              }),
            ),
          },
        });
        await this.queueService.enqueueFrontierNode({
          orgId,
          taskId: node.run.crawlTaskId,
          frontierRunId: node.runId,
          frontierNodeId: node.id,
          priorityClass: "normal",
        });
        if (node.run.workflowRunId) {
          await this.strategyRecorder.appendEvent(node.run.workflowRunId, {
            level: "warn",
            eventType: "retry_demoted_to_normal",
            nodeId: node.id,
            nodeType: "budget-control",
            message: "Frontier node retry was demoted from hot to normal queue",
            triggerReason: failureKind,
            beforeCount: 1,
            afterCount: 1,
            rescuedCount: 1,
            details: {
              url: node.url,
              previousQueueClass: node.queueClass,
              nextQueueClass: "normal",
            },
            timestamp: queuedAt.toISOString(),
          });
          await this.strategyRecorder.markRunStatus(node.run.workflowRunId, {
            status: "queued",
            finishedAt: null,
          });
        }
        await this.refreshRunStatus(node.runId);
        return { inserted: 0, skipped: 0 };
      }
      await this.prisma.crawlFrontierNode.update({
        where: { id: node.id },
        data: {
          status: "failed",
          lastError: message,
          metadata: toPrismaJsonValue(
            mergeMetadataRecords(
              mappedNode.metadata,
              {
                failureKind,
                warningFlags: uniqueStringList(
                  collectNodeWarningFlags(mappedNode.metadata, mappedNode.lastError),
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
      if (node.run.workflowRunId) {
        await this.strategyRecorder.appendEvent(node.run.workflowRunId, {
          level: "error",
          eventType: "frontier_node_failed",
          nodeId: node.id,
          nodeType: "legacy.frontier_node",
          message,
          triggerReason: failureKind,
          details: {
            url: node.url,
            pageType: node.pageType,
            depth: node.depth,
          },
          timestamp: new Date().toISOString(),
        });
      }
      await this.refreshRunStatus(node.runId);
      throw error;
    }
  }

  async processQueuedLlmJudge(
    orgId: string,
    payload: CrawlFrontierLlmJudgeJobPayload,
  ): Promise<CrawlExecutionSummary> {
    const startedMs = Date.now();
    const node = await this.prisma.crawlFrontierNode.findUnique({
      where: { id: payload.nodeId },
      include: { run: true },
    });
    if (!node || node.orgId !== orgId) {
      throw new NotFoundException("Crawl frontier node not found for LLM judge");
    }

    const mappedNode = this.mapNode(node);
    const profile = await this.resolveEffectiveProfileForUrl({
      orgId,
      profileId: node.run.profileId,
      seedUrl: node.run.seedUrl,
    });
    if (!profile) {
      throw new BadRequestException("Crawl frontier run cannot resolve site profile");
    }
    if (node.run.workflowRunId) {
      await this.strategyRecorder.appendEvent(node.run.workflowRunId, {
        level: "info",
        eventType: "llm_judge_started",
        nodeId: node.id,
        nodeType: "branch",
        message: "Deferred LLM judge started",
        details: {
          mode: payload.mode,
          candidateCount: payload.candidates.length,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const candidates = payload.candidates.map((candidate) => ({
      ...candidate,
      metadata: isPlainObject(candidate.metadata)
        ? (candidate.metadata as Record<string, unknown>)
        : {},
    }));
    let llmDiagnostics: Record<string, unknown> | undefined;
    let judgedCandidates = candidates;

    try {
      const assisted = await this.applyLlmCandidateAssistance({
        node: mappedNode,
        runId: payload.runId,
        profile,
        candidates: candidates as FrontierCandidate[],
      });
      judgedCandidates = assisted.candidates;
      llmDiagnostics =
        assisted.diagnostics && isPlainObject(assisted.diagnostics)
          ? (assisted.diagnostics as Record<string, unknown>)
          : undefined;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "llm frontier judge failed";
      llmDiagnostics = {
        llmJudgeEnabled: true,
        llmJudgeAttempted: true,
        llmJudgeParsed: false,
        llmJudgeError: message,
        warningFlags: ["llm_judge_failed"],
      };
    }
    if (node.run.workflowRunId) {
      await this.recordResolvedLlmCandidateDecisions({
        workflowRunId: node.run.workflowRunId,
        node: mappedNode,
        mode: payload.mode,
        inputCandidates: candidates as FrontierCandidate[],
        resolvedCandidates: judgedCandidates as FrontierCandidate[],
        llmDiagnostics,
      });
    }

    const result =
      payload.mode === "seed"
        ? await this.materializeSeedCandidates({
            node: mappedNode,
            run: {
              id: payload.runId,
              seedUrl: node.run.seedUrl,
              maxDepth: payload.maxDepth,
              maxPages: payload.maxPages,
            },
            taskId: payload.taskId,
            profile,
            candidates: judgedCandidates,
            sitemapDiagnostics:
              payload.seedContext?.diagnostics && isPlainObject(payload.seedContext.diagnostics)
                ? (payload.seedContext.diagnostics as Record<string, unknown>)
                : {},
            qualityThresholds: payload.seedContext?.qualityThresholds,
            discoveredCount: Math.max(
              candidates.length,
              payload.seedContext?.discoveredCount ?? candidates.length,
            ),
            llmDiagnostics,
          })
        : await this.materializeDiscoveredCandidates({
            node: mappedNode,
            runId: payload.runId,
            taskId: payload.taskId,
            maxDepth: payload.maxDepth,
            maxPages: payload.maxPages,
            profile,
            candidates: judgedCandidates,
            extractionDiagnostics:
              payload.diagnostics && isPlainObject(payload.diagnostics)
                ? (payload.diagnostics as Record<string, unknown>)
                : {},
            llmDiagnostics,
            maxDepthOverride: payload.maxDepthOverride,
            maxNewNodes: payload.maxNewNodes,
            metadataPatch:
              payload.metadataPatch && isPlainObject(payload.metadataPatch)
                ? (payload.metadataPatch as Record<string, unknown>)
                : undefined,
          });

    const resultMetadata =
      payload.mode === "seed"
        ? ((result as SeedDiscoveryOutcome).diagnostics ?? {})
        : (result as Record<string, unknown>);

    await this.updateNodeMetadata(node.id, (existing) => {
      const nextPending = Math.max(0, resolvePendingLlmJudgeJobs(existing) - 1);
      return mergeMetadataRecords(existing, resultMetadata, {
        pendingLlmJudgeJobs: nextPending,
        llmJudgeDeferredResolvedAt: new Date().toISOString(),
        warningFlags: uniqueStringList(
          collectNodeWarningFlags(existing, node.lastError),
          coerceStringArray(resultMetadata.warningFlags),
          coerceStringArray(llmDiagnostics?.warningFlags),
        ) ?? [],
      });
    });
    if (node.run.workflowRunId) {
      const resultStats = toNumericRecord(resultMetadata.candidateStats);
      await this.strategyRecorder.upsertStep(node.run.workflowRunId, {
        stepKey: `frontier:${node.id}:llm-judge:${payload.mode}`,
        nodeId: `legacy::llm-judge:${node.id}:${payload.mode}`,
        nodeType: "branch",
        label:
          payload.mode === "seed"
            ? "Deferred seed LLM judge"
            : "Deferred discovery LLM judge",
        status: llmDiagnostics?.llmJudgeError ? "failed" : "completed",
        durationMs: Date.now() - startedMs,
        inputCount: candidates.length,
        outputCount:
          payload.mode === "seed"
            ? (result as SeedDiscoveryOutcome).created
            : resultStats?.selected ?? 0,
        rejectedCount: resultStats?.rejected ?? 0,
        sampleUrls: candidates.slice(0, 5).map((candidate) => candidate.url),
        metrics: {
          mode: payload.mode,
          llmDiagnostics: llmDiagnostics ?? null,
          resultMetadata,
        },
        error:
          typeof llmDiagnostics?.llmJudgeError === "string"
            ? llmDiagnostics.llmJudgeError
            : null,
      });
      await this.strategyRecorder.appendEvent(node.run.workflowRunId, {
        level: llmDiagnostics?.llmJudgeError ? "warn" : "info",
        eventType: "llm_judge_resolved",
        nodeId: node.id,
        nodeType: "branch",
        message: llmDiagnostics?.llmJudgeError
          ? "Deferred LLM judge completed with fallback diagnostics"
          : "Deferred LLM judge completed",
        triggerReason:
          typeof llmDiagnostics?.llmJudgeError === "string"
            ? "llm_judge_failed"
            : null,
        beforeCount: candidates.length,
        afterCount:
          payload.mode === "seed"
            ? (result as SeedDiscoveryOutcome).created
            : resultStats?.selected ?? 0,
        rescuedCount:
          payload.mode === "seed"
            ? (result as SeedDiscoveryOutcome).created
            : resultStats?.selected ?? 0,
        details: {
          mode: payload.mode,
          llmDiagnostics: llmDiagnostics ?? null,
        },
        timestamp: new Date().toISOString(),
      });
    }
    await this.refreshRunStatus(payload.runId);
    return { inserted: 0, skipped: 0 };
  }

  async processQueuedLlmLearn(
    orgId: string,
    payload: CrawlFrontierLlmLearnJobPayload,
  ): Promise<CrawlExecutionSummary> {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id: payload.runId },
      include: {
        profile: true,
        nodes: {
          orderBy: [{ depth: "asc" }, { discoveredAt: "asc" }],
          select: {
            id: true,
            url: true,
            pageType: true,
            status: true,
            score: true,
            freshnessScore: true,
            metadata: true,
          },
        },
      },
    });
    if (!run || run.orgId !== orgId || !run.profile) {
      throw new NotFoundException("Crawl frontier run not found for LLM learning");
    }

    const metadata = run.metadata && isPlainObject(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};
    const profile: CrawlSiteProfileRecord = {
      ...run.profile,
      config: normalizeCrawlSiteProfileConfig(run.profile.config),
    };
    const finalSummary = {
      status: run.status,
      metadata,
      articleCount: run.articleCount,
      pageCount: run.pageCount,
      failedCount: run.failedCount,
      duplicateCount: run.duplicateCount,
    };
    const lifecycleRun: FrontierLifecycleRun = {
      id: run.id,
      orgId: run.orgId,
      seedUrl: run.seedUrl,
      maxDepth: run.maxDepth,
      maxPages: run.maxPages,
      nodeCount: run.nodeCount,
      keywords: run.keywords,
      metadata,
      createdById: run.createdById,
      profile,
      nodes: run.nodes.map((nodeItem) => ({
        id: nodeItem.id,
        url: nodeItem.url,
        pageType: nodeItem.pageType as CrawlFrontierPageType,
        status: nodeItem.status,
        score: nodeItem.score,
        freshnessScore: nodeItem.freshnessScore,
        metadata:
          nodeItem.metadata && isPlainObject(nodeItem.metadata)
            ? (nodeItem.metadata as Record<string, unknown>)
            : null,
      })),
    };

    try {
      await this.handleActiveRunCompletion(lifecycleRun, profile, finalSummary);
      await this.updateRunMetadata(run.id, {
        llmLifecycle: {
          ...(isPlainObject(metadata.llmLifecycle)
            ? (metadata.llmLifecycle as Record<string, unknown>)
            : {}),
          learnHandledAt: new Date().toISOString(),
          learnHandledKey: [
            finalSummary.status,
            finalSummary.articleCount,
            finalSummary.pageCount,
            finalSummary.failedCount,
            finalSummary.duplicateCount,
          ].join(":"),
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "frontier llm learn failed";
      await this.updateRunMetadata(run.id, {
        warningFlags: uniqueStringList(
          coerceStringArray(metadata.warningFlags),
          ["llm_learn_failed"],
        ) ?? ["llm_learn_failed"],
        llmLifecycle: {
          ...(isPlainObject(metadata.llmLifecycle)
            ? (metadata.llmLifecycle as Record<string, unknown>)
            : {}),
          learnHandledAt: new Date().toISOString(),
          learnError: message,
        },
      });
    }

    return { inserted: 0, skipped: 0 };
  }

  private shouldDemoteHotRetryToNormal(options: {
    node: CrawlFrontierNodeRecord;
    failureKind: string | null;
  }) {
    if (options.node.queueClass !== "hot") {
      return false;
    }
    if (options.failureKind !== "network_tunnel_error") {
      return false;
    }
    return (
      asBoolean(options.node.metadata?.retryDemotedToNormal) !== true
    );
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
      workflowRunId?: string | null;
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
      workflowRunId?: string | null;
    };
    profile: CrawlSiteProfileRecord;
    task: CrawlTask;
    requestTimeoutMs?: number | null;
  }) {
    const startedMs = Date.now();
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
    await this.recordCrawl4aiSystemEvents(
      options.run.workflowRunId,
      options.node,
      response.systemEvents,
    );

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
    const rootSeedPlan = this.resolveRootSeedPlan({
      nodeDepth: options.node.depth,
      profile: options.profile,
      maxPages: options.run.maxPages,
      maxDepth: options.run.maxDepth,
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
            maxDepthOverride: rootSeedPlan.topologyBudgetDepth,
            maxNewNodes: rootSeedPlan.topologyBudgetPages,
            metadataPatch: rootSeedPlan.topologyMetadataPatch,
          })
        : undefined;
    const seedDiscovery = await this.executeRootSeedBranch({
      workflowRunId: options.run.workflowRunId,
      node: options.node,
      run: {
        id: options.run.id,
        seedUrl: options.run.seedUrl,
        maxDepth: options.run.maxDepth,
        maxPages: options.run.maxPages,
      },
      profile: options.profile,
      taskId: options.task.id,
      requestTimeoutMs: options.requestTimeoutMs,
      seedStrategy: rootSeedPlan.seedStrategy,
    });
    const branchSummary = this.rootExecutor.buildRootBranchSummary({
      nodeMetadata: options.node.metadata,
      lastError: options.node.lastError,
      runtimeMetadata,
      branchMetadata: discoveryMetadata,
      seedDiscovery,
      seedPlan: rootSeedPlan,
    });

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
            seedDiscovery?.diagnostics,
            branchSummary.metadataPatch,
          ),
        ),
      },
    });
    await this.recordNodeCompletion({
      workflowRunId: options.run.workflowRunId,
      node: options.node,
      stepKey: `frontier:${options.node.id}:crawl`,
      workflowNodeId: `legacy::crawl:${options.node.id}`,
      workflowNodeType: "legacy.crawl_fetch",
      label: `Fetch ${options.node.pageType} node`,
      durationMs: Date.now() - startedMs,
      outputUrls: response.results
        .map((entry) => entry.url)
        .filter((entry): entry is string => typeof entry === "string"),
      outputCount: response.results.length,
      rejectedCount: 0,
      metrics: {
        pageType: options.node.pageType,
        hasDiscoveryBranch: Boolean(discoveryMetadata),
        hasSeedBranch: Boolean(seedDiscovery),
        warningFlags: branchSummary.combinedWarningFlags,
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
      workflowRunId?: string | null;
    };
    profile: CrawlSiteProfileRecord;
    task: CrawlTask;
    requestTimeoutMs?: number | null;
  }) {
    const startedMs = Date.now();
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
    await this.recordCrawl4aiSystemEvents(
      options.run.workflowRunId,
      options.node,
      response.systemEvents,
    );

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
    const rootSeedPlan = this.resolveRootSeedPlan({
      nodeDepth: options.node.depth,
      profile: options.profile,
      maxPages: options.run.maxPages,
      maxDepth: options.run.maxDepth,
    });

    await this.prisma.crawlFrontierRun.update({
      where: { id: options.run.id },
      data: {
        nativeRunId: response.runId ?? undefined,
      },
    });

    const rawResultByUrl = new Map<string, Crawl4aiArticle>();
    for (const entry of response.results) {
      if (typeof entry.url === "string" && entry.url.trim().length > 0) {
        rawResultByUrl.set(entry.url.trim(), entry);
      }
    }
    const nativeMaterialization =
      await this.layeredExecutor.materializeNativeDiscoveryCandidates({
        workflowRunId: options.run.workflowRunId,
        node: options.node,
        run: {
          id: options.run.id,
          maxDepth: options.run.maxDepth,
          maxPages: options.run.maxPages,
        },
        profile: options.profile,
        persistedResults: persisted.results.map((result) => ({
          id: result.id,
          sourceUrl: result.sourceUrl,
        })),
        rawResultsByUrl: rawResultByUrl,
      });
    const acceptedCount = nativeMaterialization.acceptedCount;
    const createdCount = nativeMaterialization.createdCount;
    const scannedSourceUrls = new Set(nativeMaterialization.scannedSourceUrls);
    const rejectionCounts = nativeMaterialization.rejectionCounts;
    const acceptedPageTypeCounts = nativeMaterialization.acceptedPageTypeCounts;
    const selectedPageTypeCounts = nativeMaterialization.selectedPageTypeCounts;
    const nativeWarningFlags = new Set(nativeMaterialization.nativeWarningFlags);

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
          maxDepthOverride: rootSeedPlan.topologyBudgetDepth,
          maxNewNodes: rootSeedPlan.topologyBudgetPages,
          metadataPatch: rootSeedPlan.topologyMetadataPatch,
        })
      : undefined;
    await this.recordNativeFallbackExecution({
      workflowRunId: options.run.workflowRunId,
      node: options.node,
      createdCount,
      minAcceptedResults,
      minArticleResults,
      nativeAcceptedArticles: selectedPageTypeCounts.article,
      fallbackDiscoveryMetadata,
      triggerReason:
        createdCount === 0
          ? "native_zero_accepted"
          : selectedPageTypeCounts.article < minArticleResults
            ? "native_article_below_threshold"
            : "native_accepted_below_threshold",
    });
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
    const seedDiscovery = await this.executeRootSeedBranch({
      workflowRunId: options.run.workflowRunId,
      node: options.node,
      run: {
        id: options.run.id,
        seedUrl: options.run.seedUrl,
        maxDepth: options.run.maxDepth,
        maxPages: options.run.maxPages,
      },
      profile: options.profile,
      taskId: options.task.id,
      requestTimeoutMs: options.requestTimeoutMs,
      seedStrategy: rootSeedPlan.seedStrategy,
    });
    const branchSummary = this.rootExecutor.buildRootBranchSummary({
      nodeMetadata: options.node.metadata,
      lastError: options.node.lastError,
      runtimeMetadata,
      branchMetadata: fallbackDiscoveryMetadata,
      seedDiscovery,
      extraWarningFlags: Array.from(nativeWarningFlags),
      seedPlan: rootSeedPlan,
    });

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
            seedDiscovery?.diagnostics,
            branchSummary.metadataPatch,
            {
              nativeDiscovered: true,
              sourceTier: options.profile.config.sourceTier ?? "tier2",
              discoveryPath: ["home"],
              frontierPath: ["home"],
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
    await this.recordNodeCompletion({
      workflowRunId: options.run.workflowRunId,
      node: options.node,
      stepKey: `frontier:${options.node.id}:native-root`,
      workflowNodeId: `legacy::native-root:${options.node.id}`,
      workflowNodeType: "deep-discovery",
      label: "Native root discovery",
      durationMs: Date.now() - startedMs,
      outputUrls: Array.from(scannedSourceUrls),
      outputCount: createdCount,
      rejectedCount: Object.values(rejectionCounts).reduce(
        (sum, value) => sum + value,
        0,
      ),
      metrics: {
        acceptedCount,
        createdCount,
        selectedPageTypeCounts,
        rejectionCounts,
        nativeWarningFlags: branchSummary.combinedWarningFlags,
        nativeStrategyType: nativeComponents.deepCrawlStrategy?.type ?? null,
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
        Boolean(filterChain) && !nativeOptions.filterChain,
      urlScorerSynthesized:
        Boolean(urlScorer) && !nativeOptions.urlScorer,
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

  private resolveSeedStrategy(config: CrawlSiteProfileConfig): CrawlSeedStrategy {
    return this.rootExecutor.resolveSeedStrategy(config);
  }

  private resolveSeedDiscoveryConfig(
    config: CrawlSiteProfileConfig,
    maxPages: number,
    maxDepth: number,
  ): Required<
    Pick<
      CrawlSeedDiscoveryConfig,
      | "mode"
      | "freshnessWindowHours"
      | "maxSeedUrls"
      | "topologyBudgetPages"
      | "topologyBudgetDepth"
    >
  > & {
    qualityThresholds: Required<
      NonNullable<CrawlSeedDiscoveryConfig["qualityThresholds"]>
    >;
  } {
    return this.rootExecutor.resolveSeedDiscoveryConfig(
      config,
      maxPages,
      maxDepth,
    );
  }

  private estimateSeedCandidateFreshnessScore(
    candidate: CrawlDiscoveryCandidate,
    config: CrawlSiteProfileConfig,
  ) {
    if (
      typeof candidate.publishedAtTs !== "number" ||
      !Number.isFinite(candidate.publishedAtTs)
    ) {
      return estimateFreshnessScore(candidate.url, config);
    }
    const ageHours = (Date.now() - candidate.publishedAtTs) / (1000 * 60 * 60);
    const freshnessRules = config.freshnessRules;
    const recentHours = freshnessRules?.recentHours ?? 24;
    const weekHours = freshnessRules?.weekHours ?? 24 * 7;
    const monthHours = freshnessRules?.monthHours ?? 24 * 30;
    if (ageHours <= recentHours) {
      return 1;
    }
    if (ageHours <= weekHours) {
      return 0.75;
    }
    if (ageHours <= monthHours) {
      return 0.4;
    }
    return 0.1;
  }

  private applyCandidateDiscoveryMetadata(options: {
    node: Pick<CrawlFrontierNodeRecord, "pageType">;
    config: CrawlSiteProfileConfig;
    candidates: FrontierCandidate[];
  }): { candidates: FrontierCandidate[]; syntheticListActivated: boolean } {
    const syntheticListActivated = this.shouldUseSyntheticList(
      options.node.pageType,
      options.candidates,
    );
    return {
      syntheticListActivated,
      candidates: options.candidates.map((candidate) => {
        const baseMetadata = mergeMetadataRecords(candidate.metadata, {
          sourceTier: options.config.sourceTier ?? "tier2",
          freshnessBucket: resolveFreshnessBucket(candidate.freshnessScore),
        });
        if (
          syntheticListActivated &&
          candidate.pageType === "article" &&
          (options.node.pageType === "home" || options.node.pageType === "category")
        ) {
          return {
            ...candidate,
            metadata: mergeMetadataRecords(baseMetadata, {
              syntheticList: true,
              syntheticListLabel: this.deriveSyntheticListLabel(
                candidate.url,
                candidate.metadata.linkText as string | undefined,
              ),
              discoveryPath: [options.node.pageType, "synthetic_list", "article"],
              frontierPath: [options.node.pageType, "synthetic_list", "article"],
            }) ?? {},
          };
        }
        return {
          ...candidate,
          metadata: mergeMetadataRecords(baseMetadata, {
            syntheticList: null,
            discoveryPath: [options.node.pageType, candidate.pageType],
            frontierPath: [options.node.pageType, candidate.pageType],
          }) ?? {},
        };
      }),
    };
  }

  private async applyLlmCandidateAssistance(options: {
    node: CrawlFrontierNodeRecord;
    runId: string;
    profile: CrawlSiteProfileRecord;
    candidates: FrontierCandidate[];
  }) {
    const llmAssist = resolveEffectiveLlmAssistConfig(
      options.profile.config,
      "judge",
    );
    if (
      !this.frontierLlm ||
      !llmAssist ||
      options.node.pageType === "article"
    ) {
      return {
        candidates: options.candidates,
        diagnostics: undefined,
      };
    }
    try {
      const assisted = await this.frontierLlm.judgeCandidates({
        orgId: options.node.orgId,
        runId: options.runId,
        nodeId: options.node.id,
        profileId: options.profile.id,
        seedUrl: options.node.depth === 0 ? options.node.url : options.node.url,
        parentUrl: options.node.url,
        parentPageType: options.node.pageType,
        config: {
          ...options.profile.config,
          llmAssist,
        },
        candidates: options.candidates as FrontierLlmCandidate[],
      });
      const withPaths = this.applyCandidateDiscoveryMetadata({
        node: options.node,
        config: options.profile.config,
        candidates: assisted.candidates,
      });
      return {
        candidates: withPaths.candidates,
        diagnostics: {
          ...assisted.diagnostics,
          syntheticListActivated: withPaths.syntheticListActivated,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "llm frontier judge failed";
      return {
        candidates: options.candidates,
        diagnostics: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: true,
          llmJudgeError: message,
          warningFlags: ["llm_judge_failed"],
        },
      };
    }
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
    maxDepthOverride?: number;
    maxNewNodes?: number;
    metadataPatch?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const workflowRunId = await this.resolveWorkflowRunId(options.runId);
    const extraction = this.extractCandidates(
      options.node,
      options.profile.config,
      options.results,
    );
    await this.recordExtractionCandidateDecisions({
      workflowRunId,
      sourceNodeId: options.node.id,
      decisions: extraction.decisions,
    });
    if (this.shouldQueueLlmJudge(options.node, options.profile, extraction.candidates)) {
      return this.deferLlmJudgeForDiscovery({
        node: options.node,
        runId: options.runId,
        taskId: options.taskId,
        maxDepth: options.maxDepth,
        maxPages: options.maxPages,
        profile: options.profile,
        candidates: extraction.candidates,
        extractionDiagnostics: extraction.diagnostics,
        workflowRunId,
        maxDepthOverride: options.maxDepthOverride,
        maxNewNodes: options.maxNewNodes,
        metadataPatch: options.metadataPatch,
      });
    }

    return this.materializeDiscoveredCandidates({
      node: options.node,
      runId: options.runId,
      taskId: options.taskId,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      profile: options.profile,
      candidates: extraction.candidates,
      extractionDiagnostics: extraction.diagnostics,
      workflowRunId,
      maxDepthOverride: options.maxDepthOverride,
      maxNewNodes: options.maxNewNodes,
      metadataPatch: options.metadataPatch,
    });
  }

  private async discoverSeedNodes(options: {
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
    };
    profile: CrawlSiteProfileRecord;
    taskId: string;
    requestTimeoutMs?: number | null;
  }): Promise<SeedDiscoveryOutcome | undefined> {
    if (options.node.depth !== 0 || this.resolveSeedStrategy(options.profile.config) === "frontier_only") {
      return undefined;
    }

    const seedConfig = this.resolveSeedDiscoveryConfig(
      options.profile.config,
      options.run.maxPages,
      options.run.maxDepth,
    );
    const freshnessCutoffTs =
      Date.now() - seedConfig.freshnessWindowHours * 60 * 60 * 1000;
    const sitemap = await this.metadataService.discoverSitemap({
      domain: new URL(options.run.seedUrl).origin,
      maxUrls: seedConfig.maxSeedUrls,
      requestTimeoutMs:
        typeof options.requestTimeoutMs === "number"
          ? options.requestTimeoutMs
          : undefined,
      freshnessCutoffTs,
      discoveryMode: seedConfig.mode,
    });

    const seedCandidates = sitemap.candidates
      .map((candidate) => {
        const pageType = inferFrontierPageType({
          url: candidate.url,
          parentPageType: "home",
          config: options.profile.config,
          publishedAtTs: candidate.publishedAtTs,
        });
        const freshnessScore = this.estimateSeedCandidateFreshnessScore(
          candidate,
          options.profile.config,
        );
        return {
          url: candidate.url,
          pageType,
          freshnessScore,
          score: scoreFrontierCandidate({
            url: candidate.url,
            pageType,
            parentPageType: "home",
            parentUrl: options.run.seedUrl,
            config: options.profile.config,
            rawScore: 1,
            freshnessScore,
          }),
          metadata: {
            seedCandidate: true,
            seedOrigin: "sitemap",
            seedMethod: sitemap.diagnostics.seedMethod,
            seedPublishedAt:
              typeof candidate.publishedAtTs === "number"
                ? new Date(candidate.publishedAtTs).toISOString()
                : null,
            seedCrawledAt:
              typeof candidate.crawledAtTs === "number"
                ? new Date(candidate.crawledAtTs).toISOString()
                : null,
            freshnessBucket: resolveFreshnessBucket(freshnessScore),
          },
        } satisfies FrontierCandidate;
      })
      .filter((candidate) => candidate.pageType !== "home");

    if (this.shouldQueueLlmJudge(options.node, options.profile, seedCandidates)) {
      return this.deferLlmJudgeForSeed({
        node: options.node,
        run: options.run,
        taskId: options.taskId,
        profile: options.profile,
        candidates: seedCandidates,
        discoveredCount: sitemap.candidates.length,
        seedConfig,
        sitemapDiagnostics:
          sitemap.diagnostics && isPlainObject(sitemap.diagnostics)
            ? (sitemap.diagnostics as Record<string, unknown>)
            : {},
      });
    }

    return this.materializeSeedCandidates({
      node: options.node,
      run: options.run,
      taskId: options.taskId,
      profile: options.profile,
      candidates: seedCandidates,
      sitemapDiagnostics:
        sitemap.diagnostics && isPlainObject(sitemap.diagnostics)
          ? (sitemap.diagnostics as Record<string, unknown>)
          : {},
      qualityThresholds: seedConfig.qualityThresholds,
      discoveredCount: sitemap.candidates.length,
    });
  }

  private shouldQueueLlmJudge(
    node: CrawlFrontierNodeRecord,
    profile: CrawlSiteProfileRecord,
    candidates: FrontierCandidate[],
  ) {
    return Boolean(
      this.frontierLlm &&
        resolveEffectiveLlmAssistConfig(profile.config, "judge") &&
        node.pageType !== "article" &&
        candidates.length > 0,
    );
  }

  private async deferLlmJudgeForDiscovery(options: {
    node: CrawlFrontierNodeRecord;
    runId: string;
    taskId: string;
    maxDepth: number;
    maxPages: number;
    profile: CrawlSiteProfileRecord;
    candidates: FrontierCandidate[];
    extractionDiagnostics: FrontierCandidateExtraction["diagnostics"];
    workflowRunId?: string | null;
    maxDepthOverride?: number;
    maxNewNodes?: number;
    metadataPatch?: Record<string, unknown>;
  }) {
    const queuedAt = new Date().toISOString();
    const workflowRunId =
      options.workflowRunId ?? (await this.resolveWorkflowRunId(options.runId));
    await this.queueService.enqueueFrontierLlmJudge({
      orgId: options.node.orgId,
      taskId: options.taskId,
      runId: options.runId,
      nodeId: options.node.id,
      payload: {
        mode: "discovery",
        runId: options.runId,
        nodeId: options.node.id,
        taskId: options.taskId,
        maxDepth: options.maxDepth,
        maxPages: options.maxPages,
        candidates: options.candidates as CrawlFrontierCandidatePayload[],
        diagnostics: options.extractionDiagnostics,
        maxDepthOverride: options.maxDepthOverride,
        maxNewNodes: options.maxNewNodes,
        metadataPatch: options.metadataPatch,
      },
    });
    if (workflowRunId) {
      await this.recordQueuedLlmCandidateDecisions({
        workflowRunId,
        node: options.node,
        mode: "discovery",
        candidates: options.candidates,
        queuedAt,
      });
      await this.strategyRecorder.upsertStep(workflowRunId, {
        stepKey: `frontier:${options.node.id}:llm-judge:discovery`,
        nodeId: `legacy::llm-judge:${options.node.id}:discovery`,
        nodeType: "branch",
        label: "Deferred discovery LLM judge",
        status: "queued",
        durationMs: 0,
        inputCount: options.candidates.length,
        outputCount: 0,
        rejectedCount: 0,
        sampleUrls: options.candidates.slice(0, 5).map((candidate) => candidate.url),
        metrics: {
          mode: "discovery",
          extractionDiagnostics: options.extractionDiagnostics,
        },
      });
      await this.strategyRecorder.appendEvent(workflowRunId, {
        level: "info",
        eventType: "llm_judge_deferred",
        nodeId: options.node.id,
        nodeType: "branch",
        message: "Discovery candidates deferred to the LLM judge queue",
        triggerReason: "llm_judge_enabled",
        beforeCount: options.candidates.length,
        afterCount: options.candidates.length,
        rescuedCount: 0,
        details: {
          mode: "discovery",
          queuedAt,
          candidateCount: options.candidates.length,
        },
        timestamp: queuedAt,
      });
    }
    return {
      ...options.extractionDiagnostics,
      llmJudgeEnabled: true,
      llmJudgeAttempted: false,
      llmJudgeDeferred: true,
      llmJudgeDeferredMode: "discovery",
      llmJudgeQueuedAt: queuedAt,
      llmJudgeQueuedCandidateCount: options.candidates.length,
      llmJudgeDeferredCount: 1,
      warningFlags: uniqueStringList(
        options.extractionDiagnostics.warningFlags,
        ["llm_judge_deferred"],
      ) ?? ["llm_judge_deferred"],
    };
  }

  private async deferLlmJudgeForSeed(options: {
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
    };
    taskId: string;
    profile: CrawlSiteProfileRecord;
    candidates: FrontierCandidate[];
    discoveredCount: number;
    seedConfig: CrawlSeedDiscoveryConfig;
    sitemapDiagnostics: Record<string, unknown>;
  }): Promise<SeedDiscoveryOutcome> {
    const queuedAt = new Date().toISOString();
    const workflowRunId = await this.resolveWorkflowRunId(options.run.id);
    await this.queueService.enqueueFrontierLlmJudge({
      orgId: options.node.orgId,
      taskId: options.taskId,
      runId: options.run.id,
      nodeId: options.node.id,
      payload: {
        mode: "seed",
        runId: options.run.id,
        nodeId: options.node.id,
        taskId: options.taskId,
        maxDepth: options.run.maxDepth,
        maxPages: options.run.maxPages,
        candidates: options.candidates as CrawlFrontierCandidatePayload[],
        seedContext: {
          seedMethod:
            typeof options.sitemapDiagnostics.seedMethod === "string"
              ? options.sitemapDiagnostics.seedMethod
              : null,
          seedDiscoveryMode:
            typeof options.sitemapDiagnostics.discoveryMode === "string"
              ? options.sitemapDiagnostics.discoveryMode
              : null,
          diagnostics: options.sitemapDiagnostics,
          discoveredCount: options.discoveredCount,
          qualityThresholds: options.seedConfig.qualityThresholds,
        },
      },
    });
    if (workflowRunId) {
      await this.recordQueuedLlmCandidateDecisions({
        workflowRunId,
        node: options.node,
        mode: "seed",
        candidates: options.candidates,
        queuedAt,
      });
      await this.strategyRecorder.upsertStep(workflowRunId, {
        stepKey: `frontier:${options.node.id}:llm-judge:seed`,
        nodeId: `legacy::llm-judge:${options.node.id}:seed`,
        nodeType: "branch",
        label: "Deferred seed LLM judge",
        status: "queued",
        durationMs: 0,
        inputCount: options.candidates.length,
        outputCount: 0,
        rejectedCount: 0,
        sampleUrls: options.candidates.slice(0, 5).map((candidate) => candidate.url),
        metrics: {
          mode: "seed",
          discoveredCount: options.discoveredCount,
          seedDiagnostics: options.sitemapDiagnostics,
        },
      });
      await this.strategyRecorder.appendEvent(workflowRunId, {
        level: "info",
        eventType: "llm_judge_deferred",
        nodeId: options.node.id,
        nodeType: "branch",
        message: "Seed candidates deferred to the LLM judge queue",
        triggerReason: "llm_judge_enabled",
        beforeCount: options.candidates.length,
        afterCount: options.candidates.length,
        rescuedCount: 0,
        details: {
          mode: "seed",
          queuedAt,
          candidateCount: options.candidates.length,
          discoveredCount: options.discoveredCount,
        },
        timestamp: queuedAt,
      });
    }

    return {
      created: 0,
      selectedPageTypeCounts: this.createPageTypeCountRecord(),
      diagnostics: {
        seedOrigin: "sitemap",
        seedMethod:
          typeof options.sitemapDiagnostics.seedMethod === "string"
            ? options.sitemapDiagnostics.seedMethod
            : null,
        seedDiscoveryMode:
          typeof options.sitemapDiagnostics.discoveryMode === "string"
            ? options.sitemapDiagnostics.discoveryMode
            : null,
        seedDiagnostics: options.sitemapDiagnostics,
        seedYield: {
          discovered: options.discoveredCount,
          selected: options.candidates.length,
          created: 0,
          fresh: options.candidates.filter((candidate) => candidate.freshnessScore >= 0.75)
            .length,
        },
        fallbackStage: "llm_judge_pending",
        llmJudgeEnabled: true,
        llmJudgeAttempted: false,
        llmJudgeDeferred: true,
        llmJudgeDeferredMode: "seed",
        llmJudgeQueuedAt: queuedAt,
        llmJudgeQueuedCandidateCount: options.candidates.length,
        llmJudgeDeferredCount: 1,
        warningFlags: ["llm_judge_deferred"],
      },
    };
  }

  private async materializeDiscoveredCandidates(options: {
    node: CrawlFrontierNodeRecord;
    runId: string;
    taskId: string;
    maxDepth: number;
    maxPages: number;
    profile: CrawlSiteProfileRecord;
    candidates: FrontierCandidate[];
    extractionDiagnostics: Record<string, unknown>;
    llmDiagnostics?: Record<string, unknown>;
    workflowRunId?: string | null;
    maxDepthOverride?: number;
    maxNewNodes?: number;
    metadataPatch?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.layeredExecutor.materializeDiscoveredCandidates({
      ...options,
      workflowRunId:
        options.workflowRunId ?? (await this.resolveWorkflowRunId(options.runId)),
    });
  }

  private async materializeSeedCandidates(options: {
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
    };
    taskId: string;
    profile: CrawlSiteProfileRecord;
    candidates: FrontierCandidate[];
    sitemapDiagnostics: Record<string, unknown>;
    qualityThresholds?: CrawlSeedDiscoveryConfig["qualityThresholds"];
    discoveredCount: number;
    llmDiagnostics?: Record<string, unknown>;
  }): Promise<SeedDiscoveryOutcome> {
    return this.layeredExecutor.materializeSeedCandidates({
      ...options,
      workflowRunId: await this.resolveWorkflowRunId(options.run.id),
    });
  }

  private buildCandidateTraceSnapshot(options: FrontierTraceCandidate & {
    status?: string | null;
    rejectedReason?: string | null;
  }) {
    return this.rootExecutor.buildCandidateTraceSnapshot(options);
  }

  private async recordQueuedLlmCandidateDecisions(options: {
    workflowRunId: string;
    node: Pick<CrawlFrontierNodeRecord, "id">;
    mode: "discovery" | "seed";
    candidates: FrontierCandidate[];
    queuedAt: string;
  }) {
    await this.rootExecutor.recordQueuedLlmCandidateDecisions(options);
  }

  private async recordResolvedLlmCandidateDecisions(options: {
    workflowRunId: string;
    node: Pick<CrawlFrontierNodeRecord, "id">;
    mode: "discovery" | "seed";
    inputCandidates: FrontierCandidate[];
    resolvedCandidates: FrontierCandidate[];
    llmDiagnostics?: Record<string, unknown>;
  }) {
    await this.rootExecutor.recordResolvedLlmCandidateDecisions(options);
  }

  private resolveRootSeedPlan(options: {
    nodeDepth: number;
    profile: CrawlSiteProfileRecord;
    maxPages: number;
    maxDepth: number;
  }) {
    return this.rootExecutor.resolveRootSeedPlan(options);
  }

  private async executeRootSeedBranch(options: {
    workflowRunId?: string | null;
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
    };
    profile: CrawlSiteProfileRecord;
    taskId: string;
    requestTimeoutMs?: number | null;
    seedStrategy: CrawlSeedStrategy;
  }): Promise<SeedDiscoveryOutcome | undefined> {
    return this.rootExecutor.executeRootSeedBranch({
      workflowRunId: options.workflowRunId,
      node: options.node,
      seedStrategy: options.seedStrategy,
      discoverSeedBranch: () =>
        this.discoverSeedNodes({
          node: options.node,
          run: options.run,
          profile: options.profile,
          taskId: options.taskId,
          requestTimeoutMs: options.requestTimeoutMs,
        }),
    });
  }

  private async recordNativeFallbackExecution(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, "id">;
    createdCount: number;
    minAcceptedResults: number;
    minArticleResults: number;
    nativeAcceptedArticles: number;
    fallbackDiscoveryMetadata?: Record<string, unknown>;
    triggerReason: string;
  }) {
    await this.rootExecutor.recordNativeFallbackExecution(options);
  }

  private async recordRootSeedBranchEvent(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, "id" | "depth" | "pageType">;
    seedStrategy: CrawlSeedStrategy;
    seedDiscovery?: SeedDiscoveryOutcome;
  }) {
    await this.rootExecutor.recordRootSeedBranchEvent(options);
  }

  private extractCandidates(
    node: CrawlFrontierNodeRecord,
    config: CrawlSiteProfileConfig,
    results: Crawl4aiArticle[],
  ): FrontierCandidateExtraction {
    const extraction = this.layeredExecutor.extractCandidates({
      node,
      config,
      results,
    });
    const withDiscoveryMetadata = this.applyCandidateDiscoveryMetadata({
      node,
      config,
      candidates: extraction.candidates,
    });
    const candidateByUrl = new Map(
      withDiscoveryMetadata.candidates.map((candidate) => [candidate.url, candidate] as const),
    );
    return {
      candidates: withDiscoveryMetadata.candidates,
      decisions: extraction.decisions.map((decision) => ({
        ...decision,
        candidate: candidateByUrl.get(decision.candidate.url) ?? decision.candidate,
      })),
      diagnostics: {
        ...extraction.diagnostics,
        candidateStats: {
          ...extraction.diagnostics.candidateStats,
          selected: withDiscoveryMetadata.candidates.length,
        },
        warningFlags:
          uniqueStringList(
            extraction.diagnostics.warningFlags,
            withDiscoveryMetadata.syntheticListActivated
              ? ["synthetic_list_activated"]
              : undefined,
          ) ?? [],
        syntheticListActivated: withDiscoveryMetadata.syntheticListActivated,
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
    const activeNodeCount = nodes.filter((node) =>
      node.status === "pending" ||
      node.status === "queued" ||
      node.status === "running"
    ).length;
    const pendingLlmJudgeJobs = nodes.reduce((sum, node) => {
      const metadata = isPlainObject(node.metadata)
        ? (node.metadata as Record<string, unknown>)
        : undefined;
      return sum + resolvePendingLlmJudgeJobs(metadata);
    }, 0);
    const activeCount = activeNodeCount + pendingLlmJudgeJobs;
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
    const judgeMethodCounts: Record<string, number> = {};
    let judgeConfidenceTotal = 0;
    let judgeConfidenceCount = 0;
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
        for (const key of Object.keys(candidateStats) as (keyof typeof candidateStats)[]) {
          candidateStats[key] += nodeCandidateStats?.[key] ?? 0;
        }
        const nodeRejectionCounts = toNumericRecord(metadata.rejectionCounts);
        for (const [key, value] of Object.entries(nodeRejectionCounts ?? {})) {
          rejectionCounts[key] = (rejectionCounts[key] ?? 0) + value;
        }
        const nodeWarningFlags = collectNodeWarningFlags(metadata, node.lastError);
        for (const flag of nodeWarningFlags) {
          warningFlags.add(flag);
        }
        const failureKind =
          typeof metadata.failureKind === "string" &&
          metadata.failureKind.trim().length > 0
            ? metadata.failureKind.trim()
            : classifyFrontierFailureKind(node.lastError);
        const judgeMethod =
          typeof metadata.judgeMethod === "string" &&
          metadata.judgeMethod.trim().length > 0
            ? metadata.judgeMethod.trim()
            : null;
        if (judgeMethod) {
          bumpCount(judgeMethodCounts, judgeMethod);
        }
        if (
          typeof metadata.judgeConfidence === "number" &&
          Number.isFinite(metadata.judgeConfidence)
        ) {
          judgeConfidenceTotal += metadata.judgeConfidence;
          judgeConfidenceCount += 1;
        }
        if (failureKind) {
          bumpCount(failureKindCounts, failureKind);
        }
        if (node.depth === 0) {
          rootDiagnosis = {
            failureKind: failureKind ?? null,
            warningFlags: nodeWarningFlags,
            candidateStats: nodeCandidateStats ?? null,
            rejectionCounts: nodeRejectionCounts ?? null,
            lastError: node.lastError ?? null,
            llmJudgeEnabled:
              typeof metadata.llmJudgeEnabled === "boolean"
                ? metadata.llmJudgeEnabled
                : null,
            llmJudgeAttempted:
              typeof metadata.llmJudgeAttempted === "boolean"
                ? metadata.llmJudgeAttempted
                : null,
            llmJudgeParsed:
              typeof metadata.llmJudgeParsed === "boolean"
                ? metadata.llmJudgeParsed
                : null,
            llmJudgeError:
              typeof metadata.llmJudgeError === "string"
                ? metadata.llmJudgeError
                : null,
            llmJudgeBudget:
              typeof metadata.llmJudgeBudget === "number"
                ? metadata.llmJudgeBudget
                : null,
            pendingLlmJudgeJobs: resolvePendingLlmJudgeJobs(metadata),
            retryDemotedToNormal:
              typeof metadata.retryDemotedToNormal === "boolean"
                ? metadata.retryDemotedToNormal
                : null,
            retryDemotedFromQueue:
              typeof metadata.retryDemotedFromQueue === "string"
                ? metadata.retryDemotedFromQueue
                : null,
            retryDemotedAt:
              typeof metadata.retryDemotedAt === "string"
                ? metadata.retryDemotedAt
                : null,
            seedStrategy:
              typeof metadata.seedStrategy === "string"
                ? metadata.seedStrategy
                : null,
            seedOrigin:
              typeof metadata.seedOrigin === "string"
                ? metadata.seedOrigin
                : null,
            seedMethod:
              typeof metadata.seedMethod === "string"
                ? metadata.seedMethod
                : null,
            seedDiscoveryMode:
              typeof metadata.seedDiscoveryMode === "string"
                ? metadata.seedDiscoveryMode
                : null,
            fallbackStage:
              typeof metadata.fallbackStage === "string"
                ? metadata.fallbackStage
                : null,
            seedYield: isPlainObject(metadata.seedYield)
              ? metadata.seedYield
              : null,
            seedQuality: isPlainObject(metadata.seedQuality)
              ? metadata.seedQuality
              : null,
            seedDiagnostics: isPlainObject(metadata.seedDiagnostics)
              ? metadata.seedDiagnostics
              : null,
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
        warningFlags: uniqueStringList(
          isPlainObject(run.metadata)
            ? coerceStringArray((run.metadata as Record<string, unknown>).warningFlags)
            : undefined,
          Array.from(warningFlags),
        ) ?? [],
        failureKind,
        seedStrategy:
          typeof rootDiagnosis?.seedStrategy === "string"
            ? rootDiagnosis.seedStrategy
            : undefined,
        seedOrigin:
          typeof rootDiagnosis?.seedOrigin === "string"
            ? rootDiagnosis.seedOrigin
            : undefined,
        seedMethod:
          typeof rootDiagnosis?.seedMethod === "string"
            ? rootDiagnosis.seedMethod
            : undefined,
        seedDiscoveryMode:
          typeof rootDiagnosis?.seedDiscoveryMode === "string"
            ? rootDiagnosis.seedDiscoveryMode
            : undefined,
        fallbackStage:
          typeof rootDiagnosis?.fallbackStage === "string"
            ? rootDiagnosis.fallbackStage
            : undefined,
        seedYield: isPlainObject(rootDiagnosis?.seedYield)
          ? rootDiagnosis.seedYield
          : undefined,
        seedQuality: isPlainObject(rootDiagnosis?.seedQuality)
          ? rootDiagnosis.seedQuality
          : undefined,
        seedDiagnostics: isPlainObject(rootDiagnosis?.seedDiagnostics)
          ? rootDiagnosis.seedDiagnostics
          : undefined,
        judgeSummary: {
          methods: judgeMethodCounts,
          averageConfidence:
            judgeConfidenceCount > 0
              ? Number((judgeConfidenceTotal / judgeConfidenceCount).toFixed(4))
              : null,
          count: judgeConfidenceCount,
        },
        coverage: {
          byPageType: coverageByPageType,
          byDepth: coverageByDepth,
        },
        llmPendingJudgeJobs: pendingLlmJudgeJobs,
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
    if (run.workflowRunId) {
      const finishedAt =
        activeCount === 0 && status !== "running" && status !== "queued"
          ? new Date()
          : null;
      await this.strategyRecorder.updateRunCounts(run.workflowRunId, {
        frontierRunId: runId,
        frontierStatus: status,
        nodeCount,
        pageCount,
        articleCount,
        failedCount,
        duplicateCount,
        activeCount,
        pendingLlmJudgeJobs,
        candidateStats,
        rejectionCounts,
        warningFlags: Array.from(warningFlags),
        failureKind,
      });
      await this.strategyRecorder.markRunStatus(run.workflowRunId, {
        status:
          status === "completed" ||
          status === "failed" ||
          status === "canceled"
            ? status
            : activeCount > 0
              ? "running"
              : "queued",
        error: lastError,
        finishedAt,
      });
      if (
        status !== run.status &&
        (status === "completed" || status === "failed" || status === "canceled")
      ) {
        await this.strategyRecorder.appendEvent(run.workflowRunId, {
          level:
            status === "completed"
              ? "info"
              : status === "canceled"
                ? "warn"
                : "error",
          eventType: "frontier_run_terminal",
          nodeType: "legacy.frontier_run",
          message: `Frontier run ${status}`,
          triggerReason: failureKind,
          beforeCount: nodeCount,
          afterCount: pageCount,
          rescuedCount: articleCount,
          details: {
            frontierRunId: runId,
            candidateStats,
            rejectionCounts,
          },
          timestamp: (finishedAt ?? new Date()).toISOString(),
        });
      }
    }

    if (activeCount === 0 && status !== "running" && status !== "queued") {
      await this.handleTerminalRunLifecycle(runId, {
        status,
        metadata,
        articleCount,
        pageCount,
        failedCount,
        duplicateCount,
      });
    }
  }

  private async handleTerminalRunLifecycle(
    runId: string,
    finalSummary: {
      status: string;
      metadata: Record<string, unknown> | undefined;
      articleCount: number;
      pageCount: number;
      failedCount: number;
      duplicateCount: number;
    },
  ) {
    if (!this.frontierLlm) {
      return;
    }
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id: runId },
      include: {
        profile: true,
        nodes: {
          orderBy: [{ depth: "asc" }, { discoveredAt: "asc" }],
          select: {
            id: true,
            url: true,
            pageType: true,
            status: true,
            score: true,
            freshnessScore: true,
            metadata: true,
          },
        },
      },
    });
    if (!run || !run.profile) {
      return;
    }
    const lifecycleRun: FrontierLifecycleRun = {
      id: run.id,
      orgId: run.orgId,
      seedUrl: run.seedUrl,
      maxDepth: run.maxDepth,
      maxPages: run.maxPages,
      nodeCount: run.nodeCount,
      keywords: run.keywords,
      metadata:
        run.metadata && isPlainObject(run.metadata)
          ? (run.metadata as Record<string, unknown>)
          : null,
      createdById: run.createdById,
      profile: {
        ...run.profile,
        config: normalizeCrawlSiteProfileConfig(run.profile.config),
      },
      nodes: run.nodes.map((node) => ({
        id: node.id,
        url: node.url,
        pageType: node.pageType as CrawlFrontierPageType,
        status: node.status,
        score: node.score,
        freshnessScore: node.freshnessScore,
        metadata:
          node.metadata && isPlainObject(node.metadata)
            ? (node.metadata as Record<string, unknown>)
            : null,
      })),
    };
    const runMetadata = lifecycleRun.metadata ?? {};
    const lifecycle = isPlainObject(runMetadata.llmLifecycle)
      ? (runMetadata.llmLifecycle as Record<string, unknown>)
      : {};
    const handledKey = [
      finalSummary.status,
      finalSummary.articleCount,
      finalSummary.pageCount,
      finalSummary.failedCount,
      finalSummary.duplicateCount,
    ].join(":");
    if (
      typeof lifecycle.handledKey === "string" &&
      lifecycle.handledKey === handledKey
    ) {
      return;
    }
    const profile = lifecycleRun.profile;
    const learningLlmAssist = resolveEffectiveLlmAssistConfig(
      profile.config,
      "learn",
    );
    const runRole =
      typeof runMetadata.runRole === "string" &&
      runMetadata.runRole.trim().length > 0
        ? runMetadata.runRole.trim()
        : profile.config.llmAssist?.shadow?.role === "shadow"
          ? "shadow"
          : "active";
    if (!learningLlmAssist) {
      await this.updateRunMetadata(runId, {
        llmLifecycle: {
          handledAt: new Date().toISOString(),
          handledKey,
          role: runRole,
        },
      });
      return;
    }

    if (runRole === "shadow") {
      await this.handleShadowRunCompletion(lifecycleRun, profile, finalSummary);
      await this.updateRunMetadata(runId, {
        llmLifecycle: {
          handledAt: new Date().toISOString(),
          handledKey,
          role: runRole,
        },
      });
      return;
    }

    if (
      typeof lifecycle.learnQueuedKey === "string" &&
      lifecycle.learnQueuedKey === handledKey
    ) {
      return;
    }

    await this.queueService.enqueueFrontierLlmLearn({
      orgId: lifecycleRun.orgId,
      taskId: (run.crawlTaskId as string | null | undefined) ?? run.id,
      runId,
      payload: {
        runId,
      },
    });
    await this.updateRunMetadata(runId, {
      llmLifecycle: {
        ...lifecycle,
        learnQueuedAt: new Date().toISOString(),
        learnQueuedKey: handledKey,
        role: runRole,
      },
    });
  }

  private async handleActiveRunCompletion(
    run: FrontierLifecycleRun,
    profile: CrawlSiteProfileRecord,
    finalSummary: {
      status: string;
      metadata: Record<string, unknown> | undefined;
      articleCount: number;
      pageCount: number;
      failedCount: number;
      duplicateCount: number;
    },
  ) {
    if (!this.frontierLlm) {
      return;
    }
    const runMetadata = isPlainObject(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};
    const learning = await this.frontierLlm.learnShadowProfile({
      orgId: run.orgId,
      run: {
        id: run.id,
        seedUrl: run.seedUrl,
        status: finalSummary.status,
        articleCount: finalSummary.articleCount,
        pageCount: finalSummary.pageCount,
        failedCount: finalSummary.failedCount,
        duplicateCount: finalSummary.duplicateCount,
        metadata: finalSummary.metadata ?? runMetadata,
      },
      profile,
      nodes: run.nodes.map((node) => ({
        url: node.url,
        pageType: node.pageType as CrawlFrontierPageType,
        status: node.status,
        score: node.score,
        freshnessScore: node.freshnessScore,
        metadata:
          node.metadata && isPlainObject(node.metadata)
            ? (node.metadata as Record<string, unknown>)
            : null,
      })),
    });

    let shadowProfile = await this.profiles.findShadowProfileForActiveProfile(
      run.orgId,
      profile.id,
    );
    if (learning?.profilePatch && learning.confidence >= 0.45) {
      shadowProfile = await this.profiles.upsertShadowProfileFromSuggestion({
        orgId: run.orgId,
        actorId: run.createdById,
        activeProfile: profile,
        suggestionConfidence: learning.confidence,
        suggestionReason: learning.rationale ?? null,
        suggestionPatch: learning.profilePatch,
        sourceRunId: run.id,
      });
    }

    const metadataPatch: Record<string, unknown> = {
      learningSnapshot: learning?.snapshot ?? null,
      shadowProfileId: shadowProfile?.id ?? null,
      shadowLearningConfidence: learning?.confidence ?? null,
      shadowLearningReason: learning?.rationale ?? null,
    };

    if (
      finalSummary.status === "completed" &&
      shadowProfile &&
      !asString(runMetadata.shadowEvaluationTriggeredAt)
    ) {
      const shadowRunId = await this.createRunFromProfile({
        orgId: run.orgId,
        actorId: run.createdById,
        seedUrl: run.seedUrl,
        profile: shadowProfile,
        executionMode: shadowProfile.executionMode,
        maxDepth: run.maxDepth,
        maxPages: run.maxPages,
        keywords: coerceStringArray(run.keywords) ?? [],
        runMetadata: {
          runRole: "shadow",
          originRunId: run.id,
          shadowProfileId: shadowProfile.id,
          shadowOfProfileId: profile.id,
          shadowEvaluationOfRunId: run.id,
          shadowEvaluationTriggeredByRunId: run.id,
        },
      });
      metadataPatch.shadowRunId = shadowRunId;
      metadataPatch.shadowEvaluationTriggeredAt = new Date().toISOString();
    }

    await this.updateRunMetadata(run.id, metadataPatch);
  }

  private async handleShadowRunCompletion(
    run: FrontierLifecycleRun,
    profile: CrawlSiteProfileRecord,
    finalSummary: {
      status: string;
      metadata: Record<string, unknown> | undefined;
      articleCount: number;
      pageCount: number;
      failedCount: number;
      duplicateCount: number;
    },
  ) {
    const runMetadata = isPlainObject(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};
    const originRunId = asString(runMetadata.originRunId);
    if (!originRunId) {
      return;
    }
    const originRun = await this.prisma.crawlFrontierRun.findUnique({
      where: { id: originRunId },
    });
    if (!originRun) {
      return;
    }
    const originMetadata = isPlainObject(originRun.metadata)
      ? (originRun.metadata as Record<string, unknown>)
      : {};
    const comparison = this.compareShadowRunAgainstOrigin({
      origin: {
        articleCount: originRun.articleCount,
        pageCount: originRun.pageCount,
        nodeCount: originRun.nodeCount,
        failedCount: originRun.failedCount,
        metadata: originMetadata,
      },
      shadow: {
        articleCount: finalSummary.articleCount,
        pageCount: finalSummary.pageCount,
        nodeCount: run.nodeCount,
        failedCount: finalSummary.failedCount,
        metadata: finalSummary.metadata ?? runMetadata,
      },
      thresholds: profile.config.llmAssist?.autoPublishThresholds,
    });

    const updatedShadowProfile = await this.profiles.recordShadowEvaluation({
      orgId: run.orgId,
      actorId: run.createdById,
      shadowProfileId: profile.id,
      originRunId,
      shadowRunId: run.id,
      passed: comparison.passed,
      metrics: comparison,
    });

    await this.updateRunMetadata(run.id, {
      shadowComparison: comparison,
      shadowComparisonAt: new Date().toISOString(),
    });

    const requiredPasses =
      updatedShadowProfile.config.llmAssist?.shadowEvaluationRuns ?? 3;
    const consecutivePasses =
      updatedShadowProfile.config.llmAssist?.shadow?.consecutivePasses ?? 0;
    const activeProfileId =
      updatedShadowProfile.config.llmAssist?.shadow?.shadowOfProfileId;
    if (comparison.passed && activeProfileId && consecutivePasses >= requiredPasses) {
      const published = await this.profiles.publishShadowProfile({
        orgId: run.orgId,
        actorId: run.createdById,
        activeProfileId,
        shadowProfileId: updatedShadowProfile.id,
        shadowRunId: run.id,
        comparison,
      });
      await this.updateRunMetadata(run.id, {
        shadowPublishedAt: new Date().toISOString(),
        shadowPublishedProfileId: published.activeProfile.id,
      });
    }
  }

  private compareShadowRunAgainstOrigin(options: {
    origin: {
      articleCount: number;
      pageCount: number;
      nodeCount: number;
      failedCount: number;
      metadata?: Record<string, unknown>;
    };
    shadow: {
      articleCount: number;
      pageCount: number;
      nodeCount: number;
      failedCount: number;
      metadata?: Record<string, unknown>;
    };
    thresholds?: {
      minArticleLift?: number;
      minNoiseReduction?: number;
      minJudgeConfidence?: number;
    };
  }) {
    const originNoise = Math.max(
      0,
      (options.origin.nodeCount || options.origin.pageCount) - options.origin.articleCount,
    );
    const shadowNoise = Math.max(
      0,
      (options.shadow.nodeCount || options.shadow.pageCount) - options.shadow.articleCount,
    );
    const articleLift =
      options.origin.articleCount > 0
        ? (options.shadow.articleCount - options.origin.articleCount) /
          options.origin.articleCount
        : options.shadow.articleCount > 0
          ? 1
          : 0;
    const noiseReduction =
      originNoise > 0 ? (originNoise - shadowNoise) / originNoise : 0;
    const judgeSummary = isPlainObject(options.shadow.metadata?.judgeSummary)
      ? (options.shadow.metadata?.judgeSummary as Record<string, unknown>)
      : undefined;
    const averageJudgeConfidence =
      typeof judgeSummary?.averageConfidence === "number"
        ? judgeSummary.averageConfidence
        : null;
    const thresholds = {
      minArticleLift: options.thresholds?.minArticleLift ?? 0.15,
      minNoiseReduction: options.thresholds?.minNoiseReduction ?? 0.2,
      minJudgeConfidence: options.thresholds?.minJudgeConfidence ?? 0.75,
    };
    const passed =
      options.shadow.articleCount >= options.origin.articleCount &&
      options.shadow.failedCount <= options.origin.failedCount &&
      (articleLift >= thresholds.minArticleLift ||
        noiseReduction >= thresholds.minNoiseReduction) &&
      (averageJudgeConfidence === null ||
        averageJudgeConfidence >= thresholds.minJudgeConfidence);
    return {
      passed,
      articleLift: Number(articleLift.toFixed(4)),
      noiseReduction: Number(noiseReduction.toFixed(4)),
      averageJudgeConfidence,
      summary: passed
        ? "shadow_profile_improved_frontier_quality"
        : "shadow_profile_below_publish_threshold",
      thresholds,
    };
  }

  private matchesRunQueryFilters(
    run: { executionMode: CrawlSiteExecutionMode; metadata?: Record<string, unknown> | null },
    query?: ListCrawlFrontierRunDto,
  ) {
    if (!query) {
      return true;
    }
    if (query.executionMode && run.executionMode !== query.executionMode) {
      return false;
    }
    const metadata = isPlainObject(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};
    const rootDiagnosis = isPlainObject(metadata.rootDiagnosis)
      ? (metadata.rootDiagnosis as Record<string, unknown>)
      : {};
    if (query.runRole) {
      const runRole =
        asString(metadata.runRole) ??
        (isPlainObject(metadata.llmLifecycle)
          ? asString((metadata.llmLifecycle as Record<string, unknown>).role)
          : undefined);
      if (runRole !== query.runRole) {
        return false;
      }
    }
    if (query.failureKind) {
      const failureKind =
        asString(metadata.failureKind) ?? asString(rootDiagnosis.failureKind);
      if (failureKind !== query.failureKind) {
        return false;
      }
    }
    if (query.warningFlag) {
      const warningFlags = collectNodeWarningFlags(metadata, null);
      if (!warningFlags.includes(query.warningFlag)) {
        return false;
      }
    }
    if (query.seedStrategy) {
      const seedStrategy =
        asString(metadata.seedStrategy) ?? asString(rootDiagnosis.seedStrategy);
      if (seedStrategy !== query.seedStrategy) {
        return false;
      }
    }
    return true;
  }

  private async requeueNodeRecord(
    node: {
      id: string;
      runId: string;
      queueClass: string;
      metadata: Prisma.JsonValue;
      run: {
        crawlTaskId: string | null;
      };
    },
    orgId: string,
  ) {
    if (!node.run.crawlTaskId) {
      throw new BadRequestException("Crawl frontier run is missing crawlTaskId");
    }
    const queuedAt = new Date();
    const workflowRunId = await this.resolveWorkflowRunId(node.runId);
    await this.prisma.crawlFrontierNode.update({
      where: { id: node.id },
      data: {
        status: "queued",
        lastError: null,
        rejectionReason: null,
        queuedAt,
        metadata: toPrismaJsonValue(
          mergeMetadataRecords(
            isPlainObject(node.metadata)
              ? (node.metadata as Record<string, unknown>)
              : undefined,
            {
              failureKind: null,
              warningFlags: [],
              retryQueuedAt: queuedAt.toISOString(),
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
    if (workflowRunId) {
      await this.strategyRecorder.appendEvent(workflowRunId, {
        level: "info",
        eventType: "frontier_node_requeued",
        nodeId: node.id,
        nodeType: "legacy.frontier_node",
        message: "Frontier node was requeued for another execution attempt",
        triggerReason: "manual_retry",
        beforeCount: 1,
        afterCount: 1,
        rescuedCount: 1,
        details: {
          queueClass: node.queueClass,
        },
        timestamp: queuedAt.toISOString(),
      });
      await this.strategyRecorder.markRunStatus(workflowRunId, {
        status: "queued",
        finishedAt: null,
      });
    }
  }

  private async buildRunAdminSummary(
    orgId: string,
    run: {
      id: string;
      lastError?: string | null;
      metadata?: Record<string, unknown> | null;
    },
    nodes: CrawlFrontierNodeRecord[],
  ) {
    const metadata = isPlainObject(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};
    const coverage = isPlainObject(metadata.coverage)
      ? (metadata.coverage as Record<string, unknown>)
      : {};
    const rootDiagnosis = isPlainObject(metadata.rootDiagnosis)
      ? (metadata.rootDiagnosis as Record<string, unknown>)
      : null;
    const llmLifecycle = isPlainObject(metadata.llmLifecycle)
      ? (metadata.llmLifecycle as Record<string, unknown>)
      : null;
    const shadowComparison = isPlainObject(metadata.shadowComparison)
      ? (metadata.shadowComparison as Record<string, unknown>)
      : null;
    const warningFlags = collectNodeWarningFlags(metadata, run.lastError ?? null);
    const pendingLlmJudgeJobs =
      typeof metadata.llmPendingJudgeJobs === "number"
        ? metadata.llmPendingJudgeJobs
        : resolvePendingLlmJudgeJobs(metadata);
    return {
      coverageByPageType:
        toNumericRecord(coverage.byPageType) ?? this.createPageTypeCountRecord(),
      coverageByDepth: toNumericRecord(coverage.byDepth) ?? {},
      candidateStats: toNumericRecord(metadata.candidateStats) ?? {},
      rejectionCounts: toNumericRecord(metadata.rejectionCounts) ?? {},
      judgeSummary: isPlainObject(metadata.judgeSummary)
        ? (metadata.judgeSummary as Record<string, unknown>)
        : {},
      warningFlags,
      failureKind:
        asString(metadata.failureKind) ?? asString(rootDiagnosis?.failureKind) ?? null,
      pendingLlmJudgeJobs,
      rootDiagnosis,
      seedSummary: {
        strategy:
          asString(metadata.seedStrategy) ?? asString(rootDiagnosis?.seedStrategy) ?? null,
        origin:
          asString(metadata.seedOrigin) ?? asString(rootDiagnosis?.seedOrigin) ?? null,
        method:
          asString(metadata.seedMethod) ?? asString(rootDiagnosis?.seedMethod) ?? null,
        discoveryMode:
          asString(metadata.seedDiscoveryMode) ??
          asString(rootDiagnosis?.seedDiscoveryMode) ??
          null,
        fallbackStage:
          asString(metadata.fallbackStage) ?? asString(rootDiagnosis?.fallbackStage) ?? null,
        yield: isPlainObject(metadata.seedYield)
          ? metadata.seedYield
          : isPlainObject(rootDiagnosis?.seedYield)
            ? rootDiagnosis?.seedYield
            : null,
        quality: isPlainObject(metadata.seedQuality)
          ? metadata.seedQuality
          : isPlainObject(rootDiagnosis?.seedQuality)
            ? rootDiagnosis?.seedQuality
            : null,
        diagnostics: isPlainObject(metadata.seedDiagnostics)
          ? metadata.seedDiagnostics
          : isPlainObject(rootDiagnosis?.seedDiagnostics)
            ? rootDiagnosis?.seedDiagnostics
            : null,
      },
      llmSummary: {
        pendingJudgeJobs: pendingLlmJudgeJobs,
        runRole:
          asString(metadata.runRole) ??
          (llmLifecycle ? asString(llmLifecycle.role) : null) ??
          null,
        llmAssist: isPlainObject(metadata.llmAssist) ? metadata.llmAssist : null,
        judgeSummary: isPlainObject(metadata.judgeSummary)
          ? metadata.judgeSummary
          : null,
        lifecycle: llmLifecycle,
      },
      shadowSummary: {
        profileId: asString(metadata.shadowProfileId) ?? null,
        shadowRunId: asString(metadata.shadowRunId) ?? null,
        comparison: shadowComparison,
        publishedProfileId: asString(metadata.shadowPublishedProfileId) ?? null,
      },
      repairSummary: await this.buildRunRepairSummary(orgId, nodes),
      trace: this.buildRunTrace(metadata, warningFlags),
    };
  }

  private async buildRunRepairSummary(
    orgId: string,
    nodes: CrawlFrontierNodeRecord[],
  ) {
    const crawlResultIds = Array.from(
      new Set(
        nodes
          .map((node) => node.crawlResultId)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    );
    if (crawlResultIds.length === 0) {
      return null;
    }
    const crawlResults = await this.prisma.crawlResult.findMany({
      where: {
        orgId,
        id: {
          in: crawlResultIds,
        },
      },
      select: {
        id: true,
        contentHash: true,
      },
    });
    const contentHashes = Array.from(
      new Set(crawlResults.map((result) => result.contentHash).filter(Boolean)),
    );
    if (contentHashes.length === 0) {
      return null;
    }
    const articles = await this.prisma.article.findMany({
      where: {
        orgId,
        contentHash: {
          in: contentHashes,
        },
      },
      select: {
        contentHash: true,
        metadata: true,
      },
    });
    const repairedFieldCounts: Record<string, number> = {};
    const missingFieldCounts: Record<string, number> = {};
    const errorCounts: Record<string, number> = {};
    const modelCounts: Record<string, number> = {};
    const available = articles.length;
    let attempted = 0;
    let applied = 0;
    let failed = 0;
    for (const article of articles) {
      const metadata = article.metadata && isPlainObject(article.metadata)
        ? (article.metadata as Record<string, unknown>)
        : undefined;
      const llmRepair = metadata?.llmRepair;
      if (!isPlainObject(llmRepair)) {
        continue;
      }
      attempted += 1;
      if (asString(llmRepair.model)) {
        bumpCount(modelCounts, asString(llmRepair.model)!);
      }
      if (asBoolean(llmRepair.applied)) {
        applied += 1;
      }
      if (asString(llmRepair.error)) {
        failed += 1;
        bumpCount(errorCounts, asString(llmRepair.error)!);
      }
      for (const field of coerceStringArray(llmRepair.missingFields) ?? []) {
        bumpCount(missingFieldCounts, field);
      }
      for (const field of coerceStringArray(llmRepair.repairedFields) ?? []) {
        bumpCount(repairedFieldCounts, field);
      }
    }
    return {
      available,
      attempted,
      applied,
      failed,
      untouched: Math.max(0, available - attempted),
      missingFields: missingFieldCounts,
      repairedFields: repairedFieldCounts,
      errors: errorCounts,
      models: modelCounts,
    };
  }

  private buildNodeRepairSummary(
    articleMetadata?: Record<string, unknown> | null,
  ) {
    const llmRepair =
      articleMetadata && isPlainObject(articleMetadata.llmRepair)
        ? (articleMetadata.llmRepair as Record<string, unknown>)
        : null;
    if (!llmRepair) {
      return null;
    }

    return {
      available: true,
      attempted: true,
      applied: asBoolean(llmRepair.applied) ?? false,
      source: asString(llmRepair.source) ?? null,
      model: asString(llmRepair.model) ?? null,
      error: asString(llmRepair.error) ?? null,
      missingFields: coerceStringArray(llmRepair.missingFields) ?? [],
      repairedFields: coerceStringArray(llmRepair.repairedFields) ?? [],
      promptTokens: toFiniteNumber(llmRepair.promptTokens),
      completionTokens: toFiniteNumber(llmRepair.completionTokens),
      totalTokens: toFiniteNumber(llmRepair.totalTokens),
      costUsd: toFiniteNumber(llmRepair.costUsd),
      latencyMs: toFiniteNumber(llmRepair.latencyMs),
    };
  }

  private buildNodeExtractionSummary(options: {
    article:
      | ({
          metadata?: Prisma.JsonValue | null;
        } & Record<string, unknown>)
      | null
      | undefined;
    processedArticle:
      | ({
          status?: string | null;
          title?: string | null;
          subtitle?: string | null;
          author?: string | null;
          source?: string | null;
          publishedAt?: Date | null;
          category?: string | null;
          qualityScore?: number | null;
          llmModel?: string | null;
          removedNoiseTypes?: unknown;
        } & Record<string, unknown>)
      | null
      | undefined;
  }) {
    const extractedFields = new Set<string>();
    const missingFields = new Set<string>();
    const processed = options.processedArticle;

    if (processed?.title) extractedFields.add("title");
    else missingFields.add("title");
    if (processed?.subtitle) extractedFields.add("subtitle");
    if (processed?.author) extractedFields.add("author");
    else missingFields.add("author");
    if (processed?.source) extractedFields.add("source");
    else missingFields.add("source");
    if (processed?.publishedAt) extractedFields.add("published_at");
    else missingFields.add("published_at");
    if (processed?.category) extractedFields.add("category");

    return {
      hasArticle: Boolean(options.article),
      hasProcessedArticle: Boolean(processed),
      processedStatus: processed?.status ?? null,
      qualityScore: processed?.qualityScore ?? null,
      llmModel: processed?.llmModel ?? null,
      extractedFields: Array.from(extractedFields),
      missingFields: Array.from(missingFields),
      removedNoiseTypes: coerceStringArray(processed?.removedNoiseTypes) ?? [],
    };
  }

  private buildRunTrace(
    metadata: Record<string, unknown>,
    warningFlags: string[],
  ) {
    const rootDiagnosis = isPlainObject(metadata.rootDiagnosis)
      ? (metadata.rootDiagnosis as Record<string, unknown>)
      : {};
    const judgeSummary = isPlainObject(metadata.judgeSummary)
      ? (metadata.judgeSummary as Record<string, unknown>)
      : {};
    const llmLifecycle = isPlainObject(metadata.llmLifecycle)
      ? (metadata.llmLifecycle as Record<string, unknown>)
      : {};
    const judgeCount = toFiniteNumber(judgeSummary.count) ?? 0;
    const pendingLlmJudgeJobs =
      typeof metadata.llmPendingJudgeJobs === "number"
        ? metadata.llmPendingJudgeJobs
        : resolvePendingLlmJudgeJobs(metadata);
    const nativeStrategyType =
      asString(rootDiagnosis.nativeStrategyType) ??
      asString(metadata.nativeStrategyType);
    const steps = [
      {
        key: "seed",
        label: "Seed",
        status: asString(metadata.seedMethod) || asString(rootDiagnosis.seedMethod)
          ? "completed"
          : asString(metadata.fallbackStage) === "frontier"
            ? "warning"
            : "skipped",
        detail:
          asString(metadata.seedMethod) ??
          asString(rootDiagnosis.seedMethod) ??
          asString(metadata.seedStrategy) ??
          "seed_not_used",
        tags: uniqueStringList(
          asString(metadata.seedStrategy) ? [`strategy:${metadata.seedStrategy}`] : undefined,
          asString(metadata.seedMethod) ? [`method:${metadata.seedMethod}`] : undefined,
          asString(metadata.fallbackStage)
            ? [`fallback:${metadata.fallbackStage}`]
            : undefined,
        ) ?? [],
      },
      {
        key: "topology",
        label: "Topology",
        status:
          asString(rootDiagnosis.linkPreviewMode) ||
          asString(rootDiagnosis.domScopeMode) ||
          asString(rootDiagnosis.waitForMode)
            ? "completed"
            : "skipped",
        detail:
          asString(rootDiagnosis.linkPreviewQuery) ??
          asString(rootDiagnosis.linkPreviewMode) ??
          "topology_not_applied",
        tags: uniqueStringList(
          asString(rootDiagnosis.linkPreviewMode)
            ? [`preview:${rootDiagnosis.linkPreviewMode}`]
            : undefined,
          asString(rootDiagnosis.domScopeMode)
            ? [`dom:${rootDiagnosis.domScopeMode}`]
            : undefined,
          asString(rootDiagnosis.waitForMode)
            ? [`wait:${rootDiagnosis.waitForMode}`]
            : undefined,
        ) ?? [],
      },
      {
        key: "frontier",
        label: "Frontier",
        status:
          isPlainObject(metadata.candidateStats) ||
          isPlainObject(metadata.rejectionCounts)
            ? "completed"
            : "skipped",
        detail:
          asString(metadata.failureKind) ??
          asString(rootDiagnosis.failureKind) ??
          "frontier_candidates_processed",
        tags: warningFlags,
      },
      {
        key: "native",
        label: "Native / Fallback",
        status: nativeStrategyType
          ? warningFlags.includes("native_fallback_layered")
            ? "warning"
            : "completed"
          : "skipped",
        detail: nativeStrategyType ?? "native_not_used",
        tags: uniqueStringList(
          nativeStrategyType ? [`strategy:${nativeStrategyType}`] : undefined,
          asString(rootDiagnosis.nativeFilterChainType)
            ? [`filter:${rootDiagnosis.nativeFilterChainType}`]
            : undefined,
          asString(rootDiagnosis.nativeUrlScorerType)
            ? [`scorer:${rootDiagnosis.nativeUrlScorerType}`]
            : undefined,
        ) ?? [],
      },
      {
        key: "llm_judge",
        label: "LLM Judge",
        status:
          pendingLlmJudgeJobs > 0
            ? "active"
            : warningFlags.some((flag) => flag.startsWith("llm_judge"))
              ? "warning"
              : judgeCount > 0
                ? "completed"
                : "skipped",
        detail:
          pendingLlmJudgeJobs > 0
            ? `${pendingLlmJudgeJobs} pending`
            : judgeCount > 0
              ? `${judgeCount} judged`
              : "judge_not_used",
        tags: uniqueStringList(
          warningFlags.filter((flag) => flag.startsWith("llm_judge")),
          pendingLlmJudgeJobs > 0 ? [`pending:${pendingLlmJudgeJobs}`] : undefined,
        ) ?? [],
      },
      {
        key: "shadow_learn",
        label: "Shadow Learn",
        status:
          isPlainObject(metadata.shadowComparison)
            ? "completed"
            : asString(llmLifecycle.learnQueuedAt)
              ? "active"
              : "skipped",
        detail:
          asString((metadata.shadowComparison as Record<string, unknown> | undefined)?.summary) ??
          asString(llmLifecycle.learnQueuedAt) ??
          "shadow_learning_not_triggered",
        tags: uniqueStringList(
          asString(metadata.shadowProfileId) ? [`shadow:${metadata.shadowProfileId}`] : undefined,
          asString(metadata.shadowPublishedProfileId)
            ? [`published:${metadata.shadowPublishedProfileId}`]
            : undefined,
        ) ?? [],
      },
    ];
    return steps;
  }

  private buildLlmLogFilters(options: {
    runId: string;
    nodeId?: string;
    profileId?: string | null;
    includeRepair?: boolean;
  }) {
    const shared = {
      ...(options.profileId ? { profileId: options.profileId } : {}),
      runId: options.runId,
    };
    return {
      judge: {
        ...shared,
        ...(options.nodeId ? { nodeId: options.nodeId } : {}),
        feature: "crawl_frontier_judge",
      },
      learn: {
        ...shared,
        feature: "crawl_frontier_learn",
      },
      repair: options.includeRepair
        ? {
            ...shared,
            ...(options.nodeId ? { nodeId: options.nodeId } : {}),
            feature: "crawl_article_repair",
          }
        : undefined,
    };
  }

  private async createWorkflowRunForFrontier(options: {
    orgId: string;
    actorId: string;
    frontierRunId: string;
    seedUrl: string;
    profile: CrawlSiteProfileRecord;
    executionMode: CrawlSiteExecutionMode;
    maxDepth: number;
    maxPages: number;
    keywords?: string[];
  }) {
    let workflowId = options.profile.workflowId ?? null;
    let workflowVersionId = options.profile.workflowVersionId ?? null;
    let workflowOrigin: CrawlStrategyWorkflowOrigin = "bound";
    let definition: CrawlStrategyWorkflowDefinition;
    let parameterSources: CrawlStrategyParameterSource[] = [];

    const resolved =
      workflowId || workflowVersionId
        ? await this.strategyWorkflows.resolveBoundWorkflowVersion({
            orgId: options.orgId,
            workflowId,
            workflowVersionId,
            workflowBindingMode: options.profile.workflowBindingMode,
          })
        : null;
    if (resolved) {
      workflowId = resolved.workflow.id;
      workflowVersionId = resolved.version.id;
      definition = resolved.definition;
      const overlay = await this.strategyWorkflows.compileProfileOverlay({
        orgId: options.orgId,
        baseExecutionMode: options.profile.executionMode,
        baseConfig: options.profile.config,
        workflowId,
        workflowVersionId,
        workflowBindingMode: options.profile.workflowBindingMode,
      });
      parameterSources = overlay?.parameterSources ?? [];
    } else {
      workflowOrigin = "legacy_bridge";
      definition = this.strategyWorkflows.buildLegacyProfileDefinition(
        options.profile,
        options.seedUrl,
      );
      parameterSources = [
        {
          key: "legacy_profile_bridge",
          value: {
            profileId: options.profile.id,
            profileVersion: options.profile.version,
          },
          source: "legacy_profile",
        },
      ];
    }

    const workflowRun = await this.strategyRecorder.createRun({
      orgId: options.orgId,
      createdById: options.actorId,
      workflowId,
      workflowVersionId,
      workflowOrigin,
      profileId: options.profile.id,
      frontierRunId: options.frontierRunId,
      status: "queued",
      runKind: CrawlStrategyWorkflowRunKind.FrontierRun,
      input: {
        frontierRunId: options.frontierRunId,
        seedUrl: options.seedUrl,
        profileId: options.profile.id,
        executionMode: options.executionMode,
        maxDepth: options.maxDepth,
        maxPages: options.maxPages,
        keywords: options.keywords ?? [],
      },
      graphSnapshot: definition,
      parameterSources,
    });

    return {
      id: workflowRun.id,
      workflowOrigin,
      definition,
    };
  }

  private async recordCrawl4aiSystemEvents(
    workflowRunId: string | null | undefined,
    node: Pick<CrawlFrontierNodeRecord, "id" | "url" | "pageType">,
    events: Crawl4aiResponse["systemEvents"],
  ) {
    if (!workflowRunId || !events || events.length === 0) {
      return;
    }
    for (const event of events) {
      await this.strategyRecorder.appendEvent(workflowRunId, {
        level: event.level,
        eventType: event.eventType,
        nodeId: node.id,
        nodeType: "legacy.crawl4ai",
        message: event.message,
        triggerReason: event.triggerReason ?? null,
        beforeCount: event.beforeCount ?? null,
        afterCount: event.afterCount ?? null,
        rescuedCount: event.rescuedCount ?? null,
        details: {
          url: node.url,
          pageType: node.pageType,
          ...(event.details ?? {}),
        },
        timestamp: event.timestamp,
      });
    }
  }

  private async resolveWorkflowRunId(runId: string): Promise<string | null> {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id: runId },
      select: {
        workflowRunId: true,
      },
    });
    return run?.workflowRunId ?? null;
  }

  private async recordCandidateDecision(options: {
    workflowRunId?: string | null;
    sourceNodeId: string;
    candidate: FrontierTraceCandidate;
    nodeId: string;
    nodeType: string;
    action:
      | "discovered"
      | "filtered"
      | "scored"
      | "branched"
      | "budgeted"
      | "fallback"
      | "persisted";
    message: string;
    status: "active" | "selected" | "rejected";
    accepted?: boolean;
    rejectedReason?: string | null;
    ruleHits?: string[];
    beforeSnapshot?: Record<string, unknown>;
    afterSnapshot?: Record<string, unknown>;
    scoreDelta?: number;
    freshnessDelta?: number;
    details?: Record<string, unknown>;
  }) {
    await this.layeredExecutor.recordCandidateDecision(options);
  }

  private async updateRunMetadata(runId: string, patch: Record<string, unknown>) {
    const run = await this.prisma.crawlFrontierRun.findUnique({
      where: { id: runId },
      select: { metadata: true },
    });
    const existing = run?.metadata && isPlainObject(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : undefined;
    await this.prisma.crawlFrontierRun.update({
      where: { id: runId },
      data: {
        metadata: toPrismaJsonValue(mergeMetadataRecords(existing, patch)),
      },
      });
  }

  private async recordExtractionCandidateDecisions(options: {
    workflowRunId?: string | null;
    sourceNodeId: string;
    decisions: FrontierCandidateDecision[];
  }) {
    await this.layeredExecutor.recordExtractionCandidateDecisions(options);
  }

  private async recordNodeCompletion(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, "id" | "url" | "pageType">;
    stepKey: string;
    workflowNodeId: string;
    workflowNodeType: string;
    label: string;
    durationMs: number;
    outputUrls: string[];
    outputCount?: number;
    rejectedCount: number;
    metrics: Record<string, unknown>;
  }) {
    await this.rootExecutor.recordNodeCompletion(options);
  }

  private async updateNodeMetadata(
    nodeId: string,
    patch:
      | Record<string, unknown>
      | ((
          existing: Record<string, unknown> | undefined,
        ) => Record<string, unknown> | undefined),
  ) {
    const node = await this.prisma.crawlFrontierNode.findUnique({
      where: { id: nodeId },
      select: { metadata: true },
    });
    const existing = node?.metadata && isPlainObject(node.metadata)
      ? (node.metadata as Record<string, unknown>)
      : undefined;
    const resolvedPatch =
      typeof patch === "function" ? patch(existing) : patch;
    await this.prisma.crawlFrontierNode.update({
      where: { id: nodeId },
      data: {
        metadata: toPrismaJsonValue(mergeMetadataRecords(existing, resolvedPatch)),
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
