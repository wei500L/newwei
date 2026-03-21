import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { PrismaService } from '../config/prisma.service';

import {
  isRecord,
  type CrawlStrategyCandidateTraceEntry,
  type CrawlStrategyParameterSource,
  type CrawlStrategyWorkflowCandidate,
  type CrawlStrategyWorkflowDefinition,
  type CrawlStrategyWorkflowOrigin,
  type CrawlStrategyWorkflowRunEvent,
  type CrawlStrategyWorkflowStepResult,
} from './crawl-strategy.types';

interface CreateWorkflowRunInput {
  orgId: string;
  createdById: string;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowOrigin?: CrawlStrategyWorkflowOrigin;
  profileId?: string | null;
  newsSourceId?: string | null;
  frontierRunId?: string | null;
  status?: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
  runKind: string;
  input?: Record<string, unknown> | null;
  graphSnapshot: CrawlStrategyWorkflowDefinition;
  parameterSources?: CrawlStrategyParameterSource[];
  startedAt?: Date | null;
}

interface FinalizeWorkflowRunInput {
  status: 'completed' | 'failed' | 'canceled' | 'running' | 'queued' | 'pending';
  output?: Record<string, unknown> | null;
  steps?: CrawlStrategyWorkflowStepResult[];
  candidates?: CrawlStrategyWorkflowCandidate[];
  parameterSources?: CrawlStrategyParameterSource[];
  events?: CrawlStrategyWorkflowRunEvent[];
  error?: string | null;
  finishedAt?: Date | null;
}

type WorkflowRunRecord = Prisma.CrawlStrategyWorkflowRunGetPayload<{
  include: {
    workflow: true;
    workflowVersion: true;
    frontierRun: true;
  };
}>;

@Injectable()
export class CrawlStrategyRunRecorderService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(input: CreateWorkflowRunInput) {
    const run = await this.prisma.crawlStrategyWorkflowRun.create({
      data: {
        orgId: input.orgId,
        workflowId: input.workflowId ?? null,
        workflowVersionId: input.workflowVersionId ?? null,
        workflowOrigin: input.workflowOrigin ?? 'bound',
        profileId: input.profileId ?? null,
        newsSourceId: input.newsSourceId ?? null,
        status: input.status ?? 'running',
        runKind: input.runKind,
        input: toPrismaJsonValue(input.input ?? {}),
        graphSnapshot: toPrismaJsonValue(input.graphSnapshot),
        parameterSources: toPrismaJsonValue(input.parameterSources ?? []),
        createdById: input.createdById,
        startedAt: input.startedAt ?? null,
      },
    });

    if (input.frontierRunId) {
      await this.prisma.crawlFrontierRun.update({
        where: { id: input.frontierRunId },
        data: {
          workflowRunId: run.id,
        },
      });
    }

