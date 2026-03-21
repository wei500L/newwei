export type CrawlOpsEventSource =
  | 'pipeline'
  | 'crawl'
  | 'analysis'
  | 'assistant'
  | 'alerts';

export interface CrawlOpsEventPayload {
  source?: CrawlOpsEventSource;
  event?: string;
  jobId?: string;
  taskId?: string;
  pipelineJobId?: string;
}

export interface CrawlTasksOpsRefreshDecision {
  tasks: boolean;
  queue: boolean;
}

export interface CrawlTaskDetailOpsRefreshContext {
  taskId: string;
  pipelineJobId?: string | null;
}

export interface CrawlTaskDetailOpsRefreshDecision {
  task: boolean;
}

const REFRESHABLE_EVENTS = new Set(['ACTIVE', 'COMPLETED', 'FAILED']);

function normalizePayload(payload: unknown): CrawlOpsEventPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload as CrawlOpsEventPayload;
}

function isRefreshableEvent(event: string | undefined): boolean {
  return typeof event === 'string' && REFRESHABLE_EVENTS.has(event);
}

export function getCrawlTasksOpsRefreshDecision(
  payload: unknown,
): CrawlTasksOpsRefreshDecision | null {
  const record = normalizePayload(payload);
  if (!record || record.source !== 'crawl' || !isRefreshableEvent(record.event)) {
    return null;
  }

  return { tasks: true, queue: true };
}

export function getCrawlTaskDetailOpsRefreshDecision(
  payload: unknown,
  context: CrawlTaskDetailOpsRefreshContext,
): CrawlTaskDetailOpsRefreshDecision | null {
  const record = normalizePayload(payload);
  if (!record || !isRefreshableEvent(record.event)) {
    return null;
  }

  if (record.source === 'crawl') {
    const eventTaskId =
      typeof record.taskId === 'string' ? record.taskId : undefined;
    const eventJobId =
      typeof record.jobId === 'string' ? record.jobId : undefined;
    const relevant =
      eventTaskId === context.taskId ||
      eventJobId === context.taskId ||
      (typeof eventJobId === 'string' &&
        eventJobId.startsWith(`${context.taskId}-`));
    return relevant ? { task: true } : null;
  }

  if (
    record.source === 'pipeline' &&
    typeof context.pipelineJobId === 'string' &&
    context.pipelineJobId.length > 0 &&
    record.pipelineJobId === context.pipelineJobId
  ) {
    return { task: true };
  }

  return null;
}
