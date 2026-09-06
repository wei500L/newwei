"use client";

import { Alert, App, Card, Descriptions, Spin, Typography } from "antd";
import { useSession } from "next-auth/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { resolveLocale } from "@/lib/i18n";

import { useCrawlResultActions } from "./hooks/use-crawl-result-actions";
import { useCrawlTaskActions } from "./hooks/use-crawl-task-actions";
import { useCrawlTaskBackfill } from "./hooks/use-crawl-task-backfill";
import { useCrawlTaskDetailQuery } from "./hooks/use-crawl-task-detail-query";
import { useCrawlTaskLogs } from "./hooks/use-crawl-task-logs";
import { useCrawlTaskOpsLive } from "./hooks/use-crawl-task-ops-live";
import { TaskDetailAlerts } from "./task-detail-alerts";
import { TaskDetailBrowserSection } from "./task-detail-browser-section";
import {
  classifyTaskLastErrorHeadedIssue,
  findTaskProxyIssues,
  isHeadedTaskConfig,
  parseTaskConfig,
  resolvePipelineJobId,
  buildStrategyViewModel,
} from "./task-detail-config-core-model";
import { TaskDetailExpansionSection } from "./task-detail-expansion-section";
import { TaskDetailFieldsSection } from "./task-detail-fields-section";
import { TaskDetailHeader } from "./task-detail-header";
import { TaskDetailLinkOverview } from "./task-detail-link-overview";
import { TaskDetailMarkdownSection } from "./task-detail-markdown-section";
import { TaskDetailMultiUrl } from "./task-detail-multi-url";
import { TaskDetailResults } from "./task-detail-results";
import { TaskDetailRunSummarySection } from "./task-detail-run-summary-section";
import { TaskDetailRuntimeSection } from "./task-detail-runtime-section";
import { TaskDetailStrategyCard } from "./task-detail-strategy-card";
import { TaskDetailTaskLogs } from "./task-detail-task-logs";

