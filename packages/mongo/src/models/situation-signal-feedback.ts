import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

import type { SituationSignalFeedbackLabel, SituationSignalType } from "./situation-signal.types";

const SituationSignalFeedbackSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    signalType: { type: String, enum: ["narrative", "correlation"], required: true, index: true },
    signalId: { type: String, required: true, index: true },
    label: { type: String, enum: ["false_positive", "false_negative"], required: true, index: true },
    itemMetaId: { type: String, index: true, default: null },
    itemLink: { type: String, default: null },
    itemTitle: { type: String, default: null },
    itemSource: { type: String, default: null },
    note: { type: String, default: null },
    metadata: Schema.Types.Mixed,
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

SituationSignalFeedbackSchema.index({ orgId: 1, signalType: 1, signalId: 1, createdAt: -1 });
SituationSignalFeedbackSchema.index({ orgId: 1, label: 1, createdAt: -1 });
SituationSignalFeedbackSchema.index({ orgId: 1, itemMetaId: 1, createdAt: -1 });

export type SituationSignalFeedback = InferSchemaType<typeof SituationSignalFeedbackSchema>;

export const SituationSignalFeedbackModel =
  (models.SituationSignalFeedback as Model<SituationSignalFeedback> | undefined) ||
  model<SituationSignalFeedback>("SituationSignalFeedback", SituationSignalFeedbackSchema);

export type SituationSignalFeedbackDocument = HydratedDocument<SituationSignalFeedback>;
