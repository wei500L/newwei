"use client";

/**
 * Crawl Task Detail 任务日志卡片（FE-批5A：自 task-detail.tsx 拆出）。
 * 列定义 + 展开行 data/error JSON；数据来自 use-crawl-task-logs。
 */

import { Alert, Button, Card, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMemo, type Key } from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import { markdownPreviewStyle } from "./task-detail-formatters";
import type { TaskLogRecord, TaskLogStatus } from "./task-detail-types";

const taskLogStatusColors: Record<TaskLogStatus, string> = {
  pending: "gold",
  processing: "blue",
  completed: "green",
  failed: "red",
};

interface TaskLogsProps {
  logs: TaskLogRecord[];
  loading: boolean;
  error: string | null;
  expandedKeys: string[];
  onExpandedRowsChange: (expandedRows: readonly Key[]) => void;
  onReload: () => void;
  locale: SupportedLocale;
}

export function TaskDetailTaskLogs({
  logs,
  loading,
  error,
  expandedKeys,
  onExpandedRowsChange,
  onReload,
  locale,
}: TaskLogsProps) {
  const { t } = useTranslation();

  const taskLogColumns = useMemo<ColumnsType<TaskLogRecord>>(
    () => [
      {
        title: t("quality.taskLogs.columns.time"),
        dataIndex: "createdAt",
        key: "createdAt",
        width: 170,
        render: (value: string) =>
          formatDateTime(value, locale, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
      },
      {
        title: t("quality.taskLogs.columns.stage"),
        dataIndex: "stage",
        key: "stage",
        width: 140,
        render: (value: string) => (
          <Typography.Text style={{ fontFamily: "monospace" }}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: t("quality.taskLogs.columns.status"),
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (value: TaskLogStatus) => (
          <Tag color={taskLogStatusColors[value] ?? "default"}>
            {t(`quality.taskLogs.status.${value}`, { defaultValue: value })}
          </Tag>
        ),
      },
      {
        title: t("quality.taskLogs.columns.message"),
        dataIndex: "message",
        key: "message",
        render: (value: string | null | undefined, record: TaskLogRecord) => {
          const errorMessage =
            record.error &&
            typeof record.error === "object" &&
            !Array.isArray(record.error)
              ? (() => {
                  const messageValue = (record.error as { message?: unknown })
                    .message;
                  return typeof messageValue === "string" &&
                    messageValue.trim().length > 0
                    ? messageValue.trim()
                    : null;
                })()
              : null;
          return (
            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
              {value ?? errorMessage ?? t("common.emptyValue")}
            </Typography.Text>
          );
        },
      },
    ],
    [locale, t],
  );

  return (
    <Card
      title={t("quality.taskLogs.title")}
      size="small"
      style={{ marginTop: 24 }}
      extra={
        <Button size="small" onClick={onReload} loading={loading}>
          {t("common.refresh")}
        </Button>
      }
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("common.error.unexpected")}
          description={
            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
              {error}
            </Typography.Text>
          }
        />
      ) : null}
      <Table
        size="small"
        rowKey={(record) => record.id}
        columns={taskLogColumns}
        dataSource={logs}
        pagination={false}
        loading={loading}
        locale={{ emptyText: t("common.empty") }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange,
          expandRowByClick: true,
          rowExpandable: (record) => Boolean(record.data || record.error),
          expandedRowRender: (record) => (
            <pre
              className="markdown-preview"
              style={{ ...markdownPreviewStyle, margin: 0 }}
            >
              {JSON.stringify(
                { data: record.data ?? null, error: record.error ?? null },
                null,
                2,
              )}
            </pre>
          ),
        }}
      />
    </Card>
  );
}
