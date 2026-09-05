import { ApolloLink, Observable, type FetchResult } from "@apollo/client";
import { MockedProvider } from "@apollo/client/testing";
import type { RenderResult } from "@testing-library/react";

import {
  CrawlTaskStatus,
  type CrawlTaskQuery,
} from "@/graphql/generated";
import {
  resetCrawlTaskDetailMockState,
  testSessionMock,
  testTaskLogs,
  type TestSessionMockState,
} from "@/test/component-mock-state";
import { renderWithProviders } from "@/test/render";
import { resetTestNavigation } from "@/test/url-navigation";

import { CrawlTaskDetail } from "./task-detail";

/**
 * Crawl Task Detail 行为测试共享支撑（FE-批5A 迁移前 characterization tests）。
 *
 * 本文件只被 *.test.tsx 引用，不属于生产代码；vitest coverage.include
 * 为显式清单，不会把它计入覆盖率。
 *
 * 边界设计（沿袭 alert-center-test-support 的既有模式）：
 * - Apollo 走 MockedProvider + 自定义 ApolloLink：query / mutation / refetch
 *   全部经过真实 Apollo 客户端执行（loading、变量、缓存语义为真），仅把
 *   网络出口替换为受控响应。skip 由「无请求到达 link」观察（客户端短路）；
 *   fetchPolicy 不进入 link context，靠静态审查保持。
 * - vi.mock 工厂（next-auth/react、next/navigation、socket.io-client、
 *   @/lib/api-client、antd 的 App.useApp / Modal.confirm）在测试文件里
 *   声明，工厂只动态 import 零依赖模块，避免模块加载死锁。
 */

export type CrawlTaskDetailResult = Extract<
  NonNullable<CrawlTaskQuery["crawlTask"]>["results"],
  readonly unknown[]
>[number];

export interface CrawlTaskDetailLinkInput {
  href: string;
  text?: string | null;
  title?: string | null;
  baseDomain?: string | null;
  type?: string | null;
  intrinsicScore?: number | null;
  contextualScore?: number | null;
  totalScore?: number | null;
}

export interface CrawlTaskDetailLinkAnalysisInput {
  stats: {
    totalLinks: number;
    internalLinks: number;
    externalLinks: number;
    averageIntrinsicScore?: number | null;
    highQualityLinks?: number | null;
    lowQualityLinks?: number | null;
  };
  topLinks?: CrawlTaskDetailLinkInput[];
  lowQualityLinks?: CrawlTaskDetailLinkInput[];
  buckets?: {
    kind: string;
    links: CrawlTaskDetailLinkInput[];
  }[];
}

export interface CrawlTaskDetailResultInput {
  id: string;
  itemId?: string | null;
  itemStatus?: string | null;
  sourceUrl?: string;
  fetchedAt?: string;
  markdown?: string;
  markdownWithCitations?: string | null;
  referencesMarkdown?: string | null;
  fitMarkdown?: string | null;
  metadata?: string | null;
  media?: string | null;
  mediaAssets?: string | null;
  tables?: unknown;
  linkAnalysis?: CrawlTaskDetailLinkAnalysisInput | null;
}

export interface CrawlTaskDetailTaskInput {
  id?: string;
  displayName?: string | null;
  targetUrl?: string;
  status?: CrawlTaskStatus;
  keywords?: string[];
  concurrency?: number;
  runCount?: number;
  lastResultAt?: string | null;
  lastError?: string | null;
  config?: string | null;
  lastRunSummary?: {
    inserted: number;
    skipped: number;
    itemsQueued?: number | null;
    itemsQueueFailed?: number | null;
  } | null;
  results?: CrawlTaskDetailResultInput[];
  memoryStats?: {
    serverMemoryMb?: number | null;
    peakMemoryMb?: number | null;
    efficiencyPercent?: number | null;
  } | null;
}

export type CrawlTaskDetailTask = NonNullable<CrawlTaskQuery["crawlTask"]>;

function buildLink(link: CrawlTaskDetailLinkInput) {
  return { __typename: "CrawlLinkModel", ...link };
}

