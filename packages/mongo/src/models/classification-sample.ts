import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const ClassificationSampleItemSchema = new Schema(
  {
    processedItemId: { type: String, required: true },
    itemMetaId: { type: String, default: null },
    sourceId: { type: String, default: null },
    sourceType: { type: String, enum: ['authoritative', 'blog', 'unknown'], default: null },
    articleUrl: { type: String, default: null },
    articleTitle: { type: String, default: null },
    predictedCategoryPath: { type: String, default: null },
    predictedLegacyCategory: { type: String, default: null },
    predictedConfidence: { type: Number, min: 0, max: 1, default: null },
    predictedMethod: { type: String, default: null },
    confidenceBand: { type: String, enum: ['low', 'medium', 'high'], required: true },
    sampledAt: { type: Date, required: true }
  },
  { _id: false }
);

const ClassificationSampleSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    createdById: { type: String, required: true, index: true },
    filters: Schema.Types.Mixed,
    strata: Schema.Types.Mixed,
    itemCount: { type: Number, required: true, min: 0 },
    items: { type: [ClassificationSampleItemSchema], default: [] },
    expiresAt: { type: Date, default: null }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

ClassificationSampleSchema.index({ orgId: 1, createdAt: -1 });
ClassificationSampleSchema.index({ orgId: 1, createdById: 1, createdAt: -1 });
ClassificationSampleSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }
);

export type ClassificationSample = InferSchemaType<typeof ClassificationSampleSchema>;

export const ClassificationSampleModel =
  (models.ClassificationSample as Model<ClassificationSample> | undefined) ||
  model<ClassificationSample>('ClassificationSample', ClassificationSampleSchema);

export type ClassificationSampleDocument = HydratedDocument<ClassificationSample>;
