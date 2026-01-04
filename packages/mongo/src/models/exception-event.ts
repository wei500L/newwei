import { Schema, model, models } from "mongoose";

const ExceptionEventSchema = new Schema(
  {
    id: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    userId: { type: String, index: true },
    kind: { type: String, enum: ["http", "graphql", "unknown"], required: true },
    traceId: { type: String, index: true },
    timestamp: { type: Date, required: true, index: true },
    statusCode: Number,
    message: { type: String, required: true },
    path: String,
    method: String,
    operation: String,
    operationName: String,
    errorName: String,
    stack: String
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

ExceptionEventSchema.index({ orgId: 1, timestamp: -1 });
ExceptionEventSchema.index({ kind: 1, timestamp: -1 });

export const ExceptionEventModel =
  models.ExceptionEvent || model("ExceptionEvent", ExceptionEventSchema);

export type ExceptionEventDocument = typeof ExceptionEventModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
