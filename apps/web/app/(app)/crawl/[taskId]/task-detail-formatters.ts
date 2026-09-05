/**
 * Crawl Task Detail 纯格式化与解析工具（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：无 React、无 "use client"；真实动态 JSON 的窄化集中在
 * 调用方（解析边界），本模块只做确定性格式化。
 */

import type { CSSProperties } from "react";

import {
  getCrawlConfigPolicyIssueTranslationKey,
  type CrawlConfigPolicyIssue,
} from "@/lib/crawl-config-policy";
import { env } from "@/lib/env";

import type {
  CrawlMediaItem,
  TaskDetailTranslate,
} from "./task-detail-types";

export const BACKFILL_BATCH_TIMEOUT_MS = 15_000;

export const markdownPreviewStyle: CSSProperties = {
  maxWidth: "100%",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

export function safeParseJson<T>(input?: string | null): T | null {
  if (!input) {
    return null;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatDimensions(item: CrawlMediaItem) {
  if (item.width && item.height) {
    return `${item.width}×${item.height}px`;
  }
  return undefined;
}

export function formatScore(item: CrawlMediaItem, t: TaskDetailTranslate) {
  if (typeof item.score === "number") {
    return t("crawl.detail.media.score", { score: item.score.toFixed(2) });
  }
  return undefined;
}

export function resolveStoredMediaUrl(value?: string) {
  if (!value) {
    return undefined;
  }
  if (/^(https?:\/\/|data:|blob:)/i.test(value)) {
    return value;
  }
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (normalized.startsWith("/api/")) {
    return `${env.apiRoot}${normalized}`;
  }
  return `${env.apiBaseUrl}${normalized}`;
}

export function formatPolicyIssues(
  issues: CrawlConfigPolicyIssue[],
  t: TaskDetailTranslate,
) {
  return issues
    .map(
      (issue) =>
        `${issue.path}: ${t(getCrawlConfigPolicyIssueTranslationKey(issue.code), {
          defaultValue: issue.code,
        })}`,
    )
    .join(" ");
}

export const shortenScript = (value: string) =>
  value.length > 160 ? `${value.slice(0, 157)}…` : value;
