"use client";

import { Button, Card, Space, Table, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RequestErrorBanner } from "@/components/request-error-banner";
import { resolveLocale } from "@/lib/i18n";
import {
  isQueueOpsJobState,
  QUEUE_OPS_DEFAULT_BATCH_LIMIT,
  QUEUE_OPS_JOB_STATES,
  type QueueOpsJobState,
  type QueueOpsJobSummary,
} from "@/lib/queue-ops";

import { confirmQueueOpsAction } from "./queue-ops-confirm";
import { QueueOpsJobDetailModal } from "./queue-ops-job-detail-modal";
import {
  formatQueueOpsFailedReason,
  formatQueueOpsJobName,
  formatQueueOpsTimestamp,
  truncateQueueOpsPreview,
} from "./queue-ops.helpers";
import {
  useQueueOpsJobs,
  type QueueOpsMessageApi,
  type QueueOpsRequestIssue,
} from "./use-queue-ops-data";

export interface QueueOpsJobsPanelProps {
  queue: string;
  messageApi: QueueOpsMessageApi;
  onRequestIssue: (issue: QueueOpsRequestIssue) => void;
  onCountsChanged: () => void;
}

/**
 * 选中队列的 job 列表：状态切换（waiting/active/delayed/completed/failed）、
 * cursor「加载更多」、行内详情、failed 批量重试与详情里的重试/删除/提升。
 */
