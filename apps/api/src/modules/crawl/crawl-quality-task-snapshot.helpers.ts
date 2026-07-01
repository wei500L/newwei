interface CrawlQualityTaskSourceInput {
  id: string;
  orgId: string;
  newsSourceId: string | null;
  displayName: string | null;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrawlQualityTaskExpansionSummary {
  taskId: string;
  lowSignalTaskCount: number;
  expansionTriggeredTaskCount: number;
  expansionImprovedTaskCount: number;
  candidateRejectIncludePatternCount: number;
  candidateRejectExcludePatternCount: number;
  candidateRejectPublishConfidenceCount: number;
  publishConfidenceLt04Count: number;
  publishConfidenceFrom04To06Count: number;
  publishConfidenceFrom06To08Count: number;
  publishConfidenceGte08Count: number;
  fitMarkdownPreferenceTaskCount: number;
  headSignalAttemptedCount: number;
  headSignalSucceededCount: number;
  headSignalSoftFailureCount: number;
  headSignalTruncatedCount: number;
  headSignalNoPublishSignalCount: number;
}

export interface CrawlQualityTaskPreflightSummary {
  taskId: string;
  preflightRunCount: number;
  preflightFailureCount: number;
  preflight304HitCount: number;
}

export interface CrawlQualityTaskDedupeSummary {
  taskId: string;
  dedupeEvaluatedCount: number;
  dedupeOrgReuseCount: number;
}

export interface CrawlQualityTaskMarkdownSummary {
  taskId: string;
  markdownCount: number;
  markdownCharsTotal: number;
  emptyMarkdownCount: number;
}

export interface CrawlQualityTaskSnapshotWriteRow {
  taskId: string;
  orgId: string;
  sourceId: string;
  taskCreatedAt: Date;
  taskUpdatedAt: Date;
  rolledAt: Date;
  lowSignalTaskCount: number;
  expansionTriggeredTaskCount: number;
  expansionImprovedTaskCount: number;
  markdownCount: number;
  markdownCharsTotal: number;
  emptyMarkdownCount: number;
  candidateRejectIncludePatternCount: number;
  candidateRejectExcludePatternCount: number;
  candidateRejectPublishConfidenceCount: number;
  publishConfidenceLt04Count: number;
  publishConfidenceFrom04To06Count: number;
  publishConfidenceFrom06To08Count: number;
  publishConfidenceGte08Count: number;
  fitMarkdownPreferenceTaskCount: number;
  headSignalAttemptedCount: number;
  headSignalSucceededCount: number;
  headSignalSoftFailureCount: number;
  headSignalTruncatedCount: number;
  headSignalNoPublishSignalCount: number;
  preflightRunCount: number;
  preflightFailureCount: number;
  preflight304HitCount: number;
  dedupeEvaluatedCount: number;
  dedupeOrgReuseCount: number;
}

function createEmptySnapshotCounts(): Omit<
  CrawlQualityTaskSnapshotWriteRow,
  | "taskId"
  | "orgId"
  | "sourceId"
  | "taskCreatedAt"
  | "taskUpdatedAt"
  | "rolledAt"
> {
  return {
    lowSignalTaskCount: 0,
    expansionTriggeredTaskCount: 0,
    expansionImprovedTaskCount: 0,
    markdownCount: 0,
    markdownCharsTotal: 0,
    emptyMarkdownCount: 0,
    candidateRejectIncludePatternCount: 0,
    candidateRejectExcludePatternCount: 0,
    candidateRejectPublishConfidenceCount: 0,
    publishConfidenceLt04Count: 0,
    publishConfidenceFrom04To06Count: 0,
    publishConfidenceFrom06To08Count: 0,
    publishConfidenceGte08Count: 0,
    fitMarkdownPreferenceTaskCount: 0,
    headSignalAttemptedCount: 0,
    headSignalSucceededCount: 0,
    headSignalSoftFailureCount: 0,
    headSignalTruncatedCount: 0,
    headSignalNoPublishSignalCount: 0,
    preflightRunCount: 0,
    preflightFailureCount: 0,
    preflight304HitCount: 0,
    dedupeEvaluatedCount: 0,
    dedupeOrgReuseCount: 0,
  };
}

export function normalizeCrawlQualitySourceId(
  task: Pick<
    CrawlQualityTaskSourceInput,
    "newsSourceId" | "displayName" | "config"
  >,
): string {
  if (
    typeof task.newsSourceId === "string" &&
    task.newsSourceId.trim().length > 0
  ) {
    return task.newsSourceId.trim();
  }

  const { config, displayName } = task;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const record = config as Record<string, unknown>;
    const itemPayload =
      record.itemPayload &&
      typeof record.itemPayload === "object" &&
      !Array.isArray(record.itemPayload)
        ? (record.itemPayload as Record<string, unknown>)
        : null;
    const metadata =
      itemPayload?.metadata &&
      typeof itemPayload.metadata === "object" &&
      !Array.isArray(itemPayload.metadata)
        ? (itemPayload.metadata as Record<string, unknown>)
        : null;
    const sourceId =
      typeof metadata?.sourceId === "string" ? metadata.sourceId.trim() : "";
    if (sourceId.length > 0) {
      return sourceId;
    }
  }

  if (typeof displayName === "string") {
    const match = /^NewsSource:([^:]+):/.exec(displayName);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "unknown";
}

export function buildCrawlQualityTaskSnapshotRows(
  tasks: CrawlQualityTaskSourceInput[],
  inputs: {
    expansionRows: CrawlQualityTaskExpansionSummary[];
    preflightRows: CrawlQualityTaskPreflightSummary[];
    dedupeRows: CrawlQualityTaskDedupeSummary[];
    markdownRows: CrawlQualityTaskMarkdownSummary[];
  },
  rolledAt: Date,
): CrawlQualityTaskSnapshotWriteRow[] {
  const expansionByTaskId = new Map(
    inputs.expansionRows.map((row) => [row.taskId, row]),
  );
  const preflightByTaskId = new Map(
    inputs.preflightRows.map((row) => [row.taskId, row]),
  );
  const dedupeByTaskId = new Map(
    inputs.dedupeRows.map((row) => [row.taskId, row]),
  );
  const markdownByTaskId = new Map(
    inputs.markdownRows.map((row) => [row.taskId, row]),
  );

  return tasks.map((task) => {
    const base = createEmptySnapshotCounts();
    const expansion = expansionByTaskId.get(task.id);
    const preflight = preflightByTaskId.get(task.id);
    const dedupe = dedupeByTaskId.get(task.id);
    const markdown = markdownByTaskId.get(task.id);
    const { taskId: expansionTaskId, ...expansionCounts } = expansion ?? {
      taskId: task.id,
    };
    void expansionTaskId;
    const { taskId: preflightTaskId, ...preflightCounts } = preflight ?? {
      taskId: task.id,
    };
    void preflightTaskId;
    const { taskId: dedupeTaskId, ...dedupeCounts } = dedupe ?? {
      taskId: task.id,
    };
    void dedupeTaskId;
    const { taskId: markdownTaskId, ...markdownCounts } = markdown ?? {
      taskId: task.id,
    };
    void markdownTaskId;

    return {
      taskId: task.id,
      orgId: task.orgId,
      sourceId: normalizeCrawlQualitySourceId(task),
      taskCreatedAt: task.createdAt,
      taskUpdatedAt: task.updatedAt,
      rolledAt,
      ...base,
      ...expansionCounts,
      ...preflightCounts,
      ...dedupeCounts,
      ...markdownCounts,
    };
  });
}
