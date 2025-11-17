import { Schema, model, models } from "mongoose";

const ProcessedItemSchema = new Schema(
  {
    rawItemId: { type: Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemMetaId: { type: String, index: true, required: true },
    orgId: { type: String, index: true, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    tags: { type: [String], default: [] },
    result: Schema.Types.Mixed,
    error: Schema.Types.Mixed,
    llm: {
      model: { type: String },
      promptVersion: { type: String },
      promptTokens: { type: Number },
      completionTokens: { type: Number },
      totalTokens: { type: Number },
      costUsd: { type: Number },
      latencyMs: { type: Number },
    },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

export const ProcessedItemModel =
  models.ProcessedItem || model("ProcessedItem", ProcessedItemSchema);

export type ProcessedItemDocument = typeof ProcessedItemModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
