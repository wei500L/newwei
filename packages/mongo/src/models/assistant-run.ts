import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const AssistantRunSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    type: { type: String, enum: ["query", "report", "forecast"], required: true },
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

AssistantRunSchema.index({ orgId: 1, createdAt: -1 });
AssistantRunSchema.index({ orgId: 1, type: 1, createdAt: -1 });

export type AssistantRun = InferSchemaType<typeof AssistantRunSchema>;

export const AssistantRunModel =
  (models.AssistantRun as Model<AssistantRun> | undefined) ||
  model<AssistantRun>("AssistantRun", AssistantRunSchema);

export type AssistantRunDocument = HydratedDocument<AssistantRun>;