export function CrawlTaskDetail({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const canViewTaskLogs = permissions.includes("settings.manage");
  const canCreateItem = canView && permissions.includes("items.write");
  const canViewItems =
    permissions.includes("items.read") || permissions.includes("items.write");
  const {
    task,
    loading,
    refetch,
    startPolling,
    stopPolling,
    limit: resultLimit,
    searchInput: resultSearchInput,
    setLimit: setResultLimit,
    changeSearchInput,
    submitSearchInput,
  } = useCrawlTaskDetailQuery({ taskId, canView });

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const {
    logs: taskLogs,
    loading: taskLogsLoading,
    error: taskLogsError,
    expandedKeys: expandedTaskLogKeys,
    reload: loadTaskLogs,
    onExpandedRowsChange,
  } = useCrawlTaskLogs({
    apiClient,
    canView,
    canViewTaskLogs,
    authenticated: status === "authenticated",
    taskId,
    message,
  });

  const currentTaskStatus = task?.status;
  const shouldTrackInFlightTask =
    currentTaskStatus === "pending" ||
    currentTaskStatus === "queued" ||
    currentTaskStatus === "running";

  const config = useMemo(() => parseTaskConfig(task?.config), [task?.config]);
  const proxyIssues = useMemo(
    () => findTaskProxyIssues(config),
    [config],
  );
  const hasUnsupportedLegacyProxy = proxyIssues.length > 0;
  const unsupportedProxyActionHint = useMemo(
    () =>
      hasUnsupportedLegacyProxy
        ? t("crawl.policy.actionBlockedByUnsupportedProxy")
        : undefined,
    [hasUnsupportedLegacyProxy, t],
  );
  const isHeadedTask = useMemo(
    () => isHeadedTaskConfig(config),
    [config],
  );
  const lastErrorHeadedIssue = useMemo(
    () => classifyTaskLastErrorHeadedIssue(task?.lastError),
    [task?.lastError],
  );
  const pipelineJobId = useMemo(
    () => resolvePipelineJobId(config),
    [config],
  );

  const { status: opsLiveStatus, error: opsLiveError } = useCrawlTaskOpsLive({
    canView,
    accessToken: session?.accessToken,
    taskId,
    pipelineJobId,
    shouldTrackInFlightTask,
    refetch,
    startPolling,
    stopPolling,
  });

  const strategyModel = useMemo(
    () => buildStrategyViewModel(config),
    [config],
  );

  const taskActions = useCrawlTaskActions({
    task,
    canManage,
    hasItemsWrite: permissions.includes("items.write"),
    hasUnsupportedLegacyProxy,
    proxyIssues,
    refetch,
    message,
    t,
  });
  const backfill = useCrawlTaskBackfill({
    task,
    canCreateItem,
    refetch,
    message,
    t,
  });
  const resultActions = useCrawlResultActions({
    canCreateItem,
    message,
    t,
  });

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Typography.Text type="secondary">
          {t("common.loading")}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("crawl.detail.title")}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  if (loading && !task) {
    return (
      <div className="content-card" style={{ textAlign: "center" }}>
        <Spin />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="content-card">
        <Typography.Text type="secondary">
          {t("crawl.detail.notFound")}
        </Typography.Text>
      </div>
    );
  }

  const results = task.results ?? [];

  return (
    <div className="content-card">
      <TaskDetailHeader
        task={task}
        liveStatus={opsLiveStatus}
        liveError={opsLiveError}
        canManage={canManage}
        canCreateItem={canCreateItem}
        retry={taskActions}
        retryDisabled={hasUnsupportedLegacyProxy}
        retryHint={unsupportedProxyActionHint}
        backfill={backfill}
      />
      <TaskDetailAlerts
        task={task}
        proxyIssues={proxyIssues}
        liveError={opsLiveError}
        backfill={backfill}
        isHeadedTask={isHeadedTask}
        lastErrorHeadedIssue={lastErrorHeadedIssue}
      />
      <TaskDetailStrategyCard config={config} strategy={strategyModel} />
      {/* antd Descriptions 以 toArray(children) 读取 Item props：段组件需
          以函数调用内联为 Fragment，子 Descriptions.Item 才能被识别 */}
      <Descriptions bordered column={1} size="small">
        {TaskDetailFieldsSection({
          t,
          task,
          config,
          canManage,
          hasItemsWrite: permissions.includes("items.write"),
          updatingIngest: taskActions.updatingIngest,
          onToggleIngest: (checked) => void taskActions.toggleIngestToItems(checked),
        })}
        {TaskDetailExpansionSection({
          t,
          config,
          strategy: strategyModel,
          taskLogs,
        })}
        {TaskDetailBrowserSection({ t, config })}
        {TaskDetailRuntimeSection({ t, config })}
        {TaskDetailMarkdownSection({ t, config })}
        {TaskDetailRunSummarySection({ t, task, config, locale })}
      </Descriptions>

      {canViewTaskLogs ? (
        <TaskDetailTaskLogs
          logs={taskLogs}
          loading={taskLogsLoading}
          error={taskLogsError}
          expandedKeys={expandedTaskLogKeys}
          onExpandedRowsChange={onExpandedRowsChange}
          onReload={() => void loadTaskLogs()}
          locale={locale}
        />
      ) : null}

      <TaskDetailMultiUrl config={config} />

      <TaskDetailLinkOverview results={results} />

      <TaskDetailResults
        results={results}
        loading={loading}
        limit={resultLimit}
        searchInput={resultSearchInput}
        onLimitChange={setResultLimit}
        onSearchInputChange={changeSearchInput}
        onSearchSubmit={submitSearchInput}
        canViewItems={canViewItems}
        canCreateItem={canCreateItem}
        resultActions={resultActions}
        locale={locale}
      />
    </div>
  );
}
