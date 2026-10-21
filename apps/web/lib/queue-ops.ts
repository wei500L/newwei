import { createApiClient } from "./api-client";

/**
 * 队列运维（T6）REST 客户端。
 *
 * 后端契约（api-go，前缀 /api/admin/queue-ops，需要登录 + queue.manage +
 * platform_admin）与这里一一对应；字段名与路径不要改，Go 侧并行实现。
 *
 * 注意：`timestamp` / `processedOn` / `finishedOn` 都是毫秒整数。
 */

export const QUEUE_OPS_JOB_STATES = [
  "waiting",
  "active",
  "delayed",
  "completed",
  "failed",
] as const;

export type QueueOpsJobState = (typeof QUEUE_OPS_JOB_STATES)[number];

const QUEUE_OPS_JOB_STATE_SET: ReadonlySet<string> = new Set<string>(
  QUEUE_OPS_JOB_STATES,
);

/** 死信队列名固定为 itemPipelineDlq（其 waiting 即「排队中的死信」）。 */
export const QUEUE_OPS_DLQ_QUEUE_NAME = "itemPipelineDlq";

export const QUEUE_OPS_JOBS_PAGE_SIZE = 20;
export const QUEUE_OPS_DEFAULT_BATCH_LIMIT = 100;

export const QUEUE_OPS_ENDPOINTS = {
  queues: "admin/queue-ops/queues",
  jobs: "admin/queue-ops/jobs",
  jobDetail: "admin/queue-ops/jobs/detail",
  retryJob: "admin/queue-ops/jobs/retry",
  deleteJob: "admin/queue-ops/jobs/delete",
  promoteJob: "admin/queue-ops/jobs/promote",
  retryFailed: "admin/queue-ops/queues/retry-failed",
  cleanQueue: "admin/queue-ops/queues/clean",
  pauseQueue: "admin/queue-ops/queues/pause",
  resumeQueue: "admin/queue-ops/queues/resume",
  dlqReplay: "admin/queue-ops/dlq/replay",
  dlqDelete: "admin/queue-ops/dlq/delete",
} as const;

export interface QueueOpsCounts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

export interface QueueOpsQueue {
  name: string;
  counts: QueueOpsCounts;
  paused: boolean;
  concurrency: number | null;
  isDLQ: boolean;
}

export interface QueueOpsJobSummary {
  id: string;
  name: string;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  failedReason: string;
  dataPreview: string;
}

export interface QueueOpsJobDetail extends QueueOpsJobSummary {
  data: unknown;
  opts: unknown;
  returnvalue: unknown;
  stacktrace: string[];
  logs: string[];
  dataTruncated: boolean;
  orgId: string | null;
}

export interface QueueOpsQueuesResponse {
  queues: QueueOpsQueue[];
}

export interface QueueOpsJobsResponse {
  queue: string;
  state: QueueOpsJobState;
  jobs: QueueOpsJobSummary[];
  nextCursor: string | null;
}

export interface QueueOpsJobDetailResponse {
  job: QueueOpsJobDetail;
}

export interface QueueOpsJobRef {
  queue: string;
  jobId: string;
}

export interface QueueOpsRetryJobResponse {
  queue: string;
  jobId: string;
  state: string;
}

export interface QueueOpsDeleteJobResponse {
  queue: string;
  jobId: string;
  deleted: boolean;
}

export type QueueOpsPromoteJobResponse = QueueOpsJobRef;

export interface QueueOpsRetryFailedResponse {
  queue: string;
  matched: number;
  retried: number;
}

export interface QueueOpsCleanQueueResponse {
  queue: string;
  state: QueueOpsJobState;
  removed: number;
}

export interface QueueOpsPauseQueueResponse {
  queue: string;
  paused: boolean;
}

export interface QueueOpsResumeQueueResponse {
  queue: string;
  paused: boolean;
}

export interface QueueOpsDlqReplayResult {
  dlqJobId: string;
  originalJobId: string;
  originalQueue: string;
  orgId: string | null;
  newJobId: string | null;
  replayed: boolean;
  dlqRemoved: boolean;
  warning: string | null;
}

export interface QueueOpsDlqReplayResponse {
  results: QueueOpsDlqReplayResult[];
}

export interface QueueOpsDlqDeleteResult {
  dlqJobId: string;
  deleted: boolean;
}

export interface QueueOpsDlqDeleteResponse {
  results: QueueOpsDlqDeleteResult[];
}

export type QueueOpsDlqReplayRequest =
  | { jobId: string }
  | { jobIds: readonly string[] };

export type QueueOpsDlqDeleteRequest =
  | { jobId: string }
  | { jobIds: readonly string[] };

export type QueueOpsErrorKind = "notFound" | "forbidden" | "other";

