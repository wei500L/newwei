import { AlertMetricProvider, AlertOperator } from "@/graphql/generated";

export type PipelineMetricSlug =
  | "pipeline_job"
  | "mongo_outbox.backlog"
  | "mongo_outbox.pending"
  | "mongo_outbox.failed"
  | "mongo_outbox.processing"
  | "mongo_outbox.dead"
  | "mongo_outbox.stale_processing"
  | "mongo_outbox.oldest_age_minutes";

export type MongoOutboxMetricSlug = Exclude<PipelineMetricSlug, "pipeline_job">;

export type PipelineOutboxType =
  | "processed_item"
  | "cleanup_crawl_results";

type TranslateFn = (
  key: string,
  options?: { defaultValue?: string; [key: string]: unknown },
) => string;

type PipelineMetricPreset = {
  labelKey: string;
  fallbackLabel: string;
  operator: AlertOperator;
  thresholdValue: number;
  defaultName: string;
  defaultDescription: string;
};

export const DEFAULT_PIPELINE_METRIC_SLUG: PipelineMetricSlug = "pipeline_job";
export const DEFAULT_PIPELINE_OUTBOX_TYPE: PipelineOutboxType =
  "processed_item";

export const pipelineMetricPresetConfig: Record<
  PipelineMetricSlug,
  PipelineMetricPreset
> = {
  pipeline_job: {
    labelKey: "alerts.config.pipeline.metrics.pipelineJobsFailed",
    fallbackLabel: "Failed pipeline jobs",
    operator: AlertOperator.Gte,
    thresholdValue: 1,
    defaultName: "Pipeline: Failed Jobs Detected",
    defaultDescription:
      "Alert when pipeline jobs hit the selected failure states within the evaluation window.",
  },
  "mongo_outbox.backlog": {
    labelKey: "alerts.config.pipeline.metrics.outboxBacklog",
    fallbackLabel: "Mongo outbox backlog",
    operator: AlertOperator.Gte,
    thresholdValue: 50,
    defaultName: "Pipeline: Mongo Outbox Backlog Rising",
    defaultDescription:
      "Alert when active Mongo outbox backlog keeps growing across pending, failed, or processing entries.",
  },
  "mongo_outbox.pending": {
    labelKey: "alerts.config.pipeline.metrics.outboxPending",
    fallbackLabel: "Mongo outbox pending",
    operator: AlertOperator.Gte,
    thresholdValue: 25,
    defaultName: "Pipeline: Mongo Outbox Pending Queue High",
    defaultDescription:
      "Alert when ready-to-run Mongo outbox entries start piling up.",
  },
  "mongo_outbox.failed": {
    labelKey: "alerts.config.pipeline.metrics.outboxFailed",
    fallbackLabel: "Mongo outbox failed",
    operator: AlertOperator.Gte,
    thresholdValue: 1,
    defaultName: "Pipeline: Mongo Outbox Delivery Failures",
    defaultDescription:
      "Alert when Mongo outbox delivery attempts are failing.",
  },
  "mongo_outbox.processing": {
    labelKey: "alerts.config.pipeline.metrics.outboxProcessing",
    fallbackLabel: "Mongo outbox processing",
    operator: AlertOperator.Gte,
    thresholdValue: 25,
    defaultName: "Pipeline: Mongo Outbox Processing Volume High",
    defaultDescription:
      "Alert when too many Mongo outbox items remain in processing at the same time.",
  },
  "mongo_outbox.dead": {
    labelKey: "alerts.config.pipeline.metrics.outboxDead",
    fallbackLabel: "Mongo outbox dead-letter",
    operator: AlertOperator.Gte,
    thresholdValue: 1,
    defaultName: "Pipeline: Mongo Outbox Dead-Lettered",
    defaultDescription:
      "Alert when Mongo outbox records are moved into dead-letter state.",
  },
  "mongo_outbox.stale_processing": {
    labelKey: "alerts.config.pipeline.metrics.outboxStaleProcessing",
    fallbackLabel: "Mongo outbox stale processing",
    operator: AlertOperator.Gte,
    thresholdValue: 1,
    defaultName: "Pipeline: Mongo Outbox Stale Locks",
    defaultDescription:
      "Alert when Mongo outbox processing locks are stale and likely need operator attention.",
  },
  "mongo_outbox.oldest_age_minutes": {
    labelKey: "alerts.config.pipeline.metrics.outboxOldestAge",
    fallbackLabel: "Mongo outbox oldest age",
    operator: AlertOperator.Gte,
    thresholdValue: 15,
    defaultName: "Pipeline: Mongo Outbox Oldest Entry Too Old",
    defaultDescription:
      "Alert when the oldest active Mongo outbox entry has been waiting too long.",
  },
};

