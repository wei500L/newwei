"use client";

/**
 * Crawl Task Detail 头部（FE-批5A：自 task-detail.tsx 拆出）。
 * 返回任务列表链接、任务状态 Tag、live 状态 Tag、Retry/Backfill 操作、
 * 空态提示与 open source 外链。
 */

import { Button, Space, Tag, Tooltip, Typography } from "antd";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import type { CrawlTaskStatus } from "@/graphql/generated";

import type { CrawlTaskActionController } from "./hooks/use-crawl-task-actions";
import type { CrawlBackfillController } from "./hooks/use-crawl-task-backfill";
import type { OpsLiveStatus } from "./hooks/use-crawl-task-ops-live";
import type { CrawlTaskDetailTask } from "./task-detail-types";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple",
};

interface TaskDetailHeaderProps {
  task: CrawlTaskDetailTask;
  liveStatus: OpsLiveStatus;
  liveError: string | null;
  canManage: boolean;
  canCreateItem: boolean;
  retry: CrawlTaskActionController;
  retryDisabled: boolean;
  retryHint: string | undefined;
  backfill: CrawlBackfillController;
}

export function TaskDetailHeader({
  task,
  liveStatus,
  liveError,
  canManage,
  canCreateItem,
  retry,
  retryDisabled,
  retryHint,
  backfill,
}: TaskDetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <Space style={{ marginBottom: 16 }} wrap>
      <Link href="/admin/ops/crawl-tasks">
        {t("crawl.detail.backToTasks")}
      </Link>
      <Tag color={statusColors[task.status]}>
        {t(`crawl.status.${task.status}`, { defaultValue: task.status })}
      </Tag>
      <Tag
        color={
          liveError
            ? "red"
            : liveStatus === "connected"
              ? "green"
              : liveStatus === "connecting"
                ? "blue"
                : undefined
        }
      >
        {liveError
          ? t("crawl.liveUpdates.error")
          : liveStatus === "connected"
            ? t("crawl.liveUpdates.connected")
            : liveStatus === "connecting"
              ? t("crawl.liveUpdates.connecting")
              : t("crawl.liveUpdates.disconnected")}
      </Tag>
      {canManage ? (
        <Tooltip title={retryHint}>
          <span>
            <Button
              onClick={() => void retry.retry()}
              loading={retry.retrying}
              disabled={retryDisabled}
            >
              {t("crawl.detail.retry")}
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {canCreateItem ? (
        <Button
          onClick={backfill.run}
          loading={backfill.running}
          disabled={backfill.unavailable}
        >
          {t("crawl.detail.backfill.button")}
        </Button>
      ) : null}
      {canCreateItem && backfill.unavailable ? (
        <Typography.Text type="secondary">
          {t("crawl.detail.backfill.emptyHint")}
        </Typography.Text>
      ) : null}
      <Typography.Link href={task.targetUrl} target="_blank" rel="noreferrer">
        {t("crawl.detail.openSource")}
      </Typography.Link>
    </Space>
  );
}
