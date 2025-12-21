export interface RawPipelineItem {
  id: string;
  itemMetaId: string;
  payload: Record<string, unknown>;
  source?: string | null;
}

export interface PipelineJobContext {
  queue: string;
  jobId: string;
  itemMetaId: string;
  rawItemId: string;
  orgId: string;
}

export interface CrawlCacheEntry {
  url: string;
  markdown: string;
  markdownWithCitations?: string | null;
  referencesMarkdown?: string | null;
  metadata?: Record<string, unknown>;
  publishedAt?: string | null;
  runId?: string | null;
  fetchedAt?: string | null;
  linkAnalysis?: Record<string, unknown>;
  contentHash?: string;
}
