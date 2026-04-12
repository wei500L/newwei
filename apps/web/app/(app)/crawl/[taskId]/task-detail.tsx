"use client";

import { SearchOutlined, WarningOutlined } from "@ant-design/icons";
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
  Switch,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  Grid,
} from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import {
  useCrawlTaskQuery,
  useIngestCrawlTaskResultsToItemsMutation,
  useRetryCrawlTaskMutation,
  useUpdateCrawlTaskIngestToItemsMutation,
  type IngestCrawlTaskResultsToItemsMutation,
  type CrawlTaskStatus,
} from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { getCrawlTaskDetailOpsRefreshDecision } from "@/lib/crawl-ops-refresh";
import { classifyHeadedIssue } from "@/lib/crawl-runtime";
import {
  parseExpansionHeadSignalSummary,
  resolveHeadSignalFallbackHint,
  type ExpansionHeadSignalSummary,
} from "@/lib/crawl-task-head-signal";
import { env } from "@/lib/env";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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

type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

interface TaskLogRecord {
  id: string;
  queue: string;
  jobId: string;
  orgId: string;
  stage: string;
  status: TaskLogStatus;
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ExpansionQualitySummary {
  candidateCount: number;
  batchCount: number;
  improvedSuccesses: number;
  primaryCandidatePool?: number;
  fallbackCandidatePool?: number;
  minimumCandidateCount?: number;
  strictCandidateCount?: number;
  relaxedCandidateCount?: number;
  linkFallbackCandidateCount?: number;
}

const taskLogStatusColors: Record<TaskLogStatus, string> = {
  pending: "gold",
  processing: "blue",
  completed: "green",
  failed: "red",
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

const BACKFILL_BATCH_TIMEOUT_MS = 15_000;

const markdownPreviewStyle: CSSProperties = {
  maxWidth: "100%",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

interface BackfillNotice {
  type: "info" | "success" | "warning" | "error";
  message: string;
  description?: string;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

interface CrawlMediaSource {
  src?: string;
  srcset?: string;
  type?: string;
  media?: string;
  sizes?: string;
}

interface CrawlMediaItem {
  src?: string;
  alt?: string;
  title?: string;
  desc?: string;
  type?: string;
  format?: string;
  width?: number;
  height?: number;
  score?: number;
  poster?: string;
  sizes?: string;
  srcset?: string[];
  pictureSources?: CrawlMediaSource[];
  responsiveSources?: CrawlMediaSource[];
}

type CrawlMediaCollection = Record<string, CrawlMediaItem[]>;

interface CrawlStoredMediaAsset {
  id: string;
  kind: string;
  sourceUrl: string;
  bytes: number;
  contentType?: string;
  storageProvider?: "mysql" | "s3";
  storageKey?: string;
  previewUrl?: string;
  downloadUrl?: string;
  width?: number;
  height?: number;
  alt?: string;
  title?: string;
  desc?: string;
  poster?: string;
  format?: string;
}

type CrawlResultTableRecord = Record<string, string | number | boolean | null>;
type CrawlResultTablePreviewRow = CrawlResultTableRecord & { key: string };

interface CrawlResultTable {
  id: string;
  caption?: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  columnCount: number;
  source?: string;
  metadata?: Record<string, unknown>;
  dataFrame?: {
    columns: string[];
    rows: CrawlResultTableRecord[];
  };
}

const mediaDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/link-media.md";
const tableDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/blog/release-v0.7.3.md";
const shortenScript = (value: string) =>
  value.length > 160 ? `${value.slice(0, 157)}…` : value;

const CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION = gql`
  mutation CreateItemFromCrawlResult($resultId: String!) {
    createItemFromCrawlResult(resultId: $resultId) {
      id
      title
      status
    }
  }
`;

function safeParseJson<T>(input?: string | null): T | null {
  if (!input) {
    return null;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function resolveStoredMediaUrl(value?: string) {
  if (!value) {
    return undefined;
  }
  if (/^(https?:\/\/|data:|blob:)/i.test(value)) {
    return value;
  }
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (normalized.startsWith("/api/")) {
    return `${env.apiRoot}${normalized}`;
  }
  return `${env.apiBaseUrl}${normalized}`;
}

function MediaSection({ media }: { media: CrawlMediaCollection | null }) {
  const { t } = useTranslation();
  if (!media) {
    return null;
  }
  const entries = Object.entries(media).filter(
    ([, items]) => Array.isArray(items) && items.length > 0,
  );
  if (!entries.length) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.media.title")}
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={mediaDocsUrl} target="_blank" rel="noreferrer">
          {t("common.docs")}
        </Typography.Link>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {entries.map(([kind, items]) => {
          const preview = items.slice(0, 4);
          const remaining = Math.max(0, items.length - preview.length);
          return (
            <div key={kind}>
              <Typography.Text strong style={{ textTransform: "capitalize" }}>
                {kind} ({items.length})
              </Typography.Text>
              <List
                size="small"
                split={false}
                style={{ marginTop: 8 }}
                dataSource={preview}
                renderItem={(item, index) => (
                  <List.Item key={`${kind}-${index}-${item.src ?? "media"}`}>
                    <Space align="start">
                      {renderMediaPreview(kind, item, t)}
                      <Space direction="vertical" size={4}>
                        <Typography.Link href={item.src} target="_blank">
                          {item.src ?? t("crawl.detail.media.viewAsset")}
                        </Typography.Link>
                        {item.alt || item.title ? (
                          <Typography.Text strong>
                            {item.alt ?? item.title}
                          </Typography.Text>
                        ) : null}
                        {item.desc ? (
                          <Typography.Paragraph style={{ marginBottom: 4 }}>
                            {item.desc}
                          </Typography.Paragraph>
                        ) : null}
                        <Typography.Text type="secondary">
                          {[
                            item.type,
                            item.format,
                            formatDimensions(item),
                            formatScore(item, t),
                          ]
                            .filter(Boolean)
                            .join(" • ")}
                        </Typography.Text>
                        {item.srcset ? renderSrcset(item.srcset, t) : null}
                        {renderSourceList(
                          t("crawl.detail.media.sourceTypes.picture"),
                          item.pictureSources,
                          t,
                        )}
                        {renderSourceList(
                          t("crawl.detail.media.sourceTypes.responsive"),
                          item.responsiveSources,
                          t,
                        )}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
              {remaining > 0 ? (
                <Typography.Text type="secondary">
                  {t("crawl.detail.media.more", { count: remaining, kind })}
                </Typography.Text>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

function StoredMediaSection({
  assets,
}: {
  assets: CrawlStoredMediaAsset[] | null;
}) {
  const { t } = useTranslation();
  if (!assets || assets.length === 0) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.media.storedTitle")}
      style={{ marginTop: 12 }}
    >
      <List
        size="small"
        split={false}
        dataSource={assets}
        renderItem={(asset) => {
          const sourceHref = /^https?:\/\//i.test(asset.sourceUrl)
            ? asset.sourceUrl
            : undefined;
          const previewHref = resolveStoredMediaUrl(asset.previewUrl);
          const downloadHref = resolveStoredMediaUrl(
            asset.downloadUrl ?? asset.previewUrl,
          );
          const missingStoredAccess = !previewHref && !downloadHref;
          return (
            <List.Item key={`${asset.id}-${asset.sourceUrl}`}>
              <Space align="start">
                <StoredMediaPreview asset={asset} previewUrl={previewHref} />
                <Space direction="vertical" size={4}>
                  <Typography.Text strong>
                    {asset.title ?? asset.alt ?? asset.kind}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {(
                      asset.contentType ?? t("crawl.detail.media.unknownMime")
                    ).toUpperCase()}{" "}
                    • {formatBytes(asset.bytes)}
                  </Typography.Text>
                  <Typography.Paragraph style={{ marginBottom: 4 }}>
                    {asset.desc ?? asset.sourceUrl}
                  </Typography.Paragraph>
                  {missingStoredAccess ? (
                    <Typography.Text type="danger">
                      {t("crawl.detail.media.assetUnavailable")}
                    </Typography.Text>
                  ) : null}
                  <Space size="small">
                    {sourceHref ? (
                      <Typography.Link
                        href={sourceHref}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("common.source")}
                      </Typography.Link>
                    ) : null}
                    {downloadHref ? (
                      <Typography.Link
                        href={downloadHref}
                        download={`${asset.kind}-${asset.id}`}
                        rel="noreferrer"
                      >
                        {t("common.download")}
                      </Typography.Link>
                    ) : null}
                  </Space>
                </Space>
              </Space>
            </List.Item>
          );
        }}
      />
    </Card>
  );
}

function buildTableRecords(table: CrawlResultTable): CrawlResultTableRecord[] {
  if (table.dataFrame?.rows?.length) {
    return table.dataFrame.rows;
  }
  return table.rows.map((row) =>
    table.headers.reduce<CrawlResultTableRecord>((acc, header, index) => {
      acc[header] = row[index] ?? null;
      return acc;
    }, {}),
  );
}

function TablesSection({ tables }: { tables: CrawlResultTable[] | null }) {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  if (!tables || !tables.length) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.tables.title")}
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={tableDocsUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.tables.releaseNotes")}
        </Typography.Link>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {tables.map((table) => {
          const columns = (table.dataFrame?.columns ?? table.headers).map(
            (header) => ({
              title: header,
              dataIndex: header,
              key: header,
              ellipsis: true,
            }),
          );
          const records = buildTableRecords(table);
          const previewRows: CrawlResultTablePreviewRow[] = records
            .slice(0, 5)
            .map((record, index) => ({
              key: `${table.id}-${index}`,
              ...record,
            }));
          const remaining = Math.max(0, table.rowCount - previewRows.length);
          return (
            <div key={table.id}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Space wrap>
                  <Typography.Text strong>
                    {table.caption ||
                      t("crawl.detail.tables.defaultTitle", { id: table.id })}
                  </Typography.Text>
                  <Tag>
                    {table.rowCount} × {table.columnCount}
                  </Tag>
                  {table.source && (
                    <Typography.Text type="secondary">
                      {t("crawl.detail.tables.source", {
                        source: table.source,
                      })}
                    </Typography.Text>
                  )}
                </Space>
                {table.metadata && (
                  <Typography.Text type="secondary">
                    {JSON.stringify(table.metadata)}
                  </Typography.Text>
                )}
              </Space>
              {!screens.md ? (
                <List
                  dataSource={previewRows}
                  size="small"
                  style={{ marginTop: 8 }}
                  renderItem={(item, i) => (
                    <List.Item>
                      <List.Item.Meta
                        title={`${t("common.row")} ${i + 1}`}
                        description={
                          <Space direction="vertical" size={0}>
                            {columns.slice(0, 3).map((col) => (
                              <div key={col.key}>
                                <Typography.Text
                                  type="secondary"
                                  style={{ fontSize: 12 }}
                                >
                                  {col.title}:
                                </Typography.Text>{" "}
                                <Typography.Text style={{ fontSize: 12 }}>
                                  {String(item[col.dataIndex] ?? "")}
                                </Typography.Text>
                              </div>
                            ))}
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              ) : (
                <Table
                  columns={columns}
                  dataSource={previewRows}
                  size="small"
                  pagination={false}
                  style={{ marginTop: 8 }}
                  scroll={{ x: true }}
                />
              )}
              {remaining > 0 && (
                <Typography.Text type="secondary">
                  {t("crawl.detail.tables.remaining", {
                    preview: previewRows.length,
                    remaining,
                  })}
                </Typography.Text>
              )}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

function renderMediaPreview(
  kind: string,
  item: CrawlMediaItem,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (!item.src) {
    return null;
  }
  const normalized = kind.toLowerCase();
  if (normalized.includes("image")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.src}
        alt={item.alt || item.title || t("crawl.detail.media.thumbnailAlt")}
        style={{
          width: 96,
          height: 96,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border-secondary)",
        }}
        loading="lazy"
      />
    );
  }
  if (normalized.includes("video")) {
    return (
      <video
        src={item.src}
        poster={item.poster}
        controls
        style={{ width: 160, borderRadius: 8 }}
      />
    );
  }
  if (normalized.includes("audio")) {
    return <audio src={item.src} controls style={{ minWidth: 160 }} />;
  }
  return null;
}

function StoredMediaPreview({
  asset,
  previewUrl,
}: {
  asset: CrawlStoredMediaAsset;
  previewUrl?: string;
}) {
  const { t } = useTranslation();
  const [previewFailed, setPreviewFailed] = useState(false);
  if (previewUrl && !previewFailed && asset.contentType?.startsWith("image/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={previewUrl}
        alt={asset.alt ?? asset.title ?? asset.kind}
        style={{
          width: 96,
          height: 96,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border-secondary)",
        }}
        loading="lazy"
        onError={() => {
          setPreviewFailed(true);
          captureClientError("Failed to load stored crawl image preview", {
            assetId: asset.id,
            sourceUrl: asset.sourceUrl,
            storageProvider: asset.storageProvider,
          });
        }}
      />
    );
  }
  if (previewUrl && !previewFailed && asset.contentType?.startsWith("video/")) {
    return (
      <video
        src={previewUrl}
        controls
        style={{ width: 160, borderRadius: 8 }}
        preload="metadata"
        onError={() => {
          setPreviewFailed(true);
          captureClientError("Failed to load stored crawl video preview", {
            assetId: asset.id,
            sourceUrl: asset.sourceUrl,
            storageProvider: asset.storageProvider,
          });
        }}
      />
    );
  }
  return (
    <Space direction="vertical" size={4} align="center">
      <div className="media-thumb" style={{ width: 80, height: 80 }}>
        {asset.kind.slice(0, 2).toUpperCase()}
      </div>
      {previewFailed ? (
        <Space size={4} align="center">
          <WarningOutlined style={{ color: "var(--ant-color-error)" }} />
          <Typography.Text type="danger">
            {t("crawl.detail.media.previewLoadFailed")}
          </Typography.Text>
        </Space>
      ) : (
        <Typography.Text type="secondary">
          {t("crawl.detail.media.previewUnavailable")}
        </Typography.Text>
      )}
    </Space>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDimensions(item: CrawlMediaItem) {
  if (item.width && item.height) {
    return `${item.width}×${item.height}px`;
  }
  return undefined;
}

function formatScore(
  item: CrawlMediaItem,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (typeof item.score === "number") {
    return t("crawl.detail.media.score", { score: item.score.toFixed(2) });
  }
  return undefined;
}

function renderSrcset(
  srcset: string[],
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  return (
    <div>
      <Typography.Text type="secondary">
        {t("crawl.detail.media.srcsetVariants")}
      </Typography.Text>
      <pre
        style={{
          background: "var(--ant-color-fill-alter)",
          padding: 8,
          borderRadius: 4,
          maxWidth: 520,
          whiteSpace: "pre-wrap",
        }}
      >
        {srcset.join("\n")}
      </pre>
    </div>
  );
}

function renderSourceList(
  label: string,
  sources: CrawlMediaSource[] | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (!sources || sources.length === 0) {
    return null;
  }
  return (
    <div>
      <Typography.Text type="secondary">
        {t("crawl.detail.media.sources", { label, count: sources.length })}
      </Typography.Text>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {sources.slice(0, 4).map((source, index) => (
          <li key={`${label}-${index}`}>
            <code>{source.srcset ?? source.src}</code>
            {source.type ? ` • ${source.type}` : ""}
            {source.media ? ` • ${source.media}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const [resultLimit, setResultLimit] = useState(20);
  const [resultSearch, setResultSearch] = useState<string>();
  const [resultSearchInput, setResultSearchInput] = useState("");

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const taskLogsLoadingRef = useRef(false);
  const [taskLogs, setTaskLogs] = useState<TaskLogRecord[]>([]);
  const [expandedTaskLogKeys, setExpandedTaskLogKeys] = useState<string[]>([]);
  const [taskLogsLoading, setTaskLogsLoading] = useState(false);
  const [taskLogsError, setTaskLogsError] = useState<string | null>(null);
  const opsSocketRef = useRef<Socket | null>(null);
  const opsSocketBootstrappingRef = useRef(false);
  const opsRefreshTimerRef = useRef<number | null>(null);
  const pendingOpsRefreshRef = useRef({ task: false });
  const [opsLiveStatus, setOpsLiveStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");

  const { data, loading, refetch, startPolling, stopPolling } =
    useCrawlTaskQuery({
      variables: {
        id: taskId,
        resultLimit,
        resultSearch: resultSearch ?? null,
      },
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "cache-first",
      skip: !canView,
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

  const loadTaskLogs = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!canViewTaskLogs) {
        return;
      }
      if (taskLogsLoadingRef.current) {
        return;
      }
      const silent = options?.silent === true;
      taskLogsLoadingRef.current = true;
      if (!silent) {
        setTaskLogsLoading(true);
        setTaskLogsError(null);
      }
      try {
        const res = await apiClient.get<TaskLogRecord[]>(
          "admin/quality/task-logs",
          {
            params: {
              queue: "crawl4ai",
              jobId: taskId,
              limit: 100,
            },
          },
        );
        setTaskLogs(Array.isArray(res.data) ? res.data : []);
        setTaskLogsError(null);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!silent) {
          setTaskLogsError(reason);
          message.error(reason);
        }
      } finally {
        if (!silent) {
          setTaskLogsLoading(false);
        }
        taskLogsLoadingRef.current = false;
      }
    },
    [apiClient, canViewTaskLogs, message, taskId],
  );

  const currentTaskStatus = data?.crawlTask?.status;
  const shouldTrackInFlightTask =
    currentTaskStatus === "pending" ||
    currentTaskStatus === "queued" ||
    currentTaskStatus === "running";

  useEffect(() => {
    if (!canView) {
      stopPolling();
      return;
    }
    if (
      opsSocketBootstrappingRef.current ||
      opsLiveStatus === "connected" ||
      opsLiveStatus === "connecting"
    ) {
      stopPolling();
      return;
    }
    if (shouldTrackInFlightTask) {
      startPolling(3000);
      return;
    }
    stopPolling();
  }, [
    canView,
    opsLiveStatus,
    shouldTrackInFlightTask,
    startPolling,
    stopPolling,
  ]);

  useEffect(() => {
    if (!canViewTaskLogs || !canView || status !== "authenticated") {
      return;
    }
    void loadTaskLogs();
  }, [canView, canViewTaskLogs, loadTaskLogs, status]);

  useEffect(() => {
    setExpandedTaskLogKeys((current) => {
      const next = current.filter((key) =>
        taskLogs.some((log) => log.id === key),
      );
      return next.length === current.length ? current : next;
    });
  }, [taskLogs]);

  useEffect(() => {
    setExpandedTaskLogKeys([]);
  }, [taskId]);

  const task = data?.crawlTask ?? null;
  const config = useMemo(() => {
    if (!task?.config) {
      return null;
    }
    try {
      return JSON.parse(task.config) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [task?.config]);
  const isHeadedTask = useMemo(() => config?.headless === false, [config]);
  const lastErrorHeadedIssue = useMemo(
    () => classifyHeadedIssue(task?.lastError ?? undefined),
    [task?.lastError],
  );
  const pipelineJobId = useMemo(() => {
    if (!config) {
      return null;
    }
    const value = config.pipelineJobId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }, [config]);

  const scheduleOpsRefresh = useCallback(
    (options?: { task?: boolean }) => {
      if (!canView) {
        return;
      }
      pendingOpsRefreshRef.current.task =
        pendingOpsRefreshRef.current.task || options?.task !== false;
      if (opsRefreshTimerRef.current) {
        return;
      }
      opsRefreshTimerRef.current = window.setTimeout(() => {
        opsRefreshTimerRef.current = null;
        const pending = pendingOpsRefreshRef.current;
        pendingOpsRefreshRef.current = { task: false };
        if (pending.task) {
          void refetch();
        }
      }, 700);
    },
    [canView, refetch],
  );

  useEffect(() => {
    if (!canView || !session?.accessToken) {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
      return;
    }

    opsSocketBootstrappingRef.current = true;
    setOpsLiveStatus("connecting");
    let hasConnectedOnce = false;
    const socket = io(`${env.apiRoot}/ops`, {
      auth: { token: session.accessToken },
      transports: ["websocket"],
    });
    opsSocketRef.current = socket;

    const handleConnect = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("connected");
      if (hasConnectedOnce) {
        scheduleOpsRefresh({ task: true });
        return;
      }
      hasConnectedOnce = true;
    };
    const handleDisconnect = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
    };
    const handleConnectError = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
    };
    const handleEvent = (payload: unknown) => {
      const refreshDecision = getCrawlTaskDetailOpsRefreshDecision(payload, {
        taskId,
        pipelineJobId,
      });
      if (!refreshDecision) {
        return;
      }
      scheduleOpsRefresh(refreshDecision);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("ops:event", handleEvent);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("ops:event", handleEvent);
      socket.disconnect();
      if (opsSocketRef.current === socket) {
        opsSocketRef.current = null;
      }
      opsSocketBootstrappingRef.current = false;
    };
  }, [
    canView,
    pipelineJobId,
    scheduleOpsRefresh,
    session?.accessToken,
    taskId,
  ]);

  useEffect(() => {
    return () => {
      if (opsRefreshTimerRef.current) {
        window.clearTimeout(opsRefreshTimerRef.current);
        opsRefreshTimerRef.current = null;
      }
      pendingOpsRefreshRef.current = { task: false };
    };
  }, []);

  const virtualScrollSummary = useMemo(() => {
    if (
      !config ||
      typeof config.virtualScroll !== "object" ||
      !config.virtualScroll
    ) {
      return null;
    }
    const value = config.virtualScroll as Record<string, unknown>;
    const containerSelector =
      typeof value.containerSelector === "string" &&
      value.containerSelector.trim().length > 0
        ? value.containerSelector.trim()
        : "body";
    const scrollCount =
      typeof value.scrollCount === "number" &&
      Number.isFinite(value.scrollCount)
        ? value.scrollCount
        : null;
    const waitAfterScrollMs =
      typeof value.waitAfterScrollMs === "number" &&
      Number.isFinite(value.waitAfterScrollMs)
        ? value.waitAfterScrollMs
        : null;
    const scrollByRaw = value.scrollBy;
    const scrollBy =
      typeof scrollByRaw === "number"
        ? scrollByRaw
        : typeof scrollByRaw === "string"
          ? scrollByRaw === "viewport"
            ? "page_height"
            : scrollByRaw
          : null;
    return {
      containerSelector,
      scrollCount,
      waitAfterScrollMs,
      scrollBy,
    };
  }, [config]);

  const qualityProfileValue = useMemo(() => {
    if (!config || typeof config.qualityProfile !== "string") {
      return null;
    }
    const normalized = config.qualityProfile.trim().toLowerCase();
    if (
      normalized === "quality_first" ||
      normalized === "balanced" ||
      normalized === "speed_first"
    ) {
      return normalized;
    }
    return null;
  }, [config]);

  const qualityProfileSummary = useMemo(() => {
    if (!qualityProfileValue) {
      return null;
    }
    if (qualityProfileValue === "quality_first") {
      return t("crawl.settings.qualityProfileOptions.qualityFirst");
    }
    if (qualityProfileValue === "speed_first") {
      return t("crawl.settings.qualityProfileOptions.speedFirst");
    }
    return t("crawl.settings.qualityProfileOptions.balanced");
  }, [qualityProfileValue, t]);

  const pageTypeHintValue = useMemo(() => {
    if (!config || typeof config.pageTypeHint !== "string") {
      return null;
    }
    const normalized = config.pageTypeHint.trim().toLowerCase();
    if (
      normalized === "auto" ||
      normalized === "list" ||
      normalized === "detail"
    ) {
      return normalized;
    }
    return null;
  }, [config]);

  const pageTypeHintSummary = useMemo(() => {
    if (!pageTypeHintValue) {
      return null;
    }
    if (pageTypeHintValue === "list") {
      return t("crawl.settings.pageTypeHintOptions.list");
    }
    if (pageTypeHintValue === "detail") {
      return t("crawl.settings.pageTypeHintOptions.detail");
    }
    return t("crawl.settings.pageTypeHintOptions.auto");
  }, [pageTypeHintValue, t]);

  const autoExpandDetailsValue =
    typeof config?.autoExpandDetails === "boolean"
      ? config.autoExpandDetails
      : null;

  const detailExpansionSummary = useMemo(() => {
    if (
      !config ||
      typeof config.detailExpansion !== "object" ||
      !config.detailExpansion
    ) {
      return null;
    }
    const value = config.detailExpansion as Record<string, unknown>;
    const maxDetailUrls =
      typeof value.maxDetailUrls === "number" &&
      Number.isFinite(value.maxDetailUrls)
        ? value.maxDetailUrls
        : null;
    const minRelevanceScore =
      typeof value.minRelevanceScore === "number" &&
      Number.isFinite(value.minRelevanceScore)
        ? value.minRelevanceScore
        : null;
    const requireSameDomain =
      typeof value.requireSameDomain === "boolean"
        ? value.requireSameDomain
        : null;
    const allowExternalLinks =
      typeof value.allowExternalLinks === "boolean"
        ? value.allowExternalLinks
        : null;
    const minPublishTimeConfidence =
      typeof value.minPublishTimeConfidence === "number" &&
      Number.isFinite(value.minPublishTimeConfidence)
        ? value.minPublishTimeConfidence
        : null;
    const preferFitMarkdownForQuality =
      typeof value.preferFitMarkdownForQuality === "boolean"
        ? value.preferFitMarkdownForQuality
        : null;
    const includeUrlPatterns = Array.isArray(value.includeUrlPatterns)
      ? value.includeUrlPatterns
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const excludeUrlPatterns = Array.isArray(value.excludeUrlPatterns)
      ? value.excludeUrlPatterns
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    if (
      maxDetailUrls == null &&
      minRelevanceScore == null &&
      requireSameDomain == null &&
      allowExternalLinks == null &&
      minPublishTimeConfidence == null &&
      preferFitMarkdownForQuality == null &&
      includeUrlPatterns.length === 0 &&
      excludeUrlPatterns.length === 0
    ) {
      return null;
    }
    return {
      maxDetailUrls,
      minRelevanceScore,
      requireSameDomain,
      allowExternalLinks,
      minPublishTimeConfidence,
      preferFitMarkdownForQuality,
      includeUrlPatterns,
      excludeUrlPatterns,
    };
  }, [config]);

  const crawlStrategyTags = useMemo(() => {
    const tags: ReactNode[] = [];
    if (config?.scanFullPage) {
      tags.push(
        <Tag key="scanFullPage" color="blue">
          {t("crawl.settings.scanFullPage")}
        </Tag>,
      );
    }
    if (virtualScrollSummary) {
      tags.push(
        <Tag key="virtualScroll" color="cyan">
          {t("crawl.virtualScroll.title")}
        </Tag>,
      );
    }
    if (qualityProfileSummary) {
      tags.push(
        <Tag key="qualityProfile" color="purple">
          {qualityProfileSummary}
        </Tag>,
      );
    }
    if (pageTypeHintSummary) {
      tags.push(
        <Tag key="pageTypeHint" color="magenta">
          {pageTypeHintSummary}
        </Tag>,
      );
    }
    if (autoExpandDetailsValue) {
      tags.push(
        <Tag key="autoExpandDetails" color="green">
          {t("crawl.settings.autoExpandDetails")}
        </Tag>,
      );
    }
    return tags;
  }, [
    autoExpandDetailsValue,
    config?.scanFullPage,
    pageTypeHintSummary,
    qualityProfileSummary,
    t,
    virtualScrollSummary,
  ]);

  const taskLogColumns = useMemo(
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

  const expansionSummary = useMemo<ExpansionQualitySummary | null>(() => {
    for (const log of taskLogs) {
      if (log.stage !== "expansion") {
        continue;
      }
      if (
        !log.data ||
        typeof log.data !== "object" ||
        Array.isArray(log.data)
      ) {
        continue;
      }

      const data = log.data as Record<string, unknown>;
      const candidateCount =
        typeof data.candidateCount === "number" &&
        Number.isFinite(data.candidateCount)
          ? data.candidateCount
          : null;
      const batchCount =
        typeof data.batchCount === "number" && Number.isFinite(data.batchCount)
          ? data.batchCount
          : null;
      const improvedSuccesses =
        typeof data.improvedSuccesses === "number" &&
        Number.isFinite(data.improvedSuccesses)
          ? data.improvedSuccesses
          : null;

      if (
        candidateCount == null ||
        batchCount == null ||
        improvedSuccesses == null
      ) {
        continue;
      }

      const getOptionalNumber = (key: string) => {
        const value = data[key];
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : undefined;
      };

      return {
        candidateCount,
        batchCount,
        improvedSuccesses,
        primaryCandidatePool: getOptionalNumber("primaryCandidatePool"),
        fallbackCandidatePool: getOptionalNumber("fallbackCandidatePool"),
        minimumCandidateCount: getOptionalNumber("minimumCandidateCount"),
        strictCandidateCount: getOptionalNumber("strictCandidateCount"),
        relaxedCandidateCount: getOptionalNumber("relaxedCandidateCount"),
        linkFallbackCandidateCount: getOptionalNumber(
          "linkFallbackCandidateCount",
        ),
      };
    }

    return null;
  }, [taskLogs]);

  const expansionHeadSignalSummary = useMemo<ExpansionHeadSignalSummary | null>(
    () => parseExpansionHeadSignalSummary(taskLogs),
    [taskLogs],
  );

  const expansionHeadSignalSoftFailureDetails = useMemo(() => {
    if (
      !expansionHeadSignalSummary ||
      expansionHeadSignalSummary.softFailureCount <= 0
    ) {
      return "";
    }
    const parts: string[] = [];
    if (expansionHeadSignalSummary.softFailures.httpStatus > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.httpStatus", {
          defaultValue: "HTTP non-2xx: {{count}}",
          count: expansionHeadSignalSummary.softFailures.httpStatus,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.nonHtml > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.nonHtml", {
          defaultValue: "Non-HTML response: {{count}}",
          count: expansionHeadSignalSummary.softFailures.nonHtml,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.emptyHtml > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.emptyHtml", {
          defaultValue: "Empty HTML: {{count}}",
          count: expansionHeadSignalSummary.softFailures.emptyHtml,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.networkOrTimeout > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.networkOrTimeout", {
          defaultValue: "Timeout/Network: {{count}}",
          count: expansionHeadSignalSummary.softFailures.networkOrTimeout,
        }),
      );
    }
    if (expansionHeadSignalSummary.softFailures.noPublishSignal > 0) {
      parts.push(
        t("crawl.detail.expansion.softFailures.noPublishSignal", {
          defaultValue: "No publish signal extracted: {{count}}",
          count: expansionHeadSignalSummary.softFailures.noPublishSignal,
        }),
      );
    }
    return parts.join(" · ");
  }, [expansionHeadSignalSummary, t]);

  const expansionHeadSignalFallbackHint = useMemo(() => {
    return resolveHeadSignalFallbackHint(expansionHeadSignalSummary);
  }, [expansionHeadSignalSummary]);

  const proxySummary: ReactNode = useMemo(() => {
    if (!config) {
      return t("crawl.detail.proxy.direct");
    }
    const proxyUrl =
      typeof config.proxyUrl === "string" && config.proxyUrl.length > 0
        ? config.proxyUrl
        : null;
    const proxyConfig = config.proxyConfig as
      | { server?: string; username?: string; password?: string }
      | undefined;
    if (proxyConfig?.server) {
      return `Unsupported legacy proxy config: ${proxyConfig.server}`;
    }
    if (proxyUrl) {
      return `Unsupported legacy proxy config: ${proxyUrl}`;
    }
    return t("crawl.detail.proxy.direct");
  }, [config, t]);

  const markdownOptions = useMemo(() => {
    if (!config || typeof config.markdownOptions !== "object") {
      return null;
    }
    return config.markdownOptions as Record<string, unknown>;
  }, [config]);

  const markdownFilter = useMemo(() => {
    if (!config || typeof config.markdownFilter !== "object") {
      return null;
    }
    return config.markdownFilter as Record<string, unknown>;
  }, [config]);

  const markdownStrategy = useMemo(() => {
    if (
      !config ||
      typeof config.markdownStrategy !== "object" ||
      !config.markdownStrategy
    ) {
      return null;
    }
    return config.markdownStrategy as Record<string, unknown>;
  }, [config]);

  const cleanMarkdownOptions = useMemo(() => {
    if (
      !config ||
      typeof config.cleanMarkdown !== "object" ||
      !config.cleanMarkdown
    ) {
      return null;
    }
    return config.cleanMarkdown as Record<string, unknown>;
  }, [config]);

  const markdownSummary = useMemo(() => {
    if (!markdownOptions) {
      return t("crawl.detail.markdown.default");
    }
    const parts: string[] = [];
    if (typeof markdownOptions.contentSource === "string") {
      parts.push(
        t("crawl.detail.markdown.source", {
          source: markdownOptions.contentSource,
        }),
      );
    }
    if (typeof markdownOptions.ignoreLinks === "boolean") {
      parts.push(
        markdownOptions.ignoreLinks
          ? t("crawl.detail.markdown.ignoreLinks")
          : t("crawl.detail.markdown.keepLinks"),
      );
    }
    if (typeof markdownOptions.escapeHtml === "boolean") {
      parts.push(
        markdownOptions.escapeHtml
          ? t("crawl.detail.markdown.escapeHtml")
          : t("crawl.detail.markdown.renderHtml"),
      );
    }
    if (typeof markdownOptions.citations === "boolean") {
      parts.push(
        markdownOptions.citations
          ? t("crawl.detail.markdown.citationsEnabled")
          : t("crawl.detail.markdown.citationsDisabled"),
      );
    }
    if (typeof markdownOptions.bodyWidth === "number") {
      parts.push(
        t("crawl.detail.markdown.wrap", { width: markdownOptions.bodyWidth }),
      );
    }
    return parts.length
      ? parts.join(" • ")
      : t("crawl.detail.markdown.default");
  }, [markdownOptions, t]);

  const markdownFilterSummary = useMemo(() => {
    if (!markdownFilter || typeof markdownFilter.type !== "string") {
      return t("common.disabled");
    }
    const parts = [markdownFilter.type];
    if (markdownFilter.type === "bm25") {
      const queryValue =
        typeof markdownFilter.userQuery === "string"
          ? markdownFilter.userQuery
          : typeof markdownFilter.user_query === "string"
            ? (markdownFilter.user_query as string)
            : undefined;
      if (queryValue && queryValue.trim().length > 0) {
        parts.push(
          t("crawl.detail.markdownFilter.query", { query: queryValue }),
        );
      }
      const bm25ThresholdValue =
        typeof markdownFilter.bm25Threshold === "number"
          ? markdownFilter.bm25Threshold
          : typeof markdownFilter.bm25_threshold === "number"
            ? (markdownFilter.bm25_threshold as number)
            : undefined;
      if (typeof bm25ThresholdValue === "number") {
        parts.push(
          t("crawl.detail.markdownFilter.bm25Threshold", {
            value: bm25ThresholdValue,
          }),
        );
      }
      const languageValue =
        typeof markdownFilter.language === "string"
          ? markdownFilter.language
          : typeof markdownFilter.lang === "string"
            ? (markdownFilter.lang as string)
            : undefined;
      if (languageValue && languageValue.trim().length > 0) {
        parts.push(
          t("crawl.detail.markdownFilter.language", {
            language: languageValue,
          }),
        );
      }
      return parts.join(" • ");
    }
    if (typeof markdownFilter.threshold === "number") {
      parts.push(
        t("crawl.detail.markdownFilter.threshold", {
          value: markdownFilter.threshold,
        }),
      );
    }
    const thresholdTypeValue =
      typeof markdownFilter.thresholdType === "string"
        ? markdownFilter.thresholdType
        : typeof markdownFilter.threshold_type === "string"
          ? (markdownFilter.threshold_type as string)
          : undefined;
    if (thresholdTypeValue) {
      parts.push(
        t("crawl.detail.markdownFilter.mode", { mode: thresholdTypeValue }),
      );
    }
    const minWordValue =
      typeof markdownFilter.minWordThreshold === "number"
        ? markdownFilter.minWordThreshold
        : typeof markdownFilter.min_word_threshold === "number"
          ? (markdownFilter.min_word_threshold as number)
          : undefined;
    if (typeof minWordValue === "number") {
      parts.push(
        t("crawl.detail.markdownFilter.minWords", { count: minWordValue }),
      );
    }
    return parts.join(" • ");
  }, [markdownFilter, t]);

  const markdownStrategySummary = useMemo(() => {
    if (!markdownStrategy || typeof markdownStrategy.type !== "string") {
      return t("crawl.detail.markdownStrategy.default");
    }
    const type = markdownStrategy.type;
    const params =
      markdownStrategy.params && typeof markdownStrategy.params === "object"
        ? (markdownStrategy.params as Record<string, unknown>)
        : undefined;
    if (!params) {
      return type;
    }
    const json = JSON.stringify(params);
    const snippet = json.length > 80 ? `${json.slice(0, 80)}...` : json;
    return t("crawl.detail.markdownStrategy.withParams", { type, snippet });
  }, [markdownStrategy, t]);

  const cleanMarkdownSummary = useMemo(() => {
    if (!cleanMarkdownOptions) {
      return t("common.disabled");
    }
    const parts: string[] = [];
    if (
      typeof cleanMarkdownOptions.cssSelector === "string" &&
      cleanMarkdownOptions.cssSelector.trim().length
    ) {
      parts.push(
        t("crawl.detail.cleanMarkdown.scope", {
          selector: cleanMarkdownOptions.cssSelector,
        }),
      );
    }
    if (
      Array.isArray(cleanMarkdownOptions.targetElements) &&
      cleanMarkdownOptions.targetElements.length
    ) {
      parts.push(
        t("crawl.detail.cleanMarkdown.targets", {
          targets: cleanMarkdownOptions.targetElements.join(", "),
        }),
      );
    }
    if (
      Array.isArray(cleanMarkdownOptions.excludedTags) &&
      cleanMarkdownOptions.excludedTags.length
    ) {
      parts.push(
        t("crawl.detail.cleanMarkdown.excluded", {
          tags: cleanMarkdownOptions.excludedTags.join(", "),
        }),
      );
    }
    if (typeof cleanMarkdownOptions.wordCountThreshold === "number") {
      parts.push(
        t("crawl.detail.cleanMarkdown.minWords", {
          count: cleanMarkdownOptions.wordCountThreshold,
        }),
      );
    }
    if (typeof cleanMarkdownOptions.removeOverlayElements === "boolean") {
      parts.push(
        cleanMarkdownOptions.removeOverlayElements
          ? t("crawl.detail.cleanMarkdown.removeOverlays")
          : t("crawl.detail.cleanMarkdown.keepOverlays"),
      );
    }
    return parts.length ? parts.join(" • ") : t("common.enabled");
  }, [cleanMarkdownOptions, t]);

  const browserHeaders = useMemo(() => {
    if (!Array.isArray(config?.browserHeaders)) {
      return [] as string[];
    }
    return (config?.browserHeaders as { name?: string; value?: string }[])
      .map((header) => {
        const name = typeof header?.name === "string" ? header.name : "";
        const value = typeof header?.value === "string" ? header.value : "";
        if (!name || !value) {
          return null;
        }
        return `${name}: ${value}`;
      })
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  const browserCookies = useMemo(() => {
    if (!Array.isArray(config?.browserCookies)) {
      return [] as string[];
    }
    return (
      config?.browserCookies as {
        name?: string;
        value?: string;
        domain?: string;
        path?: string;
      }[]
    )
      .map((cookie) => {
        const name = typeof cookie?.name === "string" ? cookie.name : "";
        const value = typeof cookie?.value === "string" ? cookie.value : "";
        const domain = typeof cookie?.domain === "string" ? cookie.domain : "";
        const path = typeof cookie?.path === "string" ? cookie.path : "";
        if (!name || !value || !domain) {
          return null;
        }
        const target = path ? `${domain}${path}` : domain;
        return `${name}=${value} @ ${target}`;
      })
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  const managedBrowserProfile = useMemo(() => {
    if (!config || typeof config.userDataDir !== "string") {
      return null;
    }
    const trimmed = config.userDataDir.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const userAgentValue = useMemo(() => {
    if (!config || typeof config.userAgent !== "string") {
      return null;
    }
    const trimmed = config.userAgent.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const userAgentModeSummary =
    config?.userAgentMode === "random"
      ? t("crawl.detail.userAgent.random")
      : t("crawl.detail.userAgent.default");

  const userAgentGeneratorSummary = useMemo(() => {
    if (
      !config ||
      typeof config.userAgentGenerator !== "object" ||
      !config.userAgentGenerator
    ) {
      return null;
    }
    const generator = config.userAgentGenerator as Record<string, unknown>;
    const parts: string[] = [];
    const platform =
      typeof generator.platform === "string" ? generator.platform : null;
    if (platform) {
      parts.push(
        t("crawl.detail.userAgentGenerator.platform", { value: platform }),
      );
    }
    const browser =
      typeof generator.browser === "string" ? generator.browser : null;
    if (browser) {
      parts.push(
        t("crawl.detail.userAgentGenerator.browser", { value: browser }),
      );
    }
    const deviceType =
      typeof generator.deviceType === "string" ? generator.deviceType : null;
    if (deviceType) {
      parts.push(
        t("crawl.detail.userAgentGenerator.device", { value: deviceType }),
      );
    }
    const locale =
      typeof generator.locale === "string" ? generator.locale : null;
    if (locale) {
      parts.push(
        t("crawl.detail.userAgentGenerator.locale", { value: locale }),
      );
    }
    return parts.length ? parts.join(" • ") : null;
  }, [config, t]);

  const browserLocale = useMemo(() => {
    if (!config || typeof config.locale !== "string") {
      return null;
    }
    const trimmed = config.locale.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const timezonePreference = useMemo(() => {
    if (!config || typeof config.timezoneId !== "string") {
      return null;
    }
    const trimmed = config.timezoneId.trim();
    return trimmed.length ? trimmed : null;
  }, [config]);

  const geolocationSummary = useMemo(() => {
    if (
      !config ||
      typeof config.geolocation !== "object" ||
      !config.geolocation
    ) {
      return null;
    }
    const geo = config.geolocation as Record<string, unknown>;
    const lat = typeof geo.latitude === "number" ? geo.latitude : null;
    const lon = typeof geo.longitude === "number" ? geo.longitude : null;
    if (lat == null || lon == null) {
      return null;
    }
    const accuracy = typeof geo.accuracy === "number" ? geo.accuracy : null;
    const location = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return accuracy != null
      ? `${location} (±${Math.round(accuracy)}m)`
      : location;
  }, [config]);

  const dynamicJsSteps = useMemo(() => {
    if (!config) {
      return [] as string[];
    }
    if (Array.isArray(config.jsCode)) {
      return (config.jsCode as string[]).filter(
        (entry) => typeof entry === "string",
      );
    }
    if (typeof config.jsCode === "string") {
      const trimmed = config.jsCode.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }, [config]);

  const waitCondition = useMemo(() => {
    if (!config) {
      return null;
    }
    if (
      typeof config.waitForScript === "string" &&
      config.waitForScript.trim().length
    ) {
      return `js:${config.waitForScript.trim()}`;
    }
    if (
      typeof config.waitForSelector === "string" &&
      config.waitForSelector.trim().length
    ) {
      return config.waitForSelector.trim();
    }
    return null;
  }, [config]);

  const waitUntilValue = useMemo(() => {
    if (!config || typeof config.waitUntil !== "string") {
      return null;
    }
    const normalized = config.waitUntil.trim().toLowerCase();
    if (
      normalized === "domcontentloaded" ||
      normalized === "load" ||
      normalized === "networkidle" ||
      normalized === "commit"
    ) {
      return normalized;
    }
    return null;
  }, [config]);
  const waitUntilSummary = useMemo(() => {
    if (!waitUntilValue) {
      return null;
    }
    if (waitUntilValue === "domcontentloaded") {
      return t("crawl.dynamic.waitUntilOptions.domcontentloaded", {
        defaultValue: "DOMContentLoaded",
      });
    }
    if (waitUntilValue === "networkidle") {
      return t("crawl.dynamic.waitUntilOptions.networkidle", {
        defaultValue: "Network idle",
      });
    }
    if (waitUntilValue === "commit") {
      return t("crawl.dynamic.waitUntilOptions.commit", {
        defaultValue: "Commit",
      });
    }
    return t("crawl.dynamic.waitUntilOptions.load", { defaultValue: "Load" });
  }, [t, waitUntilValue]);

  const waitTimeoutMs =
    typeof config?.waitForTimeoutMs === "number"
      ? config.waitForTimeoutMs
      : null;
  const pageTimeoutMs =
    typeof config?.pageTimeoutMs === "number" ? config.pageTimeoutMs : null;
  const delayBeforeReturnHtmlMs =
    typeof config?.delayBeforeReturnHtmlMs === "number"
      ? config.delayBeforeReturnHtmlMs
      : null;
  const meanDelayMs =
    typeof config?.meanDelayMs === "number" ? config.meanDelayMs : null;
  const maxDelayRangeMs =
    typeof config?.maxDelayRangeMs === "number" ? config.maxDelayRangeMs : null;
  const semaphoreCount =
    typeof config?.semaphoreCount === "number" ? config.semaphoreCount : null;
  const removeFormsEnabled =
    typeof config?.removeForms === "boolean" ? config.removeForms : null;
  const sessionIdentifier = useMemo(() => {
    if (!config) {
      return null;
    }
    const raw =
      typeof config.sessionId === "string" ? config.sessionId.trim() : "";
    return raw.length ? raw : null;
  }, [config]);
  const storageStatePreview = useMemo(() => {
    if (!config) {
      return null;
    }
    const raw =
      typeof config.storageState === "string" ? config.storageState.trim() : "";
    return raw.length ? shortenScript(raw) : null;
  }, [config]);
  const jsOnlyMode = Boolean(config?.jsOnly);

  const linkOverview = useMemo(() => {
    const analyses =
      task?.results
        ?.map((result) => result.linkAnalysis)
        .filter((analysis): analysis is NonNullable<typeof analysis> =>
          Boolean(analysis),
        ) ?? [];
    if (!analyses.length) {
      return null;
    }
    const totalLinks = analyses.reduce(
      (sum, analysis) => sum + analysis.stats.totalLinks,
      0,
    );
    const internalLinks = analyses.reduce(
      (sum, analysis) => sum + analysis.stats.internalLinks,
      0,
    );
    const externalLinks = analyses.reduce(
      (sum, analysis) => sum + analysis.stats.externalLinks,
      0,
    );
    const highQualityLinks = analyses.reduce(
      (sum, analysis) => sum + (analysis.stats.highQualityLinks ?? 0),
      0,
    );
    const lowQualityLinks = analyses.reduce(
      (sum, analysis) => sum + (analysis.stats.lowQualityLinks ?? 0),
      0,
    );
    const weightedIntrinsic = analyses.reduce((sum, analysis) => {
      const avg = analysis.stats.averageIntrinsicScore ?? 0;
      return sum + avg * analysis.stats.totalLinks;
    }, 0);
    const averageIntrinsic =
      totalLinks > 0
        ? Number((weightedIntrinsic / totalLinks).toFixed(2))
        : null;
    const aggregateLinks = <T,>(items: T[]) => {
      const seen = new Set<string>();
      const ordered: T[] = [];
      for (const item of items) {
        const link = item as { href?: string };
        const key = link.href ?? JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(item);
        }
      }
      return ordered;
    };
    const scoreOf = (link: {
      totalScore?: number | null;
      contextualScore?: number | null;
      intrinsicScore?: number | null;
    }) => link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;
    const topLinks = aggregateLinks(
      analyses.flatMap((analysis) => analysis.topLinks ?? []),
    )
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .slice(0, 5);
    const lowLinks = aggregateLinks(
      analyses.flatMap((analysis) => analysis.lowQualityLinks ?? []),
    )
      .sort(
        (a, b) =>
          (a.intrinsicScore ?? Number.POSITIVE_INFINITY) -
          (b.intrinsicScore ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, 5);
    const bucketMap = new Map<
      string,
      {
        count: number;
        links: NonNullable<(typeof analyses)[number]["topLinks"]>;
      }
    >();
    analyses.forEach((analysis) => {
      analysis.buckets.forEach((bucket) => {
        const existing = bucketMap.get(bucket.kind);
        if (existing) {
          existing.count += bucket.links.length;
          existing.links.push(...bucket.links);
        } else {
          bucketMap.set(bucket.kind, {
            count: bucket.links.length,
            links: [...bucket.links],
          });
        }
      });
    });
    const buckets = Array.from(bucketMap.entries()).map(([kind, value]) => ({
      kind,
      count: value.count,
      samples: value.links.slice(0, 4),
    }));
    return {
      stats: {
        totalLinks,
        internalLinks,
        externalLinks,
        highQualityLinks,
        lowQualityLinks,
        averageIntrinsic,
      },
      topLinks,
      lowLinks,
      buckets,
    };
  }, [task?.results]);

  const getLinkScore = (link: {
    totalScore?: number | null;
    contextualScore?: number | null;
    intrinsicScore?: number | null;
  }) => link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;

  const additionalUrls = useMemo(() => {
    if (!config || !Array.isArray(config.additionalUrls)) {
      return [];
    }
    return config.additionalUrls
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }, [config]);

  interface MultiUrlConfigView {
    name?: string;
    matcher?: {
      matchMode?: string;
      patterns?: string[];
    };
    urls?: string[];
    options?: Record<string, unknown>;
  }

  const multiConfigs: MultiUrlConfigView[] = useMemo(() => {
    if (!config || !Array.isArray(config.multiUrlConfigs)) {
      return [];
    }
    return config.multiUrlConfigs.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  }, [config]);

  const formatMultiUrlOverrides = useCallback(
    (options?: Record<string, unknown>) => {
      if (!options) {
        return null;
      }
      const entries = Object.entries(options).filter(
        ([, value]) => value !== undefined && value !== null,
      );
      if (!entries.length) {
        return null;
      }
      const preferredKeys = [
        "cacheMode",
        "waitUntil",
        "waitForTimeoutMs",
        "pageTimeoutMs",
        "delayBeforeReturnHtmlMs",
        "meanDelayMs",
        "maxDelayRangeMs",
        "semaphoreCount",
        "removeForms",
        "scanFullPage",
        "simulateUser",
        "overrideNavigator",
      ];
      const formatValue = (value: unknown) => {
        if (typeof value === "string") {
          return value.length > 80 ? shortenScript(value) : value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        if (Array.isArray(value)) {
          if (value.length <= 3) {
            return value.map((entry) => String(entry)).join(", ");
          }
          return `${value
            .slice(0, 3)
            .map((entry) => String(entry))
            .join(", ")}…`;
        }
        if (value && typeof value === "object") {
          const serialized = JSON.stringify(value);
          return serialized.length > 120
            ? `${serialized.slice(0, 117)}…`
            : serialized;
        }
        return String(value);
      };
      const prioritized = preferredKeys
        .filter((key) => key in options)
        .map((key) => `${key}=${formatValue(options[key])}`);
      const preferredKeySet = new Set(preferredKeys);
      const remainingCount = entries.filter(
        ([key]) => !preferredKeySet.has(key),
      ).length;
      if (remainingCount > 0) {
        prioritized.push(
          t("crawl.detail.multiUrl.additionalOverrides", {
            defaultValue: "+{{count}} other overrides",
            count: remainingCount,
          }),
        );
      }
      return prioritized.join(" • ");
    },
    [t],
  );

  const handleRetry = async () => {
    if (!task) return;
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
        t("crawl.settings.ingestToItemsNoPermission", {
          defaultValue: "Requires items.write permission.",
        }),
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
      message.success(t("common.updated", { defaultValue: "Updated." }));
      await refetch();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed", { defaultValue: "Operation failed." }),
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
        message: t("crawl.detail.backfill.emptyTitle", {
          defaultValue: "No results to backfill yet.",
        }),
        description: t("crawl.detail.backfill.emptyDescription", {
          defaultValue:
            "This task has no crawl results yet, so nothing can be sent to Items.",
        }),
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
      content: t("crawl.detail.backfill.running", {
        defaultValue: "Backfilling results...",
      }),
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
            t("crawl.detail.backfill.timeout", {
              defaultValue:
                "Backfill request timed out. Please try again after refreshing the task.",
            }),
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
            defaultValue:
              "Backfilling... ({{ingested}} ingested, {{skipped}} skipped, {{failed}} failed)",
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
        defaultValue:
          "{{ingested}} ingested, {{skipped}} skipped, {{failed}} failed across {{scanned}} scanned results.",
        ingested: ingestedTotal,
        skipped: skippedTotal,
        failed: failedTotal,
        scanned: scannedTotal,
      });
      let notice: BackfillNotice;
      if (scannedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.emptyTitle", {
            defaultValue: "No results to backfill yet.",
          }),
          description: t("crawl.detail.backfill.emptyDescription", {
            defaultValue:
              "This task has no crawl results yet, so nothing can be sent to Items.",
          }),
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (ingestedTotal === 0 && failedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.noMissingTitle", {
            defaultValue: "All crawl results are already in Items.",
          }),
          description: summaryDescription,
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (failedTotal > 0) {
        notice = {
          type: ingestedTotal > 0 ? "warning" : "error",
          message: t("crawl.detail.backfill.partialTitle", {
            defaultValue: "Backfill finished with failures.",
          }),
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
          message: t("crawl.detail.backfill.done", {
            defaultValue: "Queued missing results for Items.",
          }),
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
          : t("common.operationFailed", {
              defaultValue: "Operation failed.",
            });
      setBackfillNotice({
        type: "error",
        message: t("crawl.detail.backfill.failedTitle", {
          defaultValue: "Backfill failed.",
        }),
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
      title: t("crawl.detail.backfill.confirmTitle", {
        defaultValue: "Send missing results to Items?",
      }),
      content: t("crawl.detail.backfill.confirmDescription", {
        defaultValue:
          "This will convert crawl results into Items and enqueue LLM processing for results that are not in Items yet.",
      }),
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
        t("common.invalidInput", { defaultValue: "Invalid input." }),
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
        t("crawl.detail.ingestQueued", {
          defaultValue: "Queued for LLM processing and added to Items.",
        }),
      );
      if (createdId) {
        router.push(`/items/${createdId}`);
      }
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed", { defaultValue: "Operation failed." }),
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
          {t("common.loading", { defaultValue: "Loading..." })}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("crawl.detail.title", { defaultValue: "Crawl Task" })}
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
  const includeImagesEnabled = Boolean(config?.includeImages);
  const storeMediaEnabled = Boolean(config?.storeMedia);
  const ingestToItemsEnabled = Boolean(config?.ingestToItems);
  const adjustViewportEnabled = Boolean(config?.adjustViewportToContent);
  const managedBrowserEnabled = Boolean(config?.useManagedBrowser);
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
        {canManage ? (
          <Button onClick={handleRetry} loading={retrying}>
            {t("crawl.detail.retry")}
          </Button>
        ) : null}
        {canCreateItem ? (
          <Button
            onClick={handleBackfillToItems}
            loading={backfillRunning}
            disabled={backfillUnavailable}
          >
            {t("crawl.detail.backfill.button", {
              defaultValue: "Backfill to Items",
            })}
          </Button>
        ) : null}
        {canCreateItem && backfillUnavailable ? (
          <Typography.Text type="secondary">
            {t("crawl.detail.backfill.emptyHint", {
              defaultValue: "No crawl results available yet.",
            })}
          </Typography.Text>
        ) : null}
        <Typography.Link href={task.targetUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.openSource")}
        </Typography.Link>
      </Space>
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
          message={t("crawl.detail.latestError", {
            defaultValue: "Latest error",
          })}
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
          message={t("crawl.runtimeGuide.title", {
            defaultValue: "Headed mode and Xvfb",
          })}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.noAutoBootstrap", {
                  defaultValue:
                    "This console only provides guidance and does not auto-start Xvfb for you.",
                })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.principleBody", {
                  defaultValue:
                    "When headless=false, Chromium needs a display server. Xvfb provides a virtual X11 display (for example :99) so headed rendering can run in containers without a physical monitor.",
                })}
              </Typography.Text>
              <details>
                <summary>
                  {t("crawl.runtimeGuide.stepsTitle", {
                    defaultValue: "Recommended checks",
                  })}
                </summary>
                <Space direction="vertical" size={2} style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary">
                    {`1. ${t("crawl.runtimeGuide.step1", {
                      defaultValue:
                        "Prefer Headless for routine crawls, and use Headed only when anti-bot scenarios need it.",
                    })}`}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {`2. ${t("crawl.runtimeGuide.step2", {
                      defaultValue:
                        "When using Headed, ensure Xvfb/DISPLAY are configured in the crawl4ai container.",
                    })}`}
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
          message={t("crawl.runtimeGuide.displayIssueTitle", {
            defaultValue: "Detected DISPLAY/Xvfb dependency issue",
          })}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {task.lastError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.displayIssueHint", {
                  defaultValue:
                    "Headed runtime failed because DISPLAY/Xvfb is unavailable. Enable Xvfb in crawl4ai or switch this task to Headless.",
                })}
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
          message={t("crawl.runtimeGuide.timeoutIssueTitle", {
            defaultValue: "Headed runtime timed out",
          })}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {task.lastError}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.timeoutIssueHint", {
                  defaultValue:
                    "Display may be ready, but browser startup/navigation timed out. Check crawl4ai load and task timeout settings.",
                })}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      {crawlStrategyTags.length ? (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={t("crawl.detail.strategy.title", {
            defaultValue: "Crawl strategy",
          })}
        >
          <Space wrap size={[4, 6]}>
            {crawlStrategyTags}
          </Space>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 0, marginTop: 8 }}
          >
            {t("crawl.detail.strategy.noLlmHint", {
              defaultValue:
                "Crawl stage is deterministic (fetch + clean markdown only). Run LLM summarization and analysis in downstream pipelines.",
            })}
          </Typography.Paragraph>
        </Card>
      ) : null}
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label={t("crawl.detail.fields.displayName")}>
          {task.displayName ?? task.targetUrl}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.keywords")}>
          {task.keywords.length ? (
            <Space wrap>
              {task.keywords.map((keyword) => (
                <Tag key={keyword}>{keyword}</Tag>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.concurrency")}>
          {task.concurrency}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.includeImages")}>
          {includeImagesEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.storeMedia")}>
          {storeMediaEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.ingestToItems", {
            defaultValue: "Auto send to Items",
          })}
        >
          {canManage ? (
            <Space direction="vertical" size={4}>
              <Switch
                checked={ingestToItemsEnabled}
                loading={updatingIngest}
                onChange={(checked) => void handleToggleIngestToItems(checked)}
              />
              <Typography.Text type="secondary">
                {permissions.includes("items.write")
                  ? t("crawl.settings.ingestToItemsHint", {
                      defaultValue:
                        "New crawl results will be converted into Items and queued for LLM processing.",
                    })
                  : t("crawl.settings.ingestToItemsNoPermission", {
                      defaultValue: "Requires items.write permission.",
                    })}
              </Typography.Text>
            </Space>
          ) : ingestToItemsEnabled ? (
            t("common.enabled")
          ) : (
            t("common.disabled")
          )}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.lastRunItems", {
            defaultValue: "Last run → Items",
          })}
        >
          {task.lastRunSummary
            ? t("crawl.detail.lastRunItemsValue", {
                defaultValue: "{{queued}} queued, {{failed}} failed",
                queued: task.lastRunSummary.itemsQueued ?? 0,
                failed: task.lastRunSummary.itemsQueueFailed ?? 0,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.lastRunResults", {
            defaultValue: "Last run results",
          })}
        >
          {task.lastRunSummary
            ? t("crawl.detail.lastRunResultsValue", {
                defaultValue: "{{inserted}} inserted, {{skipped}} skipped",
                inserted: task.lastRunSummary.inserted,
                skipped: task.lastRunSummary.skipped,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.runCount")}>
          {task.runCount}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.scanFullPage")}>
          {config?.scanFullPage
            ? t("crawl.detail.scanFullPageEnabled", {
                delay: config?.scrollDelayMs ?? 200,
              })
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.virtualScroll")}>
          {virtualScrollSummary ? (
            <Space direction="vertical" size={0}>
              <Typography.Text style={{ fontFamily: "monospace" }}>
                containerSelector={virtualScrollSummary.containerSelector}
              </Typography.Text>
              {virtualScrollSummary.scrollCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  scrollCount={virtualScrollSummary.scrollCount}
                </Typography.Text>
              ) : null}
              {virtualScrollSummary.scrollBy ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  scrollBy={virtualScrollSummary.scrollBy}
                </Typography.Text>
              ) : null}
              {virtualScrollSummary.waitAfterScrollMs != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  waitAfterScrollMs={virtualScrollSummary.waitAfterScrollMs}
                </Typography.Text>
              ) : null}
            </Space>
          ) : (
            t("common.disabled")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.qualityProfile")}>
          {qualityProfileSummary ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.pageTypeHint")}>
          {pageTypeHintSummary ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.autoExpandDetails")}>
          {typeof autoExpandDetailsValue === "boolean"
            ? autoExpandDetailsValue
              ? t("common.enabled")
              : t("common.disabled")
            : t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.detailExpansion")}>
          {detailExpansionSummary ? (
            <Space direction="vertical" size={0}>
              {detailExpansionSummary.maxDetailUrls != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  maxDetailUrls={detailExpansionSummary.maxDetailUrls}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.minRelevanceScore != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  minRelevanceScore={detailExpansionSummary.minRelevanceScore}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.requireSameDomain != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  requireSameDomain=
                  {detailExpansionSummary.requireSameDomain ? "true" : "false"}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.allowExternalLinks != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  allowExternalLinks=
                  {detailExpansionSummary.allowExternalLinks ? "true" : "false"}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.minPublishTimeConfidence != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  minPublishTimeConfidence=
                  {detailExpansionSummary.minPublishTimeConfidence}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.preferFitMarkdownForQuality != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  preferFitMarkdownForQuality=
                  {detailExpansionSummary.preferFitMarkdownForQuality
                    ? "true"
                    : "false"}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.excludeUrlPatterns.length > 0 ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  excludeUrlPatterns=
                  {detailExpansionSummary.excludeUrlPatterns.join(", ")}
                </Typography.Text>
              ) : null}
              {detailExpansionSummary.includeUrlPatterns.length > 0 ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  includeUrlPatterns=
                  {detailExpansionSummary.includeUrlPatterns.join(", ")}
                </Typography.Text>
              ) : null}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.expansionMetrics", {
            defaultValue: "Expansion metrics",
          })}
        >
          {expansionSummary || expansionHeadSignalSummary ? (
            <Space direction="vertical" size={0}>
              {expansionSummary ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  candidateCount={expansionSummary.candidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  batchCount={expansionSummary.batchCount}
                </Typography.Text>
              ) : null}
              {expansionSummary ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  improvedSuccesses={expansionSummary.improvedSuccesses}
                </Typography.Text>
              ) : null}
              {expansionSummary?.primaryCandidatePool != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  primaryCandidatePool={expansionSummary.primaryCandidatePool}
                </Typography.Text>
              ) : null}
              {expansionSummary?.fallbackCandidatePool != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  fallbackCandidatePool={expansionSummary.fallbackCandidatePool}
                </Typography.Text>
              ) : null}
              {expansionSummary?.minimumCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  minimumCandidateCount={expansionSummary.minimumCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary?.strictCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  strictCandidateCount={expansionSummary.strictCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary?.relaxedCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  relaxedCandidateCount={expansionSummary.relaxedCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionSummary?.linkFallbackCandidateCount != null ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>
                  linkFallbackCandidateCount=
                  {expansionSummary.linkFallbackCandidateCount}
                </Typography.Text>
              ) : null}
              {expansionHeadSignalSummary ? (
                <>
                  {expansionHeadSignalSummary.attempted != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalAttempted={expansionHeadSignalSummary.attempted}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.succeeded != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalSucceeded={expansionHeadSignalSummary.succeeded}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.failed != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalFailed={expansionHeadSignalSummary.failed}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.topK != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalTopK={expansionHeadSignalSummary.topK}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.configuredTimeoutMs != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      configuredTimeoutMs=
                      {expansionHeadSignalSummary.configuredTimeoutMs}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.configuredConcurrency != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      configuredConcurrency=
                      {expansionHeadSignalSummary.configuredConcurrency}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.configuredMaxReadBytes != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      configuredMaxReadBytes=
                      {expansionHeadSignalSummary.configuredMaxReadBytes}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.effectiveTimeoutMs != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      effectiveTimeoutMs=
                      {expansionHeadSignalSummary.effectiveTimeoutMs}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.effectiveConcurrency != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      effectiveConcurrency=
                      {expansionHeadSignalSummary.effectiveConcurrency}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.maxReadBytes != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      maxReadBytes={expansionHeadSignalSummary.maxReadBytes}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.truncatedResponses != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      truncatedResponses=
                      {expansionHeadSignalSummary.truncatedResponses}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.earlyStoppedResponses != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      earlyStoppedResponses=
                      {expansionHeadSignalSummary.earlyStoppedResponses}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.skipped != null ? (
                    <Typography.Text style={{ fontFamily: "monospace" }}>
                      headSignalSkipped=
                      {expansionHeadSignalSummary.skipped ? "true" : "false"}
                    </Typography.Text>
                  ) : null}
                  {expansionHeadSignalSummary.softFailureCount > 0 ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t("crawl.detail.expansion.softFailureMessage", {
                        defaultValue:
                          "{{count}} publish-signal enrichment fetches soft-failed (non-blocking)",
                        count: expansionHeadSignalSummary.softFailureCount,
                      })}
                      description={t(
                        "crawl.detail.expansion.softFailureDescription",
                        {
                          defaultValue:
                            "Soft failures only reduce publish-time confidence and do not fail the crawl task. {{details}}",
                          details: expansionHeadSignalSoftFailureDetails,
                        },
                      )}
                    />
                  ) : null}
                  {expansionHeadSignalFallbackHint ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t(
                        "crawl.detail.expansion.urlPathFallbackMessage",
                        {
                          defaultValue:
                            "{{count}}/{{total}} candidates fell back to url-path publish confidence",
                          count: expansionHeadSignalFallbackHint.fallbackCount,
                          total:
                            expansionHeadSignalFallbackHint.totalCandidates,
                        },
                      )}
                      description={t(
                        "crawl.detail.expansion.urlPathFallbackDescription",
                        {
                          defaultValue:
                            "URL-path fallback keeps crawl running (non-blocking), but can reduce publish-time confidence quality. Current fallback ratio: {{ratio}}%.",
                          ratio: Number(
                            (
                              expansionHeadSignalFallbackHint.fallbackRatio *
                              100
                            ).toFixed(1),
                          ),
                        },
                      )}
                    />
                  ) : null}
                </>
              ) : null}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.adjustViewport")}>
          {adjustViewportEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.headless", {
            defaultValue: "Headless mode",
          })}
        >
          {typeof config?.headless === "boolean"
            ? config.headless
              ? t("crawl.detail.headless.headless", {
                  defaultValue: "Headless",
                })
              : t("crawl.detail.headless.headed", {
                  defaultValue: "Headed (Xvfb)",
                })
            : t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.undetectedBrowser")}>
          {config?.enableUndetectedBrowser
            ? t("common.enabled")
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.stealthMode")}>
          {config?.enableStealthMode
            ? t("common.enabled")
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.antiBotMode", {
            defaultValue: "Anti-bot retry",
          })}
        >
          {config?.antiBotMode === "enabled"
            ? t("crawl.detail.antiBotMode.enabled", { defaultValue: "Enabled" })
            : config?.antiBotMode === "disabled"
              ? t("crawl.detail.antiBotMode.disabled", {
                  defaultValue: "Disabled",
                })
              : t("crawl.detail.antiBotMode.auto", { defaultValue: "Auto" })}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.managedBrowser")}>
          {managedBrowserEnabled ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.userDataDir")}>
          {managedBrowserProfile ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.simulateUser")}>
          {config?.simulateUser ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.overrideNavigator")}>
          {config?.overrideNavigator
            ? t("common.enabled")
            : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.userAgent")}>
          {userAgentValue ?? t("crawl.detail.userAgent.default")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.userAgentMode")}>
          {userAgentModeSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.uaGenerator")}>
          {userAgentGeneratorSummary ??
            t("crawl.detail.userAgent.notConfigured")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.browserLocale")}>
          {browserLocale ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.timezone")}>
          {timezonePreference ?? t("crawl.detail.serverDefault")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.geolocation")}>
          {geolocationSummary ?? t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.customHeaders")}>
          {browserHeaders.length ? (
            <Space direction="vertical" size={0}>
              {browserHeaders.map((header) => (
                <Typography.Text
                  key={header}
                  style={{ fontFamily: "monospace" }}
                >
                  {header}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.cookies")}>
          {browserCookies.length ? (
            <Space direction="vertical" size={0}>
              {browserCookies.map((cookie) => (
                <Typography.Text
                  key={cookie}
                  style={{ fontFamily: "monospace" }}
                >
                  {cookie}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.sessionId")}>
          {sessionIdentifier ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.storageState")}>
          {storageStatePreview ? (
            <Typography.Text code>{storageStatePreview}</Typography.Text>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.jsOnly")}>
          {jsOnlyMode ? t("common.enabled") : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.jsSteps")}>
          {dynamicJsSteps.length ? (
            <Space direction="vertical" size={0}>
              {dynamicJsSteps.map((snippet, index) => (
                <Typography.Text
                  key={`js-${index}`}
                  style={{ fontFamily: "monospace" }}
                >
                  {shortenScript(snippet)}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.waitCondition")}>
          {waitCondition
            ? shortenScript(waitCondition)
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.waitTimeout")}>
          {waitTimeoutMs
            ? t("crawl.detail.waitTimeoutValue", { value: waitTimeoutMs })
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.waitUntil", {
            defaultValue: "Navigation wait",
          })}
        >
          {waitUntilSummary ?? t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.pageTimeout", {
            defaultValue: "Page timeout",
          })}
        >
          {pageTimeoutMs != null
            ? `${Math.round(pageTimeoutMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.delayBeforeReturnHtml", {
            defaultValue: "Post-load delay",
          })}
        >
          {delayBeforeReturnHtmlMs != null
            ? `${Math.round(delayBeforeReturnHtmlMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.meanDelay", {
            defaultValue: "Mean delay",
          })}
        >
          {meanDelayMs != null
            ? `${Math.round(meanDelayMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.maxDelayRange", {
            defaultValue: "Delay jitter",
          })}
        >
          {maxDelayRangeMs != null
            ? `${Math.round(maxDelayRangeMs)} ms`
            : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.semaphoreCount", {
            defaultValue: "Internal semaphore",
          })}
        >
          {semaphoreCount != null ? semaphoreCount : t("crawl.detail.default")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.robotsPolicy", {
            defaultValue: "robots.txt policy",
          })}
        >
          {t("crawl.detail.robotsPolicy.ignore", {
            defaultValue: "Ignore (always)",
          })}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.removeForms", {
            defaultValue: "Remove forms",
          })}
        >
          {removeFormsEnabled == null
            ? t("crawl.detail.default")
            : removeFormsEnabled
              ? t("common.enabled")
              : t("common.disabled")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.proxyRoute")}>
          {proxySummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.additionalUrls")}>
          {additionalUrls.length ? (
            <Space wrap>
              {additionalUrls.map((url) => (
                <Typography.Link
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {url}
                </Typography.Link>
              ))}
            </Space>
          ) : (
            t("common.emptyValue")
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.markdownGenerator")}>
          {markdownSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.markdownStrategy")}>
          {markdownStrategySummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.markdownFilter")}>
          {markdownFilterSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.cleanMarkdown")}>
          {cleanMarkdownSummary}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastServerMemory")}>
          {task.lastServerMemoryMb != null
            ? t("crawl.detail.memoryValue", { value: task.lastServerMemoryMb })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastPeakMemory")}>
          {task.lastPeakMemoryMb != null
            ? t("crawl.detail.memoryValue", { value: task.lastPeakMemoryMb })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item
          label={t("crawl.detail.fields.lastMemoryEfficiency")}
        >
          {task.lastMemoryEfficiency != null
            ? t("crawl.detail.percentValue", {
                value: task.lastMemoryEfficiency,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.serverMemory")}>
          {task.memoryStats?.serverMemoryMb != null
            ? t("crawl.detail.memoryValue", {
                value: task.memoryStats.serverMemoryMb,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.peakMemory")}>
          {task.memoryStats?.peakMemoryMb != null
            ? t("crawl.detail.memoryValue", {
                value: task.memoryStats.peakMemoryMb,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.efficiency")}>
          {task.memoryStats?.efficiencyPercent != null
            ? t("crawl.detail.percentValue", {
                value: task.memoryStats.efficiencyPercent,
              })
            : t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastSuccess")}>
          {task.lastSuccessAt
            ? formatDateTime(task.lastSuccessAt, locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : t("common.never")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.lastError")}>
          {task.lastError ?? t("common.emptyValue")}
        </Descriptions.Item>
        <Descriptions.Item label={t("crawl.detail.fields.configuration")}>
          {config ? (
            <pre className="markdown-preview" style={markdownPreviewStyle}>
              {JSON.stringify(config, null, 2)}
            </pre>
          ) : (
            t("crawl.detail.default")
          )}
        </Descriptions.Item>
      </Descriptions>

      {canViewTaskLogs ? (
        <Card
          title={t("quality.taskLogs.title")}
          size="small"
          style={{ marginTop: 24 }}
          extra={
            <Button
              size="small"
              onClick={() => void loadTaskLogs()}
              loading={taskLogsLoading}
            >
              {t("common.refresh")}
            </Button>
          }
        >
          {taskLogsError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={t("common.error.unexpected")}
              description={
                <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                  {taskLogsError}
                </Typography.Text>
              }
            />
          ) : null}
          <Table
            size="small"
            rowKey={(record) => record.id}
            columns={taskLogColumns}
            dataSource={taskLogs}
            pagination={false}
            loading={taskLogsLoading}
            locale={{ emptyText: t("common.empty") }}
            expandable={{
              expandedRowKeys: expandedTaskLogKeys,
              onExpandedRowsChange: (expandedRows) =>
                setExpandedTaskLogKeys(expandedRows.map((key) => String(key))),
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
      ) : null}

      {multiConfigs.length ? (
        <Card title={t("crawl.multiUrl.title")} style={{ marginTop: 24 }}>
          <List
            dataSource={multiConfigs}
            renderItem={(item, index) => {
              const matcher = item?.matcher;
              const urls = Array.isArray(item?.urls) ? item.urls : [];
              const options = item?.options ?? {};
              const overridesSummary = formatMultiUrlOverrides(options);
              return (
                <List.Item key={item?.name ?? `strategy-${index}`}>
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {item?.name ??
                        t("crawl.multiUrl.strategyTitle", { index: index + 1 })}
                    </Typography.Text>
                    {matcher?.patterns?.length ? (
                      <Typography.Text type="secondary">
                        {t("crawl.detail.multiUrl.patterns", {
                          mode: matcher.matchMode ?? "glob",
                          patterns: matcher.patterns.join(", "),
                        })}
                      </Typography.Text>
                    ) : null}
                    {urls.length ? (
                      <Space wrap>
                        {urls.map((url) => (
                          <Typography.Link
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {url}
                          </Typography.Link>
                        ))}
                      </Space>
                    ) : null}
                    {Object.keys(options).length && overridesSummary ? (
                      <Typography.Text>
                        {t("crawl.detail.multiUrl.overrides", {
                          overrides: overridesSummary,
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      ) : null}

      {linkOverview ? (
        <Card title={t("crawl.links.title")} style={{ marginTop: 24 }}>
          <Space size="large" wrap>
            {[
              {
                label: t("crawl.links.stats.total"),
                value: linkOverview.stats.totalLinks,
              },
              {
                label: t("crawl.links.stats.internal"),
                value: linkOverview.stats.internalLinks,
              },
              {
                label: t("crawl.links.stats.external"),
                value: linkOverview.stats.externalLinks,
              },
              {
                label: t("crawl.links.stats.highQuality"),
                value: linkOverview.stats.highQualityLinks,
              },
              {
                label: t("crawl.links.stats.needsReview"),
                value: linkOverview.stats.lowQualityLinks,
              },
              {
                label: t("crawl.links.stats.avgIntrinsic"),
                value:
                  linkOverview.stats.averageIntrinsic !== null &&
                  linkOverview.stats.averageIntrinsic !== undefined
                    ? linkOverview.stats.averageIntrinsic.toFixed(2)
                    : t("common.emptyValue"),
              },
            ].map((item) => (
              <Space key={item.label} direction="vertical" size={0}>
                <Typography.Text type="secondary">{item.label}</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {item.value}
                </Typography.Title>
              </Space>
            ))}
          </Space>
          {linkOverview.buckets.length ? (
            <>
              <Typography.Text
                strong
                style={{ display: "block", marginTop: 16 }}
              >
                {t("crawl.links.buckets")}
              </Typography.Text>
              <Space wrap>
                {linkOverview.buckets.map((bucket) => (
                  <Tag key={bucket.kind}>
                    {t("crawl.links.bucketItem", {
                      kind: bucket.kind,
                      count: bucket.count,
                    })}
                  </Tag>
                ))}
              </Space>
            </>
          ) : null}
          <Space align="start" size="large" style={{ marginTop: 16 }} wrap>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>
                {t("crawl.links.topLinks")}
              </Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.topLinks}
                locale={{ emptyText: t("crawl.links.emptyScored") }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {t("crawl.links.linkScore", {
                          domain: (link.baseDomain ?? "link").toString(),
                          score: getLinkScore(link).toFixed(2),
                        })}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
            <div style={{ minWidth: 280 }}>
              <Typography.Text strong>
                {t("crawl.links.lowQuality")}
              </Typography.Text>
              <List
                size="small"
                dataSource={linkOverview.lowLinks}
                locale={{ emptyText: t("crawl.links.emptyLowQuality") }}
                renderItem={(link) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Typography.Link href={link.href} target="_blank">
                        {link.text || link.href}
                      </Typography.Link>
                      <Typography.Text type="secondary">
                        {t("crawl.links.intrinsicScore", {
                          domain: (link.baseDomain ?? "link").toString(),
                          score: (link.intrinsicScore ?? 0).toFixed(2),
                        })}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          </Space>
        </Card>
      ) : null}

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
                onChange={(event) => {
                  const value = event.target.value;
                  setResultSearchInput(value);
                  if (!value) {
                    setResultSearch(undefined);
                  }
                }}
                onPressEnter={() => {
                  const nextValue = resultSearchInput.trim();
                  setResultSearch(nextValue || undefined);
                  setResultSearchInput(nextValue);
                }}
              />
              <Button
                icon={<SearchOutlined />}
                aria-label={t("crawl.detail.results.searchPlaceholder")}
                onClick={() => {
                  const nextValue = resultSearchInput.trim();
                  setResultSearch(nextValue || undefined);
                  setResultSearchInput(nextValue);
                }}
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
                                {t("crawl.detail.openItem", {
                                  defaultValue: "Open Item",
                                })}
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
                            {t("crawl.detail.ingestToItems", {
                              defaultValue: "Send to Items",
                            })}
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
