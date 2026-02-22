import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const ClassificationCandidateSchema = new Schema(
  {
    path: { type: String, required: true },
    score: { type: Number, min: 0, max: 1, required: true },
    legacy_category: { type: String, default: null },
    reason: { type: String, default: null }
  },
  { _id: false }
);

const ClassificationReviewSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    evidenceId: { type: String, required: true, index: true },
    processedItemId: { type: String, required: true, index: true },
    itemMetaId: { type: String, default: null, index: true },
    sourceId: { type: String, default: null, index: true },
    sourceType: {
      type: String,
      enum: ['authoritative', 'blog', 'unknown'],
      default: null,
      index: true
    },
    articleUrl: { type: String, default: null },
    articleTitle: { type: String, default: null },
    articleSummary: { type: String, default: null },
    predictedCategoryPath: { type: String, default: null, index: true },
    predictedLegacyCategory: { type: String, default: null },
    predictedConfidence: { type: Number, min: 0, max: 1, default: null, index: true },
    predictedMethod: { type: String, default: null, index: true },
    candidatePaths: { type: [ClassificationCandidateSchema], default: [] },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'corrected'],
      default: 'pending',
      index: true
    },
    correctedCategoryPath: { type: String, default: null },
    note: { type: String, default: null },
    quickTags: { type: [String], default: [] },
    reviewerId: { type: String, default: null, index: true },
    reviewedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    metadata: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

ClassificationReviewSchema.index({ orgId: 1, status: 1, createdAt: -1 });
ClassificationReviewSchema.index({ orgId: 1, sourceId: 1, createdAt: -1 });
ClassificationReviewSchema.index({ orgId: 1, predictedConfidence: 1, createdAt: -1 });
ClassificationReviewSchema.index({ orgId: 1, processedItemId: 1 }, { unique: true });
ClassificationReviewSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }
);

export type ClassificationReview = InferSchemaType<typeof ClassificationReviewSchema>;

export const ClassificationReviewModel =
  (models.ClassificationReview as Model<ClassificationReview> | undefined) ||
  model<ClassificationReview>('ClassificationReview', ClassificationReviewSchema);

export type ClassificationReviewDocument = HydratedDocument<ClassificationReview>;
