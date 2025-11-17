import { Schema, model, models } from "mongoose";

const AnalysisResultSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    type: { type: String, enum: ["correlation", "anomaly"], required: true },
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

export const AnalysisResultModel = models.AnalysisResult || model("AnalysisResult", AnalysisResultSchema);

export type AnalysisResultDocument = typeof AnalysisResultModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
