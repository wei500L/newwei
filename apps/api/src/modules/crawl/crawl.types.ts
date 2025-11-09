export interface CrawlJobData {
  taskId: string;
  orgId: string;
  triggeredById?: string;
}

export interface CrawlExecutionSummary {
  inserted: number;
  skipped: number;
  lastFetchedAt?: Date;
  runId?: string;
}