export function isQueueOpsJobState(value: unknown): value is QueueOpsJobState {
  return typeof value === "string" && QUEUE_OPS_JOB_STATE_SET.has(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * 从任意请求错误里取 HTTP 状态码（axios 错误与 `{ response: { status } }`
 * 形状的替身都支持），取不到时返回 null。
 */
export function resolveQueueOpsErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const response = error.response;
  if (!isRecord(response)) {
    return null;
  }
  const status = response.status;
  return typeof status === "number" ? status : null;
}

/**
 * 404 表示 api-go 未开启队列运维（legacy 模式）；403 表示权限不足；其余
 * 交给页面常规错误态处理。
 */
export function classifyQueueOpsError(error: unknown): QueueOpsErrorKind {
  const status = resolveQueueOpsErrorStatus(error);
  if (status === 404) {
    return "notFound";
  }
  if (status === 403) {
    return "forbidden";
  }
  return "other";
}

/** 重放成功但 DLQ 残留的条数（用于页面 warning 提示）。 */
export function countQueueOpsDlqResiduals(
  results: readonly QueueOpsDlqReplayResult[],
): number {
  return results.filter((result) => !result.dlqRemoved).length;
}

const api = createApiClient();

export async function fetchQueueOpsQueues(): Promise<QueueOpsQueuesResponse> {
  const response = await api.get<QueueOpsQueuesResponse>(
    QUEUE_OPS_ENDPOINTS.queues,
  );
  return response.data;
}

export interface FetchQueueOpsJobsParams {
  queue: string;
  state: QueueOpsJobState;
  cursor?: string | null;
  limit?: number;
}

export async function fetchQueueOpsJobs(
  params: FetchQueueOpsJobsParams,
): Promise<QueueOpsJobsResponse> {
  const query: Record<string, string | number> = {
    queue: params.queue,
    state: params.state,
    limit: params.limit ?? QUEUE_OPS_JOBS_PAGE_SIZE,
  };
  if (params.cursor) {
    query.cursor = params.cursor;
  }
  const response = await api.get<QueueOpsJobsResponse>(
    QUEUE_OPS_ENDPOINTS.jobs,
    { params: query },
  );
  return response.data;
}

export async function fetchQueueOpsJobDetail(
  ref: QueueOpsJobRef,
): Promise<QueueOpsJobDetailResponse> {
  const response = await api.get<QueueOpsJobDetailResponse>(
    QUEUE_OPS_ENDPOINTS.jobDetail,
    { params: { queue: ref.queue, jobId: ref.jobId } },
  );
  return response.data;
}

export async function retryJob(
  ref: QueueOpsJobRef,
): Promise<QueueOpsRetryJobResponse> {
  const response = await api.post<QueueOpsRetryJobResponse>(
    QUEUE_OPS_ENDPOINTS.retryJob,
    ref,
  );
  return response.data;
}

export async function deleteJob(
  ref: QueueOpsJobRef,
): Promise<QueueOpsDeleteJobResponse> {
  const response = await api.post<QueueOpsDeleteJobResponse>(
    QUEUE_OPS_ENDPOINTS.deleteJob,
    ref,
  );
  return response.data;
}

export async function promoteJob(
  ref: QueueOpsJobRef,
): Promise<QueueOpsPromoteJobResponse> {
  const response = await api.post<QueueOpsPromoteJobResponse>(
    QUEUE_OPS_ENDPOINTS.promoteJob,
    ref,
  );
  return response.data;
}

export interface RetryFailedQueueJobsParams {
  queue: string;
  limit: number;
}

export async function retryFailedQueueJobs(
  params: RetryFailedQueueJobsParams,
): Promise<QueueOpsRetryFailedResponse> {
  const response = await api.post<QueueOpsRetryFailedResponse>(
    QUEUE_OPS_ENDPOINTS.retryFailed,
    { queue: params.queue, limit: params.limit },
  );
  return response.data;
}

export interface CleanQueueParams {
  queue: string;
  state: QueueOpsJobState;
  grace: number;
  limit: number;
}

export async function cleanQueue(
  params: CleanQueueParams,
): Promise<QueueOpsCleanQueueResponse> {
  const response = await api.post<QueueOpsCleanQueueResponse>(
    QUEUE_OPS_ENDPOINTS.cleanQueue,
    {
      queue: params.queue,
      state: params.state,
      grace: params.grace,
      limit: params.limit,
    },
  );
  return response.data;
}

export async function pauseQueue(
  queue: string,
): Promise<QueueOpsPauseQueueResponse> {
  const response = await api.post<QueueOpsPauseQueueResponse>(
    QUEUE_OPS_ENDPOINTS.pauseQueue,
    { queue },
  );
  return response.data;
}

export async function resumeQueue(
  queue: string,
): Promise<QueueOpsResumeQueueResponse> {
  const response = await api.post<QueueOpsResumeQueueResponse>(
    QUEUE_OPS_ENDPOINTS.resumeQueue,
    { queue },
  );
  return response.data;
}

export async function replayDlqJobs(
  request: QueueOpsDlqReplayRequest,
): Promise<QueueOpsDlqReplayResponse> {
  const response = await api.post<QueueOpsDlqReplayResponse>(
    QUEUE_OPS_ENDPOINTS.dlqReplay,
    request,
  );
  return response.data;
}

export async function deleteDlqJobs(
  request: QueueOpsDlqDeleteRequest,
): Promise<QueueOpsDlqDeleteResponse> {
  const response = await api.post<QueueOpsDlqDeleteResponse>(
    QUEUE_OPS_ENDPOINTS.dlqDelete,
    request,
  );
  return response.data;
}