export function buildCrawlTaskDetailTask(
  input: CrawlTaskDetailTaskInput = {},
): CrawlTaskDetailTask {
  const results = (input.results ?? []).map(
    (result): CrawlTaskDetailResult => ({
      __typename: "CrawlResultModel",
      id: result.id,
      itemId: result.itemId ?? null,
      itemStatus: result.itemStatus ?? null,
      sourceUrl: result.sourceUrl ?? `https://example.com/${result.id}`,
      fetchedAt: result.fetchedAt ?? "2026-01-15T08:30:00.000Z",
      markdown: result.markdown ?? `# Result ${result.id}`,
      markdownWithCitations: result.markdownWithCitations ?? null,
      referencesMarkdown: result.referencesMarkdown ?? null,
      fitMarkdown: result.fitMarkdown ?? null,
      metadata: result.metadata ?? null,
      media: result.media ?? null,
      mediaAssets: result.mediaAssets ?? null,
      tables: result.tables ?? null,
      linkAnalysis: result.linkAnalysis
        ? {
            __typename: "CrawlLinkAnalysisModel",
            stats: {
              __typename: "CrawlLinkStatsModel",
              ...result.linkAnalysis.stats,
              averageIntrinsicScore:
                result.linkAnalysis.stats.averageIntrinsicScore ?? null,
              highQualityLinks:
                result.linkAnalysis.stats.highQualityLinks ?? null,
              lowQualityLinks:
                result.linkAnalysis.stats.lowQualityLinks ?? null,
            },
            topLinks: (result.linkAnalysis.topLinks ?? []).map(buildLink),
            lowQualityLinks: (result.linkAnalysis.lowQualityLinks ?? []).map(
              buildLink,
            ),
            buckets: (result.linkAnalysis.buckets ?? []).map((bucket) => ({
              __typename: "CrawlLinkBucketModel",
              kind: bucket.kind,
              links: bucket.links.map(buildLink),
            })),
          }
        : null,
    }),
  );
  return {
    __typename: "CrawlTaskModel",
    id: input.id ?? "task-1",
    displayName: input.displayName ?? null,
    targetUrl: input.targetUrl ?? "https://example.com",
    status: input.status ?? CrawlTaskStatus.Completed,
    keywords: input.keywords ?? [],
    concurrency: input.concurrency ?? 1,
    runCount: input.runCount ?? 0,
    lastRunAt: null,
    lastSuccessAt: null,
    lastResultAt: input.lastResultAt ?? null,
    lastError: input.lastError ?? null,
    config: input.config ?? null,
    lastServerMemoryMb: null,
    lastPeakMemoryMb: null,
    lastMemoryEfficiency: null,
    lastRunSummary: input.lastRunSummary
      ? {
          __typename: "CrawlExecutionSummaryModel",
          inserted: input.lastRunSummary.inserted,
          skipped: input.lastRunSummary.skipped,
          itemsQueued: input.lastRunSummary.itemsQueued ?? null,
          itemsQueueFailed: input.lastRunSummary.itemsQueueFailed ?? null,
          lastFetchedAt: null,
          runId: null,
          retryableFailures: null,
        }
      : null,
    results,
    memoryStats: input.memoryStats
      ? {
          __typename: "CrawlMemoryStatsModel",
          serverMemoryMb: input.memoryStats.serverMemoryMb ?? null,
          peakMemoryMb: input.memoryStats.peakMemoryMb ?? null,
          efficiencyPercent: input.memoryStats.efficiencyPercent ?? null,
        }
      : null,
  };
}

/** Task logs REST fixture（admin/quality/task-logs 返回行）。 */
export interface CrawlTaskLogInput {
  id: string;
  stage?: string;
  status?: "pending" | "processing" | "completed" | "failed";
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt?: string | null;
}

export function buildTaskLog(input: CrawlTaskLogInput) {
  return {
    id: input.id,
    queue: "crawl4ai",
    jobId: "task-1",
    orgId: "org-1",
    stage: input.stage ?? "fetch",
    status: input.status ?? "completed",
    message: input.message ?? null,
    data: input.data ?? null,
    error: input.error ?? null,
    createdAt: input.createdAt ?? "2026-01-15T08:30:00.000Z",
    updatedAt: "2026-01-15T08:30:00.000Z",
  };
}

