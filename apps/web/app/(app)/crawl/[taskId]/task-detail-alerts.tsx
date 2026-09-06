"use client";

/**
 * Crawl Task Detail 非阻断告警组（FE-批5A：自 task-detail.tsx 拆出）。
 * ready 状态下按原顺序渲染：unsupported legacy proxy、实时连接错误、
 * backfill notice、任务 lastError、headed 运行时指引与 display/timeout
 * 分类告警。
 */

import { Alert, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CrawlConfigPolicyIssue } from "@/lib/crawl-config-policy";
import type { HeadedIssueKind } from "@/lib/crawl-runtime";

import type { CrawlBackfillController } from "./hooks/use-crawl-task-backfill";
import { formatPolicyIssues } from "./task-detail-formatters";
import type { CrawlTaskDetailTask } from "./task-detail-types";

interface TaskDetailAlertsProps {
  task: CrawlTaskDetailTask;
  proxyIssues: CrawlConfigPolicyIssue[];
  liveError: string | null;
  backfill: CrawlBackfillController;
  isHeadedTask: boolean;
  lastErrorHeadedIssue: HeadedIssueKind;
}

export function TaskDetailAlerts({
  task,
  proxyIssues,
  liveError,
  backfill,
  isHeadedTask,
  lastErrorHeadedIssue,
}: TaskDetailAlertsProps) {
  const { t } = useTranslation();
  return (
    <>
      {proxyIssues.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.proxy.unsupportedLegacyTitle")}
          description={formatPolicyIssues(proxyIssues, t)}
        />
      ) : null}
      {liveError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.liveUpdates.alertTitle")}
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {liveError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.liveUpdates.fallbackHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {backfill.notice ? (
        <Alert
          type={backfill.notice.type}
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={backfill.notice.message}
          description={backfill.notice.description}
          onClose={backfill.dismissNotice}
        />
      ) : null}
      {task.lastError ? (
        <Alert
          type={
            task.status === "failed"
              ? "error"
              : task.status === "completed"
                ? "success"
                : "warning"
          }
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.detail.latestError")}
          description={
            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
              {task.lastError}
            </Typography.Text>
          }
        />
      ) : null}
      {isHeadedTask ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.runtimeGuide.title")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.noAutoBootstrap")}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.principleBody")}
              </Typography.Text>
              <details>
                <summary>
                  {t("crawl.runtimeGuide.stepsTitle")}
                </summary>
                <Space direction="vertical" size={2} style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary">
                    {`1. ${t("crawl.runtimeGuide.step1")}`}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {`2. ${t("crawl.runtimeGuide.step2")}`}
                  </Typography.Text>
                </Space>
              </details>
            </Space>
          }
        />
      ) : null}
      {isHeadedTask && task.lastError && lastErrorHeadedIssue === "display" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.runtimeGuide.displayIssueTitle")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {task.lastError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.displayIssueHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {isHeadedTask && task.lastError && lastErrorHeadedIssue === "timeout" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.runtimeGuide.timeoutIssueTitle")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {task.lastError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.timeoutIssueHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
    </>
  );
}