export function QueueOpsJobsPanel({
  queue,
  messageApi,
  onRequestIssue,
  onCountsChanged,
}: QueueOpsJobsPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const [state, setState] = useState<QueueOpsJobState>("waiting");
  const jobsData = useQueueOpsJobs({
    queue,
    state,
    t,
    messageApi,
    onRequestIssue,
    onCountsChanged,
  });

  const handleRetryFailed = () => {
    confirmQueueOpsAction({
      title: t("ops.queueOps.jobs.retryFailed.confirmTitle"),
      description: t("ops.queueOps.jobs.retryFailed.confirmDescription", {
        limit: QUEUE_OPS_DEFAULT_BATCH_LIMIT,
      }),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
      onConfirm: async () => {
        await jobsData.retryFailed();
      },
    });
  };

  const detailJob = jobsData.detail;

  const handleRetryDetail = () => {
    if (!detailJob) {
      return;
    }
    confirmQueueOpsAction({
      title: t("ops.queueOps.confirm.retryTitle", { jobId: detailJob.id }),
      description: t("ops.queueOps.confirm.retryDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        if (await jobsData.retry(detailJob.id)) {
          jobsData.closeDetail();
        }
      },
    });
  };

  const handleDeleteDetail = () => {
    if (!detailJob) {
      return;
    }
    confirmQueueOpsAction({
      title: t("ops.queueOps.confirm.deleteTitle", { jobId: detailJob.id }),
      description: t("ops.queueOps.confirm.deleteDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
      onConfirm: async () => {
        if (await jobsData.remove(detailJob.id)) {
          jobsData.closeDetail();
        }
      },
    });
  };

  const handlePromoteDetail = () => {
    if (!detailJob) {
      return;
    }
    confirmQueueOpsAction({
      title: t("ops.queueOps.confirm.promoteTitle", { jobId: detailJob.id }),
      description: t("ops.queueOps.confirm.promoteDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        if (await jobsData.promote(detailJob.id)) {
          jobsData.closeDetail();
        }
      },
    });
  };

  const detailFooter = detailJob ? (
    <div className="flex flex-col items-end gap-2">
      <Space wrap>
        {state === "failed" ? (
          <Button
            type="primary"
            loading={jobsData.busyAction === `retry:${detailJob.id}`}
            onClick={handleRetryDetail}
          >
            {t("ops.queueOps.detail.actions.retry")}
          </Button>
        ) : null}
        {state === "delayed" ? (
          <Button
            loading={jobsData.busyAction === `promote:${detailJob.id}`}
            onClick={handlePromoteDetail}
          >
            {t("ops.queueOps.detail.actions.promote")}
          </Button>
        ) : null}
        <Button
          danger
          disabled={state === "active"}
          loading={jobsData.busyAction === `delete:${detailJob.id}`}
          onClick={handleDeleteDetail}
        >
          {t("ops.queueOps.detail.actions.delete")}
        </Button>
        <Button onClick={jobsData.closeDetail}>
          {t("ops.queueOps.detail.actions.close")}
        </Button>
      </Space>
      {state === "active" ? (
        <Typography.Text type="secondary">
          {t("ops.queueOps.detail.deleteActiveHint")}
        </Typography.Text>
      ) : null}
    </div>
  ) : undefined;

  const columns: ColumnsType<QueueOpsJobSummary> = [
    {
      title: t("ops.queueOps.jobs.columns.id"),
      dataIndex: "id",
      key: "id",
      render: (jobId: string) => (
        <Button
          type="link"
          style={{ paddingInline: 0 }}
          onClick={() => jobsData.openDetail(jobId)}
        >
          {jobId}
        </Button>
      ),
    },
    {
      title: t("ops.queueOps.jobs.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (name: string) => formatQueueOpsJobName(name),
    },
    {
      title: t("ops.queueOps.jobs.columns.createdAt"),
      dataIndex: "timestamp",
      key: "timestamp",
      render: (value: number) => formatQueueOpsTimestamp(value, locale),
    },
    {
      title: t("ops.queueOps.jobs.columns.attemptsMade"),
      dataIndex: "attemptsMade",
      key: "attemptsMade",
      align: "right",
      width: 96,
    },
    {
      title: t("ops.queueOps.jobs.columns.failedReason"),
      dataIndex: "failedReason",
      key: "failedReason",
      ellipsis: true,
      render: (value: string) => formatQueueOpsFailedReason(value),
    },
    {
      title: t("ops.queueOps.jobs.columns.dataPreview"),
      dataIndex: "dataPreview",
      key: "dataPreview",
      ellipsis: true,
      render: (value: string) => truncateQueueOpsPreview(value),
    },
  ];

  return (
    <Card
      className="content-card"
      title={t("ops.queueOps.jobs.title", { queue })}
      extra={
        <Button onClick={jobsData.reload} loading={jobsData.loading}>
          {t("common.refresh")}
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Tabs
          activeKey={state}
          onChange={(key) => {
            if (isQueueOpsJobState(key)) {
              setState(key);
            }
          }}
          items={QUEUE_OPS_JOB_STATES.map((value) => ({
            key: value,
            label: t(`ops.queueOps.jobs.states.${value}`),
          }))}
        />

        {jobsData.error ? (
          <RequestErrorBanner
            error={jobsData.error}
            onRetry={jobsData.reload}
            actionLoading={jobsData.loading}
          />
        ) : null}

        {state === "failed" ? (
          <Space wrap>
            <Button
              danger
              onClick={handleRetryFailed}
              loading={(jobsData.busyAction ?? "").startsWith("retryFailed:")}
            >
              {t("ops.queueOps.jobs.actions.batchRetry", {
                limit: QUEUE_OPS_DEFAULT_BATCH_LIMIT,
              })}
            </Button>
          </Space>
        ) : null}

        <Table<QueueOpsJobSummary>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={jobsData.jobs}
          loading={jobsData.loading}
          pagination={false}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: t("ops.queueOps.jobs.empty") }}
        />

        {jobsData.hasMore ? (
          <Button onClick={jobsData.loadMore} loading={jobsData.loadingMore}>
            {t("ops.queueOps.jobs.actions.loadMore")}
          </Button>
        ) : null}
      </Space>

      <QueueOpsJobDetailModal
        open={jobsData.activeJobId !== null}
        state={state}
        job={jobsData.detail}
        loading={jobsData.detailLoading}
        error={jobsData.detailError}
        footer={detailFooter}
        onClose={jobsData.closeDetail}
      />
    </Card>
  );
}
