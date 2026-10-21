"use client";

import { Alert, Card, Space, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { canViewQueueOps } from "./queue-ops-access";
import { QueueOpsDlqPanel } from "./queue-ops-dlq-panel";
import { QueueOpsJobsPanel } from "./queue-ops-jobs-panel";
import { QueueOpsQueuesPanel } from "./queue-ops-queues-panel";
import {
  useQueueOpsData,
  type QueueOpsRequestIssue,
} from "./use-queue-ops-data";

/**
 * 队列运维控制台（/admin/ops/queue-ops）。
 *
 * 页面本体做一次与后端一致的鉴权镜像（queue.manage + platform_admin），
 * 不满足时只显示既有的「仅管理员」提示；404 表示 api-go 尚未开启
 * API_GO_QUEUE_OPS_MODE=go，只显示提示 Alert，不当作错误弹窗。
 */
export function QueueOpsContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const globalRoles = session?.user?.globalRoles ?? [];
  const canView = canViewQueueOps({ permissions, globalRoles });
  const [messageApi, contextHolder] = message.useMessage();
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);
  const [legacyMode, setLegacyMode] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const handleRequestIssue = useCallback((issue: QueueOpsRequestIssue) => {
    if (issue === "notFound") {
      setLegacyMode(true);
      return;
    }
    setForbidden(true);
  }, []);

  const queuesData = useQueueOpsData({
    canView,
    t,
    messageApi,
    onRequestIssue: handleRequestIssue,
  });

  if (status === "loading") {
    return <Card loading className="content-card" />;
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("ops.queueOps.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("ops.queueOps.title")}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("ops.queueOps.subtitle")}
        </Typography.Text>
      </Space>

      {legacyMode ? (
        <Alert
          type="info"
          showIcon
          message={t("ops.queueOps.legacy.title")}
          description={t("ops.queueOps.legacy.description")}
        />
      ) : null}

      {forbidden ? (
        <Alert
          type="warning"
          showIcon
          message={t("ops.queueOps.forbidden.title")}
          description={t("ops.queueOps.forbidden.description")}
        />
      ) : null}

      <QueueOpsQueuesPanel
        queues={queuesData.queues}
        loading={queuesData.loading}
        error={queuesData.error}
        selectedQueue={selectedQueue}
        busyAction={queuesData.busyAction}
        onRefresh={queuesData.reload}
        onSelectQueue={setSelectedQueue}
        onPause={queuesData.pause}
        onResume={queuesData.resume}
        onClean={queuesData.clean}
      />

      {selectedQueue ? (
        <QueueOpsJobsPanel
          key={selectedQueue}
          queue={selectedQueue}
          messageApi={messageApi}
          onRequestIssue={handleRequestIssue}
          onCountsChanged={queuesData.reload}
        />
      ) : null}

      <QueueOpsDlqPanel
        messageApi={messageApi}
        onRequestIssue={handleRequestIssue}
        onCountsChanged={queuesData.reload}
      />
    </div>
  );
}