    return run;
  }

  async attachFrontierRun(frontierRunId: string, workflowRunId: string) {
    await this.prisma.crawlFrontierRun.update({
      where: { id: frontierRunId },
      data: {
        workflowRunId,
      },
    });
  }

  async finalizeRun(runId: string, input: FinalizeWorkflowRunInput) {
    await this.prisma.$transaction(async (tx) => {
      if (input.steps) {
        await tx.crawlStrategyWorkflowRunStep.deleteMany({
          where: { runId },
        });
        if (input.steps.length > 0) {
          await tx.crawlStrategyWorkflowRunStep.createMany({
            data: input.steps.map((step, index) => ({
              runId,
              stepKey: step.stepKey ?? step.nodeId,
              sequence: index + 1,
              workflowNodeId: step.nodeId,
              nodeType: step.nodeType,
              label: step.label,
              status: step.status,
              startedAt: null,
              finishedAt: null,
              durationMs: step.durationMs,
              inputCount: step.inputCount,
              outputCount: step.outputCount,
              rejectedCount: step.rejectedCount,
              sampleUrls: toPrismaJsonValue(step.sampleUrls),
              metrics: toPrismaJsonValue(step.metrics ?? {}),
              error: step.error ?? null,
              metadata: toPrismaJsonValue({}),
            })),
          });
        }
      }

      if (input.events) {
        await tx.crawlStrategyWorkflowRunEvent.deleteMany({
          where: { runId },
        });
        if (input.events.length > 0) {
          await tx.crawlStrategyWorkflowRunEvent.createMany({
            data: input.events.map((event, index) => ({
              runId,
              sequence: index + 1,
              level: event.level,
              eventType: event.eventType,
              nodeId: event.nodeId ?? null,
              nodeType: event.nodeType ?? null,
              message: event.message,
              triggerReason: event.triggerReason ?? null,
              beforeCount: event.beforeCount ?? null,
              afterCount: event.afterCount ?? null,
              rescuedCount: event.rescuedCount ?? null,
              details: toPrismaJsonValue(event.details ?? {}),
              createdAt: new Date(event.timestamp),
            })),
          });
        }
      }

      if (input.candidates) {
        await tx.crawlStrategyWorkflowRunCandidateTrace.deleteMany({
          where: {
            candidate: {
              runId,
            },
          },
        });
        await tx.crawlStrategyWorkflowRunCandidate.deleteMany({
          where: { runId },
        });

        for (const candidate of input.candidates) {
          const createdCandidate =
            await tx.crawlStrategyWorkflowRunCandidate.create({
              data: this.buildCandidateCreateData(runId, candidate),
            });
          if (candidate.trace.length > 0) {
            await tx.crawlStrategyWorkflowRunCandidateTrace.createMany({
              data: candidate.trace.map((trace, index) =>
                this.buildTraceCreateManyData(createdCandidate.id, trace, index + 1),
              ),
            });
          }
        }
      }

      await tx.crawlStrategyWorkflowRun.update({
        where: { id: runId },
        data: {
          status: input.status,
          output: toPrismaJsonValue(input.output ?? {}),
          stepResults: toPrismaJsonValue(input.steps ?? []),
          candidates: toPrismaJsonValue(input.candidates ?? []),
          parameterSources: toPrismaJsonValue(input.parameterSources ?? []),
          stepCount: input.steps?.length ?? undefined,
          candidateCount: input.candidates?.length ?? undefined,
          selectedCount:
            input.candidates?.filter((candidate) => candidate.status === 'selected')
              .length ?? undefined,
          error: input.error ?? null,
          finishedAt: input.finishedAt ?? null,
        },
      });
    });
  }

  async appendEvent(
    runId: string,
    input: Omit<CrawlStrategyWorkflowRunEvent, 'sequence' | 'id'>,
  ) {
    const sequence =
      (await this.prisma.crawlStrategyWorkflowRunEvent.count({
        where: { runId },
      })) + 1;
    await this.prisma.crawlStrategyWorkflowRunEvent.create({
      data: {
        runId,
        sequence,
        level: input.level,
        eventType: input.eventType,
        nodeId: input.nodeId ?? null,
        nodeType: input.nodeType ?? null,
        message: input.message,
        triggerReason: input.triggerReason ?? null,
        beforeCount: input.beforeCount ?? null,
        afterCount: input.afterCount ?? null,
        rescuedCount: input.rescuedCount ?? null,
        details: toPrismaJsonValue(input.details ?? {}),
        createdAt: new Date(input.timestamp),
      },
    });
  }

  async upsertStep(
    runId: string,
    input: CrawlStrategyWorkflowStepResult & { stepKey?: string; startedAt?: Date | null; finishedAt?: Date | null; metadata?: Record<string, unknown> },
  ) {
    const stepKey = input.stepKey ?? input.nodeId;
    const existing = await this.prisma.crawlStrategyWorkflowRunStep.findUnique({
      where: {
        runId_stepKey: {
          runId,
          stepKey,
        },
      },
      select: {
        id: true,
        sequence: true,
      },
    });
    const sequence =
      existing?.sequence ??
      ((await this.prisma.crawlStrategyWorkflowRunStep.count({
        where: { runId },
      })) + 1);

    await this.prisma.crawlStrategyWorkflowRunStep.upsert({
      where: {
        runId_stepKey: {
          runId,
          stepKey,
        },
      },
      create: {
        runId,
        stepKey,
        sequence,
        workflowNodeId: input.nodeId,
        nodeType: input.nodeType,
        label: input.label,
        status: input.status,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        durationMs: input.durationMs,
        inputCount: input.inputCount,
        outputCount: input.outputCount,
        rejectedCount: input.rejectedCount,
        sampleUrls: toPrismaJsonValue(input.sampleUrls),
        metrics: toPrismaJsonValue(input.metrics ?? {}),
        error: input.error ?? null,
        metadata: toPrismaJsonValue(input.metadata ?? {}),
      },
      update: {
        workflowNodeId: input.nodeId,
        nodeType: input.nodeType,
        label: input.label,
        status: input.status,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        durationMs: input.durationMs,
        inputCount: input.inputCount,
        outputCount: input.outputCount,
        rejectedCount: input.rejectedCount,
        sampleUrls: toPrismaJsonValue(input.sampleUrls),
        metrics: toPrismaJsonValue(input.metrics ?? {}),
        error: input.error ?? null,
        metadata: toPrismaJsonValue(input.metadata ?? {}),
      },
    });
  }

  async recordCandidateTrace(
    runId: string,
    candidate: CrawlStrategyWorkflowCandidate,
    trace: CrawlStrategyCandidateTraceEntry,
  ) {
    const candidateKey = this.buildCandidateKey(
      candidate.metadata?.candidateKey,
      candidate.url,
    );
    const upserted = await this.prisma.crawlStrategyWorkflowRunCandidate.upsert({
      where: {
        runId_candidateKey: {
          runId,
          candidateKey,
        },
      },
      create: this.buildCandidateCreateData(runId, candidate, candidateKey),
      update: {
        externalId: candidate.id,
        sourceNodeId: candidate.sourceNodeId,
        sourceNodeType: candidate.trace[0]?.nodeType ?? null,
        url: candidate.url,
        title: candidate.title ?? null,
        description: candidate.description ?? null,
        author: candidate.author ?? null,
        pageType: candidate.pageType ?? null,
        relevanceScore: this.toFiniteOrNull(candidate.relevanceScore),
        score: this.toFiniteOrNull(candidate.score),
        freshnessScore: this.toFiniteOrNull(candidate.freshnessScore),
        qualityScore: this.toFiniteOrNull(candidate.qualityScore),
        publishedAt: this.toDateOrNull(candidate.publishedAt),
        crawledAt: this.toDateOrNull(candidate.crawledAt),
        effectiveAt: this.toDateOrNull(candidate.effectiveAt),
        status: candidate.status,
        rejectedByNodeId: candidate.rejectedByNodeId ?? null,
        rejectedReason: candidate.rejectedReason ?? null,
        metadata: toPrismaJsonValue(candidate.metadata ?? {}),
      },
      select: {
        id: true,
        traceCount: true,
      },
    });

    await this.prisma.crawlStrategyWorkflowRunCandidateTrace.create({
      data: this.buildTraceCreateData(
        upserted.id,
        trace,
        upserted.traceCount + 1,
      ),
    });

    await this.prisma.crawlStrategyWorkflowRunCandidate.update({
      where: { id: upserted.id },
      data: {
        traceCount: { increment: 1 },
      },
    });
  }

  async updateRunCounts(runId: string, patch?: Record<string, unknown>) {
    const [stepCount, candidateCount, selectedCount, steps, candidates, events] =
      await Promise.all([
        this.prisma.crawlStrategyWorkflowRunStep.count({ where: { runId } }),
        this.prisma.crawlStrategyWorkflowRunCandidate.count({ where: { runId } }),
        this.prisma.crawlStrategyWorkflowRunCandidate.count({
          where: { runId, status: 'selected' },
        }),
        this.prisma.crawlStrategyWorkflowRunStep.findMany({
          where: { runId },
          orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
        }),
        this.prisma.crawlStrategyWorkflowRunCandidate.findMany({
          where: { runId },
          include: {
            traces: {
              orderBy: [{ sequence: 'asc' }, { timestamp: 'asc' }],
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        }),
        this.prisma.crawlStrategyWorkflowRunEvent.findMany({
          where: { runId },
          orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
        }),
      ]);

    await this.prisma.crawlStrategyWorkflowRun.update({
      where: { id: runId },
      data: {
        stepCount,
        candidateCount,
        selectedCount,
        stepResults: toPrismaJsonValue(
          steps.map((step) => this.mapStep(step)),
        ),
        candidates: toPrismaJsonValue(
          candidates.map((candidate) => this.mapCandidate(candidate)),
        ),
        output: toPrismaJsonValue({
          ...(patch ?? {}),
          eventCount: events.length,
          selectedCount,
          candidateCount,
          stepCount,
        }),
      },
    });
  }

  async markRunStatus(
    runId: string,
    input: {
      status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
      error?: string | null;
      finishedAt?: Date | null;
    },
  ) {
    await this.prisma.crawlStrategyWorkflowRun.update({
      where: { id: runId },
      data: {
        status: input.status,
        error: input.error ?? null,
        finishedAt:
          input.finishedAt === undefined ? undefined : input.finishedAt,
      },
    });
  }

  async getRun(orgId: string, runId: string) {
    const run = await this.prisma.crawlStrategyWorkflowRun.findUnique({
      where: { id: runId },
      include: {
        workflow: true,
        workflowVersion: true,
        frontierRun: true,
        steps: {
          orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
        },
        candidatesDetail: {
          include: {
            traces: {
              orderBy: [{ sequence: 'asc' }, { timestamp: 'asc' }],
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        },
        events: {
          orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException('Workflow run not found');
    }
    return this.mapRun(run);
  }

  async listRunCandidates(orgId: string, runId: string) {
    const run = await this.getRun(orgId, runId);
    return run.candidates;
  }

  async getCandidateExplanation(orgId: string, runId: string, candidateId: string) {
    const run = await this.getRun(orgId, runId);
    const candidate = run.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      throw new NotFoundException('Workflow candidate not found');
    }
    return candidate;
  }

  private mapRun(run: WorkflowRunRecord & {
    steps: Prisma.CrawlStrategyWorkflowRunStepGetPayload<{}>[];
    candidatesDetail: Prisma.CrawlStrategyWorkflowRunCandidateGetPayload<{
      include: {
        traces: true;
      };
    }>[];
    events: Prisma.CrawlStrategyWorkflowRunEventGetPayload<{}>[];
  }) {
    return {
      id: run.id,
      orgId: run.orgId,
      workflowOrigin: run.workflowOrigin,
      workflow: run.workflow
        ? {
            id: run.workflow.id,
            name: run.workflow.name,
          }
        : null,
      workflowVersion: run.workflowVersion
        ? {
            id: run.workflowVersion.id,
            version: run.workflowVersion.version,
            name: run.workflowVersion.name,
          }
        : null,
      frontierRunId: run.frontierRun?.id ?? null,
      status: run.status,
      runKind: run.runKind,
      input: isRecord(run.input) ? run.input : null,
      output: isRecord(run.output) ? run.output : null,
      graphSnapshot: isRecord(run.graphSnapshot) ? run.graphSnapshot : null,
      stepResults: run.steps.map((step) => this.mapStep(step)),
      candidates: run.candidatesDetail.map((candidate) =>
        this.mapCandidate(candidate),
      ),
      parameterSources: Array.isArray(run.parameterSources)
        ? run.parameterSources
        : [],
      systemEvents: run.events.map((event) => this.mapEvent(event)),
      stepCount: run.stepCount,
      candidateCount: run.candidateCount,
      selectedCount: run.selectedCount,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private mapStep(step: Prisma.CrawlStrategyWorkflowRunStepGetPayload<{}>) {
    return {
      stepKey: step.stepKey,
      nodeId: step.workflowNodeId ?? step.stepKey,
      nodeType: step.nodeType,
      label: step.label,
      status: step.status,
      durationMs: step.durationMs ?? 0,
      inputCount: step.inputCount,
      outputCount: step.outputCount,
      rejectedCount: step.rejectedCount,
      sampleUrls: Array.isArray(step.sampleUrls) ? step.sampleUrls : [],
      metrics: isRecord(step.metrics) ? step.metrics : undefined,
      error: step.error ?? null,
    };
  }

  private mapCandidate(
    candidate: Prisma.CrawlStrategyWorkflowRunCandidateGetPayload<{
      include: {
        traces: true;
      };
    }>,
  ) {
    return {
      id: candidate.externalId ?? candidate.id,
      url: candidate.url,
      title: candidate.title ?? undefined,
      description: candidate.description ?? undefined,
      author: candidate.author ?? undefined,
      pageType: candidate.pageType ?? undefined,
      relevanceScore: candidate.relevanceScore ?? undefined,
      score: candidate.score ?? undefined,
      freshnessScore: candidate.freshnessScore ?? undefined,
      qualityScore: candidate.qualityScore ?? undefined,
      publishedAt: candidate.publishedAt?.toISOString() ?? null,
      crawledAt: candidate.crawledAt?.toISOString() ?? null,
      effectiveAt: candidate.effectiveAt?.toISOString() ?? null,
      status: candidate.status,
      rejectedByNodeId: candidate.rejectedByNodeId ?? null,
      rejectedReason: candidate.rejectedReason ?? null,
      sourceNodeId: candidate.sourceNodeId ?? 'unknown',
      metadata: isRecord(candidate.metadata) ? candidate.metadata : {},
      trace: candidate.traces.map((trace) => ({
        nodeId: trace.nodeId,
        nodeType: trace.nodeType,
        action: trace.action,
        message: trace.message,
        accepted: trace.accepted ?? undefined,
        scoreDelta: trace.scoreDelta ?? undefined,
        freshnessDelta: trace.freshnessDelta ?? undefined,
        ruleHits: Array.isArray(trace.ruleHits) ? trace.ruleHits : undefined,
        rejectedReason:
          isRecord(trace.details) && typeof trace.details.rejectedReason === 'string'
            ? trace.details.rejectedReason
            : undefined,
        beforeSnapshot: isRecord(trace.beforeSnapshot)
          ? trace.beforeSnapshot
          : undefined,
        afterSnapshot: isRecord(trace.afterSnapshot)
          ? trace.afterSnapshot
          : undefined,
        details: isRecord(trace.details) ? trace.details : undefined,
        timestamp: trace.timestamp.toISOString(),
      })),
    };
  }

  private mapEvent(event: Prisma.CrawlStrategyWorkflowRunEventGetPayload<{}>) {
    return {
      id: event.id,
      sequence: event.sequence,
      level: event.level,
      eventType: event.eventType,
      nodeId: event.nodeId ?? null,
      nodeType: event.nodeType ?? null,
      message: event.message,
      triggerReason: event.triggerReason ?? null,
      beforeCount: event.beforeCount ?? null,
      afterCount: event.afterCount ?? null,
      rescuedCount: event.rescuedCount ?? null,
      details: isRecord(event.details) ? event.details : undefined,
      timestamp: event.createdAt.toISOString(),
    };
  }

  private buildCandidateCreateData(
    runId: string,
    candidate: CrawlStrategyWorkflowCandidate,
    candidateKey?: string,
  ): Prisma.CrawlStrategyWorkflowRunCandidateCreateInput {
    return {
      run: {
        connect: { id: runId },
      },
      candidateKey: candidateKey ?? this.buildCandidateKey(candidate.metadata?.candidateKey, candidate.url),
      externalId: candidate.id,
      sourceNodeId: candidate.sourceNodeId,
      sourceNodeType: candidate.trace[0]?.nodeType ?? null,
      url: candidate.url,
      title: candidate.title ?? null,
      description: candidate.description ?? null,
      author: candidate.author ?? null,
      pageType: candidate.pageType ?? null,
      relevanceScore: this.toFiniteOrNull(candidate.relevanceScore),
      score: this.toFiniteOrNull(candidate.score),
      freshnessScore: this.toFiniteOrNull(candidate.freshnessScore),
      qualityScore: this.toFiniteOrNull(candidate.qualityScore),
      publishedAt: this.toDateOrNull(candidate.publishedAt),
      crawledAt: this.toDateOrNull(candidate.crawledAt),
      effectiveAt: this.toDateOrNull(candidate.effectiveAt),
      status: candidate.status,
      rejectedByNodeId: candidate.rejectedByNodeId ?? null,
      rejectedReason: candidate.rejectedReason ?? null,
      metadata: toPrismaJsonValue(candidate.metadata ?? {}),
      traceCount: candidate.trace.length,
    };
  }

  private buildTraceCreateData(
    candidateId: string,
    trace: CrawlStrategyCandidateTraceEntry,
    sequence: number,
  ): Prisma.CrawlStrategyWorkflowRunCandidateTraceCreateInput {
    return {
      candidate: {
        connect: { id: candidateId },
      },
      sequence,
      timestamp: new Date(trace.timestamp),
      nodeId: trace.nodeId,
      nodeType: trace.nodeType,
      action: trace.action,
      message: trace.message,
      accepted: trace.accepted ?? null,
      scoreDelta: this.toFiniteOrNull(trace.scoreDelta),
      freshnessDelta: this.toFiniteOrNull(trace.freshnessDelta),
      ruleHits: toPrismaJsonValue(trace.ruleHits ?? []),
      beforeSnapshot: toPrismaJsonValue(trace.beforeSnapshot ?? {}),
      afterSnapshot: toPrismaJsonValue(trace.afterSnapshot ?? {}),
      details: toPrismaJsonValue({
        ...(trace.details ?? {}),
        ...(trace.rejectedReason ? { rejectedReason: trace.rejectedReason } : {}),
      }),
    };
  }

  private buildTraceCreateManyData(
    candidateId: string,
    trace: CrawlStrategyCandidateTraceEntry,
    sequence: number,
  ): Prisma.CrawlStrategyWorkflowRunCandidateTraceCreateManyInput {
    return {
      candidateId,
      sequence,
      timestamp: new Date(trace.timestamp),
      nodeId: trace.nodeId,
      nodeType: trace.nodeType,
      action: trace.action,
      message: trace.message,
      accepted: trace.accepted ?? null,
      scoreDelta: this.toFiniteOrNull(trace.scoreDelta),
      freshnessDelta: this.toFiniteOrNull(trace.freshnessDelta),
      ruleHits: toPrismaJsonValue(trace.ruleHits ?? []),
      beforeSnapshot: toPrismaJsonValue(trace.beforeSnapshot ?? {}),
      afterSnapshot: toPrismaJsonValue(trace.afterSnapshot ?? {}),
      details: toPrismaJsonValue({
        ...(trace.details ?? {}),
        ...(trace.rejectedReason ? { rejectedReason: trace.rejectedReason } : {}),
      }),
    };
  }

  private buildCandidateKey(rawCandidateKey: unknown, url: string) {
    if (typeof rawCandidateKey === 'string' && rawCandidateKey.trim().length > 0) {
      return rawCandidateKey.trim().slice(0, 191);
    }
    return createHash('sha256').update(url).digest('hex');
  }

  private toDateOrNull(value?: string | null) {
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private toFiniteOrNull(value?: number) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
