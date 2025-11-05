import { Schema, model, models } from "mongoose";

const ProcessedItemSchema = new Schema(
  {
    rawItemId: { type: Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemMetaId: { type: String, index: true, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending"
    },
    tags: { type: [String], default: [] },
    result: Schema.Types.Mixed,
    error: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

export const ProcessedItemModel =
  models.ProcessedItem || model("ProcessedItem", ProcessedItemSchema);

export type ProcessedItemDocument = typeof ProcessedItemModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
