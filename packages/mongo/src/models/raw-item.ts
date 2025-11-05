import { Schema, model, models } from "mongoose";

const RawItemSchema = new Schema(
  {
    itemMetaId: { type: String, index: true, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    source: { type: String, default: "manual" }
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

export const RawItemModel = models.RawItem || model("RawItem", RawItemSchema);
export type RawItemDocument = typeof RawItemModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
