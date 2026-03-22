import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from "mongoose";

export const DEFAULT_TASK_LOG_RETENTION_DAYS = 14;
export const MIN_TASK_LOG_RETENTION_DAYS = 1;
export const MAX_TASK_LOG_RETENTION_DAYS = 3650;
export const TASK_LOG_TTL_INDEX_NAME = "task_log_created_at_ttl";
const SECONDS_PER_DAY = 24 * 60 * 60;

const TaskLogSchema = new Schema(
  {
    queue: { type: String, required: true },
    jobId: { type: String, required: true },
    orgId: { type: String, index: true, required: true },
    stage: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      required: true,
    },
    message: { type: String },
    data: Schema.Types.Mixed,
    error: Schema.Types.Mixed,
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

TaskLogSchema.index({ queue: 1, jobId: 1, stage: 1 });
TaskLogSchema.index({ orgId: 1, createdAt: -1 });
TaskLogSchema.index({ orgId: 1, queue: 1, createdAt: -1 });
TaskLogSchema.index({ orgId: 1, queue: 1, jobId: 1, stage: 1, createdAt: -1 });
TaskLogSchema.index({ orgId: 1, queue: 1, stage: 1, status: 1, createdAt: -1 });
TaskLogSchema.index({ orgId: 1, stage: 1, status: 1, createdAt: -1 });
TaskLogSchema.index(
  { createdAt: 1 },
  {
    name: TASK_LOG_TTL_INDEX_NAME,
    expireAfterSeconds: DEFAULT_TASK_LOG_RETENTION_DAYS * SECONDS_PER_DAY,
  },
);

export type TaskLog = InferSchemaType<typeof TaskLogSchema>;

export const TaskLogModel =
  (models.TaskLog as Model<TaskLog> | undefined) ||
  model<TaskLog>("TaskLog", TaskLogSchema);

export type TaskLogDocument = HydratedDocument<TaskLog>;
