export type WorkflowNodeType = string;

export interface WorkflowRunStep {
  stepKey?: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  label: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  durationMs: number;
  inputCount: number;
  outputCount: number;
  rejectedCount: number;
  sampleUrls: string[];
  metrics?: Record<string, unknown>;
  error?: string | null;
}

export interface WorkflowRunEvent {
  id?: string;
  sequence?: number;
  level: 'info' | 'warn' | 'error';
  eventType: string;
  nodeId?: string | null;
  nodeType?: WorkflowNodeType | null;
  message: string;
  triggerReason?: string | null;
  beforeCount?: number | null;
  afterCount?: number | null;
  rescuedCount?: number | null;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface WorkflowCandidateTraceEntry {
  timestamp: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  action: string;
  message: string;
  accepted?: boolean;
  ruleHits?: string[];
  scoreDelta?: number;
  freshnessDelta?: number;
  rejectedReason?: string | null;
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface WorkflowCandidateRecord {
  id: string;
  sourceNodeId: string;
  url: string;
  title?: string;
  description?: string;
  pageType?: string;
  score?: number;
  freshnessScore?: number;
  relevanceScore?: number;
  status: 'active' | 'selected' | 'rejected';
  rejectedReason?: string | null;
  metadata?: Record<string, unknown>;
  trace: WorkflowCandidateTraceEntry[];
}

export interface WorkflowCandidateTraceChainStep {
  key: string;
  index: number;
  nodeId: string;
  nodeType: WorkflowNodeType;
  action: string;
  label: string;
  status: 'active' | 'selected' | 'rejected';
  rejectedReason?: string | null;
  changedFields: string[];
  deltaSummary: string[];
  timestamp: string;
  entry: WorkflowCandidateTraceEntry;
}

export interface WorkflowTraceSnapshotDiffRow {
  field: string;
  beforeValue: string;
  afterValue: string;
}

export interface WorkflowVersionCompareResult {
  left: WorkflowVersionCompareSide;
  right: WorkflowVersionCompareSide;
  summary: {
    nodeCountDelta: number;
    edgeCountDelta: number;
    changedSettingsCount?: number;
    addedNodeCount?: number;
    removedNodeCount?: number;
    changedNodeCount?: number;
    addedEdgeCount?: number;
    removedEdgeCount?: number;
  };
  definitionDiff: {
    leftSettings: Record<string, unknown>;
    rightSettings: Record<string, unknown>;
    leftNodeIds: string[];
    rightNodeIds: string[];
    settings?: {
      key: string;
      left: unknown;
      right: unknown;
    }[];
    nodes?: {
      added: WorkflowVersionCompareNode[];
      removed: WorkflowVersionCompareNode[];
      changed: {
        id: string;
        left: WorkflowVersionCompareNode;
        right: WorkflowVersionCompareNode;
        changedFields: string[];
      }[];
    };
    edges?: {
      added: WorkflowVersionCompareEdge[];
      removed: WorkflowVersionCompareEdge[];
    };
  };
  bindingImpact?: {
    workflows: {
      id: string;
      name: string;
      publishedVersionId?: string | null;
    }[];
    profiles: WorkflowVersionCompareBindingBucket;
    newsSources: WorkflowVersionCompareBindingBucket;
  };
}

export interface WorkflowVersionCompareNode {
  id: string;
  type: string;
  label: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  uiState?: Record<string, unknown>;
}

export interface WorkflowVersionCompareEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  condition?: string | null;
  priority?: number | null;
}

export interface WorkflowVersionCompareSide {
  id: string;
  version: number;
  name: string;
  definition: {
    settings: Record<string, unknown>;
    nodes: WorkflowVersionCompareNode[];
    edges: WorkflowVersionCompareEdge[];
  };
}

export interface WorkflowVersionCompareBindingBucket {
  total: number;
  followingPublishedCount: number;
  leftVersionCount: number;
  rightVersionCount: number;
  items: {
    id: string;
    name: string;
    workflowId?: string | null;
    workflowVersionId?: string | null;
    workflowBindingMode: 'published' | 'pinned' | string;
    appliesTo:
      | 'left_version'
      | 'right_version'
      | 'published_left'
      | 'published_right'
      | 'other';
    updatedAt: string;
    matchHost?: string;
    url?: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function formatWorkflowStepSummary(step: WorkflowRunStep) {
  return `in ${step.inputCount} / out ${step.outputCount} / rejected ${step.rejectedCount}`;
}

export function buildWorkflowCompareSummary(compare: WorkflowVersionCompareResult) {
  const changedSettings = (
    compare.definitionDiff.settings?.map((entry) => entry.key) ??
    Array.from(
      new Set([
        ...Object.keys(compare.definitionDiff.leftSettings),
        ...Object.keys(compare.definitionDiff.rightSettings),
      ]),
    )
      .filter(
        (key) =>
          JSON.stringify(compare.definitionDiff.leftSettings[key]) !==
          JSON.stringify(compare.definitionDiff.rightSettings[key]),
      )
      .sort()
  );
  const addedNodeIds =
    compare.definitionDiff.nodes?.added.map((node) => node.id) ??
    compare.definitionDiff.rightNodeIds.filter(
      (nodeId) => !compare.definitionDiff.leftNodeIds.includes(nodeId),
    );
  const removedNodeIds =
    compare.definitionDiff.nodes?.removed.map((node) => node.id) ??
    compare.definitionDiff.leftNodeIds.filter(
      (nodeId) => !compare.definitionDiff.rightNodeIds.includes(nodeId),
    );

  return {
    changedSettings,
    addedNodeIds,
    removedNodeIds,
    nodeCountDelta: compare.summary.nodeCountDelta,
    edgeCountDelta: compare.summary.edgeCountDelta,
    changedNodeIds:
      compare.definitionDiff.nodes?.changed.map((node) => node.id) ?? [],
    addedEdgeCount:
      compare.summary.addedEdgeCount ?? compare.definitionDiff.edges?.added.length ?? 0,
    removedEdgeCount:
      compare.summary.removedEdgeCount ??
      compare.definitionDiff.edges?.removed.length ??
      0,
    profileImpactCount: compare.bindingImpact?.profiles.total ?? 0,
    newsSourceImpactCount: compare.bindingImpact?.newsSources.total ?? 0,
  };
}

export function buildWorkflowCandidateTraceSummary(candidate: WorkflowCandidateRecord) {
  const totalScoreDelta = candidate.trace.reduce(
    (sum, entry) => sum + (typeof entry.scoreDelta === 'number' ? entry.scoreDelta : 0),
    0,
  );
  const totalFreshnessDelta = candidate.trace.reduce(
    (sum, entry) =>
      sum + (typeof entry.freshnessDelta === 'number' ? entry.freshnessDelta : 0),
    0,
  );
  const ruleHits = Array.from(
    new Set(
      candidate.trace.flatMap((entry) => entry.ruleHits ?? []).filter(Boolean),
    ),
  );
  const changedFields = Array.from(
    new Set(
      candidate.trace.flatMap((entry) => {
        const before = isRecord(entry.beforeSnapshot) ? entry.beforeSnapshot : {};
        const after = isRecord(entry.afterSnapshot) ? entry.afterSnapshot : {};
        return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(
          (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
        );
      }),
    ),
  );

  return {
    sourceNodeId: candidate.sourceNodeId,
    totalScoreDelta,
    totalFreshnessDelta,
    ruleHits,
    changedFields,
  };
}

export function buildWorkflowTraceEntryChangedFields(
  entry: WorkflowCandidateTraceEntry,
) {
  const before = isRecord(entry.beforeSnapshot) ? entry.beforeSnapshot : {};
  const after = isRecord(entry.afterSnapshot) ? entry.afterSnapshot : {};
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function formatTraceSnapshotValue(value: unknown) {
  if (value === undefined) {
    return '(missing)';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  const serialized = JSON.stringify(value);
  if (!serialized) {
    return String(value);
  }
  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

export function buildWorkflowTraceEntryDiffRows(
  entry: WorkflowCandidateTraceEntry,
): WorkflowTraceSnapshotDiffRow[] {
  const before = isRecord(entry.beforeSnapshot) ? entry.beforeSnapshot : {};
  const after = isRecord(entry.afterSnapshot) ? entry.afterSnapshot : {};
  return buildWorkflowTraceEntryChangedFields(entry).map((field) => ({
    field,
    beforeValue: formatTraceSnapshotValue(before[field]),
    afterValue: formatTraceSnapshotValue(after[field]),
  }));
}

function formatSignedDelta(label: string, value: number) {
  const prefix = value > 0 ? '+' : '';
  return `${label} ${prefix}${value.toFixed(2)}`;
}

export function buildWorkflowCandidateTraceChain(
  candidate: WorkflowCandidateRecord,
): WorkflowCandidateTraceChainStep[] {
  return candidate.trace.map((entry, index) => {
    const after = isRecord(entry.afterSnapshot) ? entry.afterSnapshot : {};
    const status =
      entry.accepted === false ||
      entry.rejectedReason ||
      after.status === 'rejected'
        ? 'rejected'
        : after.status === 'selected'
          ? 'selected'
          : 'active';
    const deltaSummary = [
      typeof entry.scoreDelta === 'number'
        ? formatSignedDelta('score', entry.scoreDelta)
        : null,
      typeof entry.freshnessDelta === 'number'
        ? formatSignedDelta('fresh', entry.freshnessDelta)
        : null,
    ].filter((value): value is string => Boolean(value));

    return {
      key: `${entry.nodeId}-${entry.action}-${index + 1}`,
      index: index + 1,
      nodeId: entry.nodeId,
      nodeType: entry.nodeType,
      action: entry.action,
      label: `${entry.nodeType} / ${entry.action}`,
      status,
      rejectedReason:
        entry.rejectedReason ??
        (typeof after.rejectedReason === 'string' ? after.rejectedReason : null),
      changedFields: buildWorkflowTraceEntryChangedFields(entry),
      deltaSummary,
      timestamp: entry.timestamp,
      entry,
    };
  });
}
