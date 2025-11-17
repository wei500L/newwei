import { Schema, model, models } from "mongoose";

const TaskLogSchema = new Schema(
  {
    queue: { type: String, required: true },
    jobId: { type: String, required: true },
    orgId: { type: String, index: true, required: true },
    stage: { type: String, required: true },
    status: { type: String, enum: ["pending", "processing", "completed", "failed"], required: true },
    message: { type: String },
    data: Schema.Types.Mixed,
    error: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

TaskLogSchema.index({ queue: 1, jobId: 1, stage: 1 });
TaskLogSchema.index({ orgId: 1, createdAt: -1 });

export const TaskLogModel = models.TaskLog || model("TaskLog", TaskLogSchema);

export type TaskLogDocument = typeof TaskLogModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
