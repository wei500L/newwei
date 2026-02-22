import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const ClassificationAnnotationSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    sampleId: { type: String, required: true, index: true },
    processedItemId: { type: String, required: true, index: true },
    annotatorId: { type: String, required: true, index: true },
    predictedCategoryPath: { type: String, default: null },
    predictedMethod: { type: String, default: null },
    predictedConfidence: { type: Number, min: 0, max: 1, default: null },
    humanCategoryPath: { type: String, required: true, index: true },
    note: { type: String, default: null },
    quickTags: { type: [String], default: [] },
    expiresAt: { type: Date, default: null },
    metadata: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

ClassificationAnnotationSchema.index(
  { orgId: 1, sampleId: 1, processedItemId: 1 },
  { unique: true }
);
ClassificationAnnotationSchema.index({ orgId: 1, sampleId: 1, createdAt: -1 });
ClassificationAnnotationSchema.index({ orgId: 1, humanCategoryPath: 1, createdAt: -1 });
ClassificationAnnotationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }
);

export type ClassificationAnnotation = InferSchemaType<typeof ClassificationAnnotationSchema>;

export const ClassificationAnnotationModel =
  (models.ClassificationAnnotation as Model<ClassificationAnnotation> | undefined) ||
  model<ClassificationAnnotation>('ClassificationAnnotation', ClassificationAnnotationSchema);

export type ClassificationAnnotationDocument = HydratedDocument<ClassificationAnnotation>;
