"use client";

import {
  Button,
  Card,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RequestErrorBanner } from "@/components/request-error-banner";
import {
  QUEUE_OPS_JOB_STATES,
  type QueueOpsCounts,
  type QueueOpsJobState,
  type QueueOpsQueue,
} from "@/lib/queue-ops";

import { confirmQueueOpsAction } from "./queue-ops-confirm";
import type { QueueOpsCleanInput } from "./use-queue-ops-data";

interface QueueOpsCleanFormValues {
  state: QueueOpsJobState;
  grace: number;
  limit: number;
}

interface QueueOpsCountColumn {
  key: keyof QueueOpsCounts;
  titleKey: string;
}

const COUNT_COLUMNS: QueueOpsCountColumn[] = [
  { key: "waiting", titleKey: "ops.queueOps.queues.columns.waiting" },
  { key: "active", titleKey: "ops.queueOps.queues.columns.active" },
  { key: "delayed", titleKey: "ops.queueOps.queues.columns.delayed" },
  { key: "completed", titleKey: "ops.queueOps.queues.columns.completed" },
  { key: "failed", titleKey: "ops.queueOps.queues.columns.failed" },
  { key: "paused", titleKey: "ops.queueOps.queues.columns.paused" },
];

const CLEAN_FORM_INITIAL_VALUES: QueueOpsCleanFormValues = {
  state: "completed",
  grace: 0,
  limit: 100,
};

export interface QueueOpsQueuesPanelProps {
  queues: QueueOpsQueue[];
  loading: boolean;
  error: unknown;
  selectedQueue: string | null;
  busyAction: string | null;
  onRefresh: () => void;
  onSelectQueue: (queueName: string) => void;
  onPause: (queueName: string) => Promise<boolean>;
  onResume: (queueName: string) => Promise<boolean>;
  onClean: (input: QueueOpsCleanInput) => Promise<boolean>;
}

