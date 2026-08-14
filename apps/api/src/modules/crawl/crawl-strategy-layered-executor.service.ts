import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { PrismaService } from '../config/prisma.service';

import {
  classifyFrontierFailureKind,
  computeFrontierPageTypeBudgets,
  estimateFreshnessScore,
  inferFrontierPageType,
  isUtilityFrontierLinkText,
  prioritizeFrontierCandidates,
  resolveFreshnessBucket,
  resolveNodeQueueClass,
  scoreFrontierCandidate,
  shouldRejectFrontierUrl,
} from './crawl-frontier.utils';
import { CrawlQueueService } from './crawl-queue.service';
import { CrawlStrategyRunRecorderService } from './crawl-strategy-run-recorder.service';
import type {
  CrawlStrategyWorkflowCandidate,
} from './crawl-strategy.types';
import type {
  CrawlFrontierNodeRecord,
  CrawlFrontierPageType,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from './crawl.types';
import type { Crawl4aiArticle } from './crawl4ai.client';
import {
  buildCanonicalUrlFingerprint,
} from './url-fingerprint';

export interface CrawlStrategyLayeredCandidate {
  url: string;
  pageType: CrawlFrontierPageType;
  score: number;
  freshnessScore: number;
  metadata: Record<string, unknown>;
}

export interface CrawlStrategyLayeredTraceCandidate {
  url: string;
  pageType?: CrawlFrontierPageType | null;
  score?: number | null;
  freshnessScore?: number | null;
  relevanceScore?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface CrawlStrategyLayeredCandidateDecision {
  candidate: CrawlStrategyLayeredTraceCandidate;
  nodeType: string;
  action:
    | 'discovered'
    | 'classified'
    | 'filtered'
    | 'scored'
    | 'branched'
    | 'budgeted'
    | 'fallback'
    | 'persisted';
  message: string;
  status: 'active' | 'selected' | 'rejected';
  accepted: boolean;
  rejectedReason?: string | null;
  ruleHits?: string[];
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
  scoreDelta?: number;
  freshnessDelta?: number;
  details?: Record<string, unknown>;
}

export interface CrawlStrategyLayeredCandidateExtraction {
  candidates: CrawlStrategyLayeredCandidate[];
  decisions: CrawlStrategyLayeredCandidateDecision[];
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

export interface CrawlStrategySeedMaterializationOutcome {
  created: number;
  selectedPageTypeCounts: Record<CrawlFrontierPageType, number>;
  diagnostics: Record<string, unknown>;
}

export interface CrawlStrategyNativeDiscoveryMaterialization {
  acceptedCount: number;
  createdCount: number;
  scannedSourceUrls: string[];
  rejectionCounts: Record<string, number>;
  acceptedPageTypeCounts: Record<CrawlFrontierPageType, number>;
  selectedPageTypeCounts: Record<CrawlFrontierPageType, number>;
  nativeWarningFlags: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bumpCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
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

function toNumericRecord(value: unknown): Record<string, number> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = typeof entry === 'number' ? entry : Number(entry);
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

@Injectable()
export class CrawlStrategyLayeredExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: CrawlQueueService,
    private readonly strategyRecorder: CrawlStrategyRunRecorderService,
  ) {}

  extractCandidates(options: {
    node: Pick<CrawlFrontierNodeRecord, 'id' | 'url' | 'pageType'>;
    config: CrawlSiteProfileConfig;
    results: Crawl4aiArticle[];
  }): CrawlStrategyLayeredCandidateExtraction {
    const byUrl = new Map<string, CrawlStrategyLayeredCandidate>();
    const decisions: CrawlStrategyLayeredCandidateDecision[] = [];
    const rejectionCounts: Record<string, number> = {};
    const sameDomainHost = new URL(options.node.url).hostname;
    const selfCanonical = buildCanonicalUrlFingerprint(
      options.node.url,
      options.config.urlQueryParamAllowlist,
    );
    const selfKey =
      selfCanonical?.fingerprint ?? selfCanonical?.canonicalUrl ?? options.node.url;
    let scannedLinks = 0;
    const buildBaseMetadata = (
      linkText?: string,
      extra?: Record<string, unknown>,
    ) =>
      mergeMetadataRecords(
        {
          discoveredFromNodeId: options.node.id,
          discoveredFromPageType: options.node.pageType,
          linkText: linkText ?? null,
        },
        extra,
      ) ?? {};
    const pushDecision = (decision: CrawlStrategyLayeredCandidateDecision) => {
      decisions.push(decision);
    };

    for (const result of options.results) {
      const baseUrl =
        typeof result.url === 'string' && result.url.trim().length > 0
          ? result.url.trim()
          : options.node.url;
      for (const links of Object.values(result.links ?? {})) {
        if (!Array.isArray(links)) {
          continue;
        }
        for (const link of links) {
          const href =
            typeof link.href === 'string'
              ? link.href.trim()
              : typeof link.url === 'string'
                ? link.url.trim()
                : '';
          const linkText =
            typeof link.text === 'string'
              ? link.text
              : typeof link.title === 'string'
                ? link.title
                : undefined;
          if (!href) {
            continue;
          }
          scannedLinks += 1;
          let resolvedUrl = href;
          try {
            resolvedUrl = new URL(href, baseUrl).toString();
          } catch {
            bumpCount(rejectionCounts, 'invalid_url');
            pushDecision({
              candidate: {
                url: href,
                metadata: buildBaseMetadata(linkText, {
                  baseUrl,
                  invalidHref: href,
                }),
              },
              nodeType: 'url-filter',
              action: 'filtered',
              message:
                'Rejected link because the href could not be resolved into a valid URL',
              status: 'rejected',
              accepted: false,
              rejectedReason: 'invalid_url',
              ruleHits: ['invalid_url'],
            });
            continue;
          }
          if (resolvedUrl === options.node.url) {
            bumpCount(rejectionCounts, 'self_url');
            pushDecision({
              candidate: {
                url: resolvedUrl,
                metadata: buildBaseMetadata(linkText, { baseUrl }),
              },
              nodeType: 'url-filter',
              action: 'filtered',
              message: 'Rejected self-referential link during layered extraction',
              status: 'rejected',
              accepted: false,
              rejectedReason: 'self_url',
              ruleHits: ['self_url'],
            });
            continue;
          }
          if (isUtilityFrontierLinkText(linkText)) {
            bumpCount(rejectionCounts, 'utility_link_text');
            pushDecision({
              candidate: {
                url: resolvedUrl,
                metadata: buildBaseMetadata(linkText, { baseUrl }),
              },
              nodeType: 'url-filter',
              action: 'filtered',
              message: 'Rejected utility navigation link during layered extraction',
              status: 'rejected',
              accepted: false,
              rejectedReason: 'utility_link_text',
              ruleHits: ['utility_link_text'],
            });
            continue;
          }
          const rejectionReason = shouldRejectFrontierUrl({
            url: resolvedUrl,
            config: options.config,
            requireSameDomainHost: sameDomainHost,
            linkText,
          });
          if (rejectionReason) {
            bumpCount(rejectionCounts, rejectionReason);
            pushDecision({
              candidate: {
                url: resolvedUrl,
                metadata: buildBaseMetadata(linkText, { baseUrl }),
              },
              nodeType: 'url-filter',
              action: 'filtered',
              message: `Rejected URL during layered filtering: ${rejectionReason}`,
              status: 'rejected',
              accepted: false,
              rejectedReason: rejectionReason,
              ruleHits: [rejectionReason],
            });
            continue;
          }
          const candidateCanonical = buildCanonicalUrlFingerprint(
            resolvedUrl,
            options.config.urlQueryParamAllowlist,
          );
          const candidateKey =
            candidateCanonical?.fingerprint ??
            candidateCanonical?.canonicalUrl ??
            resolvedUrl;
          if (candidateKey === selfKey) {
            bumpCount(rejectionCounts, 'self_canonical');
            pushDecision({
              candidate: {
                url: resolvedUrl,
                metadata: buildBaseMetadata(linkText, {
                  baseUrl,
                  canonicalUrl: candidateCanonical?.canonicalUrl ?? null,
                  urlFingerprint: candidateCanonical?.fingerprint ?? null,
                }),
              },
              nodeType: 'url-filter',
              action: 'filtered',
              message:
                'Rejected link because it canonicalized back to the current frontier node',
              status: 'rejected',
              accepted: false,
              rejectedReason: 'self_canonical',
              ruleHits: ['self_canonical'],
            });
            continue;
          }
          const pageType = inferFrontierPageType({
            url: resolvedUrl,
            parentPageType: options.node.pageType,
            config: options.config,
            linkText,
          });
          const freshnessScore = estimateFreshnessScore(resolvedUrl, options.config);
          const rawScore =
            typeof link.totalScore === 'number'
              ? link.totalScore
              : typeof link.total_score === 'number'
                ? link.total_score
                : typeof link.contextualScore === 'number'
                  ? link.contextualScore
                  : typeof link.contextual_score === 'number'
                    ? link.contextual_score
                    : typeof link.intrinsicScore === 'number'
                      ? link.intrinsicScore
                      : typeof link.intrinsic_score === 'number'
                        ? link.intrinsic_score
                        : 0;
          const score = scoreFrontierCandidate({
            url: resolvedUrl,
            pageType,
            parentPageType: options.node.pageType,
            parentUrl: options.node.url,
            config: options.config,
            rawScore,
            linkText,
            freshnessScore,
          });
          const candidate: CrawlStrategyLayeredCandidate = {
            url: resolvedUrl,
            pageType,
            score,
            freshnessScore,
            metadata: {
              discoveredFromNodeId: options.node.id,
              discoveredFromPageType: options.node.pageType,
              linkText: linkText ?? null,
              frontierScore: score,
              frontierFreshnessScore: freshnessScore,
            },
          };
          const baseSnapshot = this.buildCandidateSnapshot({
            url: candidate.url,
            pageType: null,
            score: null,
            freshnessScore: null,
            relevanceScore: null,
            status: 'active',
            rejectedReason: null,
          });
          const classifiedSnapshot = this.buildCandidateSnapshot({
            url: candidate.url,
            pageType,
            score: null,
            freshnessScore: null,
            status: 'active',
            rejectedReason: null,
          });
          const freshnessSnapshot = this.buildCandidateSnapshot({
            url: candidate.url,
            pageType,
            score: null,
            freshnessScore,
            status: 'active',
            rejectedReason: null,
          });
          const scoredSnapshot = this.buildCandidateSnapshot({
            ...candidate,
            status: 'active',
            rejectedReason: null,
          });
          pushDecision({
            candidate,
            nodeType: 'page-type-classifier',
            action: 'classified',
            message: `Classified candidate as ${pageType}`,
            status: 'active',
            accepted: true,
            beforeSnapshot: baseSnapshot,
            afterSnapshot: classifiedSnapshot,
            details: {
              pageType,
            },
          });
          pushDecision({
            candidate,
            nodeType: 'freshness-scorer',
            action: 'scored',
            message: `Layered freshness 0.000 -> ${freshnessScore.toFixed(3)}`,
            status: 'active',
            accepted: true,
            beforeSnapshot: classifiedSnapshot,
            afterSnapshot: freshnessSnapshot,
            freshnessDelta: Number(freshnessScore.toFixed(4)),
            ruleHits: ['freshness_scored'],
          });
          pushDecision({
            candidate,
            nodeType: 'url-scorer',
            action: 'scored',
            message: `Layered score 0.000 -> ${score.toFixed(3)}`,
            status: 'active',
            accepted: true,
            beforeSnapshot: freshnessSnapshot,
            afterSnapshot: scoredSnapshot,
            scoreDelta: Number(score.toFixed(4)),
            ruleHits: ['url_scored'],
          });
          const existing = byUrl.get(resolvedUrl);
          if (!existing || score > existing.score) {
            byUrl.set(resolvedUrl, candidate);
          }
        }
      }
    }

    const threshold = options.config.layeredOptions?.scoreThreshold ?? 0.35;
    const accepted = Array.from(byUrl.values()).filter((entry) => entry.score >= threshold);
    const lowScoreCandidates = Array.from(byUrl.values()).filter(
      (entry) => entry.score < threshold,
    );
    const lowScoreCount = Math.max(0, byUrl.size - accepted.length);
    if (lowScoreCount > 0) {
      rejectionCounts.low_score = lowScoreCount;
      for (const candidate of lowScoreCandidates) {
        const scoredSnapshot = this.buildCandidateSnapshot({
          ...candidate,
          status: 'active',
          rejectedReason: null,
        });
        pushDecision({
          candidate,
          nodeType: 'budget-control',
          action: 'budgeted',
          message:
            'Rejected candidate because layered discovery score was below the threshold',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'low_score',
          ruleHits: ['low_score'],
          beforeSnapshot: scoredSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'low_score',
          }),
          details: {
            scoreThreshold: threshold,
          },
        });
      }
    }
    const acceptedPageTypeCounts = this.createPageTypeCountRecord();
    for (const candidate of accepted) {
      acceptedPageTypeCounts[candidate.pageType] += 1;
    }
    const prioritized = prioritizeFrontierCandidates({
      parentPageType: options.node.pageType,
      candidates: accepted,
    });
    const maxChildren = options.config.layeredOptions?.maxChildrenPerNode ?? 24;
    const trimmed = Math.max(0, prioritized.length - maxChildren);
    const trimmedCandidates = trimmed > 0 ? prioritized.slice(maxChildren) : [];
    if (trimmed > 0) {
      rejectionCounts.max_children_trimmed = trimmed;
      for (const [index, candidate] of trimmedCandidates.entries()) {
        pushDecision({
          candidate,
          nodeType: 'budget-control',
          action: 'budgeted',
          message:
            'Rejected candidate because it fell outside the layered max children budget',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'max_children_trimmed',
          ruleHits: ['max_children_trimmed'],
          beforeSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'active',
            rejectedReason: null,
          }),
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'max_children_trimmed',
          }),
          details: {
            maxChildren,
            trimmedRank: maxChildren + index + 1,
          },
        });
      }
    }
    const candidates = prioritized.slice(0, maxChildren);
    for (const candidate of candidates) {
      pushDecision({
        candidate,
        nodeType: 'list-discovery',
        action: 'discovered',
        message: 'Candidate passed layered extraction filters and entered discovery flow',
        status: 'active',
        accepted: true,
        ruleHits: ['layered_candidate_selected'],
        beforeSnapshot: this.buildCandidateSnapshot({
          ...candidate,
          status: 'active',
          rejectedReason: null,
        }),
        afterSnapshot: this.buildCandidateSnapshot({
          ...candidate,
          status: 'active',
          rejectedReason: null,
        }),
        details: {
          scoreThreshold: threshold,
          maxChildren,
        },
      });
    }

    return {
      candidates,
      decisions,
      diagnostics: {
        candidateStats: {
          scanned: scannedLinks,
          unique: byUrl.size,
          accepted: accepted.length,
          selected: candidates.length,
          rejected: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
          trimmed,
        },
        rejectionCounts,
        acceptedPageTypeCounts,
        warningFlags: [],
        syntheticListActivated: false,
      },
    };
  }

  async materializeDiscoveredCandidates(options: {
    workflowRunId?: string | null;
    node: CrawlFrontierNodeRecord;
    runId: string;
    taskId: string;
    maxDepth: number;
    maxPages: number;
    profile: CrawlSiteProfileRecord;
    candidates: CrawlStrategyLayeredCandidate[];
    extractionDiagnostics: Record<string, unknown>;
    llmDiagnostics?: Record<string, unknown>;
    maxDepthOverride?: number;
    maxNewNodes?: number;
    metadataPatch?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const effectiveMaxDepth = Math.min(
      options.maxDepth,
      options.maxDepthOverride ?? options.maxDepth,
    );
    const childDepth = options.node.depth + 1;
    if (childDepth > effectiveMaxDepth) {
      for (const candidate of options.candidates) {
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'branch',
          action: 'branched',
          message:
            'Rejected candidate because the discovery branch exceeded the effective depth limit',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'depth_exhausted',
          ruleHits: ['depth_exhausted'],
          beforeSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'active',
            rejectedReason: null,
          }),
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'depth_exhausted',
          }),
          details: {
            childDepth,
            effectiveMaxDepth,
          },
        });
      }
      if (options.workflowRunId) {
        await this.strategyRecorder.appendEvent(options.workflowRunId, {
          level: 'warn',
          eventType: 'branch_depth_exhausted',
          nodeId: options.node.id,
          nodeType: 'branch',
          message: 'Discovery branch stopped because effective max depth was reached',
          triggerReason: 'depth_exhausted',
          beforeCount: options.candidates.length,
          afterCount: 0,
          rescuedCount: 0,
          details: {
            childDepth,
            effectiveMaxDepth,
          },
          timestamp: new Date().toISOString(),
        });
      }
      return {
        ...options.extractionDiagnostics,
        ...(options.llmDiagnostics ?? {}),
        warningFlags: uniqueStringList(
          Array.isArray(options.extractionDiagnostics.warningFlags)
            ? options.extractionDiagnostics.warningFlags
            : undefined,
          Array.isArray(options.llmDiagnostics?.warningFlags)
            ? (options.llmDiagnostics.warningFlags as string[])
            : undefined,
          ['depth_exhausted'],
        ) ?? ['depth_exhausted'],
      };
    }
    if (options.candidates.length === 0) {
      if (options.workflowRunId) {
        await this.strategyRecorder.appendEvent(options.workflowRunId, {
          level: 'warn',
          eventType: 'branch_empty_candidate_set',
          nodeId: options.node.id,
          nodeType: 'branch',
          message: 'Discovery branch produced no materializable candidates',
          triggerReason: 'llm_dropped_all_candidates',
          beforeCount: 0,
          afterCount: 0,
          rescuedCount: 0,
          details: {
            llmDiagnostics: options.llmDiagnostics ?? null,
          },
          timestamp: new Date().toISOString(),
        });
      }
      return {
        ...options.extractionDiagnostics,
        ...(options.llmDiagnostics ?? {}),
        warningFlags: uniqueStringList(
          Array.isArray(options.extractionDiagnostics.warningFlags)
            ? options.extractionDiagnostics.warningFlags
            : undefined,
          Array.isArray(options.llmDiagnostics?.warningFlags)
            ? (options.llmDiagnostics.warningFlags as string[])
            : undefined,
          ['llm_dropped_all_candidates'],
        ) ?? ['llm_dropped_all_candidates'],
      };
    }

    const pageTypeBudgets = computeFrontierPageTypeBudgets({
      maxDepth: effectiveMaxDepth,
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
    const creationBudget =
      typeof options.maxNewNodes === 'number' && Number.isFinite(options.maxNewNodes)
        ? Math.max(0, Math.min(remainingBudget, Math.round(options.maxNewNodes)))
        : remainingBudget;
    const rejectionCounts = {
      ...(toNumericRecord(options.extractionDiagnostics.rejectionCounts) ?? {}),
    };
    const baseCandidateStats =
      toNumericRecord(options.extractionDiagnostics.candidateStats) ?? {
        scanned: 0,
        unique: 0,
        accepted: options.candidates.length,
        selected: options.candidates.length,
        rejected: 0,
        trimmed: 0,
      };
    if (creationBudget === 0) {
      bumpCount(rejectionCounts, 'run_budget_exhausted');
      for (const candidate of options.candidates) {
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected candidate because the run budget was already exhausted',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'run_budget_exhausted',
          ruleHits: ['run_budget_exhausted'],
          beforeSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'active',
            rejectedReason: null,
          }),
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'run_budget_exhausted',
          }),
          details: {
            existingCount,
            maxPages: options.maxPages,
          },
        });
      }
      if (options.workflowRunId) {
        await this.strategyRecorder.appendEvent(options.workflowRunId, {
          level: 'warn',
          eventType: 'budget_exhausted',
          nodeId: options.node.id,
          nodeType: 'budget-control',
          message: 'Discovery branch had no remaining run budget',
          triggerReason: 'run_budget_exhausted',
          beforeCount: options.candidates.length,
          afterCount: 0,
          rescuedCount: 0,
          details: {
            existingCount,
            maxPages: options.maxPages,
          },
          timestamp: new Date().toISOString(),
        });
      }
      return {
        ...options.extractionDiagnostics,
        ...(options.llmDiagnostics ?? {}),
        rejectionCounts,
        candidateStats: {
          ...baseCandidateStats,
          selected: 0,
          rejected: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
        },
      };
    }

    const seenFingerprints = new Set(
      existingNodesForRun
        .map((entry) => entry.urlFingerprint ?? entry.canonicalUrl ?? '')
        .filter((entry) => entry.length > 0),
    );
    const countsByPageType = this.createPageTypeCountRecord();
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
      candidates: options.candidates,
    });
    for (const candidate of prioritizedCandidates) {
      const activeSnapshot = this.buildCandidateSnapshot({
        ...candidate,
        status: 'active',
        rejectedReason: null,
      });
      if (created >= creationBudget) {
        bumpCount(rejectionCounts, 'run_budget_exhausted');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected candidate because run budget was exhausted',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'run_budget_exhausted',
          ruleHits: ['run_budget_exhausted'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'run_budget_exhausted',
          }),
        });
        break;
      }
      if (countsByPageType[candidate.pageType] >= pageTypeBudgets[candidate.pageType]) {
        bumpCount(rejectionCounts, 'page_type_budget');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected candidate because page type budget was exhausted',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'page_type_budget',
          ruleHits: ['page_type_budget'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'page_type_budget',
          }),
        });
        continue;
      }
      const canonical = buildCanonicalUrlFingerprint(
        candidate.url,
        options.profile.config.urlQueryParamAllowlist,
      );
      const dedupeKey = canonical?.fingerprint ?? canonical?.canonicalUrl ?? candidate.url;
      if (seenFingerprints.has(dedupeKey)) {
        bumpCount(rejectionCounts, 'duplicate');
        const duplicateCandidate = {
          ...candidate,
          metadata: mergeMetadataRecords(candidate.metadata, {
            canonicalUrl: canonical?.canonicalUrl ?? null,
            urlFingerprint: canonical?.fingerprint ?? null,
          }) ?? candidate.metadata,
        };
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: duplicateCandidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected duplicate candidate',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'duplicate',
          ruleHits: ['duplicate'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'duplicate',
          }),
        });
        continue;
      }
      if (candidate.pageType === 'list' && listPagesCreated >= paginationKeepCount) {
        bumpCount(rejectionCounts, 'pagination_limit');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected candidate because pagination keep limit was exhausted',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'pagination_limit',
          ruleHits: ['pagination_limit'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'pagination_limit',
          }),
        });
        continue;
      }
      const queueClass = resolveNodeQueueClass({
        pageType: candidate.pageType,
        freshnessScore: candidate.freshnessScore,
      });
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate,
        nodeId: options.node.id,
        nodeType: 'budget-control',
        action: 'budgeted',
        message: 'Kept candidate within layered materialization budget',
        status: 'active',
        accepted: true,
        ruleHits: ['kept_by_budget'],
        beforeSnapshot: activeSnapshot,
        afterSnapshot: activeSnapshot,
        details: {
          queueClass,
        },
      });
      const persisted = await this.persistFrontierNode({
        runId: options.runId,
        parentNodeId: options.node.id,
        orgId: options.node.orgId,
        url: candidate.url,
        canonicalUrl: canonical?.canonicalUrl,
        urlFingerprint: canonical?.fingerprint,
        pageType: candidate.pageType,
        depth: childDepth,
        queueClass,
        status: 'queued',
        score: candidate.score,
        freshnessScore: candidate.freshnessScore,
        queuedAt: new Date(),
        metadata: toPrismaJsonValue(
          mergeMetadataRecords(
            candidate.metadata,
            {
              sourceTier: options.profile.config.sourceTier ?? 'tier2',
            },
            options.metadataPatch,
          ),
        ),
      });
      const node = persisted.node;
      seenFingerprints.add(dedupeKey);
      if (persisted.created) {
        countsByPageType[candidate.pageType] += 1;
        selectedPageTypeCounts[candidate.pageType] += 1;
        created += 1;
        if (candidate.pageType === 'list') {
          listPagesCreated += 1;
        }
      }
      if (persisted.created || node.status === 'pending') {
        await this.queueService.enqueueFrontierNode({
          orgId: options.node.orgId,
          taskId: options.taskId,
          frontierRunId: options.runId,
          frontierNodeId: node.id,
          priorityClass: queueClass,
        });
      }
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate: {
          ...candidate,
          metadata: mergeMetadataRecords(candidate.metadata, {
            canonicalUrl: canonical?.canonicalUrl ?? null,
            urlFingerprint: canonical?.fingerprint ?? null,
            queuedNodeId: node.id,
            queueClass,
          }) ?? candidate.metadata,
        },
        nodeId: options.node.id,
          nodeType: 'persist-result',
          action: 'persisted',
          message: 'Candidate materialized into queued frontier node',
          status: 'selected',
          accepted: true,
          ruleHits: ['selected_for_persistence', 'queued_frontier_node'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'selected',
          rejectedReason: null,
        }),
      });
    }

    if (options.workflowRunId) {
      await this.strategyRecorder.upsertStep(options.workflowRunId, {
        stepKey: `frontier:${options.node.id}:materialize-discovery`,
        nodeId: `legacy::discovery:${options.node.id}`,
        nodeType: 'list-discovery',
        label: 'Materialize discovered candidates',
        status: 'completed',
        durationMs: 0,
        inputCount: prioritizedCandidates.length,
        outputCount: created,
        rejectedCount: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
        sampleUrls: prioritizedCandidates.slice(0, 5).map((candidate) => candidate.url),
        metrics: {
          creationBudget,
          selectedPageTypeCounts,
          rejectionCounts,
        },
      });
    }

    return {
      ...options.extractionDiagnostics,
      ...(options.llmDiagnostics ?? {}),
      rejectionCounts,
      selectedPageTypeCounts,
      candidateStats: {
        ...baseCandidateStats,
        llmJudgeDropped:
          typeof options.llmDiagnostics?.llmJudgeDropped === 'number'
            ? options.llmDiagnostics.llmJudgeDropped
            : undefined,
        budgeted: creationBudget,
        selected: created,
        rejected: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
      },
      warningFlags: uniqueStringList(
        Array.isArray(options.extractionDiagnostics.warningFlags)
          ? options.extractionDiagnostics.warningFlags
          : undefined,
        Array.isArray(options.llmDiagnostics?.warningFlags)
          ? (options.llmDiagnostics.warningFlags as string[])
          : undefined,
        created === 0 ? ['no_child_nodes_created'] : undefined,
      ) ?? [],
    };
  }

  async materializeSeedCandidates(options: {
    workflowRunId?: string | null;
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      seedUrl: string;
      maxDepth: number;
      maxPages: number;
    };
    taskId: string;
    profile: CrawlSiteProfileRecord;
    candidates: CrawlStrategyLayeredCandidate[];
    sitemapDiagnostics: Record<string, unknown>;
    qualityThresholds?: {
      minCandidates?: number;
      minArticleRatio?: number;
      maxNoiseRatio?: number;
      minFreshRatio?: number;
    };
    discoveredCount: number;
    llmDiagnostics?: Record<string, unknown>;
  }): Promise<CrawlStrategySeedMaterializationOutcome> {
    const normalizedCandidates = options.candidates.map((candidate) => {
      const synthetic =
        candidate.metadata &&
        isPlainObject(candidate.metadata) &&
        candidate.metadata.syntheticList === true &&
        candidate.pageType === 'article';
      const discoveryPath = synthetic
        ? ['seed', 'synthetic_list', 'article']
        : ['seed', candidate.pageType];
      return {
        ...candidate,
        metadata:
          mergeMetadataRecords(candidate.metadata, {
            seedCandidate: true,
            seedOrigin: 'sitemap',
            seedMethod:
              typeof options.sitemapDiagnostics.seedMethod === 'string'
                ? options.sitemapDiagnostics.seedMethod
                : null,
            discoveryPath,
            frontierPath: discoveryPath,
          }) ?? {},
      };
    });

    const selectedPageTypeCounts = this.createPageTypeCountRecord();
    for (const candidate of normalizedCandidates) {
      selectedPageTypeCounts[candidate.pageType] += 1;
    }
    const articleCount = selectedPageTypeCounts.article;
    const freshCount = normalizedCandidates.filter(
      (candidate) => candidate.freshnessScore >= 0.75,
    ).length;
    const candidateCount = Math.max(options.discoveredCount, normalizedCandidates.length);
    const selectedCount = normalizedCandidates.length;
    const articleRatio =
      selectedCount > 0 ? Number((articleCount / selectedCount).toFixed(4)) : 0;
    const noiseRatio =
      candidateCount > 0
        ? Number(
            Math.max(0, (candidateCount - selectedCount) / candidateCount).toFixed(4),
          )
        : 1;
    const freshRatio =
      selectedCount > 0 ? Number((freshCount / selectedCount).toFixed(4)) : 0;
    const qualityThresholds = {
      minCandidates: options.qualityThresholds?.minCandidates ?? 1,
      minArticleRatio: options.qualityThresholds?.minArticleRatio ?? 0,
      maxNoiseRatio: options.qualityThresholds?.maxNoiseRatio ?? 1,
      minFreshRatio: options.qualityThresholds?.minFreshRatio ?? 0,
    };
    const qualityPassed =
      selectedCount >= qualityThresholds.minCandidates &&
      articleRatio >= qualityThresholds.minArticleRatio &&
      noiseRatio <= qualityThresholds.maxNoiseRatio &&
      freshRatio >= qualityThresholds.minFreshRatio;

    const rejectionCounts: Record<string, number> = {};
    if (!qualityPassed && selectedCount > 0) {
      bumpCount(rejectionCounts, 'seed_low_quality');
      if (options.workflowRunId) {
        await this.strategyRecorder.appendEvent(options.workflowRunId, {
          level: 'warn',
          eventType: 'seed_quality_gate_failed',
          nodeId: options.node.id,
          nodeType: 'branch',
          message: 'Seed candidate set failed the quality gate',
          triggerReason: 'seed_low_quality',
          beforeCount: selectedCount,
          afterCount: 0,
          rescuedCount: 0,
          details: {
            articleRatio,
            noiseRatio,
            freshRatio,
            qualityThresholds,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

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
        .map((entry) => entry.urlFingerprint ?? entry.canonicalUrl ?? '')
        .filter((entry) => entry.length > 0),
    );
    const countsByPageType = this.createPageTypeCountRecord();
    for (const entry of existingNodesForRun) {
      countsByPageType[entry.pageType] += 1;
    }
    const pageTypeBudgets = computeFrontierPageTypeBudgets({
      maxDepth: options.run.maxDepth,
      maxPages: options.run.maxPages,
    });
    const remainingBudget = Math.max(0, options.run.maxPages - existingNodesForRun.length);
    const paginationKeepCount = this.clampInt(
      options.profile.config.layeredOptions?.paginationKeepCount,
      1,
      10,
      3,
    );
    let listPagesCreated = 0;
    let created = 0;

    if (qualityPassed) {
      const prioritizedCandidates = prioritizeFrontierCandidates({
        parentPageType: 'home',
        candidates: normalizedCandidates,
      });
      for (const [index, candidate] of prioritizedCandidates.entries()) {
        const branchSnapshot = this.buildCandidateSnapshot({
          url: candidate.url,
          pageType: candidate.pageType,
          score: null,
          freshnessScore: null,
          status: 'active',
          rejectedReason: null,
        });
        const freshnessSnapshot = this.buildCandidateSnapshot({
          url: candidate.url,
          pageType: candidate.pageType,
          score: null,
          freshnessScore: candidate.freshnessScore,
          status: 'active',
          rejectedReason: null,
        });
        const activeSnapshot = this.buildCandidateSnapshot({
          ...candidate,
          status: 'active',
          rejectedReason: null,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'branch',
          action: 'branched',
          message: 'Seed candidate entered the root seed branch',
          status: 'active',
          accepted: true,
          ruleHits: ['seed_branch_selected'],
          beforeSnapshot: branchSnapshot,
          afterSnapshot: branchSnapshot,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'freshness-scorer',
          action: 'scored',
          message: 'Seed candidate freshness scored from sitemap signals',
          status: 'active',
          accepted: true,
          freshnessDelta:
            typeof candidate.freshnessScore === 'number'
              ? candidate.freshnessScore
              : undefined,
          ruleHits: ['freshness_scored'],
          beforeSnapshot: branchSnapshot,
          afterSnapshot: freshnessSnapshot,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'url-scorer',
          action: 'scored',
          message: 'Seed candidate scored for frontier persistence',
          status: 'active',
          accepted: true,
          scoreDelta:
            typeof candidate.score === 'number' ? candidate.score : undefined,
          ruleHits: ['url_scored', 'seed_scored'],
          beforeSnapshot: freshnessSnapshot,
          afterSnapshot: activeSnapshot,
        });
        if (created >= remainingBudget) {
          bumpCount(rejectionCounts, 'run_budget_exhausted');
          await this.recordCandidateDecision({
            workflowRunId: options.workflowRunId,
            sourceNodeId: options.node.id,
            candidate,
            nodeId: options.node.id,
            nodeType: 'budget-control',
            action: 'budgeted',
            message: 'Rejected seed candidate because run budget was exhausted',
            status: 'rejected',
            accepted: false,
            rejectedReason: 'run_budget_exhausted',
            ruleHits: ['run_budget_exhausted'],
            beforeSnapshot: activeSnapshot,
            afterSnapshot: this.buildCandidateSnapshot({
              ...candidate,
              status: 'rejected',
              rejectedReason: 'run_budget_exhausted',
            }),
          });
          break;
        }
        if (countsByPageType[candidate.pageType] >= pageTypeBudgets[candidate.pageType]) {
          bumpCount(rejectionCounts, 'page_type_budget');
          await this.recordCandidateDecision({
            workflowRunId: options.workflowRunId,
            sourceNodeId: options.node.id,
            candidate,
            nodeId: options.node.id,
            nodeType: 'budget-control',
            action: 'budgeted',
            message: 'Rejected seed candidate because page type budget was exhausted',
            status: 'rejected',
            accepted: false,
            rejectedReason: 'page_type_budget',
            ruleHits: ['page_type_budget'],
            beforeSnapshot: activeSnapshot,
            afterSnapshot: this.buildCandidateSnapshot({
              ...candidate,
              status: 'rejected',
              rejectedReason: 'page_type_budget',
            }),
          });
          continue;
        }
        const canonical = buildCanonicalUrlFingerprint(
          candidate.url,
          options.profile.config.urlQueryParamAllowlist,
        );
        const dedupeKey =
          canonical?.fingerprint ?? canonical?.canonicalUrl ?? candidate.url;
        if (seenFingerprints.has(dedupeKey)) {
          bumpCount(rejectionCounts, 'duplicate');
          const duplicateCandidate = {
            ...candidate,
            metadata:
              mergeMetadataRecords(candidate.metadata, {
                canonicalUrl: canonical?.canonicalUrl ?? null,
                urlFingerprint: canonical?.fingerprint ?? null,
              }) ?? candidate.metadata,
          };
          await this.recordCandidateDecision({
            workflowRunId: options.workflowRunId,
            sourceNodeId: options.node.id,
            candidate: duplicateCandidate,
            nodeId: options.node.id,
            nodeType: 'budget-control',
            action: 'budgeted',
            message: 'Rejected duplicate seed candidate',
            status: 'rejected',
            accepted: false,
            rejectedReason: 'duplicate',
            ruleHits: ['duplicate'],
            beforeSnapshot: activeSnapshot,
            afterSnapshot: this.buildCandidateSnapshot({
              ...candidate,
              status: 'rejected',
              rejectedReason: 'duplicate',
            }),
          });
          continue;
        }
        if (candidate.pageType === 'list' && listPagesCreated >= paginationKeepCount) {
          bumpCount(rejectionCounts, 'pagination_limit');
          await this.recordCandidateDecision({
            workflowRunId: options.workflowRunId,
            sourceNodeId: options.node.id,
            candidate,
            nodeId: options.node.id,
            nodeType: 'budget-control',
            action: 'budgeted',
            message: 'Rejected seed candidate because pagination keep limit was exhausted',
            status: 'rejected',
            accepted: false,
            rejectedReason: 'pagination_limit',
            ruleHits: ['pagination_limit'],
            beforeSnapshot: activeSnapshot,
            afterSnapshot: this.buildCandidateSnapshot({
              ...candidate,
              status: 'rejected',
              rejectedReason: 'pagination_limit',
            }),
          });
          continue;
        }
        const queueClass = resolveNodeQueueClass({
          pageType: candidate.pageType,
          freshnessScore: candidate.freshnessScore,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Kept seed candidate within materialization budget',
          status: 'active',
          accepted: true,
          ruleHits: ['kept_by_budget'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: activeSnapshot,
          details: {
            queueClass,
            rank: index + 1,
          },
        });
        const persisted = await this.persistFrontierNode({
          runId: options.run.id,
          parentNodeId: options.node.id,
          orgId: options.node.orgId,
          url: candidate.url,
          canonicalUrl: canonical?.canonicalUrl,
          urlFingerprint: canonical?.fingerprint,
          pageType: candidate.pageType,
          depth:
            candidate.pageType === 'article'
              ? Math.min(options.run.maxDepth, 3)
              : 1,
          queueClass,
          status: 'queued',
          score: candidate.score,
          freshnessScore: candidate.freshnessScore,
          queuedAt: new Date(),
          metadata: toPrismaJsonValue(
            mergeMetadataRecords(candidate.metadata, {
              sourceTier: options.profile.config.sourceTier ?? 'tier2',
            }),
          ),
        });
        const node = persisted.node;
        seenFingerprints.add(dedupeKey);
        if (persisted.created) {
          countsByPageType[candidate.pageType] += 1;
          created += 1;
          if (candidate.pageType === 'list') {
            listPagesCreated += 1;
          }
        }
        if (persisted.created || node.status === 'pending') {
          await this.queueService.enqueueFrontierNode({
            orgId: options.node.orgId,
            taskId: options.taskId,
            frontierRunId: options.run.id,
            frontierNodeId: node.id,
            priorityClass: queueClass,
          });
        }
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: {
            ...candidate,
            metadata:
              mergeMetadataRecords(candidate.metadata, {
                canonicalUrl: canonical?.canonicalUrl ?? null,
                urlFingerprint: canonical?.fingerprint ?? null,
                queuedNodeId: node.id,
                queueClass,
              }) ?? candidate.metadata,
          },
          nodeId: options.node.id,
          nodeType: 'persist-result',
          action: 'persisted',
          message: 'Seed candidate materialized into queued frontier node',
          status: 'selected',
          accepted: true,
          ruleHits: ['selected_for_persistence', 'queued_frontier_node'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'selected',
            rejectedReason: null,
          }),
        });
      }
    } else if (options.workflowRunId) {
      for (const candidate of normalizedCandidates) {
        const branchSnapshot = this.buildCandidateSnapshot({
          url: candidate.url,
          pageType: candidate.pageType,
          score: null,
          freshnessScore: null,
          status: 'active',
          rejectedReason: null,
        });
        const freshnessSnapshot = this.buildCandidateSnapshot({
          url: candidate.url,
          pageType: candidate.pageType,
          score: null,
          freshnessScore: candidate.freshnessScore,
          status: 'active',
          rejectedReason: null,
        });
        const activeSnapshot = this.buildCandidateSnapshot({
          ...candidate,
          status: 'active',
          rejectedReason: null,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'branch',
          action: 'branched',
          message: 'Seed candidate entered the root seed branch',
          status: 'active',
          accepted: true,
          ruleHits: ['seed_branch_selected'],
          beforeSnapshot: branchSnapshot,
          afterSnapshot: branchSnapshot,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'freshness-scorer',
          action: 'scored',
          message: 'Seed candidate freshness scored from sitemap signals',
          status: 'active',
          accepted: true,
          freshnessDelta:
            typeof candidate.freshnessScore === 'number'
              ? candidate.freshnessScore
              : undefined,
          ruleHits: ['freshness_scored'],
          beforeSnapshot: branchSnapshot,
          afterSnapshot: freshnessSnapshot,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'url-scorer',
          action: 'scored',
          message: 'Seed candidate scored for frontier persistence',
          status: 'active',
          accepted: true,
          scoreDelta:
            typeof candidate.score === 'number' ? candidate.score : undefined,
          ruleHits: ['url_scored', 'seed_scored'],
          beforeSnapshot: freshnessSnapshot,
          afterSnapshot: activeSnapshot,
        });
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'content-filter',
          action: 'filtered',
          message: 'Seed candidate dropped by the seed quality gate',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'seed_low_quality',
          ruleHits: ['seed_low_quality'],
          beforeSnapshot: activeSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...candidate,
            status: 'rejected',
            rejectedReason: 'seed_low_quality',
          }),
        });
      }
    }

    if (options.workflowRunId && (!qualityPassed || created === 0)) {
      const triggerReason = !qualityPassed ? 'seed_low_quality' : 'seed_no_nodes_created';
      await this.strategyRecorder.appendEvent(options.workflowRunId, {
        level: 'warn',
        eventType: 'seed_to_frontier_fallback',
        nodeId: options.node.id,
        nodeType: 'fallback-strategy',
        message: 'Seed discovery did not produce durable nodes; frontier path remains active',
        triggerReason,
        beforeCount: selectedCount,
        afterCount: created,
        rescuedCount: created,
        details: {
          qualityPassed,
          articleRatio,
          noiseRatio,
          freshRatio,
          qualityThresholds,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (options.workflowRunId) {
      await this.strategyRecorder.upsertStep(options.workflowRunId, {
        stepKey: `frontier:${options.node.id}:materialize-seed`,
        nodeId: `legacy::seed:${options.node.id}`,
        nodeType: 'seed-discovery',
        label: 'Materialize sitemap seed candidates',
        status: qualityPassed ? 'completed' : 'failed',
        durationMs: 0,
        inputCount: normalizedCandidates.length,
        outputCount: created,
        rejectedCount: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
        sampleUrls: normalizedCandidates.slice(0, 5).map((candidate) => candidate.url),
        metrics: {
          qualityPassed,
          articleRatio,
          noiseRatio,
          freshRatio,
          selectedPageTypeCounts,
          rejectionCounts,
          qualityThresholds,
        },
        error: qualityPassed ? null : 'seed_low_quality',
      });
    }

    const diagnostics: Record<string, unknown> = {
      seedOrigin: 'sitemap',
      seedMethod:
        typeof options.sitemapDiagnostics.seedMethod === 'string'
          ? options.sitemapDiagnostics.seedMethod
          : null,
      seedDiscoveryMode:
        typeof options.sitemapDiagnostics.discoveryMode === 'string'
          ? options.sitemapDiagnostics.discoveryMode
          : null,
      seedDiagnostics: options.sitemapDiagnostics,
      seedYield: {
        discovered: candidateCount,
        selected: selectedCount,
        created,
        fresh: freshCount,
      },
      seedQuality: {
        passed: qualityPassed,
        articleRatio,
        noiseRatio,
        freshRatio,
        thresholds: qualityThresholds,
      },
      seedSelectedPageTypeCounts: selectedPageTypeCounts,
      seedRejectionCounts: rejectionCounts,
      fallbackStage: qualityPassed && created > 0 ? 'seed' : 'frontier',
      warningFlags:
        uniqueStringList(
          !qualityPassed ? ['seed_low_quality'] : undefined,
          created === 0 ? ['seed_no_nodes_created'] : undefined,
          Array.isArray(options.llmDiagnostics?.warningFlags)
            ? (options.llmDiagnostics.warningFlags as string[])
            : undefined,
        ) ?? [],
      candidateStats: {
        scanned: candidateCount,
        unique: candidateCount,
        accepted: selectedCount,
        selected: created,
        rejected: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
        trimmed: Math.max(0, selectedCount - created),
      },
      rejectionCounts,
    };

    return {
      created,
      selectedPageTypeCounts,
      diagnostics: mergeMetadataRecords(diagnostics, options.llmDiagnostics) ?? diagnostics,
    };
  }

  async materializeNativeDiscoveryCandidates(options: {
    workflowRunId?: string | null;
    node: CrawlFrontierNodeRecord;
    run: {
      id: string;
      maxDepth: number;
      maxPages: number;
    };
    profile: CrawlSiteProfileRecord;
    persistedResults: {
      id: string;
      sourceUrl: string;
    }[];
    rawResultsByUrl: Map<string, Crawl4aiArticle>;
  }): Promise<CrawlStrategyNativeDiscoveryMaterialization> {
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
        .map((entry) => entry.urlFingerprint ?? entry.canonicalUrl ?? '')
        .filter((entry) => entry.length > 0),
    );
    const countsByPageType = this.createPageTypeCountRecord();
    for (const entry of existingNodesForRun) {
      countsByPageType[entry.pageType] += 1;
    }
    const rootSelfCanonical = buildCanonicalUrlFingerprint(
      options.node.url,
      options.profile.config.urlQueryParamAllowlist,
    );
    const rootSelfKey =
      rootSelfCanonical?.fingerprint ??
      rootSelfCanonical?.canonicalUrl ??
      options.node.url;
    const remainingBudget = Math.max(0, options.run.maxPages - existingNodesForRun.length);

    const scannedSourceUrls = new Set<string>();
    const rejectionCounts: Record<string, number> = {};
    const acceptedPageTypeCounts = this.createPageTypeCountRecord();
    const selectedPageTypeCounts = this.createPageTypeCountRecord();
    const nativeWarningFlags = new Set<string>();
    let acceptedCount = 0;
    let createdCount = 0;

    for (const result of options.persistedResults) {
      const sourceUrl =
        typeof result.sourceUrl === 'string' && result.sourceUrl.length > 0
          ? result.sourceUrl
          : '';
      if (!sourceUrl) {
        bumpCount(rejectionCounts, 'invalid_source_url');
        continue;
      }

      const unresolvedSnapshot = this.buildCandidateSnapshot({
        url: sourceUrl,
        status: 'active',
        rejectedReason: null,
      });

      if (scannedSourceUrls.has(sourceUrl)) {
        bumpCount(rejectionCounts, 'duplicate_source_url');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: {
            url: sourceUrl,
            metadata: {},
          },
          nodeId: options.node.id,
          nodeType: 'deep-discovery',
          action: 'filtered',
          message: 'Rejected duplicate source URL from native discovery',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'duplicate_source_url',
          ruleHits: ['duplicate_source_url'],
          beforeSnapshot: unresolvedSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            url: sourceUrl,
            status: 'rejected',
            rejectedReason: 'duplicate_source_url',
          }),
        });
        continue;
      }
      scannedSourceUrls.add(sourceUrl);
      if (sourceUrl === options.node.url) {
        bumpCount(rejectionCounts, 'self_url');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: {
            url: sourceUrl,
            metadata: {},
          },
          nodeId: options.node.id,
          nodeType: 'deep-discovery',
          action: 'filtered',
          message: 'Rejected self URL from native discovery',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'self_url',
          ruleHits: ['self_url'],
          beforeSnapshot: unresolvedSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            url: sourceUrl,
            status: 'rejected',
            rejectedReason: 'self_url',
          }),
        });
        continue;
      }
      const rejectionReason = shouldRejectFrontierUrl({
        url: sourceUrl,
        config: options.profile.config,
        requireSameDomainHost: sameDomainHost,
      });
      if (rejectionReason) {
        bumpCount(rejectionCounts, rejectionReason);
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: {
            url: sourceUrl,
            metadata: {},
          },
          nodeId: options.node.id,
          nodeType: 'url-filter',
          action: 'filtered',
          message: `Rejected native candidate: ${rejectionReason}`,
          status: 'rejected',
          accepted: false,
          rejectedReason: rejectionReason,
          ruleHits: [rejectionReason],
          beforeSnapshot: unresolvedSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            url: sourceUrl,
            status: 'rejected',
            rejectedReason: rejectionReason,
          }),
        });
        continue;
      }

      const canonical = buildCanonicalUrlFingerprint(
        sourceUrl,
        options.profile.config.urlQueryParamAllowlist,
      );
      const dedupeKey =
        canonical?.fingerprint ?? canonical?.canonicalUrl ?? sourceUrl;
      if (dedupeKey === rootSelfKey) {
        bumpCount(rejectionCounts, 'self_canonical');
        const candidate = {
          url: sourceUrl,
          metadata: {
            canonicalUrl: canonical?.canonicalUrl ?? null,
            urlFingerprint: canonical?.fingerprint ?? null,
          },
        };
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate,
          nodeId: options.node.id,
          nodeType: 'url-filter',
          action: 'filtered',
          message: 'Rejected self canonical URL from native discovery',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'self_canonical',
          ruleHits: ['self_canonical'],
          beforeSnapshot: unresolvedSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            url: sourceUrl,
            status: 'rejected',
            rejectedReason: 'self_canonical',
          }),
        });
        continue;
      }
      if (seenFingerprints.has(dedupeKey)) {
        bumpCount(rejectionCounts, 'duplicate');
        const duplicateCandidate = {
          url: sourceUrl,
          metadata: {
            canonicalUrl: canonical?.canonicalUrl ?? null,
            urlFingerprint: canonical?.fingerprint ?? null,
          },
        };
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: duplicateCandidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected duplicate native candidate',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'duplicate',
          ruleHits: ['duplicate'],
          beforeSnapshot: unresolvedSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            url: sourceUrl,
            status: 'rejected',
            rejectedReason: 'duplicate',
          }),
        });
        continue;
      }

      const pageType = inferFrontierPageType({
        url: sourceUrl,
        parentPageType: options.node.pageType,
        config: options.profile.config,
      });
      acceptedPageTypeCounts[pageType] += 1;
      acceptedCount += 1;
      const classifiedCandidate = {
        url: sourceUrl,
        pageType,
        metadata: {
          canonicalUrl: canonical?.canonicalUrl ?? null,
          urlFingerprint: canonical?.fingerprint ?? null,
        },
      };
      const classifiedSnapshot = this.buildCandidateSnapshot({
        ...classifiedCandidate,
        status: 'active',
        rejectedReason: null,
      });
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate: classifiedCandidate,
        nodeId: options.node.id,
        nodeType: 'page-type-classifier',
        action: 'classified',
        message: `Classified native candidate as ${pageType}`,
        status: 'active',
        accepted: true,
        beforeSnapshot: unresolvedSnapshot,
        afterSnapshot: classifiedSnapshot,
        details: { pageType },
      });

      const freshnessScore = estimateFreshnessScore(sourceUrl, options.profile.config);
      const score = scoreFrontierCandidate({
        url: sourceUrl,
        pageType,
        parentPageType: options.node.pageType,
        config: options.profile.config,
        rawScore: 1,
        freshnessScore,
      });
      const rawResult = options.rawResultsByUrl.get(sourceUrl);
      const statusCode =
        typeof rawResult?.statusCode === 'number'
          ? rawResult.statusCode
          : typeof rawResult?.status_code === 'number'
            ? rawResult.status_code
            : null;
      const crawlError =
        typeof rawResult?.error === 'string'
          ? rawResult.error
          : typeof rawResult?.errorMessage === 'string'
            ? rawResult.errorMessage
            : typeof rawResult?.error_message === 'string'
              ? rawResult.error_message
              : null;
      let failureKind = classifyFrontierFailureKind(crawlError);
      if (
        !failureKind &&
        typeof statusCode === 'number' &&
        [401, 403, 429].includes(statusCode)
      ) {
        failureKind = 'challenge_detected';
      }
      const warningFlags =
        uniqueStringList(
          failureKind ? [failureKind] : undefined,
          typeof statusCode === 'number' && statusCode >= 400
            ? [`http_${statusCode}`]
            : undefined,
        ) ?? [];
      for (const flag of warningFlags) {
        nativeWarningFlags.add(flag);
      }
      const scoredCandidate = {
        ...classifiedCandidate,
        score,
        freshnessScore,
        metadata: {
          ...classifiedCandidate.metadata,
          failureKind,
          warningFlags,
        },
      };
      const scoredSnapshot = this.buildCandidateSnapshot({
        ...scoredCandidate,
        status: 'active',
        rejectedReason: null,
      });
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate: scoredCandidate,
        nodeId: options.node.id,
        nodeType: 'url-scorer',
        action: 'scored',
        message: 'Native discovery candidate scored for persistence',
        status: 'active',
        accepted: true,
        scoreDelta: score,
        freshnessDelta: freshnessScore,
        ruleHits: ['url_scored', 'native_scored'],
        beforeSnapshot: classifiedSnapshot,
        afterSnapshot: scoredSnapshot,
      });
      const compositeScore = Number((score + freshnessScore).toFixed(4));
      if (createdCount >= remainingBudget) {
        bumpCount(rejectionCounts, 'run_budget_exhausted');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: scoredCandidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected native candidate because run budget was exhausted',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'run_budget_exhausted',
          ruleHits: ['run_budget_exhausted'],
          beforeSnapshot: scoredSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...scoredCandidate,
            status: 'rejected',
            rejectedReason: 'run_budget_exhausted',
          }),
          details: {
            compositeScore,
            existingNodeCount: existingNodesForRun.length,
            maxPages: options.run.maxPages,
          },
        });
        break;
      }
      if (countsByPageType[pageType] >= pageTypeBudgets[pageType]) {
        bumpCount(rejectionCounts, 'page_type_budget');
        await this.recordCandidateDecision({
          workflowRunId: options.workflowRunId,
          sourceNodeId: options.node.id,
          candidate: scoredCandidate,
          nodeId: options.node.id,
          nodeType: 'budget-control',
          action: 'budgeted',
          message: 'Rejected native candidate because page type budget was exhausted',
          status: 'rejected',
          accepted: false,
          rejectedReason: 'page_type_budget',
          ruleHits: ['page_type_budget'],
          beforeSnapshot: scoredSnapshot,
          afterSnapshot: this.buildCandidateSnapshot({
            ...scoredCandidate,
            status: 'rejected',
            rejectedReason: 'page_type_budget',
          }),
          details: {
            compositeScore,
            pageType,
            pageTypeBudget: pageTypeBudgets[pageType],
            currentPageTypeCount: countsByPageType[pageType],
          },
        });
        continue;
      }

      const queueClass = resolveNodeQueueClass({
        pageType,
        freshnessScore,
      });
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate: scoredCandidate,
        nodeId: options.node.id,
        nodeType: 'budget-control',
        action: 'budgeted',
        message: 'Kept native candidate within materialization budget',
        status: 'active',
        accepted: true,
        ruleHits: ['kept_by_budget'],
        beforeSnapshot: scoredSnapshot,
        afterSnapshot: scoredSnapshot,
        details: {
          compositeScore,
          queueClass,
          pageType,
        },
      });

      const persisted = await this.persistFrontierNode({
        runId: options.run.id,
        parentNodeId: options.node.id,
        orgId: options.node.orgId,
        url: sourceUrl,
        canonicalUrl: canonical?.canonicalUrl,
        urlFingerprint: canonical?.fingerprint,
        pageType,
        depth: Math.min(options.run.maxDepth, pageType === 'article' ? 3 : 1),
        queueClass,
        status: 'completed',
        crawledAt: new Date(),
        crawlResultId: result.id,
        score,
        freshnessScore,
        metadata: toPrismaJsonValue({
          nativeDiscovered: true,
          sourceTier: options.profile.config.sourceTier ?? 'tier2',
          discoveryPath: ['home', pageType],
          frontierPath: ['home', pageType],
          failureKind,
          warningFlags,
          freshnessBucket: resolveFreshnessBucket(freshnessScore),
        }),
      });
      if (persisted.created) {
        countsByPageType[pageType] += 1;
        selectedPageTypeCounts[pageType] += 1;
        createdCount += 1;
      }
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.node.id,
        candidate: scoredCandidate,
        nodeId: options.node.id,
        nodeType: 'persist-result',
        action: 'persisted',
        message: 'Native candidate materialized into frontier topology',
        status: 'selected',
        accepted: true,
        ruleHits: ['selected_for_persistence', 'native_discovery'],
        beforeSnapshot: scoredSnapshot,
        afterSnapshot: this.buildCandidateSnapshot({
          ...scoredCandidate,
          status: 'selected',
          rejectedReason: null,
        }),
        details: {
          compositeScore,
          queueClass,
        },
      });
      seenFingerprints.add(dedupeKey);
    }

    if (options.workflowRunId) {
      await this.strategyRecorder.upsertStep(options.workflowRunId, {
        stepKey: `frontier:${options.node.id}:materialize-native`,
        nodeId: `legacy::native-materialize:${options.node.id}`,
        nodeType: 'persist-result',
        label: 'Materialize native discovery candidates',
        status: 'completed',
        durationMs: 0,
        inputCount: options.persistedResults.length,
        outputCount: createdCount,
        rejectedCount: Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0),
        sampleUrls: Array.from(scannedSourceUrls).slice(0, 5),
        metrics: {
          acceptedCount,
          createdCount,
          selectedPageTypeCounts,
          rejectionCounts,
          nativeWarningFlags: Array.from(nativeWarningFlags),
        },
      });
    }

    return {
      acceptedCount,
      createdCount,
      scannedSourceUrls: Array.from(scannedSourceUrls),
      rejectionCounts,
      acceptedPageTypeCounts,
      selectedPageTypeCounts,
      nativeWarningFlags: Array.from(nativeWarningFlags),
    };
  }

  async recordExtractionCandidateDecisions(options: {
    workflowRunId?: string | null;
    sourceNodeId: string;
    decisions: CrawlStrategyLayeredCandidateDecision[];
  }) {
    if (!options.workflowRunId || options.decisions.length === 0) {
      return;
    }
    for (const decision of options.decisions) {
      await this.recordCandidateDecision({
        workflowRunId: options.workflowRunId,
        sourceNodeId: options.sourceNodeId,
        candidate: decision.candidate,
        nodeId: options.sourceNodeId,
        nodeType: decision.nodeType,
        action: decision.action,
        message: decision.message,
        status: decision.status,
        accepted: decision.accepted,
        rejectedReason: decision.rejectedReason,
        ruleHits: decision.ruleHits,
        beforeSnapshot: decision.beforeSnapshot,
        afterSnapshot: decision.afterSnapshot,
        scoreDelta: decision.scoreDelta,
        freshnessDelta: decision.freshnessDelta,
        details: decision.details,
      });
    }
  }

  async recordCandidateDecision(options: {
    workflowRunId?: string | null;
    sourceNodeId: string;
    candidate: CrawlStrategyLayeredTraceCandidate;
    nodeId: string;
    nodeType: string;
    action:
      | 'discovered'
      | 'classified'
      | 'filtered'
      | 'scored'
      | 'branched'
      | 'budgeted'
      | 'fallback'
      | 'persisted';
    message: string;
    status: 'active' | 'selected' | 'rejected';
    accepted?: boolean;
    rejectedReason?: string | null;
    ruleHits?: string[];
    beforeSnapshot?: Record<string, unknown>;
    afterSnapshot?: Record<string, unknown>;
    scoreDelta?: number;
    freshnessDelta?: number;
    details?: Record<string, unknown>;
  }) {
    if (!options.workflowRunId) {
      return;
    }
    const workflowCandidate = this.toWorkflowCandidate({
      sourceNodeId: options.sourceNodeId,
      candidate: options.candidate,
      status: options.status,
      rejectedByNodeId: options.status === 'rejected' ? options.nodeId : null,
      rejectedReason: options.rejectedReason ?? null,
    });
    await this.strategyRecorder.recordCandidateTrace(
      options.workflowRunId,
      workflowCandidate,
      {
        nodeId: options.nodeId,
        nodeType: options.nodeType,
        action: options.action,
        message: options.message,
        accepted: options.accepted,
        scoreDelta: options.scoreDelta,
        freshnessDelta: options.freshnessDelta,
        ruleHits: options.ruleHits,
        rejectedReason: options.rejectedReason ?? null,
        beforeSnapshot: options.beforeSnapshot,
        afterSnapshot:
          options.afterSnapshot ?? this.buildCandidateSnapshot(workflowCandidate),
        details: options.details,
        timestamp: new Date().toISOString(),
      },
    );
  }

  private toWorkflowCandidate(options: {
    sourceNodeId: string;
    candidate: CrawlStrategyLayeredTraceCandidate;
    status: 'active' | 'selected' | 'rejected';
    rejectedByNodeId?: string | null;
    rejectedReason?: string | null;
  }): CrawlStrategyWorkflowCandidate {
    const metadata = mergeMetadataRecords(options.candidate.metadata ?? {}, {
      candidateKey:
        typeof options.candidate.metadata?.urlFingerprint === 'string'
          ? options.candidate.metadata.urlFingerprint
          : typeof options.candidate.metadata?.canonicalUrl === 'string'
            ? options.candidate.metadata.canonicalUrl
            : options.candidate.url,
    }) ?? {};
    return {
      id: `${options.sourceNodeId}:${options.candidate.url}`,
      url: options.candidate.url,
      pageType:
        (options.candidate.pageType as CrawlFrontierPageType | undefined) ??
        undefined,
      relevanceScore:
        typeof options.candidate.relevanceScore === 'number'
          ? options.candidate.relevanceScore
          : undefined,
      score:
        typeof options.candidate.score === 'number'
          ? options.candidate.score
          : undefined,
      freshnessScore:
        typeof options.candidate.freshnessScore === 'number'
          ? options.candidate.freshnessScore
          : undefined,
      qualityScore: undefined,
      publishedAt:
        typeof metadata.seedPublishedAt === 'string'
          ? metadata.seedPublishedAt
          : null,
      crawledAt:
        typeof metadata.seedCrawledAt === 'string'
          ? metadata.seedCrawledAt
          : null,
      effectiveAt:
        typeof metadata.seedPublishedAt === 'string'
          ? metadata.seedPublishedAt
          : typeof metadata.seedCrawledAt === 'string'
            ? metadata.seedCrawledAt
            : null,
      status: options.status,
      rejectedByNodeId: options.rejectedByNodeId ?? null,
      rejectedReason: options.rejectedReason ?? null,
      sourceNodeId: options.sourceNodeId,
      metadata,
      trace: [],
    };
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

  private createPageTypeCountRecord(): Record<CrawlFrontierPageType, number> {
    return {
      home: 0,
      category: 0,
      list: 0,
      article: 0,
    };
  }

  private async persistFrontierNode(data: Prisma.CrawlFrontierNodeUncheckedCreateInput): Promise<{
    node: { id: string; status: string };
    created: boolean;
  }> {
    const fingerprint =
      typeof data.urlFingerprint === 'string' && data.urlFingerprint.trim()
        ? data.urlFingerprint.trim()
        : null;
    const runId = typeof data.runId === 'string' ? data.runId : null;

    if (!fingerprint || !runId) {
      const node = await this.prisma.crawlFrontierNode.create({ data });
      return { node, created: true };
    }

    const existing = await this.prisma.crawlFrontierNode.findUnique({
      where: {
        runId_urlFingerprint: { runId, urlFingerprint: fingerprint },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      return { node: existing, created: false };
    }

    try {
      const node = await this.prisma.crawlFrontierNode.create({
        data: { ...data, urlFingerprint: fingerprint },
      });
      return { node, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.crawlFrontierNode.findUnique({
          where: {
            runId_urlFingerprint: { runId, urlFingerprint: fingerprint },
          },
          select: { id: true, status: true },
        });
        if (raced) {
          return { node: raced, created: false };
        }
      }
      throw error;
    }
  }

  private clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }
}
