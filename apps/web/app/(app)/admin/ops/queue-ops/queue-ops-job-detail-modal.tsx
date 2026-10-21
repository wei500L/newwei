"use client";

import {
  Alert,
  Button,
  Descriptions,
  Modal,
  Space,
  Spin,
  Typography,
} from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { resolveLocale } from "@/lib/i18n";
import type { QueueOpsJobDetail, QueueOpsJobState } from "@/lib/queue-ops";

import {
  formatQueueOpsJobName,
  formatQueueOpsJson,
  formatQueueOpsTimestamp,
} from "./queue-ops.helpers";

const JSON_BLOCK_STYLE: CSSProperties = {
  maxHeight: 240,
  overflow: "auto",
  margin: 0,
  padding: 12,
  borderRadius: 8,
  background: "rgba(15, 23, 42, 0.06)",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const STACKTRACE_BLOCK_STYLE: CSSProperties = {
  ...JSON_BLOCK_STYLE,
  maxHeight: 200,
};

export interface QueueOpsJobDetailModalProps {
  open: boolean;
  state: QueueOpsJobState;
  job: QueueOpsJobDetail | null;
  loading: boolean;
  error: unknown;
  footer?: ReactNode;
  onClose: () => void;
}

/**
 * 作业详情（modal 形态，与 news-sources 的详情弹窗一致）：
 * 完整 data（JSON 美化 + dataTruncated 提示）、opts、returnvalue、
 * stacktrace、logs。操作按钮由调用方通过 footer 注入。
 */
export function QueueOpsJobDetailModal({
  open,
  state,
  job,
  loading,
  error,
  footer,
  onClose,
}: QueueOpsJobDetailModalProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const stateLabel = t(`ops.queueOps.jobs.states.${state}`);

  return (
    <Modal
      open={open}
      width={760}
      title={t("ops.queueOps.detail.title")}
      onCancel={onClose}
      footer={
        footer ?? (
          <Button onClick={onClose}>{t("ops.queueOps.detail.actions.close")}</Button>
        )
      }
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Spin />
        </div>
      ) : error ? (
        <Alert type="error" showIcon message={t("ops.queueOps.loadFailed")} />
      ) : job ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label={t("ops.queueOps.detail.fields.id")}>
              {job.id}
            </Descriptions.Item>
            <Descriptions.Item label={t("ops.queueOps.detail.fields.name")}>
              {formatQueueOpsJobName(job.name)}
            </Descriptions.Item>
            <Descriptions.Item label={t("ops.queueOps.detail.fields.state")}>
              {stateLabel}
            </Descriptions.Item>
            <Descriptions.Item
              label={t("ops.queueOps.detail.fields.attemptsMade")}
            >
              {job.attemptsMade}
            </Descriptions.Item>
            <Descriptions.Item label={t("ops.queueOps.detail.fields.orgId")}>
              {job.orgId ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item
              label={t("ops.queueOps.detail.fields.createdAt")}
            >
              {formatQueueOpsTimestamp(job.timestamp, locale)}
            </Descriptions.Item>
            <Descriptions.Item
              label={t("ops.queueOps.detail.fields.processedAt")}
            >
              {formatQueueOpsTimestamp(job.processedOn, locale)}
            </Descriptions.Item>
            <Descriptions.Item
              label={t("ops.queueOps.detail.fields.finishedAt")}
            >
              {formatQueueOpsTimestamp(job.finishedOn, locale)}
            </Descriptions.Item>
          </Descriptions>

          {job.dataTruncated ? (
            <Alert
              type="warning"
              showIcon
              message={t("ops.queueOps.detail.dataTruncated")}
            />
          ) : null}

          <section>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("ops.queueOps.detail.sections.data")}
            </Typography.Title>
            <pre data-testid="queue-ops-job-data" style={JSON_BLOCK_STYLE}>
              {formatQueueOpsJson(job.data)}
            </pre>
          </section>

          <section>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("ops.queueOps.detail.sections.opts")}
            </Typography.Title>
            <pre data-testid="queue-ops-job-opts" style={JSON_BLOCK_STYLE}>
              {formatQueueOpsJson(job.opts)}
            </pre>
          </section>

          <section>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("ops.queueOps.detail.sections.returnValue")}
            </Typography.Title>
            <pre data-testid="queue-ops-job-returnvalue" style={JSON_BLOCK_STYLE}>
              {formatQueueOpsJson(job.returnvalue)}
            </pre>
          </section>

          <section>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("ops.queueOps.detail.sections.stacktrace")}
            </Typography.Title>
            {job.stacktrace.length > 0 ? (
              <pre
                data-testid="queue-ops-job-stacktrace"
                style={STACKTRACE_BLOCK_STYLE}
              >
                {job.stacktrace.join("\n")}
              </pre>
            ) : (
              <Typography.Text type="secondary">
                {t("ops.queueOps.detail.emptyStacktrace")}
              </Typography.Text>
            )}
          </section>

          <section>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("ops.queueOps.detail.sections.logs")}
            </Typography.Title>
            {job.logs.length > 0 ? (
              <pre data-testid="queue-ops-job-logs" style={STACKTRACE_BLOCK_STYLE}>
                {job.logs.join("\n")}
              </pre>
            ) : (
              <Typography.Text type="secondary">
                {t("ops.queueOps.detail.emptyLogs")}
              </Typography.Text>
            )}
          </section>
        </Space>
      ) : null}
    </Modal>
  );
}