/** 队列列表：六项计数、paused、concurrency + 暂停/恢复/清理/查看作业。 */
export function QueueOpsQueuesPanel({
  queues,
  loading,
  error,
  selectedQueue,
  busyAction,
  onRefresh,
  onSelectQueue,
  onPause,
  onResume,
  onClean,
}: QueueOpsQueuesPanelProps) {
  const { t } = useTranslation();
  const [cleanForm] = Form.useForm<QueueOpsCleanFormValues>();
  const [cleanTarget, setCleanTarget] = useState<QueueOpsQueue | null>(null);
  const [cleanSubmitting, setCleanSubmitting] = useState(false);

  const handlePause = (queue: QueueOpsQueue) => {
    confirmQueueOpsAction({
      title: t("ops.queueOps.confirm.pauseTitle", { queue: queue.name }),
      description: t("ops.queueOps.confirm.pauseDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
      onConfirm: async () => {
        await onPause(queue.name);
      },
    });
  };

  const handleResume = (queue: QueueOpsQueue) => {
    confirmQueueOpsAction({
      title: t("ops.queueOps.confirm.resumeTitle", { queue: queue.name }),
      description: t("ops.queueOps.confirm.resumeDescription"),
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.cancel"),
      onConfirm: async () => {
        await onResume(queue.name);
      },
    });
  };

  const openClean = (queue: QueueOpsQueue) => {
    setCleanTarget(queue);
  };

  const closeClean = () => {
    if (cleanSubmitting) {
      return;
    }
    setCleanTarget(null);
  };

  const submitClean = async () => {
    if (!cleanTarget) {
      return;
    }
    const values = await cleanForm
      .validateFields()
      .catch(() => null);
    if (!values) {
      return;
    }
    setCleanSubmitting(true);
    const succeeded = await onClean({
      queue: cleanTarget.name,
      state: values.state,
      grace: values.grace,
      limit: values.limit,
    });
    setCleanSubmitting(false);
    if (succeeded) {
      setCleanTarget(null);
    }
  };

  const columns: ColumnsType<QueueOpsQueue> = [
    {
      title: t("ops.queueOps.queues.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (name: string, record) => (
        <Button
          type="link"
          style={{ paddingInline: 0 }}
          onClick={() => onSelectQueue(record.name)}
        >
          {name}
        </Button>
      ),
    },
    ...COUNT_COLUMNS.map((column) => ({
      title: t(column.titleKey),
      dataIndex: ["counts", column.key],
      key: column.key,
      align: "right" as const,
      width: 84,
    })),
    {
      title: t("ops.queueOps.queues.columns.status"),
      key: "status",
      render: (_value: unknown, record) => (
        <Space size={4} wrap>
          <Tag color={record.paused ? "orange" : "green"}>
            {record.paused
              ? t("ops.queueOps.queues.tags.paused")
              : t("ops.queueOps.queues.tags.running")}
          </Tag>
          {record.isDLQ ? (
            <Tag color="red">{t("ops.queueOps.queues.tags.dlq")}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("ops.queueOps.queues.columns.concurrency"),
      dataIndex: "concurrency",
      key: "concurrency",
      align: "right",
      width: 100,
      render: (value: number | null) => value ?? "-",
    },
    {
      title: t("ops.queueOps.queues.columns.actions"),
      key: "actions",
      render: (_value: unknown, record) => (
        <Space size={4} wrap>
          {record.paused ? (
            <Button
              size="small"
              loading={busyAction === `resume:${record.name}`}
              onClick={() => handleResume(record)}
            >
              {t("ops.queueOps.queues.actions.resume")}
            </Button>
          ) : (
            <Button
              size="small"
              loading={busyAction === `pause:${record.name}`}
              onClick={() => handlePause(record)}
            >
              {t("ops.queueOps.queues.actions.pause")}
            </Button>
          )}
          <Button size="small" onClick={() => openClean(record)}>
            {t("ops.queueOps.queues.actions.clean")}
          </Button>
          <Button
            size="small"
            type="primary"
            onClick={() => onSelectQueue(record.name)}
          >
            {t("ops.queueOps.queues.actions.viewJobs")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="content-card"
      title={t("ops.queueOps.queues.title")}
      extra={
        <Button onClick={onRefresh} loading={loading}>
          {t("common.refresh")}
        </Button>
      }
    >
      {error ? (
        <RequestErrorBanner
          error={error}
          onRetry={onRefresh}
          actionLoading={loading}
        />
      ) : null}
      <Table<QueueOpsQueue>
        size="small"
        rowKey="name"
        columns={columns}
        dataSource={queues}
        loading={loading}
        pagination={false}
        scroll={{ x: "max-content" }}
        rowClassName={(record) =>
          record.name === selectedQueue ? "ant-table-row-selected" : ""
        }
        locale={{ emptyText: t("ops.queueOps.queues.empty") }}
      />

      <Modal
        open={cleanTarget !== null}
        title={t("ops.queueOps.queues.clean.title", {
          queue: cleanTarget?.name ?? "",
        })}
        okText={t("ops.queueOps.queues.clean.submit")}
        cancelText={t("common.cancel")}
        confirmLoading={cleanSubmitting}
        onOk={() => {
          void submitClean();
        }}
        onCancel={closeClean}
      >
        <Form
          form={cleanForm}
          layout="vertical"
          initialValues={CLEAN_FORM_INITIAL_VALUES}
        >
          <Form.Item
            name="state"
            label={t("ops.queueOps.queues.clean.state")}
            rules={[{ required: true }]}
          >
            <Select
              options={QUEUE_OPS_JOB_STATES.map((value) => ({
                value,
                label: t(`ops.queueOps.jobs.states.${value}`),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="grace"
            label={t("ops.queueOps.queues.clean.grace")}
            rules={[{ required: true }]}
          >
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="limit"
            label={t("ops.queueOps.queues.clean.limit")}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={1000} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
