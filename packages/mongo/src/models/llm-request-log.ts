import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from "mongoose";

export const DEFAULT_LLM_REQUEST_LOG_RETENTION_DAYS = 30;
export const MIN_LLM_REQUEST_LOG_RETENTION_DAYS = 1;
export const MAX_LLM_REQUEST_LOG_RETENTION_DAYS = 3650;
export const LLM_REQUEST_LOG_TTL_INDEX_NAME = "llm_request_log_created_at_ttl";
const SECONDS_PER_DAY = 24 * 60 * 60;
const RUNTIME_DECISIONS = [
  "allowed",
  "warn_concurrency",
  "warn_daily_budget",
  "warn_monthly_budget",
  "warn_multiple",
] as const;

const LlmRequestLogSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    requestType: {
      type: String,
      enum: ["completion", "embedding", "rerank", "stream", "responses"],
      required: true,
      index: true,
    },
    model: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["success", "error"],
      required: true,
      index: true,
    },
    promptTokens: { type: Number, default: null },
    completionTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
    costUsd: { type: Number, default: null },
    feature: { type: String, default: null, index: true },
    runtimeRequestId: { type: String, default: null, index: true },
    runtimeDecision: {
      type: String,
      enum: RUNTIME_DECISIONS,
      default: null,
      index: true,
    },
    currentConcurrency: { type: Number, default: null, min: 0 },
    concurrencyLimit: { type: Number, default: null, min: 0 },
    dailySpendUsdSnapshot: { type: Number, default: null, min: 0 },
    monthlySpendUsdSnapshot: { type: Number, default: null, min: 0 },
    latencyMs: { type: Number, required: true, min: 0 },
    error: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    apiSurface: {
      type: String,
      enum: ["chat_completions", "responses", "embeddings"],
      default: null,
      index: true,
    },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

LlmRequestLogSchema.index({ orgId: 1, createdAt: -1 });
LlmRequestLogSchema.index({ orgId: 1, feature: 1, createdAt: -1 });
LlmRequestLogSchema.index({ orgId: 1, model: 1, createdAt: -1 });
LlmRequestLogSchema.index({
  orgId: 1,
  requestType: 1,
  status: 1,
  createdAt: -1,
});
LlmRequestLogSchema.index({ runtimeDecision: 1, createdAt: -1 });
LlmRequestLogSchema.index(
  { createdAt: 1 },
  {
    name: LLM_REQUEST_LOG_TTL_INDEX_NAME,
    expireAfterSeconds:
      DEFAULT_LLM_REQUEST_LOG_RETENTION_DAYS * SECONDS_PER_DAY,
  },
);

export type LlmRequestLog = InferSchemaType<typeof LlmRequestLogSchema>;

export const LlmRequestLogModel =
  (models.LlmRequestLog as Model<LlmRequestLog> | undefined) ||
  model<LlmRequestLog>("LlmRequestLog", LlmRequestLogSchema);

export type LlmRequestLogDocument = HydratedDocument<LlmRequestLog>;
