import { AssistantRunModel, ProcessedItemModel, RawItemModel } from "@modular/mongo";
import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { EconomicDataPoint } from "@prisma/client";
import type { Queue } from "bullmq";
import type { PubSubEngine } from "graphql-subscriptions";
import { createHash } from "node:crypto";

import { safeJsonParseFromText } from "../../common/llm-json";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { ItemsService } from "../items/items.service";
import { ModelServiceClient } from "../model-service/model-service.client";
import { LiteLlmGuardrailViolationError, LiteLlmService, type LiteLlmMessage } from "../news-pipeline/litellm.service";
import { AssistantSafetySettingsService } from "../system-settings/assistant-safety-settings.service";
import { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";
import { OpenAiKeysSettingsService } from "../system-settings/openai-keys-settings.service";

import {
  AssistantPromptService,
  AssistantQueryPlanSchema,
  CorrelationFieldSelectionSchema,
  CorrelationSeriesSelectionSchema
} from "./assistant-prompt.service";
import { ASSISTANT_QUEUE } from "./assistant.constants";
import { AssistantStreamError } from "./assistant.errors";
import { ASSISTANT_PUBSUB } from "./assistant.pubsub";
import type { AssistantForecastInput, AssistantJobPayload, AssistantQueryInput, AssistantReportInput } from "./assistant.types";

const logger = createLogger({ name: "assistant-service" });

type AssistantRunType = "query" | "report" | "forecast";
type AssistantRunStatus = "pending" | "running" | "completed" | "failed";

interface EconomicSeriesReference {
  slug: string;
  displayName: string;
  docUrl?: string | null;
  sourceField: string;
  resolvedFrom: { input: string; method: "explicit_slug" | "explicit_slug_field" | "display_name_search" | "llm_selection" };
}

interface ParsedSeriesSpecifier {
  input: string;
  slug?: string;
  field?: string;
  query: string;
}

function parseSeriesSpecifier(input: string): ParsedSeriesSpecifier {
  const trimmed = typeof input === "string" ? input.trim() : "";
  const normalized = trimmed.startsWith("economic:") ? trimmed.slice("economic:".length) : trimmed;
  const slugFieldMatch = normalized.match(/^([a-zA-Z0-9_-]+)[.:](.+)$/);
  if (slugFieldMatch) {
    return {
      input: trimmed,
      slug: slugFieldMatch[1]!,
      field: slugFieldMatch[2]!.trim(),
      query: slugFieldMatch[1]!
    };
  }
  if (/^[a-zA-Z0-9_-]+$/.test(normalized) && normalized.length > 0) {
    return { input: trimmed, slug: normalized, query: normalized };
  }
  return { input: trimmed, query: trimmed };
}

function safeJsonParse<T>(raw: string): T | null {
  return safeJsonParseFromText<T>(raw);
}

function pearsonCorrelation(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) {
    return null;
  }
  const n = x.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += x[i]!;
    sumY += y[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 0 || varY <= 0) {
    return null;
  }
  return cov / Math.sqrt(varX * varY);
}

