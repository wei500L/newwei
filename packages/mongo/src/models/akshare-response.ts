import { Schema, model, models } from "mongoose";

const AkshareResponseSchema = new Schema(
  {
    dataItemId: { type: String, required: true, index: true },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    requestParams: { type: Schema.Types.Mixed, default: {} },
    payload: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, required: true, default: () => new Date() }
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

AkshareResponseSchema.index({ dataItemId: 1, fetchedAt: -1 });

export const AkshareResponseModel =
  models.AkshareResponse || model("AkshareResponse", AkshareResponseSchema);

export type AkshareResponseDocument = typeof AkshareResponseModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
