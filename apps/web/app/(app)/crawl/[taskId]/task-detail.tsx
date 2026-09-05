"use client";

import { SearchOutlined } from "@ant-design/icons";
import { gql, type FetchResult, useMutation } from "@apollo/client";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  useIngestCrawlTaskResultsToItemsMutation,
  useRetryCrawlTaskMutation,
  useUpdateCrawlTaskIngestToItemsMutation,
  type IngestCrawlTaskResultsToItemsMutation,
  type CrawlTaskStatus,
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { useCrawlTaskDetailQuery } from "./hooks/use-crawl-task-detail-query";
import { useCrawlTaskLogs } from "./hooks/use-crawl-task-logs";
import { useCrawlTaskOpsLive } from "./hooks/use-crawl-task-ops-live";
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
import {
  BACKFILL_BATCH_TIMEOUT_MS,
  formatPolicyIssues,
  markdownPreviewStyle,
  safeParseJson,
  withTimeout,
} from "./task-detail-formatters";
import { TaskDetailLinkOverview } from "./task-detail-link-overview";
import { TaskDetailMarkdownSection } from "./task-detail-markdown-section";
import { MediaSection } from "./task-detail-media-section";
import { TaskDetailMultiUrl } from "./task-detail-multi-url";
import { TaskDetailRunSummarySection } from "./task-detail-run-summary-section";
import { TaskDetailRuntimeSection } from "./task-detail-runtime-section";
import { StoredMediaSection } from "./task-detail-stored-media-section";
import { TaskDetailStrategyCard } from "./task-detail-strategy-card";
import { TablesSection } from "./task-detail-tables-section";
import { TaskDetailTaskLogs } from "./task-detail-task-logs";
import type {
  BackfillNotice,
  CrawlMediaCollection,
  CrawlResultTable,
  CrawlStoredMediaAsset,
} from "./task-detail-types";

const statusColors: Record<CrawlTaskStatus, string> = {
  pending: "gold",
  queued: "cyan",
  running: "blue",
  completed: "green",
  failed: "red",
  paused: "purple",
};

const itemStatusColors: Record<string, string> = {
  draft: "default",
  pending: "gold",
  processing: "blue",
  completed: "green",
  failed: "red",
  duplicate: "purple",
};

const limitOptions = [
  {
    value: 10,
    labelKey: "crawl.detail.results.latest10",
    defaultValue: "Latest 10",
  },
  {
    value: 20,
    labelKey: "crawl.detail.results.latest20",
    defaultValue: "Latest 20",
  },
  {
    value: 50,
    labelKey: "crawl.detail.results.latest50",
    defaultValue: "Latest 50",
  },
];

const CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION = gql`
  mutation CreateItemFromCrawlResult($resultId: String!) {
    createItemFromCrawlResult(resultId: $resultId) {
      id
      title
      status
    }
  }
`;