const knownPipelineMetricSlugs = new Set<PipelineMetricSlug>(
  Object.keys(pipelineMetricPresetConfig) as PipelineMetricSlug[],
);

const allowedPipelineOutboxTypes = new Set<PipelineOutboxType>([
  "processed_item",
  "cleanup_crawl_results",
]);

export const pipelinePresetDefaultNames = new Set(
  Object.values(pipelineMetricPresetConfig).map((preset) => preset.defaultName),
);

export const pipelinePresetDefaultDescriptions = new Set(
  Object.values(pipelineMetricPresetConfig).map(
    (preset) => preset.defaultDescription,
  ),
);

export const isPipelineMetricPresetSlug = (
  value: string | undefined,
): value is PipelineMetricSlug =>
  typeof value === "string" &&
  knownPipelineMetricSlugs.has(value as PipelineMetricSlug);

export const isMongoOutboxMetricSlug = (
  value: string | undefined,
): value is `mongo_outbox.${string}` =>
  typeof value === "string" && value.startsWith("mongo_outbox.");

export const isPipelineOutboxType = (
  value: string | null | undefined,
): value is PipelineOutboxType =>
  typeof value === "string" &&
  allowedPipelineOutboxTypes.has(value as PipelineOutboxType);

export const buildPipelineMetricPresetOptions = (
  t: TranslateFn,
): { value: PipelineMetricSlug; label: string }[] =>
  (Object.entries(pipelineMetricPresetConfig) as Array<
    [PipelineMetricSlug, PipelineMetricPreset]
  >).map(([value, preset]) => ({
    value,
    label: t(preset.labelKey, {
      defaultValue: preset.fallbackLabel,
    }),
  }));

export const buildPipelineOutboxTypeOptions = (
  t: TranslateFn,
): { value: PipelineOutboxType; label: string }[] => [
  {
    value: "processed_item",
    label: t("alerts.config.pipeline.outboxTypes.processedItem", {
      defaultValue: "Processed item delivery",
    }),
  },
  {
    value: "cleanup_crawl_results",
    label: t("alerts.config.pipeline.outboxTypes.cleanupCrawlResults", {
      defaultValue: "Crawl cleanup",
    }),
  },
];

export const resolveInitialPipelineOutboxType = (
  metricSlug: string | undefined,
  value: string | null | undefined,
): PipelineOutboxType | undefined => {
  if (isPipelineOutboxType(value)) {
    return value;
  }
  return isMongoOutboxMetricSlug(metricSlug)
    ? DEFAULT_PIPELINE_OUTBOX_TYPE
    : undefined;
};

type BuildPipelineProviderMetadataInput = {
  metricSlug: string | undefined;
  pipelineStatuses?: string[] | null | undefined;
  pipelineQueueName?: string | null | undefined;
  pipelineSourceId?: string | null | undefined;
  pipelineOutboxType?: string | null | undefined;
};

export const buildPipelineProviderMetadata = ({
  metricSlug,
  pipelineStatuses,
  pipelineQueueName,
  pipelineSourceId,
  pipelineOutboxType,
}: BuildPipelineProviderMetadataInput): Record<string, unknown> => {
  if (isMongoOutboxMetricSlug(metricSlug)) {
    return isPipelineOutboxType(pipelineOutboxType)
      ? { type: pipelineOutboxType }
      : {};
  }

  const metadata: Record<string, unknown> = {};
  if (Array.isArray(pipelineStatuses) && pipelineStatuses.length > 0) {
    metadata.statuses = pipelineStatuses;
  }
  if (
    typeof pipelineQueueName === "string" &&
    pipelineQueueName.trim().length > 0
  ) {
    metadata.queueName = pipelineQueueName.trim();
  }
  if (
    typeof pipelineSourceId === "string" &&
    pipelineSourceId.trim().length > 0
  ) {
    metadata.sourceId = pipelineSourceId.trim();
  }
  return metadata;
};

const omitKeys = (
  metadata: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => !keys.includes(key) && value !== undefined,
    ),
  );

export const stripControlledMetadataForProvider = ({
  metricProvider,
  metadata,
}: {
  metricProvider: AlertMetricProvider;
  metadata: Record<string, unknown>;
}): Record<string, unknown> => {
  if (metricProvider === AlertMetricProvider.PipelineJob) {
    return omitKeys(metadata, [
      "status",
      "statuses",
      "queueName",
      "sourceId",
      "type",
    ]);
  }
  if (metricProvider === AlertMetricProvider.CrawlTask) {
    return omitKeys(metadata, ["status", "statuses", "createdById"]);
  }
  if (metricProvider === AlertMetricProvider.SystemMetric) {
    return omitKeys(metadata, ["currentValue"]);
  }
  return omitKeys(metadata, []);
};
