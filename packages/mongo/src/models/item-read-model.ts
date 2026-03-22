import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (typeof entry === "number") {
        return entry.toString();
      }
      return null;
    })
    .filter((entry): entry is string => Boolean(entry && entry.trim()));
};

const ItemReadModelMetaSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    externalId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, required: true, trim: true },
    mongoRef: { type: String, required: true, trim: true },
    version: { type: Number, required: true, min: 0 },
    publishedAt: { type: Date, default: null },
    sortAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    _id: false,
    id: false,
    minimize: false,
  },
);

const ItemReadModelRawSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    itemMetaId: { type: String, required: true, trim: true },
    source: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    _id: false,
    id: false,
    minimize: false,
  },
);

const ItemReadModelProcessedErrorSchema = new Schema(
  {
    message: { type: String, required: true },
    name: { type: String, default: null },
  },
  {
    _id: false,
    id: false,
    minimize: false,
  },
);

const ItemReadModelProcessedLlmSchema = new Schema(
  {
    model: { type: String, default: null },
    promptVersion: { type: String, default: null },
    promptTokens: { type: Number, default: null },
    completionTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
    costUsd: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
  },
  {
    _id: false,
    id: false,
    minimize: false,
  },
);

const ItemReadModelProcessedSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    itemMetaId: { type: String, required: true, trim: true },
    rawItemId: { type: String, default: null },
    pipelineJobId: { type: String, default: null },
    sourceId: { type: String, default: null },
    status: { type: String, required: true, trim: true },
    error: { type: ItemReadModelProcessedErrorSchema, default: null },
    tags: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    result: { type: Schema.Types.Mixed, default: null },
    duplicateOf: { type: String, default: null },
    duplicateSimilarity: { type: Number, default: null },
    summaryEmbeddingModel: { type: String, default: null },
    summaryEmbeddingDimensions: { type: Number, default: null },
    llm: { type: ItemReadModelProcessedLlmSchema, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    _id: false,
    id: false,
    minimize: false,
  },
);

const ItemReadModelSchema = new Schema(
  {
    orgId: { type: String, index: true, required: true, trim: true },
    itemMetaId: { type: String, required: true, trim: true },
    meta: { type: ItemReadModelMetaSchema, required: true },
    raw: { type: ItemReadModelRawSchema, default: null },
    processed: { type: ItemReadModelProcessedSchema, default: null },
    externalId: { type: String, required: true, trim: true },
    externalIdLower: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    titleLower: { type: String, required: true, trim: true },
    status: { type: String, required: true, trim: true },
    ingestedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    publishedAt: { type: Date, default: null },
    sortAt: { type: Date, required: true },
    sourceId: { type: String, default: null, trim: true },
    sourceName: { type: String, default: null },
    sourceNameLower: { type: String, default: null, trim: true },
    url: { type: String, default: null },
    thumbnail: { type: String, default: null },
    domain: { type: String, default: null, trim: true },
    language: { type: String, default: null, trim: true },
    summary: { type: String, default: null },
    topics: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    topicKeys: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    entities: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    entityKeys: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    region: { type: String, default: null },
    regionKey: { type: String, default: null, trim: true },
    location: { type: String, default: null },
    locationKey: { type: String, default: null, trim: true },
    sentiment: { type: String, default: null, trim: true },
    contentType: { type: String, default: null, trim: true },
    qualityScore: { type: Number, default: null },
    duplicateOf: { type: String, default: null, trim: true },
    duplicateSimilarity: { type: Number, default: null },
    tags: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    hasVector: { type: Boolean, default: false },
    embeddingModel: { type: String, default: null, trim: true },
    searchText: { type: String, default: "" },
    searchTerms: {
      type: [String],
      default: [],
      set: toStringArray,
    },
    projectionUpdatedAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    minimize: false,
  },
);

ItemReadModelSchema.index({ orgId: 1, itemMetaId: 1 }, { unique: true });
ItemReadModelSchema.index({ orgId: 1, sortAt: -1, itemMetaId: -1 });
ItemReadModelSchema.index({ orgId: 1, createdAt: -1, itemMetaId: -1 });
ItemReadModelSchema.index({ orgId: 1, sourceId: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, sourceNameLower: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, sentiment: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, contentType: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, duplicateOf: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, regionKey: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, locationKey: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, topicKeys: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, entityKeys: 1, sortAt: -1 });
ItemReadModelSchema.index({ orgId: 1, searchTerms: 1, sortAt: -1 });
ItemReadModelSchema.index({
  title: "text",
  summary: "text",
  sourceName: "text",
  searchText: "text",
  topics: "text",
  entities: "text",
  externalId: "text",
});

export type ItemReadModel = InferSchemaType<typeof ItemReadModelSchema>;

export const ItemReadModelModel =
  (models.ItemReadModel as Model<ItemReadModel> | undefined) ||
  model<ItemReadModel>("ItemReadModel", ItemReadModelSchema);

export type ItemReadModelDocument = HydratedDocument<ItemReadModel>;
