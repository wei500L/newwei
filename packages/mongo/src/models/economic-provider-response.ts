import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const EconomicProviderResponseSchema = new Schema(
  {
    dataItemId: { type: String, required: true, index: true },
    providerKind: { type: String, required: true, index: true },
    providerIdentity: { type: String, required: true, index: true },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    requestParams: { type: Schema.Types.Mixed, default: {} },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true, default: 'success' },
    fetchedAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  },
);

EconomicProviderResponseSchema.index({ dataItemId: 1, fetchedAt: -1 });
EconomicProviderResponseSchema.index({ providerKind: 1, providerIdentity: 1, fetchedAt: -1 });

export type EconomicProviderResponse = InferSchemaType<typeof EconomicProviderResponseSchema>;

export const EconomicProviderResponseModel =
  (models.EconomicProviderResponse as Model<EconomicProviderResponse> | undefined) ||
  model<EconomicProviderResponse>('EconomicProviderResponse', EconomicProviderResponseSchema);

export type EconomicProviderResponseDocument = HydratedDocument<EconomicProviderResponse>;
