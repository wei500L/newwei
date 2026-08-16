import { Injectable, NotFoundException } from '@nestjs/common';
import type { NewsSource } from '@prisma/client';

import { PrismaService } from '../config/prisma.service';

import { assertSupportedWorkflowDefinition } from './crawl-config-policy';
import {
  estimateFreshnessScore,
  inferFrontierPageType,
  normalizeCrawlSiteProfileConfig,
  scoreFrontierCandidate,
} from './crawl-frontier.utils';
import {
  CrawlMetadataService,
  type CrawlDiscoveryCandidate,
} from './crawl-metadata.service';
import { CrawlStrategyRunRecorderService } from './crawl-strategy-run-recorder.service';
import { CrawlStrategyWorkflowService } from './crawl-strategy-workflow.service';
import {
  CrawlStrategyWorkflowRunKind,
  CrawlStrategyWorkflowNodeType,
  isRecord,
  type CrawlStrategyCandidateTraceEntry,
  type CrawlStrategyParameterSource,
  type CrawlStrategyWorkflowCandidate,
  type CrawlStrategyWorkflowDefinition,
  type CrawlStrategyWorkflowRunResult,
  type CrawlStrategyWorkflowStepResult,
} from './crawl-strategy.types';
import type {
  CrawlMetadataResult,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from './crawl.types';
import type { TrialRunCrawlStrategyWorkflowDto } from './dto/crawl-strategy.dto';

interface RuntimeContext {
  orgId: string;
  actorId: string;
  runId: string;
  definition: CrawlStrategyWorkflowDefinition;
  seedUrl?: string;
  newsSource?: NewsSource | null;
  profile?: CrawlSiteProfileRecord | null;
  effectiveProfileConfig: CrawlSiteProfileConfig;
  parameterSources: CrawlStrategyParameterSource[];
  systemEvents: CrawlStrategyWorkflowRunResult['systemEvents'];
  maxCandidates: number;
}

type NodeOutputMap = Record<string, CrawlStrategyWorkflowCandidate[]>;
interface NodeExecutionResult {
  outputs: NodeOutputMap;
  metrics?: Record<string, unknown>;
}

@Injectable()
export class CrawlStrategyRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metadata: CrawlMetadataService,
    private readonly recorder: CrawlStrategyRunRecorderService,
    private readonly workflows: CrawlStrategyWorkflowService,
  ) {}

  async trialRunWorkflow(
    orgId: string,
    actorId: string,
    workflowId: string,
    input: TrialRunCrawlStrategyWorkflowDto,
  ) {
    const resolved = await this.workflows.resolveBoundWorkflowVersion({
      orgId,
      workflowId,
      workflowVersionId: input.workflowVersionId,
      workflowBindingMode: 'pinned',
    });
    if (!resolved) {
      throw new NotFoundException('Workflow not found');
    }
    assertSupportedWorkflowDefinition(
      resolved.definition,
      'workflow.definition',
    );

    const profile = input.profileId
      ? await this.resolveProfile(orgId, input.profileId)
      : null;
    const newsSource = input.newsSourceId
      ? await this.resolveNewsSource(orgId, input.newsSourceId)
      : null;

    const profileOverlay = await this.workflows.compileProfileOverlay({
      orgId,
      baseExecutionMode: profile?.executionMode ?? resolved.definition.settings.executionMode,
      baseConfig: profile?.config ?? normalizeCrawlSiteProfileConfig({}),
      workflowId: resolved.workflow.id,
      workflowVersionId: resolved.version.id,
      workflowBindingMode: 'pinned',
    });

    const effectiveProfile = profile
      ? this.workflows.applyProfileOverlay({
          profile,
          overlay: profileOverlay,
        })
      : ({
          id: 'workflow-trial',
          orgId,
          name: resolved.workflow.name,
          description: resolved.workflow.description,
          matchHost: this.resolveMatchHost(input.seedUrl ?? newsSource?.url ?? ''),
          isActive: true,
          executionMode:
            profileOverlay?.executionMode ?? resolved.definition.settings.executionMode,
          version: resolved.version.version,
          config: normalizeCrawlSiteProfileConfig(profileOverlay?.configPatch ?? {}),
          createdById: actorId,
          updatedById: actorId,
          publishedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies CrawlSiteProfileRecord);

    const run = await this.recorder.createRun({
      orgId,
      createdById: actorId,
      workflowId: resolved.workflow.id,
      workflowVersionId: resolved.version.id,
      workflowOrigin: 'bound',
      profileId: profile?.id,
      newsSourceId: newsSource?.id,
      status: 'running',
      runKind: input.runKind ?? CrawlStrategyWorkflowRunKind.Trial,
      input: {
        seedUrl: input.seedUrl,
        profileId: profile?.id,
        newsSourceId: newsSource?.id,
        maxCandidates: input.maxCandidates,
        runtimeOverrides: input.runtimeOverrides ?? {},
      },
      graphSnapshot: resolved.definition,
      parameterSources: profileOverlay?.parameterSources ?? [],
      startedAt: new Date(),
    });

    try {
      const result = await this.execute({
        orgId,
        actorId,
        runId: run.id,
        definition: resolved.definition,
        seedUrl: input.seedUrl ?? newsSource?.url ?? undefined,
        newsSource,
        profile: effectiveProfile,
        effectiveProfileConfig: effectiveProfile.config,
        parameterSources: profileOverlay?.parameterSources ?? [],
        systemEvents: [],
        maxCandidates: this.toNumber(input.maxCandidates, 100),
      });

      await this.recorder.finalizeRun(run.id, {
        status: 'completed',
        output: {
          selectedCount: result.selectedCandidates.length,
          candidateCount: result.candidates.length,
        },
        steps: result.steps,
        candidates: result.candidates,
        parameterSources: result.parameterSources,
        events: result.systemEvents,
        finishedAt: new Date(),
      });

      return {
        runId: run.id,
        workflow: {
          id: resolved.workflow.id,
          name: resolved.workflow.name,
          versionId: resolved.version.id,
          version: resolved.version.version,
        },
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recorder.finalizeRun(run.id, {
        status: 'failed',
        error: message,
        finishedAt: new Date(),
      });
      throw error;
    }
  }

  async getRun(orgId: string, runId: string) {
    return this.recorder.getRun(orgId, runId);
  }

  async listRunCandidates(orgId: string, runId: string) {
    return this.recorder.listRunCandidates(orgId, runId);
  }

  async getCandidateExplanation(orgId: string, runId: string, candidateId: string) {
    return this.recorder.getCandidateExplanation(orgId, runId, candidateId);
  }

  async replayRun(
    orgId: string,
    actorId: string,
    runId: string,
    overrides?: {
      seedUrl?: string;
      profileId?: string;
      newsSourceId?: string;
      maxCandidates?: number;
    },
  ) {
    const existing = await this.recorder.getRun(orgId, runId);
    const workflowId =
      existing.workflow?.id ??
      (isRecord(existing.graphSnapshot) ? 'legacy-replay' : '');
    if (
      existing.workflowOrigin === 'legacy_bridge' ||
      !workflowId ||
      workflowId === 'legacy-replay'
    ) {
      throw new NotFoundException(
        'Legacy bridge workflow runs are observable but cannot be replayed until they are bound to a published workflow version',
      );
    }
    const workflowVersionId =
      existing.workflowVersion?.id ??
      (isRecord(existing.input) && typeof existing.input.workflowVersionId === 'string'
        ? existing.input.workflowVersionId
        : undefined);
    if (!workflowVersionId) {
      throw new NotFoundException('Workflow run version not found');
    }
    return this.trialRunWorkflow(orgId, actorId, workflowId, {
      workflowVersionId,
      seedUrl:
        overrides?.seedUrl ??
        (isRecord(existing.input) && typeof existing.input.seedUrl === 'string'
          ? existing.input.seedUrl
          : undefined),
      profileId:
        overrides?.profileId ??
        (isRecord(existing.input) && typeof existing.input.profileId === 'string'
          ? existing.input.profileId
          : undefined),
      newsSourceId:
        overrides?.newsSourceId ??
        (isRecord(existing.input) && typeof existing.input.newsSourceId === 'string'
          ? existing.input.newsSourceId
          : undefined),
      maxCandidates:
        overrides?.maxCandidates ??
        (isRecord(existing.input) && typeof existing.input.maxCandidates === 'number'
          ? existing.input.maxCandidates
          : undefined),
      runKind: CrawlStrategyWorkflowRunKind.Trial,
    });
  }

  private async execute(context: RuntimeContext): Promise<CrawlStrategyWorkflowRunResult> {
    const order = this.topologicalSort(context.definition);
    const nodeById = new Map(context.definition.nodes.map((node) => [node.id, node]));
    const incomingEdges = new Map<string, typeof context.definition.edges>();
    for (const edge of context.definition.edges) {
      const list = incomingEdges.get(edge.target) ?? [];
      list.push(edge);
      incomingEdges.set(edge.target, list);
    }

    const outputs = new Map<string, NodeOutputMap>();
    const steps: CrawlStrategyWorkflowStepResult[] = [];
    const candidateRegistry = new Map<string, CrawlStrategyWorkflowCandidate>();

    for (const nodeId of order) {
      const node = nodeById.get(nodeId);
      if (!node) {
        continue;
      }
      const inputCandidates = this.collectInputCandidates({
        nodeId,
        incomingEdges: incomingEdges.get(nodeId) ?? [],
        outputs,
      });
      const start = Date.now();
      try {
        const nodeResult = await this.executeNode(
          context,
          node,
          inputCandidates,
          candidateRegistry,
        );
        outputs.set(node.id, nodeResult.outputs);
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          label: node.label,
          status: 'completed',
          durationMs: Date.now() - start,
          inputCount: inputCandidates.length,
          outputCount: this.flattenOutputs(nodeResult.outputs).length,
          rejectedCount: this.countRejected(nodeResult.outputs),
          sampleUrls: this.flattenOutputs(nodeResult.outputs)
            .slice(0, 5)
            .map((candidate) => candidate.url),
          metrics: nodeResult.metrics,
        });
      } catch (error) {
        steps.push({
          nodeId: node.id,
          nodeType: node.type,
          label: node.label,
          status: 'failed',
          durationMs: Date.now() - start,
          inputCount: inputCandidates.length,
          outputCount: 0,
          rejectedCount: 0,
          sampleUrls: [],
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const terminalNodeIds = new Set(
      context.definition.nodes
        .filter(
          (node) =>
            !context.definition.edges.some((edge) => edge.source === node.id),
        )
        .map((node) => node.id),
    );
    const finalCandidates = this.dedupeCandidates(
      Array.from(terminalNodeIds).flatMap((nodeId) =>
        this.flattenOutputs(outputs.get(nodeId) ?? {}),
      ),
    );
    const limitedCandidates = finalCandidates.slice(0, context.maxCandidates);
    const selectedCandidates = limitedCandidates.filter(
      (candidate) => candidate.status === 'selected',
    );

    return {
      definition: context.definition,
      steps,
      candidates: limitedCandidates,
      selectedCandidates,
      parameterSources: context.parameterSources,
      systemEvents: context.systemEvents,
    };
  }

  private async executeNode(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
    registry: Map<string, CrawlStrategyWorkflowCandidate>,
  ): Promise<NodeExecutionResult> {
    switch (node.type) {
      case CrawlStrategyWorkflowNodeType.SeedDiscovery:
        return this.executeSeedDiscovery(context, node, registry);
      case CrawlStrategyWorkflowNodeType.ListDiscovery:
        return this.executeListDiscovery(context, node, registry);
      case CrawlStrategyWorkflowNodeType.DeepDiscovery:
        return this.executeDeepDiscovery(context, node, registry);
      case CrawlStrategyWorkflowNodeType.UrlFilter:
        return this.executeUrlFilter(node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.ContentFilter:
        return this.executeContentFilter(context, node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.PageTypeClassifier:
        return this.executePageTypeClassifier(context, node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.UrlScorer:
        return this.executeUrlScorer(context, node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.FreshnessScorer:
        return this.executeFreshnessScorer(context, node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.Branch:
        return this.executeBranch(node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.BudgetControl:
        return this.executeBudgetControl(node, inputCandidates);
      case CrawlStrategyWorkflowNodeType.FallbackStrategy:
        return this.executeFallbackStrategy(context, node, inputCandidates, registry);
      case CrawlStrategyWorkflowNodeType.PersistResult:
        return this.executePersistResult(node, inputCandidates);
      default:
        return {
          outputs: {
            default: inputCandidates,
          },
        };
    }
  }

  private async executeSeedDiscovery(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    registry: Map<string, CrawlStrategyWorkflowCandidate>,
  ): Promise<NodeExecutionResult> {
    const mode = this.toString(node.config.mode) === 'rss' ? 'rss' : 'sitemap';
    const maxUrls = this.toNumber(node.config.maxUrls, 40);
    const seedUrl =
      this.toString(node.config.seedUrl) ??
      context.seedUrl ??
      context.newsSource?.url ??
      '';
    const domain =
      this.toString(node.config.domain) ??
      this.resolveOrigin(seedUrl) ??
      undefined;
    const pattern = this.toString(node.config.pattern);
    const feedUrl = this.toString(node.config.feedUrl) ?? seedUrl;

    const discovered =
      mode === 'rss'
        ? await this.metadata.discoverRssCandidates({
            feedUrl,
            maxUrls,
          })
        : await this.metadata.discoverSitemapCandidates({
            domain,
            pattern,
            maxUrls,
          });
    return {
      outputs: {
        default: this.mapDiscoveryCandidates(node.id, node.type, discovered, registry),
      },
      metrics: {
        mode,
        discoveredCount: discovered.length,
      },
    };
  }

  private async executeListDiscovery(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    registry: Map<string, CrawlStrategyWorkflowCandidate>,
  ): Promise<NodeExecutionResult> {
    const listUrl =
      this.toString(node.config.listUrl) ??
      context.seedUrl ??
      context.newsSource?.url ??
      '';
    const discovered = await this.metadata.discoverListCandidates({
      url: listUrl,
      domain: this.toString(node.config.domain),
      pattern: this.toString(node.config.pattern),
      maxUrls: this.toNumber(node.config.maxUrls, 60),
      listMaxPages: this.toNumber(node.config.listMaxPages, 6),
      listPageConcurrency: this.toNumber(node.config.listPageConcurrency, 2),
      followPagination: node.config.followPagination !== false,
      crawlOptions: isRecord(node.config.crawlOptions)
        ? node.config.crawlOptions
        : undefined,
    });
    return {
      outputs: {
        default: this.mapDiscoveryCandidates(node.id, node.type, discovered, registry),
      },
      metrics: {
        discoveredCount: discovered.length,
      },
    };
  }

  private async executeDeepDiscovery(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    registry: Map<string, CrawlStrategyWorkflowCandidate>,
  ): Promise<NodeExecutionResult> {
    const seedUrl =
      this.toString(node.config.seedUrl) ??
      context.seedUrl ??
      context.newsSource?.url ??
      '';
    const discovered = await this.metadata.discoverDeepCandidates({
      url: seedUrl,
      domain: this.toString(node.config.domain),
      pattern: this.toString(node.config.pattern),
      query: this.toString(node.config.query),
      maxUrls: this.toNumber(node.config.maxUrls, 60),
      deep: isRecord(node.config.deep) ? node.config.deep : undefined,
      crawlOptions: isRecord(node.config.crawlOptions)
        ? node.config.crawlOptions
        : undefined,
    });
    return {
      outputs: {
        default: this.mapDiscoveryCandidates(node.id, node.type, discovered, registry),
      },
      metrics: {
        discoveredCount: discovered.length,
      },
    };
  }

  private executeUrlFilter(
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const includePatterns = this.toStringArray(node.config.includePatterns);
    const excludePatterns = this.toStringArray(node.config.excludePatterns);
    const blockedDomains = this.toStringArray(node.config.blockedDomains);
    const allowedHosts = this.toStringArray(node.config.allowedHosts);
    const denyKeywords = this.toStringArray(node.config.denyKeywords);
    const accepted: CrawlStrategyWorkflowCandidate[] = [];
    const rejected: CrawlStrategyWorkflowCandidate[] = [];

    for (const candidate of inputCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const reason = this.resolveUrlFilterReason(candidate.url, {
        includePatterns,
        excludePatterns,
        blockedDomains,
        allowedHosts,
        denyKeywords,
      });
      if (reason) {
        candidate.status = 'rejected';
        candidate.rejectedByNodeId = node.id;
        candidate.rejectedReason = reason;
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'filtered',
          message: `Rejected by URL filter: ${reason}`,
          accepted: false,
          ruleHits: [reason],
          rejectedReason: reason,
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
        });
        rejected.push(candidate);
      } else {
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'filtered',
          message: 'Accepted by URL filter',
          accepted: true,
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
        });
        accepted.push(candidate);
      }
    }

    return {
      outputs: {
        default: accepted,
        rejected,
      },
      metrics: {
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
      },
    };
  }

  private async executeContentFilter(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): Promise<NodeExecutionResult> {
    if (inputCandidates.length === 0) {
      return { outputs: { default: [] } };
    }
    const maxFetch = Math.min(
      this.toNumber(node.config.maxFetch, 20),
      inputCandidates.length,
    );
    const urls = inputCandidates.slice(0, maxFetch).map((candidate) => candidate.url);
    const results = await this.metadata.extract({
      urls,
      maxUrls: maxFetch,
      concurrency: Math.min(4, urls.length),
      query: this.toString(node.config.query),
      scoreThreshold: 0,
      extractOpenGraph: true,
      extractStandardMeta: true,
    });
    const resultByUrl = new Map(results.map((entry) => [entry.url, entry]));
    const accepted: CrawlStrategyWorkflowCandidate[] = [];
    const rejected: CrawlStrategyWorkflowCandidate[] = [];

    for (const candidate of inputCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const extracted = resultByUrl.get(candidate.url);
      if (extracted) {
        this.applyMetadataResult(candidate, extracted);
      }
      const reason = this.resolveContentFilterReason(candidate, node.config);
      if (reason) {
        candidate.status = 'rejected';
        candidate.rejectedByNodeId = node.id;
        candidate.rejectedReason = reason;
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'filtered',
          message: `Rejected by content filter: ${reason}`,
          accepted: false,
          ruleHits: [reason],
          rejectedReason: reason,
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
        });
        rejected.push(candidate);
      } else {
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'filtered',
          message: 'Accepted by content filter',
          accepted: true,
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
          details: extracted ? { status: extracted.status } : undefined,
        });
        accepted.push(candidate);
      }
    }

    return {
      outputs: {
        default: accepted,
        rejected,
      },
      metrics: {
        extractedCount: results.length,
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
      },
    };
  }

  private executePageTypeClassifier(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const classifierConfig = {
      ...context.effectiveProfileConfig,
      ...(isRecord(node.config.urlPatterns)
        ? { urlPatterns: node.config.urlPatterns }
        : {}),
      ...(isRecord(node.config.pageTypeSignals)
        ? { pageTypeSignals: node.config.pageTypeSignals }
        : {}),
    } as CrawlSiteProfileConfig;

    for (const candidate of inputCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const nextPageType = inferFrontierPageType({
        url: candidate.url,
        parentPageType: 'home',
        config: classifierConfig,
        publishedAtTs: this.resolveTimestamp(candidate.publishedAt),
      });
      candidate.pageType = nextPageType;
      this.pushTrace(candidate, {
        nodeId: node.id,
        nodeType: node.type,
        action: 'classified',
        message: `Classified as ${nextPageType}`,
        accepted: true,
        beforeSnapshot,
        afterSnapshot: this.buildCandidateSnapshot(candidate),
        details: { pageType: nextPageType },
      });
    }

    return {
      outputs: {
        default: inputCandidates,
      },
    };
  }

  private executeUrlScorer(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const scoringConfig: CrawlSiteProfileConfig = {
      ...context.effectiveProfileConfig,
      keywords: this.toStringArray(node.config.keywordBoosts),
      priorityKeywords: this.toStringArray(node.config.keywordBoosts),
    };

    for (const candidate of inputCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const previousScore = candidate.score ?? 0;
      const nextScore = scoreFrontierCandidate({
        url: candidate.url,
        pageType: candidate.pageType ?? 'article',
        config: scoringConfig,
        rawScore: previousScore,
        freshnessScore: candidate.freshnessScore,
      });
      candidate.score = nextScore;
      this.pushTrace(candidate, {
        nodeId: node.id,
        nodeType: node.type,
        action: 'scored',
        message: `URL score ${previousScore.toFixed(3)} -> ${nextScore.toFixed(3)}`,
        accepted: true,
        scoreDelta: Number((nextScore - previousScore).toFixed(4)),
        ruleHits: ['url_scored'],
        beforeSnapshot,
        afterSnapshot: this.buildCandidateSnapshot(candidate),
      });
    }

    return {
      outputs: {
        default: inputCandidates,
      },
    };
  }

  private executeFreshnessScorer(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const scoringConfig: CrawlSiteProfileConfig = {
      ...context.effectiveProfileConfig,
      freshnessRules: {
        recentHours: this.toNumber(node.config.recentHours, 24),
        weekHours: this.toNumber(node.config.weekHours, 24 * 7),
        monthHours: this.toNumber(node.config.monthHours, 24 * 30),
      },
    };
    for (const candidate of inputCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const previous = candidate.freshnessScore ?? 0;
      const next = estimateFreshnessScore(candidate.url, scoringConfig);
      candidate.freshnessScore = next;
      this.pushTrace(candidate, {
        nodeId: node.id,
        nodeType: node.type,
        action: 'scored',
        message: `Freshness ${previous.toFixed(3)} -> ${next.toFixed(3)}`,
        accepted: true,
        freshnessDelta: Number((next - previous).toFixed(4)),
        ruleHits: ['freshness_scored'],
        beforeSnapshot,
        afterSnapshot: this.buildCandidateSnapshot(candidate),
      });
    }
    return {
      outputs: {
        default: inputCandidates,
      },
    };
  }

  private executeBranch(
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const field = this.toString(node.config.field) ?? 'pageType';
    const operator = this.toString(node.config.operator) ?? 'equals';
    const value = node.config.value;
    const pass: CrawlStrategyWorkflowCandidate[] = [];
    const fail: CrawlStrategyWorkflowCandidate[] = [];

    for (const candidate of inputCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const targetValue = Reflect.get(candidate, field);
      const matched = this.evaluateBranch(targetValue, operator, value);
      this.pushTrace(candidate, {
        nodeId: node.id,
        nodeType: node.type,
        action: 'branched',
        message: matched ? 'Matched branch condition' : 'Missed branch condition',
        accepted: matched,
        ruleHits: [matched ? 'branch_match' : 'branch_miss'],
        beforeSnapshot,
        afterSnapshot: this.buildCandidateSnapshot(candidate),
        details: { field, operator, value },
      });
      if (matched) {
        pass.push(candidate);
      } else {
        fail.push(candidate);
      }
    }

    return {
      outputs: {
        pass,
        fail,
      },
      metrics: {
        passCount: pass.length,
        failCount: fail.length,
      },
    };
  }

  private executeBudgetControl(
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const minScore = this.toNumber(node.config.minScore, 0);
    const keepTopK = this.toNumber(node.config.keepTopK, 20);
    const sorted = [...inputCandidates].sort((left, right) => {
      const leftComposite =
        (left.score ?? 0) + (left.freshnessScore ?? 0) + (left.relevanceScore ?? 0);
      const rightComposite =
        (right.score ?? 0) + (right.freshnessScore ?? 0) + (right.relevanceScore ?? 0);
      return rightComposite - leftComposite || left.url.localeCompare(right.url);
    });
    const accepted: CrawlStrategyWorkflowCandidate[] = [];
    const rejected: CrawlStrategyWorkflowCandidate[] = [];

    for (const [index, candidate] of sorted.entries()) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const compositeScore =
        (candidate.score ?? 0) +
        (candidate.freshnessScore ?? 0) +
        (candidate.relevanceScore ?? 0);
      const belowThreshold = (candidate.score ?? 0) < minScore;
      const beyondBudget = index >= keepTopK;
      if (belowThreshold || beyondBudget) {
        candidate.status = 'rejected';
        candidate.rejectedByNodeId = node.id;
        candidate.rejectedReason = belowThreshold ? 'min_score' : 'budget_trim';
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'budgeted',
          message: belowThreshold
            ? 'Rejected by min score threshold'
            : 'Rejected by budget trim',
          accepted: false,
          ruleHits: [candidate.rejectedReason],
          rejectedReason: candidate.rejectedReason,
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
          details: {
            compositeScore,
            minScore,
            keepTopK,
            rank: index + 1,
          },
        });
        rejected.push(candidate);
      } else {
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'budgeted',
          message: 'Kept by budget control',
          accepted: true,
          ruleHits: ['kept_by_budget'],
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
          details: {
            compositeScore,
            minScore,
            keepTopK,
            rank: index + 1,
          },
        });
        accepted.push(candidate);
      }
    }

    return {
      outputs: {
        default: accepted,
        rejected,
      },
      metrics: {
        keptCount: accepted.length,
        rejectedCount: rejected.length,
      },
    };
  }

  private async executeFallbackStrategy(
    context: RuntimeContext,
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
    registry: Map<string, CrawlStrategyWorkflowCandidate>,
  ): Promise<NodeExecutionResult> {
    const activateWhen = this.toString(node.config.activateWhen) ?? 'empty';
    const shouldRunFallback =
      activateWhen === 'always' || inputCandidates.length === 0;
    if (!shouldRunFallback) {
      return {
        outputs: {
          default: inputCandidates,
        },
      };
    }
    const mode = this.toString(node.config.mode) ?? 'list';
    const discoveryNode = {
      ...node,
      id: `${node.id}::fallback`,
      type:
        mode === 'deep'
          ? CrawlStrategyWorkflowNodeType.DeepDiscovery
          : mode === 'rss' || mode === 'sitemap'
            ? CrawlStrategyWorkflowNodeType.SeedDiscovery
            : CrawlStrategyWorkflowNodeType.ListDiscovery,
      config: {
        ...(mode === 'list'
          ? {
              listUrl: this.toString(node.config.seedUrl) ?? context.seedUrl ?? '',
            }
          : {}),
        ...(mode === 'deep' || mode === 'rss' || mode === 'sitemap'
          ? {
              seedUrl: this.toString(node.config.seedUrl) ?? context.seedUrl ?? '',
            }
          : {}),
        ...node.config,
      },
    };
    const result = await this.executeNode(context, discoveryNode, [], registry);
    const fallbackCandidates = this.flattenOutputs(result.outputs);
    context.systemEvents.push({
      level: 'info',
      eventType: 'fallback_strategy_activated',
      nodeId: node.id,
      nodeType: node.type,
      message: 'Fallback strategy activated',
      triggerReason: activateWhen === 'always' ? 'fallback_always' : 'empty_input',
      beforeCount: inputCandidates.length,
      afterCount: fallbackCandidates.length,
      rescuedCount: fallbackCandidates.length,
      details: { mode, activateWhen },
      timestamp: new Date().toISOString(),
    });
    for (const candidate of fallbackCandidates) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      this.pushTrace(candidate, {
        nodeId: node.id,
        nodeType: node.type,
        action: 'fallback',
        message: `Fallback produced candidate via ${mode}`,
        accepted: true,
        ruleHits: ['fallback_activated'],
        beforeSnapshot,
        afterSnapshot: this.buildCandidateSnapshot(candidate),
        details: { activateWhen, mode },
      });
    }
    return result;
  }

  private executePersistResult(
    node: CrawlStrategyWorkflowDefinition['nodes'][number],
    inputCandidates: CrawlStrategyWorkflowCandidate[],
  ): NodeExecutionResult {
    const selectTopK = this.toNumber(node.config.selectTopK, inputCandidates.length);
    const sorted = [...inputCandidates].sort((left, right) => {
      const leftComposite =
        (left.score ?? 0) + (left.freshnessScore ?? 0) + (left.relevanceScore ?? 0);
      const rightComposite =
        (right.score ?? 0) + (right.freshnessScore ?? 0) + (right.relevanceScore ?? 0);
      return rightComposite - leftComposite || left.url.localeCompare(right.url);
    });
    const selected: CrawlStrategyWorkflowCandidate[] = [];
    const rejected: CrawlStrategyWorkflowCandidate[] = [];
    for (const [index, candidate] of sorted.entries()) {
      const beforeSnapshot = this.buildCandidateSnapshot(candidate);
      const compositeScore =
        (candidate.score ?? 0) +
        (candidate.freshnessScore ?? 0) +
        (candidate.relevanceScore ?? 0);
      if (index < selectTopK) {
        candidate.status = 'selected';
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'persisted',
          message: 'Selected for persistence',
          accepted: true,
          ruleHits: ['selected_for_persistence'],
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
          details: {
            selectTopK,
            rank: index + 1,
            compositeScore,
          },
        });
        selected.push(candidate);
      } else {
        candidate.status = 'rejected';
        candidate.rejectedByNodeId = node.id;
        candidate.rejectedReason = 'persist_trim';
        this.pushTrace(candidate, {
          nodeId: node.id,
          nodeType: node.type,
          action: 'persisted',
          message: 'Dropped by persistence limit',
          accepted: false,
          ruleHits: ['persist_trim'],
          rejectedReason: 'persist_trim',
          beforeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot(candidate),
          details: {
            selectTopK,
            rank: index + 1,
            compositeScore,
          },
        });
        rejected.push(candidate);
      }
    }
    return {
      outputs: {
        default: selected,
        rejected,
      },
      metrics: {
        selectedCount: selected.length,
        rejectedCount: rejected.length,
      },
    };
  }

  private collectInputCandidates(options: {
    nodeId: string;
    incomingEdges: CrawlStrategyWorkflowDefinition['edges'];
    outputs: Map<string, NodeOutputMap>;
  }) {
    if (options.incomingEdges.length === 0) {
      return [];
    }
    const collected = options.incomingEdges.flatMap((edge) => {
      const sourceOutputs = options.outputs.get(edge.source) ?? {};
      const handle = edge.sourceHandle ?? 'default';
      return sourceOutputs[handle] ?? sourceOutputs.default ?? [];
    });
    return this.dedupeCandidates(collected);
  }

  private mapDiscoveryCandidates(
    nodeId: string,
    nodeType: CrawlStrategyWorkflowNodeType,
    candidates: CrawlDiscoveryCandidate[],
    registry: Map<string, CrawlStrategyWorkflowCandidate>,
  ) {
    return candidates.slice(0, 500).map((entry) => {
      const existing = registry.get(entry.url);
      if (existing) {
        this.pushTrace(existing, {
          nodeId,
          nodeType,
          action: 'discovered',
          message: 'Rediscovered candidate',
          accepted: true,
        });
        return existing;
      }
      const candidate: CrawlStrategyWorkflowCandidate = {
        id: `candidate:${registry.size + 1}`,
        url: entry.url,
        relevanceScore: entry.relevanceScore,
        pageType: undefined,
        score: undefined,
        freshnessScore: undefined,
        qualityScore: undefined,
        publishedAt:
          typeof entry.publishedAtTs === 'number'
            ? new Date(entry.publishedAtTs).toISOString()
            : null,
        crawledAt:
          typeof entry.crawledAtTs === 'number'
            ? new Date(entry.crawledAtTs).toISOString()
            : null,
        effectiveAt:
          typeof entry.publishedAtTs === 'number'
            ? new Date(entry.publishedAtTs).toISOString()
            : typeof entry.crawledAtTs === 'number'
              ? new Date(entry.crawledAtTs).toISOString()
              : null,
        status: 'active',
        rejectedByNodeId: null,
        rejectedReason: null,
        sourceNodeId: nodeId,
        metadata: {
          prefetchedArticle: entry.prefetchedArticle ?? null,
        },
        trace: [],
      };
      if (entry.prefetchedArticle) {
        candidate.title = entry.prefetchedArticle.title;
        candidate.description = entry.prefetchedArticle.description;
        candidate.author = entry.prefetchedArticle.author;
      }
      this.pushTrace(candidate, {
        nodeId,
        nodeType,
        action: 'discovered',
        message: 'Candidate discovered',
        accepted: true,
        beforeSnapshot: this.buildCandidateSnapshot({
          url: entry.url,
          status: 'active',
          rejectedReason: null,
        }),
        afterSnapshot: this.buildCandidateSnapshot(candidate),
        details: {
          relevanceScore: entry.relevanceScore,
        },
      });
      registry.set(candidate.url, candidate);
      return candidate;
    });
  }

  private applyMetadataResult(
    candidate: CrawlStrategyWorkflowCandidate,
    result: CrawlMetadataResult,
  ) {
    candidate.title = result.title ?? candidate.title;
    candidate.description = result.description ?? candidate.description;
    candidate.author = result.author ?? candidate.author;
    candidate.relevanceScore = result.relevanceScore ?? candidate.relevanceScore;
    if (result.fetchedAt) {
      candidate.crawledAt = result.fetchedAt.toISOString();
      candidate.effectiveAt = candidate.effectiveAt ?? candidate.crawledAt;
    }
    candidate.metadata = {
      ...candidate.metadata,
      metadataStatus: result.status,
      metaTags: result.metaTags,
      openGraph: result.openGraph,
    };
  }

  private resolveContentFilterReason(
    candidate: CrawlStrategyWorkflowCandidate,
    config: Record<string, unknown>,
  ) {
    const minRelevanceScore = this.toNumber(config.minRelevanceScore, 0);
    const titleIncludes = this.toStringArray(config.titleIncludes);
    const descriptionIncludes = this.toStringArray(config.descriptionIncludes);

    if (config.requireTitle === true && !candidate.title?.trim()) {
      return 'missing_title';
    }
    if ((candidate.relevanceScore ?? 0) < minRelevanceScore) {
      return 'low_relevance';
    }
    if (
      titleIncludes.length > 0 &&
      !titleIncludes.some((term) =>
        (candidate.title ?? '').toLowerCase().includes(term.toLowerCase()),
      )
    ) {
      return 'title_miss';
    }
    if (
      descriptionIncludes.length > 0 &&
      !descriptionIncludes.some((term) =>
        (candidate.description ?? '').toLowerCase().includes(term.toLowerCase()),
      )
    ) {
      return 'description_miss';
    }
    return null;
  }

  private resolveUrlFilterReason(
    url: string,
    config: {
      includePatterns: string[];
      excludePatterns: string[];
      blockedDomains: string[];
      allowedHosts: string[];
      denyKeywords: string[];
    },
  ) {
    const lower = url.toLowerCase();
    if (config.excludePatterns.some((pattern) => this.matchesPattern(url, pattern))) {
      return 'exclude_pattern';
    }
    if (
      config.blockedDomains.some((domain) => {
        const host = this.resolveHost(url);
        return host === domain || host.endsWith(`.${domain}`);
      })
    ) {
      return 'blocked_domain';
    }
    if (
      config.allowedHosts.length > 0 &&
      !config.allowedHosts.some((host) => this.resolveHost(url) === host)
    ) {
      return 'host_out_of_scope';
    }
    if (
      config.denyKeywords.some((keyword) => lower.includes(keyword.toLowerCase()))
    ) {
      return 'deny_keyword';
    }
    if (
      config.includePatterns.length > 0 &&
      !config.includePatterns.some((pattern) => this.matchesPattern(url, pattern))
    ) {
      return 'include_miss';
    }
    return null;
  }

  private evaluateBranch(targetValue: unknown, operator: string, value: unknown) {
    if (operator === 'gte') {
      return this.toNumber(targetValue, Number.NEGATIVE_INFINITY) >= this.toNumber(value, 0);
    }
    if (operator === 'lte') {
      return this.toNumber(targetValue, Number.POSITIVE_INFINITY) <= this.toNumber(value, 0);
    }
    if (operator === 'contains') {
      return String(targetValue ?? '')
        .toLowerCase()
        .includes(String(value ?? '').toLowerCase());
    }
    return String(targetValue ?? '') === String(value ?? '');
  }

  private flattenOutputs(outputs: NodeOutputMap) {
    return this.dedupeCandidates(Object.values(outputs).flat());
  }

  private countRejected(outputs: NodeOutputMap) {
    return (outputs.rejected ?? []).length;
  }

  private dedupeCandidates(candidates: CrawlStrategyWorkflowCandidate[]) {
    const map = new Map<string, CrawlStrategyWorkflowCandidate>();
    for (const candidate of candidates) {
      map.set(candidate.url, candidate);
    }
    return Array.from(map.values());
  }

  private topologicalSort(definition: CrawlStrategyWorkflowDefinition) {
    const indegree = new Map<string, number>();
    const next = new Map<string, string[]>();
    for (const node of definition.nodes) {
      indegree.set(node.id, 0);
      next.set(node.id, []);
    }
    for (const edge of definition.edges) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
      next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
    }
    const queue = definition.nodes
      .filter((node) => (indegree.get(node.id) ?? 0) === 0)
      .map((node) => node.id);
    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);
      for (const target of next.get(current) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) {
          queue.push(target);
        }
      }
    }
    if (result.length !== definition.nodes.length) {
      return definition.nodes.map((node) => node.id);
    }
    return result;
  }

  private async resolveProfile(orgId: string, id: string): Promise<CrawlSiteProfileRecord> {
    const profile = await this.prisma.crawlSiteProfile.findUnique({
      where: { id },
    });
    if (!profile || profile.orgId !== orgId) {
      throw new NotFoundException('Crawl site profile not found');
    }
    return {
      ...profile,
      config: normalizeCrawlSiteProfileConfig(profile.config),
    };
  }

  private async resolveNewsSource(orgId: string, id: string) {
    const source = await this.prisma.newsSource.findUnique({
      where: { id },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException('News source not found');
    }
    return source;
  }

  private resolveMatchHost(url: string) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return 'workflow.local';
    }
  }

  private resolveOrigin(url: string) {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  private resolveHost(url: string) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  private matchesPattern(url: string, pattern: string) {
    if (!pattern.trim()) {
      return false;
    }
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(escaped, 'i').test(url);
  }

  private pushTrace(
    candidate: CrawlStrategyWorkflowCandidate,
    entry: Omit<CrawlStrategyCandidateTraceEntry, 'timestamp'>,
  ) {
    candidate.trace.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  private buildCandidateSnapshot(candidate: {
    url: string;
    pageType?: string | null;
    score?: number | null;
    freshnessScore?: number | null;
    relevanceScore?: number | null;
    status?: string | null;
    rejectedReason?: string | null;
  }) {
    return {
      url: candidate.url,
      pageType: candidate.pageType ?? null,
      score:
        typeof candidate.score === 'number' && Number.isFinite(candidate.score)
          ? candidate.score
          : null,
      freshnessScore:
        typeof candidate.freshnessScore === 'number' &&
        Number.isFinite(candidate.freshnessScore)
          ? candidate.freshnessScore
          : null,
      relevanceScore:
        typeof candidate.relevanceScore === 'number' &&
        Number.isFinite(candidate.relevanceScore)
          ? candidate.relevanceScore
          : null,
      status: candidate.status ?? null,
      rejectedReason: candidate.rejectedReason ?? null,
    };
  }

  private toString(value: unknown) {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  private toStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  private toNumber(value: unknown, fallback: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return value;
  }

  private resolveTimestamp(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed.getTime();
  }
}
