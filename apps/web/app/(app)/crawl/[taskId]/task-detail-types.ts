/**
 * Crawl Task Detail 领域类型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯类型模块：无 React、无 "use client"；任务与结果类型直接从
 * generated query 派生，不复制 GraphQL DTO。
 */

import type { CrawlTaskQuery } from "@/graphql/generated";

/** 窄化翻译函数签名（TFunction 可赋值；模型层避免依赖 react-i18next）。 */
export type TaskDetailTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export type CrawlTaskDetailTask = NonNullable<CrawlTaskQuery["crawlTask"]>;

export type CrawlTaskDetailResult = NonNullable<
  CrawlTaskDetailTask["results"]
>[number];

export type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskLogRecord {
  id: string;
  queue: string;
  jobId: string;
  orgId: string;
  stage: string;
  status: TaskLogStatus;
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BackfillNotice {
  type: "info" | "success" | "warning" | "error";
  message: string;
  description?: string;
}

export interface CrawlMediaSource {
  src?: string;
  srcset?: string;
  type?: string;
  media?: string;
  sizes?: string;
}

export interface CrawlMediaItem {
  src?: string;
  alt?: string;
  title?: string;
  desc?: string;
  type?: string;
  format?: string;
  width?: number;
  height?: number;
  score?: number;
  poster?: string;
  sizes?: string;
  srcset?: string[];
  pictureSources?: CrawlMediaSource[];
  responsiveSources?: CrawlMediaSource[];
}

export type CrawlMediaCollection = Record<string, CrawlMediaItem[]>;

export interface CrawlStoredMediaAsset {
  id: string;
  kind: string;
  sourceUrl: string;
  bytes: number;
  contentType?: string;
  storageProvider?: "mysql" | "s3";
  storageKey?: string;
  previewUrl?: string;
  downloadUrl?: string;
  width?: number;
  height?: number;
  alt?: string;
  title?: string;
  desc?: string;
  poster?: string;
  format?: string;
}

export type CrawlResultTableRecord = Record<string, string | number | boolean | null>;

export type CrawlResultTablePreviewRow = CrawlResultTableRecord & { key: string };

export interface CrawlResultTable {
  id: string;
  caption?: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  columnCount: number;
  source?: string;
  metadata?: Record<string, unknown>;
  dataFrame?: {
    columns: string[];
    rows: CrawlResultTableRecord[];
  };
}
