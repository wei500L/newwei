"use client";

/**
 * Crawl Task Detail 头部（FE-批5A：自 task-detail.tsx 拆出）。
 * 返回任务列表链接、任务状态 Tag、live 状态 Tag、Retry/Backfill 操作、
 * 空态提示与 open source 外链。
 */

import { Button, Tag, Tooltip, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";
import type { CrawlTaskStatus } from "@/graphql/generated";

import type { CrawlTaskActionController } from "./hooks/use-crawl-task-actions";
import type { CrawlBackfillController } from "./hooks/use-crawl-task-backfill";
import type { OpsLiveStatus } from "./hooks/use-crawl-task-ops-live";
import type { CrawlTaskDetailTask } from "./task-detail-types";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "warning",
  queued: "processing",
  running: "processing",
  completed: "success",
  failed: "error",
  paused: "default",
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
    <PageHeader
      kicker={t("nav.groups.admin")}
      back={{
        href: "/admin/ops/crawl-tasks",
        label: t("crawl.detail.backToTasks"),
      }}
      title={
        <span className="line-clamp-2 break-all">
          {task.displayName || task.targetUrl}
        </span>
      }
      meta={
        <>
          <Tag className="m-0" color={statusColors[task.status]}>
            {t(`crawl.status.${task.status}`, { defaultValue: task.status })}
          </Tag>
          <Tag
            className="m-0"
            color={
              liveError
                ? "error"
                : liveStatus === "connected"
                  ? "success"
                  : liveStatus === "connecting"
                    ? "processing"
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
        </>
      }
      actions={
        <>
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
          <Typography.Link
            href={task.targetUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("crawl.detail.openSource")}
          </Typography.Link>
        </>
      }
    />
  );
}