/** Backfill 单批响应（IngestCrawlTaskResultsToItems）。 */
export interface CrawlBackfillBatch {
  scanned: number;
  ingested: number;
  skippedExisting: number;
  failed: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface TestCrawlApolloState {
  /** CrawlTask query 响应（null 模拟 task not found）。 */
  task: CrawlTaskDetailTask | null;
  /** 非空时 CrawlTask query 拒绝。 */
  taskError: Error | null;
  /** 挂起模式：CrawlTask 请求永不返回（模拟慢 refetch，旧数据保留）。 */
  taskHang: boolean;
  /** 每次 CrawlTask 请求收到的变量（按顺序）。 */
  taskVariables: Record<string, unknown>[];
  retryVariables: Record<string, unknown>[];
  retryError: Error | null;
  /** UpdateCrawlTaskIngestToItems mutation 变量。 */
  ingestToItemsVariables: Record<string, unknown>[];
  ingestToItemsError: Error | null;
  /** IngestCrawlTaskResultsToItems 按顺序的批次响应（Error=拒绝，"hang"=永不返回）。 */
  backfillBatches: (CrawlBackfillBatch | Error | "hang")[];
  backfillVariables: Record<string, unknown>[];
  /** CreateItemFromCrawlResult（inline gql）变量。 */
  createItemVariables: Record<string, unknown>[];
  createItemResult: { id: string; title: string; status: string } | null;
  createItemError: Error | null;
  /** CreateItemFromCrawlResult 挂起（观察单行 loading）。 */
  createItemHang: boolean;
  /** 按到达顺序记录的 operationName（含 polling / refetch 重复请求）。 */
  operations: string[];
}

export function createCrawlApolloState(
  task: CrawlTaskDetailTask | null,
): TestCrawlApolloState {
  return {
    task,
    taskError: null,
    taskHang: false,
    taskVariables: [],
    retryVariables: [],
    retryError: null,
    ingestToItemsVariables: [],
    ingestToItemsError: null,
    backfillBatches: [],
    backfillVariables: [],
    createItemVariables: [],
    createItemResult: null,
    createItemError: null,
    createItemHang: false,
    operations: [],
  };
}

/** 异步（microtask）发送结果，模拟网络往返。 */
function respond(
  produce: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Observable<FetchResult> {
  return new Observable<FetchResult>((observer) => {
    let active = true;
    Promise.resolve()
      .then(produce)
      .then(
        (data) => {
          if (!active) {
            return;
          }
          observer.next({ data: { __typename: "Query", ...data } });
          observer.complete();
        },
        (error: Error) => {
          if (active) {
            observer.error(error);
          }
        },
      );
    return () => {
      active = false;
    };
  });
}

export function createCrawlApolloLink(
  state: TestCrawlApolloState,
): ApolloLink {
  return new ApolloLink((operation) => {
    state.operations.push(operation.operationName);
    const variables = operation.variables as Record<string, unknown>;

    switch (operation.operationName) {
      case "CrawlTask": {
        state.taskVariables.push(variables);
        if (state.taskHang) {
          return new Observable<FetchResult>(() => () => undefined);
        }
        if (state.taskError) {
          return respond(() => Promise.reject(state.taskError));
        }
        return respond(() => ({ crawlTask: state.task }));
      }
      case "RetryCrawlTask": {
        state.retryVariables.push(variables);
        if (state.retryError) {
          return respond(() => Promise.reject(state.retryError));
        }
        return respond(() => ({
          retryCrawlTask: {
            __typename: "CrawlTaskModel",
            id: String(variables.id),
            status: CrawlTaskStatus.Queued,
            lastRunAt: null,
            lastError: null,
            runCount: 1,
          },
        }));
      }
      case "UpdateCrawlTaskIngestToItems": {
        state.ingestToItemsVariables.push(variables);
        if (state.ingestToItemsError) {
          return respond(() => Promise.reject(state.ingestToItemsError));
        }
        return respond(() => ({
          updateCrawlTaskIngestToItems: {
            __typename: "CrawlTaskModel",
            id: String(variables.id),
            config: state.task?.config ?? null,
          },
        }));
      }
      case "IngestCrawlTaskResultsToItems": {
        state.backfillVariables.push(variables);
        const batch = state.backfillBatches.shift();
        if (batch === "hang") {
          return new Observable<FetchResult>(() => () => undefined);
        }
        if (batch instanceof Error) {
          return respond(() => Promise.reject(batch));
        }
        const resolved: CrawlBackfillBatch =
          batch ?? {
            scanned: 0,
            ingested: 0,
            skippedExisting: 0,
            failed: 0,
            nextCursor: null,
            hasMore: false,
          };
        return respond(() => ({
          ingestCrawlTaskResultsToItems: {
            __typename: "CrawlIngestBatchModel",
            taskId: String(variables.taskId),
            scanned: resolved.scanned,
            attempted: resolved.scanned,
            ingested: resolved.ingested,
            skippedExisting: resolved.skippedExisting,
            failed: resolved.failed,
            nextCursor: resolved.nextCursor ?? null,
            hasMore: resolved.hasMore,
          },
        }));
      }
      case "CreateItemFromCrawlResult": {
        state.createItemVariables.push(variables);
        if (state.createItemHang) {
          return new Observable<FetchResult>(() => () => undefined);
        }
        if (state.createItemError) {
          return respond(() => Promise.reject(state.createItemError));
        }
        return respond(() => ({
          createItemFromCrawlResult: state.createItemResult
            ? {
                __typename: "ItemModel",
                ...state.createItemResult,
              }
            : {
                __typename: "ItemModel",
                id: `item-${String(variables.resultId)}`,
                title: "Created item",
                status: "draft",
              },
        }));
      }
      default:
        return respond(() =>
          Promise.reject(
            new Error(
              `Unhandled Apollo operation: ${operation.operationName}`,
            ),
          ),
        );
    }
  });
}

/** renderCrawlTaskDetail 选项。 */
export interface RenderCrawlTaskDetailOptions {
  taskId?: string;
  sessionStatus?: TestSessionMockState["status"];
  permissions?: string[];
  accessToken?: string;
  task?: CrawlTaskDetailTask | null;
  /** 初始 CrawlTask 请求即挂起（观察首屏 loading）。 */
  taskHang?: boolean;
  /** 初始 task-logs REST 响应（默认空数组）。 */
  taskLogs?: unknown[] | Error | "hang";
}

export interface RenderCrawlTaskDetailResult extends RenderResult {
  apollo: TestCrawlApolloState;
  /** 以相同 Apollo client / link 重新渲染（观察 taskId 变化行为）。 */
  rerenderTaskId: (taskId: string) => void;
}

export function renderCrawlTaskDetail(
  options: RenderCrawlTaskDetailOptions = {},
): RenderCrawlTaskDetailResult {
  resetCrawlTaskDetailMockState();
  resetTestNavigation(`/admin/ops/crawl-tasks/${options.taskId ?? "task-1"}`);
  if (options.taskLogs !== undefined) {
    testTaskLogs.responses[0] = options.taskLogs;
  }
  testSessionMock.status = options.sessionStatus ?? "authenticated";
  // 非 authenticated（loading/unauthenticated）时 data 为 null，贴近 next-auth 真实语义
  testSessionMock.data =
    options.sessionStatus && options.sessionStatus !== "authenticated"
      ? null
      : {
          permissions: options.permissions ?? ["crawl.read"],
          ...(options.accessToken === undefined
            ? {}
            : { accessToken: options.accessToken }),
        };

  const apollo = createCrawlApolloState(
    options.task === undefined
      ? buildCrawlTaskDetailTask()
      : options.task,
  );
  apollo.taskHang = options.taskHang ?? false;
  const taskId = options.taskId ?? "task-1";
  const link = createCrawlApolloLink(apollo);
  const element = (
    <MockedProvider link={link}>
      <CrawlTaskDetail taskId={taskId} />
    </MockedProvider>
  );

  const result = renderWithProviders(element);
  return {
    ...result,
    apollo,
    rerenderTaskId: (next: string) => {
      result.rerender(
        <MockedProvider link={link}>
          <CrawlTaskDetail taskId={next} />
        </MockedProvider>,
      );
    },
  };
}

/** 追加一条 task-logs REST 响应（供刷新/重挂载后的请求消费）。 */
export function queueTaskLogsResponse(
  response: unknown[] | Error | "hang",
): void {
  testTaskLogs.responses.push(response);
}
