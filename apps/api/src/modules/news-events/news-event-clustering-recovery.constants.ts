export const NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME =
  "news_event_clustering_recovery";
export const NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE = Symbol(
  "NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE",
);

export interface NewsEventClusteringRecoveryJobPayload {
  jobType: "llm_backfill";
  orgId: string;
  actorId: string;
  groupId: string;
  traceId: string;
}
