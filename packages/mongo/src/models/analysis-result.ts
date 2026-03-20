import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const AnalysisResultSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ["correlation", "anomaly", "geo_transport"],
      required: true,
    },
    status: { type: String, enum: ["pending", "running", "completed", "failed"], default: "pending" },
    input: Schema.Types.Mixed,
    output: Schema.Types.Mixed,
    summary: String,
    error: String,
    model: String,
    triggeredById: String
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

AnalysisResultSchema.index({ orgId: 1, createdAt: -1 });
AnalysisResultSchema.index({ type: 1, orgId: 1 });

export type AnalysisResult = InferSchemaType<typeof AnalysisResultSchema>;

export const AnalysisResultModel =
  (models.AnalysisResult as Model<AnalysisResult> | undefined) ||
  model<AnalysisResult>("AnalysisResult", AnalysisResultSchema);

export type AnalysisResultDocument = HydratedDocument<AnalysisResult>;
