import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const SituationSignalLearningStateSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    signalType: { type: String, enum: ["narrative", "correlation"], required: true },
    signalId: { type: String, required: true },
    falsePositiveCount: { type: Number, default: 0, min: 0 },
    falseNegativeCount: { type: Number, default: 0, min: 0 },
    suppressedItemMetaIds: { type: [String], default: [] },
    boostedTokenCounts: { type: Map, of: Number, default: {} },
    blockedTokenCounts: { type: Map, of: Number, default: {} },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

SituationSignalLearningStateSchema.index({ orgId: 1, signalType: 1, signalId: 1 }, { unique: true });
SituationSignalLearningStateSchema.index({ orgId: 1, updatedAt: -1 });

export type SituationSignalLearningState = InferSchemaType<typeof SituationSignalLearningStateSchema>;

export const SituationSignalLearningStateModel =
  (models.SituationSignalLearningState as Model<SituationSignalLearningState> | undefined) ||
  model<SituationSignalLearningState>("SituationSignalLearningState", SituationSignalLearningStateSchema);

export type SituationSignalLearningStateDocument = HydratedDocument<SituationSignalLearningState>;
