import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

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

export type AkshareResponse = InferSchemaType<typeof AkshareResponseSchema>;

export const AkshareResponseModel =
  (models.AkshareResponse as Model<AkshareResponse> | undefined) ||
  model<AkshareResponse>("AkshareResponse", AkshareResponseSchema);

export type AkshareResponseDocument = HydratedDocument<AkshareResponse>;
