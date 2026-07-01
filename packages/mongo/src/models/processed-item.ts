import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from "mongoose";

interface ProcessedItemLocationCarrier {
  location?: unknown;
}

export function processedItemHasLocation(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const location = (result as ProcessedItemLocationCarrier).location;
  return typeof location === "string" && location.trim().length > 0;
}

export function buildProcessedItemLocationExpression(
  locationFieldPath = "$result.location",
): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: locationFieldPath }, "string"] },
      {
        $gt: [{ $strLenCP: { $trim: { input: locationFieldPath } } }, 0],
      },
      false,
    ],
  };
}

export function buildProcessedItemHasLocationExpression(
  hasLocationFieldPath = "$hasLocation",
  locationFieldPath = "$result.location",
): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [{ $type: hasLocationFieldPath }, "bool"] },
      hasLocationFieldPath,
      buildProcessedItemLocationExpression(locationFieldPath),
    ],
  };
}

const ProcessedItemErrorSchema = new Schema(
  {
    message: { type: String, required: true },
    name: { type: String },
    stack: { type: String },
  },
  { _id: false },
);

const ProcessedItemEntitySchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false },
);

const ProcessedItemResultSchema = new Schema(
  {
    title: { type: String, default: null },
    subtitle: { type: String, default: null },
    author: { type: String, default: null },
    source: { type: String, default: null },
    published_at: { type: String, default: null },
    language: { type: String, default: null },
    location: { type: String, default: null },
    category: { type: String, default: null },
    content_type: { type: String, default: null },
    category_path: { type: String, default: null },
    category_labels: { type: [String], default: [] },
    category_confidence: { type: Number, min: 0, max: 1, default: null },
    category_reason: { type: String, default: null },
    category_method: { type: String, default: null },
    category_candidates: {
      type: [
        {
          path: { type: String, required: true },
          score: { type: Number, min: 0, max: 1, required: true },
          legacy_category: { type: String, required: true },
          reason: { type: String, default: null },
        },
      ],
      default: [],
    },
    sentiment: { type: String, default: null },
    sentiment_label: { type: String, default: null },
    topics: { type: [String], default: [] },
    summary: { type: String, default: null },
    key_points: { type: [String], default: [] },
    entities: { type: [ProcessedItemEntitySchema], default: [] },
    kg_relations: { type: [Schema.Types.Mixed], default: [] },
    stage_meta: { type: Schema.Types.Mixed, default: undefined },
    cleaned_markdown: { type: String, required: true },
    cleaned_markdown_source: {
      type: String,
      enum: ["llm", "crawl_fallback"],
      default: undefined,
    },
    removed_noise_types: { type: [String], default: [] },
    quality_score: { type: Number, min: 0, max: 1, default: null },
    llm_model: { type: String, default: null },
    llm_prompt_version: { type: String, default: null },
  },
  { _id: false },
);

const ProcessedItemSchema = new Schema(
  {
    rawItemId: { type: Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemMetaId: { type: String, required: true },
    orgId: { type: String, required: true },
    ingestedAt: { type: Date, default: undefined },
    sortAt: { type: Date, default: undefined },
    traceId: { type: String, index: true, default: null },
    pipelineJobId: { type: String, index: true, default: null },
    sourceId: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    hasLocation: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    result: { type: ProcessedItemResultSchema, default: undefined },
    error: { type: ProcessedItemErrorSchema, default: undefined },
    llm: {
      model: { type: String },
      promptVersion: { type: String },
      promptTokens: { type: Number },
      completionTokens: { type: Number },
      totalTokens: { type: Number },
      costUsd: { type: Number },
      latencyMs: { type: Number },
    },
    summaryEmbedding: { type: [Number], default: undefined },
    summaryEmbeddingModel: { type: String, default: null },
    summaryEmbeddingDimensions: { type: Number, default: null },
    duplicateOf: {
      type: Schema.Types.ObjectId,
      ref: "ProcessedItem",
      default: null,
    },
    duplicateSimilarity: { type: Number, min: 0, max: 1, default: null },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

ProcessedItemSchema.index({ orgId: 1, createdAt: -1 });
ProcessedItemSchema.index({ orgId: 1, status: 1, createdAt: -1 });
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  itemMetaId: 1,
  createdAt: -1,
});
ProcessedItemSchema.index({ itemMetaId: 1, status: 1, createdAt: -1 });
ProcessedItemSchema.index({ orgId: 1, status: 1, sortAt: -1 });
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  duplicateOf: 1,
  createdAt: -1,
});
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  duplicateOf: 1,
  sortAt: -1,
  ingestedAt: -1,
  createdAt: -1,
});
ProcessedItemSchema.index({ orgId: 1, duplicateOf: 1, createdAt: -1 });
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  summaryEmbeddingModel: 1,
  duplicateOf: 1,
  createdAt: -1,
});
ProcessedItemSchema.index({ orgId: 1, status: 1, sourceId: 1, createdAt: -1 });
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  "result.content_type": 1,
  createdAt: -1,
});
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  "result.category_confidence": 1,
  createdAt: -1,
});
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  "result.category_path": 1,
  createdAt: -1,
});
ProcessedItemSchema.index({
  orgId: 1,
  status: 1,
  "result.category_method": 1,
  createdAt: -1,
});
ProcessedItemSchema.index(
  {
    orgId: 1,
    status: 1,
    "result.title": "text",
    "result.subtitle": "text",
    "result.summary": "text",
    "result.topics": "text",
    "result.key_points": "text",
    "result.entities.name": "text",
    "result.location": "text",
    tags: "text",
  },
  {
    name: "processed_item_org_status_search_text",
    default_language: "none",
    weights: {
      "result.title": 10,
      "result.subtitle": 6,
      "result.summary": 4,
      "result.topics": 5,
      "result.key_points": 4,
      "result.entities.name": 5,
      "result.location": 3,
      tags: 2,
    },
  },
);
ProcessedItemSchema.index(
  {
    orgId: 1,
    status: 1,
    hasLocation: 1,
    duplicateOf: 1,
    sortAt: -1,
    ingestedAt: -1,
    createdAt: -1,
  },
  { name: "processed_item_war_map_location_recency" },
);

ProcessedItemSchema.pre("validate", function (next) {
  const doc = this as unknown as {
    status?: string;
    result?: unknown;
    error?: unknown;
  };
  if (doc.status === "completed" && !doc.result) {
    next(
      new Error("ProcessedItem.result is required when status is completed"),
    );
    return;
  }
  if (doc.status === "failed" && !doc.error) {
    next(new Error("ProcessedItem.error is required when status is failed"));
    return;
  }
  next();
});

export const ProcessedItemModel =
  (models.ProcessedItem as Model<ProcessedItem> | undefined) ||
  model<ProcessedItem>("ProcessedItem", ProcessedItemSchema);

export type ProcessedItem = InferSchemaType<typeof ProcessedItemSchema>;

export type ProcessedItemDocument = HydratedDocument<ProcessedItem>;
