"use client";

import { Alert, Button, Card, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RequestErrorBanner } from "@/components/request-error-banner";
import { resolveLocale } from "@/lib/i18n";
import {
  QUEUE_OPS_DLQ_QUEUE_NAME,
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
  useQueueOpsDlq,
  useQueueOpsJobs,
  type QueueOpsMessageApi,
  type QueueOpsRequestIssue,
} from "./use-queue-ops-data";

export interface QueueOpsDlqPanelProps {
  messageApi: QueueOpsMessageApi;
  onRequestIssue: (issue: QueueOpsRequestIssue) => void;
  onCountsChanged: () => void;
}

/**
 * DLQ 专区：队列固定 itemPipelineDlq（其 waiting 即「排队中的死信」），
 * 支持列表/详情、单条重放/删除与多选批量重放，并在 dlqRemoved === false
 * 时用 warning 提示「重放成功但 DLQ 残留」。
 */
export function QueueOpsDlqPanel({
  messageApi,
  onRequestIssue,
  onCountsChanged,
}: QueueOpsDlqPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const jobsData = useQueueOpsJobs({
    queue: QUEUE_OPS_DLQ_QUEUE_NAME,
    state: "waiting",
    t,
    messageApi,
    onRequestIssue,
    onCountsChanged,
  });
  const dlq = useQueueOpsDlq({ t, messageApi, onRequestIssue });

  const refreshAfterDlqChange = () => {
    setSelectedJobIds([]);
    jobsData.reload();
    onCountsChanged();
  };

  const handleReplay = (jobId: string) => {
    confirmQueueOpsAction({
      title: t("ops.queueOps.dlq.replayConfirmTitle"),
      description: t("ops.queueOps.dlq.replayConfirmDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        if (await dlq.replayOne(jobId)) {
          refreshAfterDlqChange();
          jobsData.closeDetail();
        }
      },
    });
  };

  const handleDelete = (jobId: string) => {
    confirmQueueOpsAction({
      title: t("ops.queueOps.dlq.deleteConfirmTitle"),
      description: t("ops.queueOps.dlq.deleteConfirmDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
      onConfirm: async () => {
        if (await dlq.deleteOne(jobId)) {
          refreshAfterDlqChange();
          jobsData.closeDetail();
        }
      },
    });
  };

  const handleReplaySelected = () => {
    if (selectedJobIds.length === 0) {
      messageApi.error(t("ops.queueOps.dlq.selection.empty"));
      return;
    }
    const jobIds = [...selectedJobIds];
    confirmQueueOpsAction({
      title: t("ops.queueOps.dlq.selection.confirmTitle"),
      description: t("ops.queueOps.dlq.selection.confirmDescription", {
        selected: jobIds.length,
      }),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
      onConfirm: async () => {
        if (await dlq.replayMany(jobIds)) {
          refreshAfterDlqChange();
        }
      },
    });
  };

  const detailJob = jobsData.detail;

  const detailFooter = detailJob ? (
    <Space wrap>
      <Button
        type="primary"
        loading={dlq.busyAction === `dlqReplay:${detailJob.id}`}
        onClick={() => handleReplay(detailJob.id)}
      >
        {t("ops.queueOps.dlq.actions.replay")}
      </Button>
      <Button
        danger
        loading={dlq.busyAction === `dlqDelete:${detailJob.id}`}
        onClick={() => handleDelete(detailJob.id)}
      >
        {t("ops.queueOps.dlq.actions.delete")}
      </Button>
      <Button onClick={jobsData.closeDetail}>
        {t("ops.queueOps.detail.actions.close")}
      </Button>
    </Space>
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
    {
      title: t("ops.queueOps.queues.columns.actions"),
      key: "actions",
      render: (_value: unknown, record) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => handleReplay(record.id)}>
            {t("ops.queueOps.dlq.actions.replay")}
          </Button>
          <Button size="small" danger onClick={() => handleDelete(record.id)}>
            {t("ops.queueOps.dlq.actions.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card className="content-card" title={t("ops.queueOps.dlq.title")}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          {t("ops.queueOps.dlq.description")}
        </Typography.Text>

        {dlq.residualCount > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t("ops.queueOps.dlq.residualWarning")}
            description={t("ops.queueOps.dlq.residualDescription", {
              residuals: dlq.residualCount,
            })}
          />
        ) : null}

        {jobsData.error ? (
          <RequestErrorBanner
            error={jobsData.error}
            onRetry={jobsData.reload}
            actionLoading={jobsData.loading}
          />
        ) : null}

        <Space wrap>
          <Typography.Text type="secondary">
            {t("ops.queueOps.dlq.selection.selected", {
              selected: selectedJobIds.length,
            })}
          </Typography.Text>
          <Button
            type="primary"
            danger
            disabled={selectedJobIds.length === 0}
            onClick={handleReplaySelected}
            loading={dlq.busyAction === "dlqReplay:batch"}
          >
            {t("ops.queueOps.dlq.selection.replay")}
          </Button>
        </Space>

        <Table<QueueOpsJobSummary>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={jobsData.jobs}
          loading={jobsData.loading}
          pagination={false}
          scroll={{ x: "max-content" }}
          rowSelection={{
            selectedRowKeys: selectedJobIds,
            onChange: (keys) => {
              setSelectedJobIds(
                keys.filter((key): key is string => typeof key === "string"),
              );
            },
          }}
          locale={{ emptyText: t("ops.queueOps.dlq.empty") }}
        />

        {jobsData.hasMore ? (
          <Button onClick={jobsData.loadMore} loading={jobsData.loadingMore}>
            {t("ops.queueOps.jobs.actions.loadMore")}
          </Button>
        ) : null}
      </Space>

      <QueueOpsJobDetailModal
        open={jobsData.activeJobId !== null}
        state="waiting"
        job={jobsData.detail}
        loading={jobsData.detailLoading}
        error={jobsData.detailError}
        footer={detailFooter}
        onClose={jobsData.closeDetail}
      />
    </Card>
  );
}
