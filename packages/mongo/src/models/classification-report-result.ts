import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const ConfusionEntrySchema = new Schema(
  {
    predictedPath: { type: String, required: true },
    actualPath: { type: String, required: true },
    count: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const ProblemPathPairSchema = new Schema(
  {
    predictedPath: { type: String, required: true },
    actualPath: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
    errorRate: { type: Number, required: true, min: 0, max: 1 }
  },
  { _id: false }
);

const ClassificationReportResultSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    jobId: { type: String, required: true, index: true, unique: true },
    sampleId: { type: String, default: null, index: true },
    total: { type: Number, required: true, min: 0 },
    correct: { type: Number, required: true, min: 0 },
    accuracy: { type: Number, required: true, min: 0, max: 1 },
    confusionMatrix: { type: [ConfusionEntrySchema], default: [] },
    problemPathPairs: { type: [ProblemPathPairSchema], default: [] },
    expiresAt: { type: Date, default: null },
    metadata: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

ClassificationReportResultSchema.index({ orgId: 1, createdAt: -1 });
ClassificationReportResultSchema.index({ orgId: 1, sampleId: 1, createdAt: -1 });
ClassificationReportResultSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }
);

export type ClassificationReportResult = InferSchemaType<typeof ClassificationReportResultSchema>;

export const ClassificationReportResultModel =
  (models.ClassificationReportResult as Model<ClassificationReportResult> | undefined) ||
  model<ClassificationReportResult>('ClassificationReportResult', ClassificationReportResultSchema);

export type ClassificationReportResultDocument = HydratedDocument<ClassificationReportResult>;
