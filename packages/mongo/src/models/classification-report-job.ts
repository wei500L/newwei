import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const ClassificationReportJobSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    requestedById: { type: String, required: true, index: true },
    sampleId: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
      index: true
    },
    progress: { type: Number, min: 0, max: 1, default: 0 },
    reportResultId: { type: String, default: null, index: true },
    filters: Schema.Types.Mixed,
    options: Schema.Types.Mixed,
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    error: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

ClassificationReportJobSchema.index({ orgId: 1, status: 1, createdAt: -1 });
ClassificationReportJobSchema.index({ orgId: 1, requestedById: 1, createdAt: -1 });
ClassificationReportJobSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }
);

export type ClassificationReportJob = InferSchemaType<typeof ClassificationReportJobSchema>;

export const ClassificationReportJobModel =
  (models.ClassificationReportJob as Model<ClassificationReportJob> | undefined) ||
  model<ClassificationReportJob>('ClassificationReportJob', ClassificationReportJobSchema);

export type ClassificationReportJobDocument = HydratedDocument<ClassificationReportJob>;
