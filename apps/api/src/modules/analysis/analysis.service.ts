import { AnalysisResultModel, type AnalysisResultDocument } from "@modular/mongo";
import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
// eslint-disable-next-line import/no-unresolved
import { NotificationType } from "@prisma/client";
import type { Queue } from "bullmq";
import type { PubSubEngine } from "graphql-subscriptions";

import { EnvService } from "../config/config.service";
import { LiteLlmService, type LiteLlmMessage } from "../news-pipeline/litellm.service";
import { NotificationsService } from "../notifications/notifications.service";

import { AnalysisPromptService } from "./analysis-prompt.service";
import { ANALYSIS_QUEUE } from "./analysis.constants";
import { getPartialSummaryFromError, AnalysisStreamError } from "./analysis.errors";
import { ANALYSIS_PUBSUB } from "./analysis.pubsub";
import type { AnalysisJobPayload, AnomalyInput, CorrelationInput } from "./analysis.types";

const logger = createLogger({ name: "analysis-service" });

@Injectable()
export class AnalysisService {
  constructor(
    private readonly llm: LiteLlmService,
    private readonly env: EnvService,
    private readonly prompts: AnalysisPromptService,
    @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobPayload>,
    @Inject(ANALYSIS_PUBSUB) private readonly pubsub: PubSubEngine,
    private readonly notifications: NotificationsService
  ) {}

  async submitCorrelation(orgId: string, input: CorrelationInput, triggeredById?: string) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "correlation",
      status: "pending",
      input,
      triggeredById
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "correlation",
      { type: "correlation", analysisId: record.id, traceId },
      { jobId: `corr-${record.id}`, removeOnComplete: true, attempts: this.env.analysisConfig.maxRetries }
    );
    return record;
  }

  async submitAnomaly(orgId: string, input: AnomalyInput, triggeredById?: string) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "anomaly",
      status: "pending",
      input,
      triggeredById
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "anomaly",
      { type: "anomaly", analysisId: record.id, traceId },
      { jobId: `anomaly-${record.id}`, removeOnComplete: true, attempts: this.env.analysisConfig.maxRetries }
    );
    return record;
  }

  async listResults(orgId: string, limit = 50) {
    return AnalysisResultModel.find({ orgId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  async process(job: AnalysisJobPayload) {
    const record = await AnalysisResultModel.findById(job.analysisId);
    if (!record) {
      logger.warn({ job }, "Analysis record not found");
      return;
    }
    const createdAt = record.createdAt ? new Date(record.createdAt) : new Date();
    record.status = "running";
    await record.save();
    await this.publish(record.orgId, record.id, record.type, record.status, undefined, createdAt);

    try {
      if (job.type === "correlation") {
        const output = await this.runCorrelation(record.orgId, record.id, createdAt, record.input as CorrelationInput);
        record.output = output;
        record.summary = output.summary;
      } else {
        const output = await this.runAnomaly(record.orgId, record.id, createdAt, record.input as AnomalyInput);
        record.output = output;
        record.summary = output.summary;
      }
      record.status = "completed";
      await record.save();
      await this.publish(record.orgId, record.id, record.type, record.status, record.summary ?? undefined, createdAt);
      await this.notifyResult(record);
    } catch (error: unknown) {
      logger.error({ job, error }, "Analysis job failed");
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      const partialSummary = getPartialSummaryFromError(error);
      if (partialSummary) record.summary = partialSummary;
      await record.save();
      await this.publish(
        record.orgId,
        record.id,
        record.type,
        record.status,
        record.summary ?? undefined,
        createdAt,
        record.error ?? undefined
      );
      await this.notifyResult(record);
      throw error;
    }
  }

  private async notifyResult(record: AnalysisResultDocument) {
    if (!record.triggeredById) {
      return;
    }
    const analysisId = (record.id as string | undefined) ?? record._id?.toString?.() ?? "";
    try {
      await this.notifications.notify({
        orgId: record.orgId,
        userId: record.triggeredById,
        type:
          record.status === "completed"
            ? NotificationType.analysis_completed
            : NotificationType.analysis_failed,
        title: `${record.type} analysis ${record.status}`,
        body:
          record.status === "completed"
            ? record.summary ?? undefined
            : record.error ?? "Analysis job failed",
        data: {
          analysisId,
          status: record.status,
          type: record.type
        }
      });
    } catch (error) {
      logger.warn({ analysisId, error }, "Failed to send analysis notification");
    }
  }

  private async runCorrelation(orgId: string, analysisId: string, createdAt: Date, input: CorrelationInput) {
    const messages = this.prompts.buildCorrelationMessages(input);
    const { summary, raw } = await this.streamMessages(orgId, analysisId, "correlation", createdAt, messages);
    return { summary, raw };
  }

  private async runAnomaly(orgId: string, analysisId: string, createdAt: Date, input: AnomalyInput) {
    const { messages, statisticalFindings, statsSummary } = this.prompts.buildAnomalyMessages(input);
    const prefix = statisticalFindings.length ? `统计检测：\n${statsSummary}\n\n` : "";
    const { summary: content, raw } = await this.streamMessages(orgId, analysisId, "anomaly", createdAt, messages, prefix);
    return { summary: content, raw, statisticalFindings };
  }

  private async streamMessages(
    orgId: string,
    analysisId: string,
    type: string,
    createdAt: Date,
    messages: LiteLlmMessage[],
    initialChunk?: string
  ): Promise<{ summary: string; raw: Record<string, unknown> }> {
    const flushChars = Math.max(1, Number(this.env.analysisConfig.streamFlushChars ?? 80));
    const flushMs = Math.max(0, Number(this.env.analysisConfig.streamFlushMs ?? 250));

    let buffer = "";
    let summary = "";
    let lastModel: string | undefined;
    let lastFlushAt = Date.now();

    const flush = async () => {
      if (!buffer) {
        return;
      }
      const chunk = buffer;
      buffer = "";
      summary += chunk;
      lastFlushAt = Date.now();
      await this.publish(orgId, analysisId, type, "running", chunk, createdAt);
    };

    try {
      if (initialChunk) {
        buffer += initialChunk;
        await flush();
      }
      for await (const chunk of this.llm.stream({ messages, timeoutMs: this.env.analysisConfig.llmTimeoutMs })) {
        if (typeof chunk.model === "string") {
          lastModel = chunk.model;
        }
        if (typeof chunk.delta !== "string" || chunk.delta.length === 0) {
          continue;
        }
        buffer += chunk.delta;
        const now = Date.now();
        if (buffer.length >= flushChars || now - lastFlushAt >= flushMs) {
          await flush();
        }
      }
      await flush();
      return { summary, raw: { stream: true, model: lastModel } };
    } catch (error: unknown) {
      try {
        await flush();
      } catch (flushError) {
        logger.warn({ flushError }, "Failed to flush partial summary after stream error");
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      const streamError = new AnalysisStreamError(normalized.message, summary, { cause: normalized });
      streamError.stack = normalized.stack;
      throw streamError;
    }
  }

  private async publish(
    orgId: string,
    id: string,
    type: string,
    status: string,
    summary?: string,
    createdAt?: Date,
    error?: string
  ) {
    await this.pubsub.publish("analysisEvents", {
      orgId,
      result: {
        id,
        type,
        status,
        summary,
        error,
        createdAt: (createdAt ?? new Date()).toISOString()
      }
    });
  }
}
