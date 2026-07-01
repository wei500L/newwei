import { Injectable } from '@nestjs/common';

import { classifyFrontierFailureKind } from './crawl-frontier.utils';
import { CrawlStrategyLayeredExecutorService, type CrawlStrategyLayeredTraceCandidate } from './crawl-strategy-layered-executor.service';
import { CrawlStrategyRunRecorderService } from './crawl-strategy-run-recorder.service';
import type {
  CrawlFrontierNodeRecord,
  CrawlFrontierPageType,
  CrawlSeedDiscoveryConfig,
  CrawlSeedStrategy,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from './crawl.types';

export interface CrawlStrategyRootSeedDiscoveryOutcome {
  created: number;
  selectedPageTypeCounts: Record<CrawlFrontierPageType, number>;
  diagnostics: Record<string, unknown>;
}

export interface CrawlStrategyResolvedSeedDiscoveryConfig
  extends Required<
    Pick<
      CrawlSeedDiscoveryConfig,
      | 'mode'
      | 'freshnessWindowHours'
      | 'maxSeedUrls'
      | 'topologyBudgetPages'
      | 'topologyBudgetDepth'
    >
  > {
  qualityThresholds: Required<
    NonNullable<CrawlSeedDiscoveryConfig['qualityThresholds']>
  >;
}

export interface CrawlStrategyRootSeedPlan {
  seedStrategy: CrawlSeedStrategy;
  seedConfig: CrawlStrategyResolvedSeedDiscoveryConfig;
  topologyBudgetDepth?: number;
  topologyBudgetPages?: number;
  topologyMetadataPatch?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function collectNodeWarningFlags(
  metadata: Record<string, unknown> | null | undefined,
  lastError?: string | null,
): string[] {
  const failureKind =
    typeof metadata?.failureKind === 'string' && metadata.failureKind.trim().length > 0
      ? metadata.failureKind.trim()
      : classifyFrontierFailureKind(lastError);
  return (
    uniqueStringList(
      coerceStringArray(metadata?.warningFlags),
      asBoolean(metadata?.llmJudgeEnabled) &&
        asBoolean(metadata?.llmJudgeAttempted) &&
        asBoolean(metadata?.llmJudgeParsed) === false
        ? ['llm_judge_parse_failed']
        : undefined,
      asBoolean(metadata?.llmJudgeEnabled) &&
        asBoolean(metadata?.llmJudgeAttempted) &&
        Boolean(asString(metadata?.llmJudgeError))
        ? ['llm_judge_failed']
        : undefined,
      failureKind ? [failureKind] : undefined,
    ) ?? []
  );
}

@Injectable()
export class CrawlStrategyRootExecutorService {
  constructor(
    private readonly layeredExecutor: CrawlStrategyLayeredExecutorService,
    private readonly strategyRecorder: CrawlStrategyRunRecorderService,
  ) {}

  resolveSeedStrategy(config: CrawlSiteProfileConfig): CrawlSeedStrategy {
    return config.seedDiscovery?.strategy ?? 'auto';
  }

  resolveSeedDiscoveryConfig(
    config: CrawlSiteProfileConfig,
    maxPages: number,
    maxDepth: number,
  ): CrawlStrategyResolvedSeedDiscoveryConfig {
    return {
      mode: config.seedDiscovery?.mode ?? 'robots',
      freshnessWindowHours: Math.max(
        1,
        config.seedDiscovery?.freshnessWindowHours ?? 24 * 7,
      ),
      maxSeedUrls: Math.max(1, config.seedDiscovery?.maxSeedUrls ?? Math.min(120, maxPages)),
      topologyBudgetPages: Math.max(
        1,
        config.seedDiscovery?.topologyBudgetPages ?? Math.min(12, maxPages),
      ),
      topologyBudgetDepth: Math.max(
        1,
        config.seedDiscovery?.topologyBudgetDepth ?? Math.min(2, maxDepth),
      ),
      qualityThresholds: {
        minCandidates: config.seedDiscovery?.qualityThresholds?.minCandidates ?? 3,
        minArticleRatio:
          config.seedDiscovery?.qualityThresholds?.minArticleRatio ?? 0.4,
        maxNoiseRatio:
          config.seedDiscovery?.qualityThresholds?.maxNoiseRatio ?? 0.45,
        minFreshRatio: config.seedDiscovery?.qualityThresholds?.minFreshRatio ?? 0.2,
      },
    };
  }

  resolveRootSeedPlan(options: {
    nodeDepth: number;
    profile: CrawlSiteProfileRecord;
    maxPages: number;
    maxDepth: number;
  }): CrawlStrategyRootSeedPlan {
    const seedStrategy = this.resolveSeedStrategy(options.profile.config);
    const seedConfig = this.resolveSeedDiscoveryConfig(
      options.profile.config,
      options.maxPages,
      options.maxDepth,
    );
    const enableTopologyBudget =
      options.nodeDepth === 0 &&
      seedStrategy !== 'frontier_only' &&
      seedStrategy !== 'frontier_first';
    return {
      seedStrategy,
      seedConfig,
      topologyBudgetDepth: enableTopologyBudget
        ? seedConfig.topologyBudgetDepth
        : undefined,
      topologyBudgetPages: enableTopologyBudget
        ? seedConfig.topologyBudgetPages
        : undefined,
      topologyMetadataPatch: enableTopologyBudget
        ? {
            topologyChannel: true,
            topologyDepthLimit: seedConfig.topologyBudgetDepth,
          }
        : undefined,
    };
  }

  async executeRootSeedBranch(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, 'id' | 'depth' | 'pageType'>;
    seedStrategy: CrawlSeedStrategy;
    discoverSeedBranch: () => Promise<CrawlStrategyRootSeedDiscoveryOutcome | undefined>;
  }): Promise<CrawlStrategyRootSeedDiscoveryOutcome | undefined> {
    const seedDiscovery = await options.discoverSeedBranch();
    await this.recordRootSeedBranchEvent({
      workflowRunId: options.workflowRunId,
      node: options.node,
      seedStrategy: options.seedStrategy,
      seedDiscovery,
    });
    return seedDiscovery;
  }

  buildRootBranchSummary(options: {
    nodeMetadata?: Record<string, unknown> | null;
    lastError?: string | null;
    runtimeMetadata?: Record<string, unknown> | null;
    branchMetadata?: Record<string, unknown> | undefined;
    seedDiscovery?: CrawlStrategyRootSeedDiscoveryOutcome;
    extraWarningFlags?: string[];
    seedPlan: CrawlStrategyRootSeedPlan;
  }) {
    const diagnostics = isPlainObject(options.seedDiscovery?.diagnostics)
      ? options.seedDiscovery.diagnostics
      : {};
    const combinedWarningFlags =
      uniqueStringList(
        collectNodeWarningFlags(options.nodeMetadata, options.lastError),
        coerceStringArray(options.runtimeMetadata?.warningFlags),
        options.extraWarningFlags,
        coerceStringArray(options.branchMetadata?.warningFlags),
        coerceStringArray(diagnostics.warningFlags),
      ) ?? [];
    const pendingLlmJudgeJobs =
      clampInt(options.branchMetadata?.llmJudgeDeferredCount, 0, 10, 0) +
      clampInt(diagnostics.llmJudgeDeferredCount, 0, 10, 0);
    const llmJudgeDeferredModes =
      uniqueStringList(
        typeof options.branchMetadata?.llmJudgeDeferredMode === 'string'
          ? [options.branchMetadata.llmJudgeDeferredMode]
          : undefined,
        typeof diagnostics.llmJudgeDeferredMode === 'string'
          ? [diagnostics.llmJudgeDeferredMode]
          : undefined,
      ) ?? [];
    return {
      combinedWarningFlags,
      pendingLlmJudgeJobs,
      llmJudgeDeferredModes,
      metadataPatch: {
        warningFlags: combinedWarningFlags,
        pendingLlmJudgeJobs,
        llmJudgeDeferredModes,
        seedStrategy: options.seedPlan.seedStrategy,
        topologyBudgetPages: options.seedPlan.topologyBudgetPages ?? null,
        topologyBudgetDepth: options.seedPlan.topologyBudgetDepth ?? null,
      },
    };
  }

  async recordRootSeedBranchEvent(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, 'id' | 'depth' | 'pageType'>;
    seedStrategy: CrawlSeedStrategy;
    seedDiscovery?: CrawlStrategyRootSeedDiscoveryOutcome;
  }) {
    if (!options.workflowRunId || options.node.depth !== 0) {
      return;
    }

    if (options.seedStrategy === 'frontier_only' || !options.seedDiscovery) {
      await this.strategyRecorder.appendEvent(options.workflowRunId, {
        level: 'info',
        eventType: 'seed_branch_skipped',
        nodeId: options.node.id,
        nodeType: 'branch',
        message: 'Seed branch was skipped for this root execution',
        triggerReason:
          options.seedStrategy === 'frontier_only'
            ? 'frontier_only'
            : 'seed_branch_unavailable',
        beforeCount: 0,
        afterCount: 0,
        rescuedCount: 0,
        details: {
          seedStrategy: options.seedStrategy,
          pageType: options.node.pageType,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const diagnostics = isPlainObject(options.seedDiscovery.diagnostics)
      ? options.seedDiscovery.diagnostics
      : {};
    const candidateStats =
      isPlainObject(diagnostics.candidateStats) ? diagnostics.candidateStats : undefined;
    const seedYield = isPlainObject(diagnostics.seedYield)
      ? diagnostics.seedYield
      : undefined;
    const beforeCount =
      toFiniteNumber(candidateStats?.accepted) ??
      toFiniteNumber(seedYield?.selected) ??
      0;
    const afterCount = options.seedDiscovery.created;
    const fallbackStage =
      typeof diagnostics.fallbackStage === 'string' ? diagnostics.fallbackStage : null;

    await this.strategyRecorder.appendEvent(options.workflowRunId, {
      level: afterCount > 0 ? 'info' : 'warn',
      eventType: 'seed_branch_completed',
      nodeId: options.node.id,
      nodeType: 'branch',
      message:
        afterCount > 0
          ? 'Seed branch materialized frontier candidates'
          : 'Seed branch did not materialize frontier candidates',
      triggerReason:
        fallbackStage === 'seed'
          ? 'seed_selected'
          : fallbackStage === 'frontier'
            ? 'seed_to_frontier'
            : options.seedStrategy,
      beforeCount,
      afterCount,
      rescuedCount: fallbackStage === 'seed' ? afterCount : 0,
      details: {
        seedStrategy: options.seedStrategy,
        fallbackStage,
        seedQuality: isPlainObject(diagnostics.seedQuality)
          ? diagnostics.seedQuality
          : null,
        seedDiscoveryMode:
          typeof diagnostics.seedDiscoveryMode === 'string'
            ? diagnostics.seedDiscoveryMode
            : null,
      },
      timestamp: new Date().toISOString(),
    });
  }

  async recordNativeFallbackExecution(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, 'id'>;
    acceptedCount: number;
    createdCount: number;
    minAcceptedResults: number;
    minArticleResults: number;
    nativeAcceptedArticles: number;
    fallbackDiscoveryMetadata?: Record<string, unknown>;
    triggerReason: string;
  }) {
    if (!options.workflowRunId || !options.fallbackDiscoveryMetadata) {
      return;
    }

    const candidateStats =
      isPlainObject(options.fallbackDiscoveryMetadata.candidateStats)
        ? options.fallbackDiscoveryMetadata.candidateStats
        : undefined;
    const rejectionCounts =
      isPlainObject(options.fallbackDiscoveryMetadata.rejectionCounts)
        ? options.fallbackDiscoveryMetadata.rejectionCounts
        : undefined;
    const fallbackSelected = toFiniteNumber(candidateStats?.selected) ?? 0;
    const fallbackRejected = toFiniteNumber(candidateStats?.rejected) ?? 0;
    await this.strategyRecorder.upsertStep(options.workflowRunId, {
      stepKey: `frontier:${options.node.id}:native-fallback`,
      nodeId: `legacy::native-fallback:${options.node.id}`,
      nodeType: 'fallback-strategy',
      label: 'Layered fallback for native root discovery',
      status: fallbackSelected > 0 ? 'completed' : 'failed',
      durationMs: 0,
      inputCount: 1,
      outputCount: fallbackSelected,
      rejectedCount: fallbackRejected,
      sampleUrls: [],
      metrics: {
        triggerReason: options.triggerReason,
        candidateStats: candidateStats ?? null,
        rejectionCounts: rejectionCounts ?? null,
      },
      error: fallbackSelected > 0 ? null : options.triggerReason,
    });
    await this.strategyRecorder.appendEvent(options.workflowRunId, {
      level: 'warn',
      eventType: 'native_to_layered_fallback',
      nodeId: options.node.id,
      nodeType: 'fallback-strategy',
      message: 'Native root discovery fell back to layered discovery',
      triggerReason: options.triggerReason,
      beforeCount: options.acceptedCount,
      afterCount: options.acceptedCount + fallbackSelected,
      rescuedCount: fallbackSelected,
      details: {
        minAcceptedResults: options.minAcceptedResults,
        minArticleResults: options.minArticleResults,
        nativeAcceptedResults: options.acceptedCount,
        nativeSelectedResults: options.createdCount,
        nativeAcceptedArticles: options.nativeAcceptedArticles,
        candidateStats: candidateStats ?? null,
        rejectionCounts: rejectionCounts ?? null,
      },
      timestamp: new Date().toISOString(),
    });
  }

  async recordQueuedLlmCandidateDecisions(options: {
    workflowRunId: string;
    node: Pick<CrawlFrontierNodeRecord, 'id'>;
    mode: 'discovery' | 'seed';
    candidates: CrawlStrategyLayeredTraceCandidate[];
    queuedAt: string;
  }) {
    for (const candidate of options.candidates) {
      const activeSnapshot = this.buildCandidateTraceSnapshot({
        ...candidate,
        status: 'active',
        rejectedReason: null,
      });
      await this.layeredExecutor.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate,
        nodeId: options.node.id,
        nodeType: 'branch',
        action: 'branched',
        message: `Deferred ${options.mode} candidate to the LLM judge queue`,
        status: 'active',
        accepted: true,
        ruleHits: ['llm_judge_deferred'],
        beforeSnapshot: activeSnapshot,
        afterSnapshot: activeSnapshot,
        details: {
          mode: options.mode,
          queuedAt: options.queuedAt,
        },
      });
    }
  }

  async recordResolvedLlmCandidateDecisions(options: {
    workflowRunId: string;
    node: Pick<CrawlFrontierNodeRecord, 'id'>;
    mode: 'discovery' | 'seed';
    inputCandidates: CrawlStrategyLayeredTraceCandidate[];
    resolvedCandidates: CrawlStrategyLayeredTraceCandidate[];
    llmDiagnostics?: Record<string, unknown>;
  }) {
    const resolvedByUrl = new Map(
      options.resolvedCandidates.map((candidate) => [candidate.url, candidate] as const),
    );
    const decisions = Array.isArray(options.llmDiagnostics?.llmJudgeDecisions)
      ? options.llmDiagnostics.llmJudgeDecisions.filter(
          (entry): entry is Record<string, unknown> => isPlainObject(entry),
        )
      : [];
    const decisionByUrl = new Map(
      decisions
        .map((entry) => {
          const url = asString(entry.url);
          return url ? ([url, entry] as const) : null;
        })
        .filter((entry): entry is readonly [string, Record<string, unknown>] => Boolean(entry)),
    );
    const llmError = asString(options.llmDiagnostics?.llmJudgeError);
    const llmParsed = asBoolean(options.llmDiagnostics?.llmJudgeParsed);

    for (const candidate of options.inputCandidates) {
      const resolvedCandidate = resolvedByUrl.get(candidate.url);
      const decision = decisionByUrl.get(candidate.url);
      const beforeSnapshot = this.buildCandidateTraceSnapshot({
        ...candidate,
        status: 'active',
        rejectedReason: null,
      });

      if (!resolvedCandidate) {
        const dropReason =
          decision && asBoolean(decision.appliedDrop)
            ? 'llm_judge_drop'
            : 'llm_candidate_removed';
        await this.layeredExecutor.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'branch',
          action: 'branched',
          message: 'LLM judge dropped candidate from the branch',
          status: 'rejected',
          accepted: false,
          rejectedReason: dropReason,
          ruleHits: ['llm_judge_resolved', dropReason],
          beforeSnapshot,
          afterSnapshot: this.buildCandidateTraceSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: dropReason,
          }),
          details: {
            mode: options.mode,
            action: asString(decision?.action) ?? 'drop',
            confidence: toFiniteNumber(decision?.confidence),
            reason: asString(decision?.reason) ?? null,
          },
        });
        continue;
      }

      const afterSnapshot = this.buildCandidateTraceSnapshot({
        ...resolvedCandidate,
        status: 'active',
        rejectedReason: null,
      });
      const ruleHits = ['llm_judge_resolved'];
      const decisionAction = asString(decision?.action);
      if (llmError) {
        ruleHits.push('llm_judge_failed');
      } else if (decisionAction) {
        ruleHits.push(`llm_action:${decisionAction}`);
      } else {
        ruleHits.push(llmParsed ? 'llm_judge_kept' : 'llm_judge_passthrough');
      }
      if (
        resolvedCandidate.pageType &&
        candidate.pageType &&
        resolvedCandidate.pageType !== candidate.pageType
      ) {
        ruleHits.push('llm_judge_retyped');
      }
      await this.layeredExecutor.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate: resolvedCandidate,
        nodeId: options.node.id,
        nodeType: 'branch',
        action: 'branched',
        message: llmError
          ? 'LLM judge fell back to rule-ranked candidate'
          : resolvedCandidate.pageType !== candidate.pageType
            ? `LLM judge kept candidate and retyped it as ${resolvedCandidate.pageType}`
            : 'LLM judge kept candidate in the branch',
        status: 'active',
        accepted: true,
        scoreDelta:
          typeof resolvedCandidate.score === 'number' &&
          typeof candidate.score === 'number'
            ? Number((resolvedCandidate.score - candidate.score).toFixed(4))
            : undefined,
        freshnessDelta:
          typeof resolvedCandidate.freshnessScore === 'number' &&
          typeof candidate.freshnessScore === 'number'
            ? Number(
                (resolvedCandidate.freshnessScore - candidate.freshnessScore).toFixed(4),
              )
            : undefined,
        ruleHits,
        beforeSnapshot,
        afterSnapshot,
        details: {
          mode: options.mode,
          action: decisionAction ?? null,
          confidence: toFiniteNumber(decision?.confidence),
          reason: asString(decision?.reason) ?? null,
          judgeMethod:
            resolvedCandidate.metadata && isPlainObject(resolvedCandidate.metadata)
              ? asString(resolvedCandidate.metadata.judgeMethod) ?? null
              : null,
        },
      });
    }
  }

  async recordNodeCompletion(options: {
    workflowRunId?: string | null;
    node: Pick<CrawlFrontierNodeRecord, 'id' | 'url' | 'pageType'>;
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
    if (!options.workflowRunId) {
      return;
    }
    await this.strategyRecorder.upsertStep(options.workflowRunId, {
      stepKey: options.stepKey,
      nodeId: options.workflowNodeId,
      nodeType: options.workflowNodeType,
      label: options.label,
      status: 'completed',
      durationMs: options.durationMs,
      inputCount: 1,
      outputCount: options.outputCount ?? options.outputUrls.length,
      rejectedCount: options.rejectedCount,
      sampleUrls: options.outputUrls.slice(0, 5),
      metrics: options.metrics,
    });
    await this.strategyRecorder.appendEvent(options.workflowRunId, {
      level: 'info',
      eventType: 'frontier_node_completed',
      nodeId: options.node.id,
      nodeType: 'legacy.frontier_node',
      message: 'Frontier node execution completed',
      details: {
        url: options.node.url,
        pageType: options.node.pageType,
        resultCount: options.outputUrls.length,
      },
      timestamp: new Date().toISOString(),
    });
  }

  buildCandidateTraceSnapshot(options: CrawlStrategyLayeredTraceCandidate & {
    status?: string | null;
    rejectedReason?: string | null;
  }) {
    return {
      url: options.url,
      pageType: options.pageType ?? null,
      score:
        typeof options.score === 'number' && Number.isFinite(options.score)
          ? options.score
          : null,
      freshnessScore:
        typeof options.freshnessScore === 'number' &&
        Number.isFinite(options.freshnessScore)
          ? options.freshnessScore
          : null,
      relevanceScore:
        typeof options.relevanceScore === 'number' &&
        Number.isFinite(options.relevanceScore)
          ? options.relevanceScore
          : null,
      status: options.status ?? null,
      rejectedReason: options.rejectedReason ?? null,
    };
  }
}