function dateKeyUTC(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly llm: LiteLlmService,
    private readonly env: EnvService,
    private readonly assistantSafety: AssistantSafetySettingsService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
    private readonly openaiKeys: OpenAiKeysSettingsService,
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly modelService: ModelServiceClient,
    private readonly prompts: AssistantPromptService,
    @Inject(ASSISTANT_QUEUE) private readonly queue: Queue<AssistantJobPayload>,
    @Inject(ASSISTANT_PUBSUB) private readonly pubsub: PubSubEngine,
  ) {}

  async submitQuery(orgId: string, input: AssistantQueryInput, triggeredById?: string) {
    const record = await AssistantRunModel.create({
      orgId,
      type: "query" satisfies AssistantRunType,
      status: "pending" satisfies AssistantRunStatus,
      input,
      triggeredById
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "query",
      { type: "query", runId: record.id, orgId, traceId },
      { jobId: `assistant:query:${record.id}`, removeOnComplete: true, attempts: this.env.assistantConfig.maxRetries }
    );
    return record;
  }

  async submitReport(orgId: string, input: AssistantReportInput, triggeredById?: string) {
    const record = await AssistantRunModel.create({
      orgId,
      type: "report" satisfies AssistantRunType,
      status: "pending" satisfies AssistantRunStatus,
      input,
      triggeredById
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "report",
      { type: "report", runId: record.id, orgId, traceId },
      { jobId: `assistant:report:${record.id}`, removeOnComplete: true, attempts: this.env.assistantConfig.maxRetries }
    );
    return record;
  }

  async submitForecast(orgId: string, input: AssistantForecastInput, triggeredById?: string) {
    const record = await AssistantRunModel.create({
      orgId,
      type: "forecast" satisfies AssistantRunType,
      status: "pending" satisfies AssistantRunStatus,
      input,
      triggeredById
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "forecast",
      { type: "forecast", runId: record.id, orgId, traceId },
      { jobId: `assistant:forecast:${record.id}`, removeOnComplete: true, attempts: this.env.assistantConfig.maxRetries }
    );
    return record;
  }

  async listRuns(orgId: string, limit = 50) {
    return AssistantRunModel.find({ orgId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  async deleteRun(orgId: string, runId: string): Promise<boolean> {
    let record: { type: AssistantRunType; status: AssistantRunStatus } | null = null;
    try {
      record = await AssistantRunModel.findOne({ _id: runId, orgId }, { type: 1, status: 1 }).lean();
    } catch {
      return false;
    }

    if (!record) {
      return false;
    }

    if (record.status === "running") {
      throw new ConflictException("Assistant run is currently running and cannot be deleted");
    }

    if (record.status === "pending") {
      const jobId = `assistant:${record.type}:${runId}`;
      try {
        const queuedJob = await this.queue.getJob(jobId);
        if (queuedJob) {
          await queuedJob.remove();
        }
      } catch (error) {
        logger.warn({ runId, error }, "Failed to remove pending assistant job before deleting run");
      }
    }

    const result = await AssistantRunModel.deleteOne({ _id: runId, orgId });
    return result.deletedCount > 0;
  }

  async process(job: AssistantJobPayload) {
    const record = await AssistantRunModel.findById(job.runId);
    if (!record) {
      logger.warn({ job }, "Assistant run not found");
      return;
    }
    const createdAt = record.createdAt ? new Date(record.createdAt) : new Date();
    record.status = "running";
    await record.save();
    await this.publish(record.orgId, record.id, record.type, record.status, undefined, createdAt);

    const baseGuardrails = (await this.assistantSafety.getEffectiveConfig()).guardrails;
    const guardrails = await this.pickGuardrailsForRun(record.id, baseGuardrails);
    const assistantModel = await this.resolveAssistantModelOverride();

    try {
      if (job.type === "query") {
        const output = await this.runQuery(
          record.orgId,
          record.id,
          createdAt,
          record.input as AssistantQueryInput,
          guardrails,
          assistantModel
        );
        record.output = output;
        record.summary = output.summary;
      } else if (job.type === "report") {
        const output = await this.runReport(
          record.orgId,
          record.id,
          createdAt,
          record.input as AssistantReportInput,
          guardrails,
          assistantModel
        );
        record.output = output;
        record.summary = output.summary;
      } else if (job.type === "forecast") {
        const output = await this.runForecast(
          record.orgId,
          record.id,
          createdAt,
          record.input as AssistantForecastInput,
          guardrails,
          assistantModel
        );
        record.output = output;
        record.summary = output.summary;
      } else {
        const jobType = (job as unknown as { type?: unknown }).type;
        throw new Error(`Unsupported assistant job type: ${typeof jobType === "string" ? jobType : "unknown"}`);
      }

      record.status = "completed";
      await record.save();
      await this.publish(record.orgId, record.id, record.type, record.status, record.summary ?? undefined, createdAt);
    } catch (error: unknown) {
      if (error instanceof LiteLlmGuardrailViolationError) {
        logger.warn(
          { job, appliedGuardrails: error.appliedGuardrails, upstreamStatus: error.upstreamStatus },
          "Assistant request blocked by content safety guardrails",
        );
        record.status = "completed";
        record.summary = error.message;
        record.output = {
          blocked: true,
          code: error.code,
          summary: error.message,
          appliedGuardrails: error.appliedGuardrails,
          upstreamStatus: error.upstreamStatus ?? null
        };
        record.error = undefined;
        await record.save();
        await this.publish(record.orgId, record.id, record.type, record.status, record.summary ?? undefined, createdAt);
        return;
      }
      logger.error({ job, error }, "Assistant job failed");
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      if (error instanceof AssistantStreamError) {
        record.summary = error.partialSummary;
      }
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
      throw error;
    }
  }

  private async pickGuardrailsForRun(runId: string, baseGuardrails?: string[]) {
    if (!Array.isArray(baseGuardrails)) {
      return undefined;
    }
    const normalized = Array.from(
      new Set(
        baseGuardrails
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    );
    if (normalized.length === 0) {
      return undefined;
    }

    const keyCount = await this.openaiKeys.getKeyCount();
    if (keyCount <= 1) {
      return normalized;
    }

    const bucket = this.stableBucket(runId, keyCount);
    return normalized.map((name) => this.mapOpenAiGuardrailName(name, bucket));
  }

  private stableBucket(input: string, buckets: number): number {
    const normalizedBuckets = Math.max(1, Math.floor(buckets));
    const digest = createHash("sha256").update(input).digest();
    const value = digest.readUInt32BE(0);
    return value % normalizedBuckets;
  }

  private mapOpenAiGuardrailName(name: string, bucket: number): string {
    if (bucket <= 0) {
      return name;
    }
    if (name === "openai-moderation-pre" || name === "openai-moderation-post") {
      return `${name}-${bucket + 1}`;
    }
    return name;
  }

  private async resolveAssistantModelOverride(): Promise<string | undefined> {
    const activeConfig = await this.llmGatewaySettings.getActiveConfig();
    const override = activeConfig?.assistantModel;
    if (typeof override !== "string") {
      return undefined;
    }
    const normalized = override.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async runQuery(
    orgId: string,
    runId: string,
    createdAt: Date,
    input: AssistantQueryInput,
    guardrails?: string[],
    assistantModel?: string
  ) {
    const message = typeof input?.message === "string" ? input.message.trim() : "";
    if (!message) {
      throw new Error("Assistant query message is required");
    }

    const planner = this.prompts.buildQueryPlannerRequest(message);
    const planResponse = await this.llm.acompletion({
      model: assistantModel,
      messages: planner.messages,
      response_format: planner.responseFormat,
      timeoutMs: Math.min(120_000, this.env.assistantConfig.llmTimeoutMs),
      guardrails,
      metadata: { orgId, source: "assistant-planner" }
    });
    const planRaw = planResponse.choices?.[0]?.message?.content;
    const planJson = typeof planRaw === "string" ? safeJsonParse<unknown>(planRaw) : null;
    const parsed = AssistantQueryPlanSchema.safeParse(planJson);
    const plan = parsed.success ? parsed.data : ({ kind: "unsupported" } as const);

    if (plan.kind === "news_negative_list") {
      const lookbackDays = Math.min(90, Math.max(1, plan.lookbackDays ?? 7));
      const limit = Math.min(50, Math.max(1, plan.limit ?? 20));
      const end = new Date();
      const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const filters = { sentiments: ["negative"], dateRange: { start, end } };
      const listItems = (rankingMode: "RELEVANCE" | "RECENCY") =>
        this.items.list(orgId, 1, limit, plan.topic, filters, "PUBLISHED_DESC", rankingMode);

      let items;
      try {
        ({ items } = await listItems("RELEVANCE"));
      } catch (error) {
        if (!this.isRerankUnavailable(error)) {
          throw error;
        }
        logger.warn(
          {
            orgId,
            runId,
            code: "RERANK_UNAVAILABLE",
          },
          "Assistant query rerank unavailable; falling back to RECENCY ranking",
        );
        ({ items } = await listItems("RECENCY"));
      }

      const renderedItems = await this.renderNewsItems(orgId, items);

      const messages = this.prompts.buildNewsListRendererMessages({
        question: message,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        items: renderedItems
      });

      const stream = await this.streamMessages(orgId, runId, "query", createdAt, messages, {
        guardrails,
        assistantModel
      });
      return {
        plan,
        items: renderedItems,
        summary: stream.summary,
        raw: stream.raw
      };
    }

    if (plan.kind === "correlation_gold_usd") {
      return this.runCorrelationQuery(
        orgId,
        runId,
        createdAt,
        message,
        {
          lookbackDays: plan.lookbackDays,
          transform: plan.transform,
          seriesA: "gold_futures_main",
          seriesB: "usd_index_history"
        },
        guardrails,
        assistantModel
      );
    }

    if (plan.kind === "correlation_two_series") {
      return this.runCorrelationQuery(
        orgId,
        runId,
        createdAt,
        message,
        {
          lookbackDays: plan.lookbackDays,
          transform: plan.transform,
          seriesA: plan.seriesA,
          seriesB: plan.seriesB
        },
        guardrails,
        assistantModel
      );
    }

    const messages: LiteLlmMessage[] = [
      {
        role: "system",
        content: [
          "You are a finance analysis assistant.",
          "Write the response in Simplified Chinese.",
          "Explain that the request is not supported yet and ask for a supported query."
        ].join("\n")
      },
      { role: "user", content: `User request: ${message}` }
    ];
    const stream = await this.streamMessages(orgId, runId, "query", createdAt, messages, {
      guardrails,
      assistantModel
    });
    return { plan, summary: stream.summary, raw: stream.raw };
  }

  private isRerankUnavailable(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const candidate = error as {
      getStatus?: () => number;
      getResponse?: () => unknown;
    };
    if (typeof candidate.getStatus !== "function" || typeof candidate.getResponse !== "function") {
      return false;
    }
    try {
      if (candidate.getStatus() !== 503) {
        return false;
      }
      const response = candidate.getResponse();
      if (!response || typeof response !== "object") {
        return false;
      }
      return (response as { code?: unknown }).code === "RERANK_UNAVAILABLE";
    } catch {
      return false;
    }
  }

  private async runReport(
    orgId: string,
    runId: string,
    createdAt: Date,
    input: AssistantReportInput,
    guardrails?: string[],
    assistantModel?: string
  ) {
    const period = input?.period === "weekly" ? "weekly" : "daily";
    const lookbackDays = period === "weekly" ? 7 : 1;
    const limit = Math.min(100, Math.max(1, Number(input?.limit ?? 40)));
    const topic = typeof input?.topic === "string" ? input.topic.trim() : "";

    const end = new Date();
    const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const { items } = await this.items.list(
      orgId,
      1,
      limit,
      topic || undefined,
      { dateRange: { start, end } },
      "PUBLISHED_DESC"
    );

    const rendered = await this.renderNewsItems(orgId, items);

    const stats = rendered.reduce<Record<string, number>>((acc, item) => {
      const key = typeof item.sentiment === "string" && item.sentiment.length > 0 ? item.sentiment : "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    const messages: LiteLlmMessage[] = [
      {
        role: "system",
        content: [
          "You are a finance market analyst.",
          "Write the report in Simplified Chinese.",
          "Only use the provided items; do not invent facts, tickers, or URLs.",
          "Keep the output concise and structured."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `Report period: ${period}`,
          `Time window: ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
          topic ? `Topic filter: ${topic}` : "Topic filter: (none)",
          "Sentiment counts (JSON):",
          JSON.stringify(stats),
          "Items (JSON):",
          JSON.stringify(rendered)
        ].join("\n")
      }
    ];

    const stream = await this.streamMessages(orgId, runId, "report", createdAt, messages, {
      guardrails,
      assistantModel
    });
    return {
      period,
      topic: topic || null,
      timeWindow: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) },
      stats,
      items: rendered,
      summary: stream.summary,
      raw: stream.raw
    };
  }

  private async runForecast(
    orgId: string,
    runId: string,
    createdAt: Date,
    input: AssistantForecastInput,
    guardrails?: string[],
    assistantModel?: string
  ) {
    const seriesInput = typeof input?.series === "string" ? input.series.trim() : "";
    if (!seriesInput) {
      throw new Error("Forecast series is required");
    }

    const spec = parseSeriesSpecifier(seriesInput);
    const lookbackDays = Math.min(3650, Math.max(7, Number(input?.lookbackDays ?? 365)));
    const end = new Date();
    const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const item = await this.resolveEconomicSeriesOrThrow(spec);

    const fields = await this.listFieldCounts(item.id, start, end);
    const fallbackField = fields[0]?.name ?? "";
    const preferredField = typeof input?.sourceField === "string" ? input.sourceField.trim() : spec.field ?? null;
    const sourceField = this.pickPreferredField(preferredField, fields, fallbackField);
    if (!sourceField) {
      throw new Error("No usable sourceField found for forecast series");
    }

    const rawPoints = await this.loadSeries(item.id, start, end, sourceField);
    const points = rawPoints
      .map((p) => ({ timestamp: p.recordedAt.toISOString(), value: Number(p.value) }))
      .filter((p) => Number.isFinite(p.value));

    if (points.length < 12) {
      throw new Error("Not enough data points for forecast");
    }

    const modelKind = input?.modelKind === "arima" ? "arima" : "ets";
    const seasonalPeriod =
      typeof input?.seasonalPeriod === "number" && Number.isFinite(input.seasonalPeriod)
        ? Math.max(0, Math.trunc(input.seasonalPeriod))
        : undefined;

    const confidenceLevel =
      typeof input?.confidenceLevel === "number" && Number.isFinite(input.confidenceLevel)
        ? Math.min(0.999, Math.max(0.5, input.confidenceLevel))
        : 0.95;

    const modelResponse = await this.modelService.forecastHoldoutLastOrThrow({
      series: points,
      model: { kind: modelKind, seasonalPeriod, confidenceLevel },
      requestId: runId
    });

    const actual = points[points.length - 1]!;

    const forecast = modelResponse.forecast;

    const error = actual.value - forecast.expected;
    const absError = Math.abs(error);
    const pctError = actual.value !== 0 ? error / actual.value : null;

    const references: EconomicSeriesReference[] = [
      {
        slug: item.slug,
        displayName: item.displayName,
        docUrl: item.sourceDocUrl ?? null,
        sourceField,
        resolvedFrom: {
          input: spec.input,
          method: spec.slug && spec.field ? "explicit_slug_field" : spec.slug ? "explicit_slug" : "display_name_search"
        }
      }
    ];

    const messages: LiteLlmMessage[] = [
      {
        role: "system",
        content: [
          "You are a quantitative finance analyst.",
          "Write the response in Simplified Chinese.",
          "Explain the holdout-last forecast result and key caveats.",
          "Only use the provided numbers and metadata; do not invent values."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "Input (JSON):",
          JSON.stringify({
            timeWindow: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) },
            series: {
              slug: item.slug,
              displayName: item.displayName,
              field: sourceField,
              docUrl: item.sourceDocUrl ?? null
            },
            modelServiceUsed: true,
            model: modelResponse.model,
            actual,
            forecast,
            errors: { error, absError, pctError },
            references
          })
        ].join("\n")
      }
    ];

    const stream = await this.streamMessages(orgId, runId, "forecast", createdAt, messages, {
      guardrails,
      assistantModel
    });
    return {
      series: { slug: item.slug, displayName: item.displayName, field: sourceField, docUrl: item.sourceDocUrl ?? null },
      timeWindow: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) },
      modelServiceUsed: true,
      model: modelResponse.model,
      forecast,
      actual,
      errors: { error, absError, pctError },
      diagnostics: modelResponse.diagnostics,
      references,
      summary: stream.summary,
      raw: stream.raw
    };
  }

  private async runCorrelationQuery(
    orgId: string,
    runId: string,
    createdAt: Date,
    question: string,
    input: { seriesA: string; seriesB: string; lookbackDays?: number; transform?: string | null },
    guardrails?: string[],
    assistantModel?: string
  ) {
    const lookbackDays = Math.min(3650, Math.max(7, input.lookbackDays ?? 365));
    const transform = input.transform === "level" ? "level" : "return";

    const end = new Date();
    const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const specA = parseSeriesSpecifier(input.seriesA);
    const specB = parseSeriesSpecifier(input.seriesB);

    const resolved = await this.resolveCorrelationSeries(orgId, question, specA, specB, guardrails, assistantModel);
    const itemA = resolved.seriesA.item;
    const itemB = resolved.seriesB.item;

    const [fieldsA, fieldsB] = await Promise.all([
      this.listFieldCounts(itemA.id, start, end),
      this.listFieldCounts(itemB.id, start, end)
    ]);

    const fallbackA = fieldsA[0]?.name ?? "";
    const fallbackB = fieldsB[0]?.name ?? "";

    const userFieldA = specA.field ?? null;
    const userFieldB = specB.field ?? null;

    const shouldCallFieldSelector =
      !(userFieldA && fieldsA.some((f) => f.name === userFieldA)) || !(userFieldB && fieldsB.some((f) => f.name === userFieldB));

    const selectionParsed = shouldCallFieldSelector
      ? await this.pickCorrelationFieldsWithLlm(orgId, {
          seriesA: { slug: itemA.slug, displayName: itemA.displayName, fields: fieldsA },
          seriesB: { slug: itemB.slug, displayName: itemB.displayName, fields: fieldsB }
        }, guardrails, assistantModel)
      : null;

    const fieldA = this.pickPreferredField(
      userFieldA ?? (selectionParsed?.fieldA ?? null),
      fieldsA,
      fallbackA
    );
    const fieldB = this.pickPreferredField(
      userFieldB ?? (selectionParsed?.fieldB ?? null),
      fieldsB,
      fallbackB
    );

    const seriesReferences: EconomicSeriesReference[] = [
      {
        slug: itemA.slug,
        displayName: itemA.displayName,
        docUrl: itemA.sourceDocUrl ?? null,
        sourceField: fieldA,
        resolvedFrom: resolved.seriesA.resolvedFrom
      },
      {
        slug: itemB.slug,
        displayName: itemB.displayName,
        docUrl: itemB.sourceDocUrl ?? null,
        sourceField: fieldB,
        resolvedFrom: resolved.seriesB.resolvedFrom
      }
    ];

    const [seriesA, seriesB] = await Promise.all([
      this.loadSeries(itemA.id, start, end, fieldA),
      this.loadSeries(itemB.id, start, end, fieldB)
    ]);

    const mapA = new Map<string, number>();
    for (const point of seriesA) {
      const key = dateKeyUTC(point.recordedAt);
      mapA.set(key, Number(point.value));
    }
    const mapB = new Map<string, number>();
    for (const point of seriesB) {
      const key = dateKeyUTC(point.recordedAt);
      mapB.set(key, Number(point.value));
    }

    const commonDates = Array.from(mapA.keys()).filter((key) => mapB.has(key)).sort();
    const levelsA = commonDates.map((key) => mapA.get(key)!);
    const levelsB = commonDates.map((key) => mapB.get(key)!);

    const { x, y } = this.transformAlignedSeries(levelsA, levelsB, transform);
    const pearson = pearsonCorrelation(x, y);

    const references: { label: string; value: string }[] = [
      { label: "seriesA", value: `${itemA.displayName} (${itemA.slug}) field=${fieldA}` },
      { label: "seriesB", value: `${itemB.displayName} (${itemB.slug}) field=${fieldB}` },
      ...(itemA.sourceDocUrl ? [{ label: "seriesA_doc", value: itemA.sourceDocUrl }] : []),
      ...(itemB.sourceDocUrl ? [{ label: "seriesB_doc", value: itemB.sourceDocUrl }] : [])
    ];

    const messages = this.prompts.buildCorrelationRendererMessages({
      question,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      seriesA: { slug: itemA.slug, displayName: itemA.displayName, field: fieldA, docUrl: itemA.sourceDocUrl ?? null },
      seriesB: { slug: itemB.slug, displayName: itemB.displayName, field: fieldB, docUrl: itemB.sourceDocUrl ?? null },
      stats: { n: x.length, pearson },
      references
    });

    const stream = await this.streamMessages(orgId, runId, "query", createdAt, messages, {
      guardrails,
      assistantModel
    });
    return {
      plan: {
        kind: "correlation_two_series",
        transform,
        lookbackDays,
        seriesA: { input: specA.input, slug: itemA.slug, field: fieldA },
        seriesB: { input: specB.input, slug: itemB.slug, field: fieldB }
      },
      references: seriesReferences,
      stats: { n: x.length, pearson },
      summary: stream.summary,
      raw: stream.raw
    };
  }

  private transformAlignedSeries(levelsA: number[], levelsB: number[], transform: "level" | "return"): { x: number[]; y: number[] } {
    const x: number[] = [];
    const y: number[] = [];

    if (transform === "level") {
      for (let i = 0; i < levelsA.length; i += 1) {
        const a = levelsA[i]!;
        const b = levelsB[i]!;
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          continue;
        }
        x.push(a);
        y.push(b);
      }
      return { x, y };
    }

    for (let i = 1; i < levelsA.length; i += 1) {
      const prevA = levelsA[i - 1]!;
      const nextA = levelsA[i]!;
      const prevB = levelsB[i - 1]!;
      const nextB = levelsB[i]!;
      if (!Number.isFinite(prevA) || !Number.isFinite(nextA) || !Number.isFinite(prevB) || !Number.isFinite(nextB)) {
        continue;
      }
      if (prevA === 0 || prevB === 0) {
        continue;
      }
      const ra = nextA / prevA - 1;
      const rb = nextB / prevB - 1;
      if (!Number.isFinite(ra) || !Number.isFinite(rb)) {
        continue;
      }
      x.push(ra);
      y.push(rb);
    }

    return { x, y };
  }

  private async pickCorrelationFieldsWithLlm(
    orgId: string,
    input: {
      seriesA: { slug: string; displayName?: string | null; fields: { name: string; count: number }[] };
      seriesB: { slug: string; displayName?: string | null; fields: { name: string; count: number }[] };
    },
    guardrails?: string[],
    assistantModel?: string
  ): Promise<{ fieldA: string; fieldB: string } | null> {
    const selector = this.prompts.buildCorrelationFieldSelectorRequest(input);
    const selectionResponse = await this.llm.acompletion({
      model: assistantModel,
      messages: selector.messages,
      response_format: selector.responseFormat,
      timeoutMs: Math.min(120_000, this.env.assistantConfig.llmTimeoutMs),
      guardrails,
      metadata: { orgId, source: "assistant-field-selector" }
    });

    const selectionRaw = selectionResponse.choices?.[0]?.message?.content;
    const selectionJson = typeof selectionRaw === "string" ? safeJsonParse<unknown>(selectionRaw) : null;
    const selectionParsed = CorrelationFieldSelectionSchema.safeParse(selectionJson);
    if (!selectionParsed.success) {
      return null;
    }
    return selectionParsed.data;
  }

  private pickPreferredField(candidate: string | null, fields: { name: string; count: number }[], fallback: string) {
    const set = new Set(fields.map((f) => f.name));
    if (candidate && set.has(candidate)) {
      return candidate;
    }

    const preferredNeedles = ["最新价", "收盘", "close", "last", "value", "settle", "结算", "price"];
    for (const needle of preferredNeedles) {
      const preferred = fields.find((field) => field.name.toLowerCase().includes(needle.toLowerCase()));
      if (preferred) {
        return preferred.name;
      }
    }

    if (fallback && set.has(fallback)) {
      return fallback;
    }
    return fields[0]?.name ?? "";
  }

  private async resolveEconomicSeriesOrThrow(spec: ParsedSeriesSpecifier): Promise<{
    id: string;
    slug: string;
    displayName: string;
    sourceDocUrl?: string | null;
  }> {
    if (spec.slug) {
      const item = await this.prisma.economicDataItem.findFirst({
        where: { slug: spec.slug },
        select: { id: true, slug: true, displayName: true, sourceDocUrl: true }
      });
      if (item) {
        return item;
      }
    }

    const term = spec.query.trim();
    if (!term) {
      throw new Error("Economic series slug is required");
    }

    const candidates = await this.searchEconomicSeriesCandidates(term, 6);
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    if (candidates.length === 0) {
      throw new Error(`Unable to resolve economic series for '${spec.input}'`);
    }

    const suggestions = candidates.map((candidate) => `${candidate.displayName} (${candidate.slug})`).join(", ");
    throw new Error(`Multiple economic series match '${spec.input}': ${suggestions}. Please specify a slug.`);
  }

  private async resolveCorrelationSeries(
    orgId: string,
    question: string,
    seriesA: ParsedSeriesSpecifier,
    seriesB: ParsedSeriesSpecifier,
    guardrails?: string[],
    assistantModel?: string
  ): Promise<{
    seriesA: {
      item: { id: string; slug: string; displayName: string; description?: string | null; sourceDocUrl?: string | null };
      resolvedFrom: EconomicSeriesReference["resolvedFrom"];
    };
    seriesB: {
      item: { id: string; slug: string; displayName: string; description?: string | null; sourceDocUrl?: string | null };
      resolvedFrom: EconomicSeriesReference["resolvedFrom"];
    };
  }> {
    const [explicitA, explicitB] = await Promise.all([
      seriesA.slug
        ? this.prisma.economicDataItem.findFirst({
            where: { slug: seriesA.slug },
            select: { id: true, slug: true, displayName: true, description: true, sourceDocUrl: true }
          })
        : Promise.resolve(null),
      seriesB.slug
        ? this.prisma.economicDataItem.findFirst({
            where: { slug: seriesB.slug },
            select: { id: true, slug: true, displayName: true, description: true, sourceDocUrl: true }
          })
        : Promise.resolve(null)
    ]);

    const [candidatesA, candidatesB] = await Promise.all([
      explicitA ? Promise.resolve([explicitA]) : this.searchEconomicSeriesCandidates(seriesA.query, 8),
      explicitB ? Promise.resolve([explicitB]) : this.searchEconomicSeriesCandidates(seriesB.query, 8)
    ]);

    if (candidatesA.length === 0) {
      throw new Error(`Unable to resolve economic series for '${seriesA.input}'`);
    }
    if (candidatesB.length === 0) {
      throw new Error(`Unable to resolve economic series for '${seriesB.input}'`);
    }

    const slugSetA = new Set(candidatesA.map((c) => c.slug));
    const slugSetB = new Set(candidatesB.map((c) => c.slug));

    let chosenSlugA = candidatesA[0]!.slug;
    let chosenSlugB = candidatesB[0]!.slug;

    const selectionNeeded = candidatesA.length > 1 || candidatesB.length > 1;
    if (selectionNeeded) {
      const selector = this.prompts.buildCorrelationSeriesSelectorRequest({
        question,
        seriesA: {
          query: seriesA.query,
          candidates: candidatesA.map((candidate) => ({
            slug: candidate.slug,
            displayName: candidate.displayName,
            description: candidate.description ?? null
          }))
        },
        seriesB: {
          query: seriesB.query,
          candidates: candidatesB.map((candidate) => ({
            slug: candidate.slug,
            displayName: candidate.displayName,
            description: candidate.description ?? null
          }))
        }
      });

      const selectionResponse = await this.llm.acompletion({
        model: assistantModel,
        messages: selector.messages,
        response_format: selector.responseFormat,
        timeoutMs: Math.min(120_000, this.env.assistantConfig.llmTimeoutMs),
        guardrails,
        metadata: { orgId, source: "assistant-series-selector" }
      });

      const selectionRaw = selectionResponse.choices?.[0]?.message?.content;
      const selectionJson = typeof selectionRaw === "string" ? safeJsonParse<unknown>(selectionRaw) : null;
      const selectionParsed = CorrelationSeriesSelectionSchema.safeParse(selectionJson);
      if (selectionParsed.success) {
        if (slugSetA.has(selectionParsed.data.slugA)) {
          chosenSlugA = selectionParsed.data.slugA;
        }
        if (slugSetB.has(selectionParsed.data.slugB)) {
          chosenSlugB = selectionParsed.data.slugB;
        }
      }
    }

    const itemA = candidatesA.find((candidate) => candidate.slug === chosenSlugA) ?? candidatesA[0]!;
    const itemB = candidatesB.find((candidate) => candidate.slug === chosenSlugB) ?? candidatesB[0]!;

    const resolvedFromA: EconomicSeriesReference["resolvedFrom"] = explicitA
      ? { input: seriesA.input, method: seriesA.field ? "explicit_slug_field" : "explicit_slug" }
      : candidatesA.length === 1
        ? { input: seriesA.input, method: "display_name_search" }
        : { input: seriesA.input, method: "llm_selection" };

    const resolvedFromB: EconomicSeriesReference["resolvedFrom"] = explicitB
      ? { input: seriesB.input, method: seriesB.field ? "explicit_slug_field" : "explicit_slug" }
      : candidatesB.length === 1
        ? { input: seriesB.input, method: "display_name_search" }
        : { input: seriesB.input, method: "llm_selection" };

    return {
      seriesA: { item: itemA, resolvedFrom: resolvedFromA },
      seriesB: { item: itemB, resolvedFrom: resolvedFromB }
    };
  }

  async searchEconomicSeriesCandidates(term: string, limit: number): Promise<
    {
      id: string;
      slug: string;
      displayName: string;
      description?: string | null;
      sourceDocUrl?: string | null;
    }[]
  > {
    const normalized = typeof term === "string" ? term.trim() : "";
    if (!normalized) {
      return [];
    }

    const slugNeedle = normalized.toLowerCase();
    const results = await this.prisma.economicDataItem.findMany({
      where: {
        isActive: true,
        OR: [
          { slug: { contains: slugNeedle } },
          { displayName: { contains: normalized } }
        ]
      },
      take: Math.min(Math.max(limit, 1), 20),
      select: { id: true, slug: true, displayName: true, description: true, sourceDocUrl: true }
    });

    const unique = new Map<string, (typeof results)[number]>();
    for (const row of results) {
      if (!unique.has(row.slug)) {
        unique.set(row.slug, row);
      }
    }
    return Array.from(unique.values());
  }

  private async renderNewsItems(
    orgId: string,
    items: { id: string; mongoRef?: string | null; name?: string | null; publishedAt?: Date | null }[]
  ): Promise<
    {
      itemMetaId: string;
      title?: string | null;
      summary?: string | null;
      source?: string | null;
      publishedAt?: string | null;
      url?: string | null;
      sentiment?: string | null;
    }[]
  > {
    const itemMetaIds = items.map((row) => row.id);
    const mongoRefs = items
      .map((row) => row.mongoRef)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    const [rawItems, processedItems] = await Promise.all([
      mongoRefs.length ? RawItemModel.find({ _id: { $in: mongoRefs } }, { itemMetaId: 1, payload: 1 }).lean() : Promise.resolve([]),
      itemMetaIds.length
        ? ProcessedItemModel.find(
            { orgId, itemMetaId: { $in: itemMetaIds }, status: "completed", duplicateOf: null },
            { itemMetaId: 1, result: 1, createdAt: 1 }
          )
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),
    ]);

    const rawPayloadByRef = new Map<string, Record<string, unknown>>();
    for (const raw of rawItems as unknown as { _id?: unknown; payload?: unknown }[]) {
      const idValue = raw?._id;
      const id =
        typeof idValue === "string"
          ? idValue
          : idValue && typeof (idValue as { toString?: unknown }).toString === "function"
            ? (idValue as { toString: () => string }).toString()
            : undefined;
      const payload =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>)
          : undefined;
      if (id && payload) {
        rawPayloadByRef.set(id, payload);
      }
    }

    const processedResultByMetaId = new Map<string, Record<string, unknown>>();
    for (const processed of processedItems as unknown as { itemMetaId?: unknown; result?: unknown }[]) {
      const itemMetaId = typeof processed?.itemMetaId === "string" ? processed.itemMetaId : undefined;
      if (!itemMetaId || processedResultByMetaId.has(itemMetaId)) {
        continue;
      }
      const result =
        processed?.result && typeof processed.result === "object" && !Array.isArray(processed.result)
          ? (processed.result as Record<string, unknown>)
          : undefined;
      if (result) {
        processedResultByMetaId.set(itemMetaId, result);
      }
    }

    return items.map((meta) => {
      const payload = meta.mongoRef ? rawPayloadByRef.get(meta.mongoRef) : undefined;
      const result = processedResultByMetaId.get(meta.id);

      const url = typeof payload?.url === "string" ? payload.url : null;
      const sourceName = typeof payload?.sourceName === "string" ? payload.sourceName : null;

      const title =
        typeof result?.title === "string"
          ? (result.title as string)
          : typeof meta.name === "string"
            ? meta.name
            : null;

      const summary = typeof result?.summary === "string" ? (result.summary as string) : null;
      const sentiment =
        typeof result?.sentiment_label === "string"
          ? (result.sentiment_label as string)
          : typeof result?.sentiment === "string"
            ? (result.sentiment as string)
            : null;

      const publishedAt =
        typeof result?.published_at === "string"
          ? (result.published_at as string)
          : meta.publishedAt?.toISOString?.() ?? null;

      return {
        itemMetaId: meta.id,
        title,
        summary,
        source: sourceName,
        publishedAt,
        url,
        sentiment
      };
    });
  }

  private async listFieldCounts(itemId: string, start: Date, end: Date) {
    const rows = await this.prisma.economicDataPoint.groupBy({
      by: ["sourceField"],
      where: {
        itemId,
        recordedAt: {
          gte: start,
          lte: end
        }
      },
      _count: { _all: true }
    });

    return rows
      .map((row) => ({ name: row.sourceField, count: row._count._all }))
      .filter((entry) => typeof entry.name === "string" && entry.name.length > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }

  private pickField(candidate: string | null, fields: { name: string; count: number }[], fallback: string) {
    const set = new Set(fields.map((f) => f.name));
    if (candidate && set.has(candidate)) {
      return candidate;
    }
    if (fallback && set.has(fallback)) {
      return fallback;
    }
    return fields[0]?.name ?? "";
  }

  private loadSeries(itemId: string, start: Date, end: Date, sourceField: string) {
    return this.prisma.economicDataPoint.findMany({
      where: {
        itemId,
        sourceField,
        recordedAt: { gte: start, lte: end }
      },
      select: {
        recordedAt: true,
        value: true
      },
      orderBy: [{ recordedAt: "asc" }]
    }) as Promise<Pick<EconomicDataPoint, "recordedAt" | "value">[]>;
  }

  private async streamMessages(
    orgId: string,
    runId: string,
    type: AssistantRunType,
    createdAt: Date,
    messages: LiteLlmMessage[],
    options?: { initialChunk?: string; guardrails?: string[]; assistantModel?: string }
  ): Promise<{ summary: string; raw: Record<string, unknown> }> {
    const flushChars = Math.max(1, Number(this.env.assistantConfig.streamFlushChars ?? 80));
    const flushMs = Math.max(0, Number(this.env.assistantConfig.streamFlushMs ?? 250));
    const initialChunk = options?.initialChunk;
    const guardrails = options?.guardrails;
    const assistantModel = options?.assistantModel;

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
      await this.publish(orgId, runId, type, "running", chunk, createdAt);
    };

    try {
      if (initialChunk) {
        buffer += initialChunk;
        await flush();
      }

      for await (const chunk of this.llm.stream({
        model: assistantModel,
        messages,
        timeoutMs: this.env.assistantConfig.llmTimeoutMs,
        guardrails
      })) {
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
      if (error instanceof LiteLlmGuardrailViolationError) {
        throw error;
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      const streamError = new AssistantStreamError(normalized.message, summary, { cause: normalized });
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
    await this.pubsub.publish("assistantEvents", {
      orgId,
      run: {
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
