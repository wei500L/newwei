import { TaskLogModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";

export type TaskLogWriteStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export interface TaskLogWritePayload {
  queue: string;
  jobId: string | number;
  orgId: string;
  stage: string;
  status: TaskLogWriteStatus;
  message?: string;
  data?: unknown;
  error?: unknown;
}

const logger = createLogger({ name: "task-log-writer" });

export async function writeTaskLogBestEffort(
  payload: TaskLogWritePayload,
): Promise<void> {
  try {
    await TaskLogModel.create({
      ...payload,
      jobId: String(payload.jobId),
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        queue: payload.queue,
        jobId: payload.jobId,
        orgId: payload.orgId,
        stage: payload.stage,
        status: payload.status,
      },
      "Failed to persist task log",
    );
  }
}