export function CrawlTaskDetail({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
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

  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const [updateIngestToItems, { loading: updatingIngest }] =
    useUpdateCrawlTaskIngestToItemsMutation();
  const [ingestCrawlTaskResultsToItems] =
    useIngestCrawlTaskResultsToItemsMutation();
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillNotice, setBackfillNotice] = useState<BackfillNotice | null>(
    null,
  );
  const [ingestingResultId, setIngestingResultId] = useState<string | null>(
    null,
  );
  const [createItemFromCrawlResult, { loading: ingesting }] = useMutation<{
    createItemFromCrawlResult: { id: string; title: string; status: string };
  }>(CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION);

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

  const handleRetry = async () => {
    if (!task) return;
    if (hasUnsupportedLegacyProxy) {
      message.error(formatPolicyIssues(proxyIssues, t));
      return;
    }
    try {
      await retryTask({ variables: { id: task.id } });
      message.success(t("crawl.detail.retryQueued"));
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.detail.retryFailed"));
    }
  };

  const handleToggleIngestToItems = async (enabled: boolean) => {
    if (!task || !canManage) {
      return;
    }
    if (enabled && !permissions.includes("items.write")) {
      message.error(
        t("crawl.settings.ingestToItemsNoPermission"),
      );
      return;
    }

    try {
      await updateIngestToItems({
        variables: {
          id: task.id,
          enabled,
        },
      });
      message.success(t("common.updated"));
      await refetch();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed"),
      );
    }
  };

  const runBackfillToItems = async () => {
    if (!task || !canCreateItem) {
      return;
    }
    if ((task.results?.length ?? 0) === 0 && !task.lastResultAt) {
      const notice: BackfillNotice = {
        type: "info",
        message: t("crawl.detail.backfill.emptyTitle"),
        description: t("crawl.detail.backfill.emptyDescription"),
      };
      setBackfillNotice(notice);
      message.info(notice.message);
      return;
    }

    const messageKey = `crawl-backfill-${task.id}`;
    const batchLimit = 50;
    const maxBatches = 20;
    let after: string | null = null;
    let scannedTotal = 0;
    let ingestedTotal = 0;
    let skippedTotal = 0;
    let failedTotal = 0;

    setBackfillRunning(true);
    setBackfillNotice(null);
    message.loading({
      key: messageKey,
      duration: 0,
      content: t("crawl.detail.backfill.running"),
    });

    try {
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
        const response: FetchResult<IngestCrawlTaskResultsToItemsMutation> =
          await withTimeout(
            ingestCrawlTaskResultsToItems({
              variables: {
                taskId: task.id,
                after,
                limit: batchLimit,
                onlyMissing: true,
              },
            }),
            BACKFILL_BATCH_TIMEOUT_MS,
            t("crawl.detail.backfill.timeout"),
          );
        const summary:
          | IngestCrawlTaskResultsToItemsMutation["ingestCrawlTaskResultsToItems"]
          | null
          | undefined = response.data?.ingestCrawlTaskResultsToItems;
        if (!summary) {
          break;
        }

        scannedTotal += summary.scanned;
        ingestedTotal += summary.ingested;
        skippedTotal += summary.skippedExisting;
        failedTotal += summary.failed;

        message.loading({
          key: messageKey,
          duration: 0,
          content: t("crawl.detail.backfill.progress", {
            ingested: ingestedTotal,
            skipped: skippedTotal,
            failed: failedTotal,
          }),
        });

        after = summary.nextCursor ?? null;
        if (!summary.hasMore || !after) {
          break;
        }
      }

      const summaryDescription = t("crawl.detail.backfill.summary", {
        ingested: ingestedTotal,
        skipped: skippedTotal,
        failed: failedTotal,
        scanned: scannedTotal,
      });
      let notice: BackfillNotice;
      if (scannedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.emptyTitle"),
          description: t("crawl.detail.backfill.emptyDescription"),
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (ingestedTotal === 0 && failedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.noMissingTitle"),
          description: summaryDescription,
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (failedTotal > 0) {
        notice = {
          type: ingestedTotal > 0 ? "warning" : "error",
          message: t("crawl.detail.backfill.partialTitle"),
          description: summaryDescription,
        };
        if (notice.type === "error") {
          message.error({
            key: messageKey,
            content: notice.message,
          });
        } else {
          message.warning({
            key: messageKey,
            content: notice.message,
          });
        }
      } else {
        notice = {
          type: "success",
          message: t("crawl.detail.backfill.done"),
          description: summaryDescription,
        };
        message.success({
          key: messageKey,
          content: notice.message,
        });
      }
      setBackfillNotice(notice);
      await refetch();
    } catch (error) {
      const description =
        error instanceof Error
          ? error.message
          : t("common.operationFailed");
      setBackfillNotice({
        type: "error",
        message: t("crawl.detail.backfill.failedTitle"),
        description,
      });
      message.error({
        key: messageKey,
        content: description,
      });
    } finally {
      setBackfillRunning(false);
    }
  };

  const handleBackfillToItems = () => {
    if (!task || !canCreateItem) {
      return;
    }
    if ((task.results?.length ?? 0) === 0 && !task.lastResultAt) {
      void runBackfillToItems();
      return;
    }

    Modal.confirm({
      title: t("crawl.detail.backfill.confirmTitle"),
      content: t("crawl.detail.backfill.confirmDescription"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: runBackfillToItems,
    });
  };

  const handleCreateItem = async (resultId: string) => {
    if (!canCreateItem) {
      return;
    }

    const normalizedId = resultId.trim();
    if (!normalizedId) {
      message.error(
        t("common.invalidInput"),
      );
      return;
    }

    setIngestingResultId(normalizedId);
    try {
      const response = await createItemFromCrawlResult({
        variables: { resultId: normalizedId },
      });
      const createdId = response.data?.createItemFromCrawlResult?.id;
      message.success(
        t("crawl.detail.ingestQueued"),
      );
      if (createdId) {
        router.push(`/items/${createdId}`);
      }
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed"),
      );
    } finally {
      setIngestingResultId(null);
    }
  };

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
  const backfillUnavailable = results.length === 0 && !task.lastResultAt;

  return (
    <div className="content-card">
      <Space style={{ marginBottom: 16 }} wrap>
        <Link href="/admin/ops/crawl-tasks">
          {t("crawl.detail.backToTasks")}
        </Link>
        <Tag color={statusColors[task.status]}>
          {t(`crawl.status.${task.status}`, { defaultValue: task.status })}
        </Tag>
        <Tag
          color={
            opsLiveError
              ? "red"
              : opsLiveStatus === "connected"
                ? "green"
                : opsLiveStatus === "connecting"
                  ? "blue"
                  : undefined
          }
        >
          {opsLiveError
            ? t("crawl.liveUpdates.error")
            : opsLiveStatus === "connected"
              ? t("crawl.liveUpdates.connected")
              : opsLiveStatus === "connecting"
                ? t("crawl.liveUpdates.connecting")
                : t("crawl.liveUpdates.disconnected")}
        </Tag>
        {canManage ? (
          <Tooltip title={unsupportedProxyActionHint}>
            <span>
              <Button
                onClick={handleRetry}
                loading={retrying}
                disabled={hasUnsupportedLegacyProxy}
              >
                {t("crawl.detail.retry")}
              </Button>
            </span>
          </Tooltip>
        ) : null}
        {canCreateItem ? (
          <Button
            onClick={handleBackfillToItems}
            loading={backfillRunning}
            disabled={backfillUnavailable}
          >
            {t("crawl.detail.backfill.button")}
          </Button>
        ) : null}
        {canCreateItem && backfillUnavailable ? (
          <Typography.Text type="secondary">
            {t("crawl.detail.backfill.emptyHint")}
          </Typography.Text>
        ) : null}
        <Typography.Link href={task.targetUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.openSource")}
        </Typography.Link>
      </Space>
      {hasUnsupportedLegacyProxy ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.proxy.unsupportedLegacyTitle")}
          description={formatPolicyIssues(proxyIssues, t)}
        />
      ) : null}
      {opsLiveError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.liveUpdates.alertTitle")}
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {opsLiveError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.liveUpdates.fallbackHint")}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {backfillNotice ? (
        <Alert
          type={backfillNotice.type}
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={backfillNotice.message}
          description={backfillNotice.description}
          onClose={() => setBackfillNotice(null)}
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
          updatingIngest,
          onToggleIngest: (checked) => void handleToggleIngestToItems(checked),
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

      <Card
        title={t("crawl.detail.results.title")}
        style={{ marginTop: 24 }}
        extra={
          <Space>
            <Space.Compact style={{ width: 260 }}>
              <Input
                id="crawl-task-result-search"
                name="crawlTaskResultSearch"
                placeholder={t("crawl.detail.results.searchPlaceholder")}
                allowClear
                value={resultSearchInput}
                onChange={(event) => changeSearchInput(event.target.value)}
                onPressEnter={() => submitSearchInput()}
              />
              <Button
                icon={<SearchOutlined />}
                aria-label={t("crawl.detail.results.searchPlaceholder")}
                onClick={() => submitSearchInput()}
              />
            </Space.Compact>
            <Select
              value={resultLimit}
              style={{ width: 140 }}
              onChange={setResultLimit}
              options={limitOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey, {
                  defaultValue: option.defaultValue,
                }),
              }))}
            />
          </Space>
        }
      >
        {loading && results.length === 0 ? (
          <Spin />
        ) : (
          <List
            dataSource={results}
            locale={{ emptyText: t("crawl.detail.results.empty") }}
            renderItem={(result) => {
              const metadata = result.metadata;
              const mediaPayload = safeParseJson<CrawlMediaCollection>(
                result.media,
              );
              const storedAssets = safeParseJson<CrawlStoredMediaAsset[]>(
                result.mediaAssets,
              );
              const tablesPayload = (result.tables ?? null) as
                | CrawlResultTable[]
                | null;
              const itemStatus =
                result.itemStatus?.toLowerCase?.() ?? result.itemStatus ?? null;
              const itemTagColor =
                itemStatus && typeof itemStatus === "string"
                  ? (itemStatusColors[itemStatus] ?? "default")
                  : "default";
              const variantEntries = [
                {
                  key: "raw",
                  label: t("crawl.detail.results.variants.raw"),
                  content: result.markdown,
                },
                {
                  key: "citations",
                  label: t("crawl.detail.results.variants.citations"),
                  content: result.markdownWithCitations,
                },
                {
                  key: "references",
                  label: t("crawl.detail.results.variants.references"),
                  content: result.referencesMarkdown,
                },
                {
                  key: "fit",
                  label: t("crawl.detail.results.variants.cleanFit"),
                  content: result.fitMarkdown,
                },
              ].filter((entry) => entry.content && entry.content.length > 0);
              const defaultContent = (
                <pre
                  className="markdown-preview"
                  style={{ ...markdownPreviewStyle, marginTop: 8 }}
                >
                  {result.markdown}
                </pre>
              );
              const tabs =
                variantEntries.length > 1 ? (
                  <Tabs
                    size="small"
                    style={{ marginTop: 8 }}
                    items={variantEntries.map((entry) => ({
                      key: entry.key,
                      label: entry.label,
                      children: (
                        <pre
                          className="markdown-preview"
                          style={{ ...markdownPreviewStyle, marginTop: 8 }}
                        >
                          {entry.content}
                        </pre>
                      ),
                    }))}
                  />
                ) : (
                  defaultContent
                );
              return (
                <List.Item key={result.id}>
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Typography.Link
                          href={result.sourceUrl}
                          target="_blank"
                        >
                          {result.sourceUrl}
                        </Typography.Link>
                        <Typography.Text type="secondary">
                          {formatDateTime(result.fetchedAt, locale, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Typography.Text>
                        {result.itemId ? (
                          <>
                            {itemStatus ? (
                              <Tag color={itemTagColor}>
                                {t(`items.status.${itemStatus}`, {
                                  defaultValue: itemStatus,
                                })}
                              </Tag>
                            ) : null}
                            {canViewItems ? (
                              <Button
                                size="small"
                                onClick={() =>
                                  router.push(`/items/${result.itemId}`)
                                }
                              >
                                {t("crawl.detail.openItem")}
                              </Button>
                            ) : null}
                          </>
                        ) : canCreateItem ? (
                          <Button
                            size="small"
                            loading={
                              ingesting && ingestingResultId === result.id
                            }
                            onClick={() => handleCreateItem(result.id)}
                          >
                            {t("crawl.detail.ingestToItems")}
                          </Button>
                        ) : null}
                      </Space>
                    }
                    description={
                      <>
                        {metadata && (
                          <Typography.Text type="secondary">
                            {metadata}
                          </Typography.Text>
                        )}
                        {tabs}
                        <MediaSection media={mediaPayload} />
                        <StoredMediaSection assets={storedAssets} />
                        <TablesSection tables={tablesPayload} />
                      </>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    </div>
  );
}
