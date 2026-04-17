import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

const NewsEventClusteringFailureItemEntitySchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: null },
  },
  { _id: false },
);

const NewsEventClusteringFailureItemSchema = new Schema(
  {
    processedArticleId: { type: String, required: true },
    processedItemId: { type: String, default: null },
    articleId: { type: String, required: true },
    title: { type: String, default: null },
    summary: { type: String, default: null },
    language: { type: String, default: null },
    category: { type: String, default: null },
    categoryPath: { type: String, default: null },
    categoryConfidence: { type: Number, min: 0, max: 1, default: null },
    topics: { type: [String], default: [] },
    entities: { type: [NewsEventClusteringFailureItemEntitySchema], default: [] },
    qualityScore: { type: Number, min: 0, max: 1, default: null },
    publishedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    crawlAt: { type: Date, default: null },
  },
  { _id: false },
);

const NewsEventClusteringFailureSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    groupId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'resolved', 'ignored'],
      default: 'pending',
      index: true,
    },
    clusteringMode: { type: String, default: 'bertopic_primary' },
    failureReason: { type: String, required: true },
    failureMessage: { type: String, default: null },
    requestId: { type: String, default: null },
    language: { type: String, default: null, index: true },
    embeddingModel: { type: String, default: null, index: true },
    itemCount: { type: Number, required: true, min: 0 },
    sampleTitles: { type: [String], default: [] },
    items: { type: [NewsEventClusteringFailureItemSchema], default: [] },
    attemptCount: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    activeJobId: { type: String, default: null, index: true },
    progressProcessedCount: { type: Number, default: 0, min: 0 },
    progressTotalCount: { type: Number, default: 0, min: 0 },
    lastRecoveryModel: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedById: { type: String, default: null, index: true },
    resolutionMode: { type: String, default: null },
    resolvedEventIds: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: undefined },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  },
);

NewsEventClusteringFailureSchema.index(
  { orgId: 1, groupId: 1 },
  { unique: true },
);
NewsEventClusteringFailureSchema.index({ orgId: 1, status: 1, createdAt: -1 });
NewsEventClusteringFailureSchema.index({ orgId: 1, language: 1, createdAt: -1 });
NewsEventClusteringFailureSchema.index({
  orgId: 1,
  embeddingModel: 1,
  createdAt: -1,
});

export type NewsEventClusteringFailure = InferSchemaType<
  typeof NewsEventClusteringFailureSchema
>;

export const NewsEventClusteringFailureModel =
  (models.NewsEventClusteringFailure as
    | Model<NewsEventClusteringFailure>
    | undefined) ||
  model<NewsEventClusteringFailure>(
    'NewsEventClusteringFailure',
    NewsEventClusteringFailureSchema,
  );

export type NewsEventClusteringFailureDocument = HydratedDocument<
  NewsEventClusteringFailure
>;
