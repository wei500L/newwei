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
    triggeredById: String,
    // The BullMQ lock token of the attempt that currently owns the record.
    // Optional on historical documents: the first attempt that receives the
    // job writes it, and every terminal update is conditional on it. This is
    // the fencing token that lets a stalled attempt be recovered without
    // letting the old worker overwrite the new result.
    runToken: String
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
