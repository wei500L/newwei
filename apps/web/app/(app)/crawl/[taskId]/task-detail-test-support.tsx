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
import {
  createCrawlApolloLink,
  createCrawlApolloState,
  type TestCrawlApolloState,
} from "./task-detail-apollo-mock";

/**
 * Crawl Task Detail 行为测试共享支撑（FE-批5A characterization tests）。
 * 只被 *.test.tsx 引用，不计入 coverage。Apollo 走 MockedProvider + 自定义
 * ApolloLink（真实客户端执行 query/mutation/refetch，仅替换网络出口）；
 * vi.mock 工厂在测试文件声明且只 import 零依赖模块，避免加载死锁。
 * fetchPolicy 不进入 link context，其保持依赖静态审查。
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

export interface CrawlTaskDetailLinkStatsInput {
  totalLinks: number;
  internalLinks: number;
  externalLinks: number;
  averageIntrinsicScore?: number | null;
  highQualityLinks?: number | null;
  lowQualityLinks?: number | null;
}

export interface CrawlTaskDetailLinkAnalysisInput {
  stats: CrawlTaskDetailLinkStatsInput;
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

type CrawlTaskLinkAnalysisFixture = NonNullable<
  CrawlTaskDetailResult["linkAnalysis"]
>;

function buildTopLink(link: CrawlTaskDetailLinkInput) {
  return {
    __typename: "CrawlLinkModel" as const,
    href: link.href,
    text: link.text ?? null,
    title: link.title ?? null,
    baseDomain: link.baseDomain ?? null,
    type: link.type ?? null,
    intrinsicScore: link.intrinsicScore ?? null,
    contextualScore: link.contextualScore ?? null,
    totalScore: link.totalScore ?? null,
  };
}

function buildLowQualityLink(link: CrawlTaskDetailLinkInput) {
  return {
    __typename: "CrawlLinkModel" as const,
    href: link.href,
    text: link.text ?? null,
    title: link.title ?? null,
    intrinsicScore: link.intrinsicScore ?? null,
    baseDomain: link.baseDomain ?? null,
  };
}

function buildLinkAnalysis(
  input: CrawlTaskDetailLinkAnalysisInput,
): CrawlTaskLinkAnalysisFixture {
  return {
    __typename: "CrawlLinkAnalysisModel",
    stats: {
      __typename: "CrawlLinkStatsModel",
      totalLinks: input.stats.totalLinks,
      internalLinks: input.stats.internalLinks,
      externalLinks: input.stats.externalLinks,
      averageIntrinsicScore: input.stats.averageIntrinsicScore ?? null,
      highQualityLinks: input.stats.highQualityLinks ?? null,
      lowQualityLinks: input.stats.lowQualityLinks ?? null,
    },
    topLinks: (input.topLinks ?? []).map(buildTopLink),
    lowQualityLinks: (input.lowQualityLinks ?? []).map(buildLowQualityLink),
    buckets: (input.buckets ?? []).map((bucket) => ({
      __typename: "CrawlLinkBucketModel" as const,
      kind: bucket.kind,
      links: bucket.links.map(buildTopLink),
    })),
  };
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
        ? buildLinkAnalysis(result.linkAnalysis)
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

/** renderCrawlTaskDetail 选项。 */
export interface RenderCrawlTaskDetailOptions {
  taskId?: string;
  sessionStatus?: TestSessionMockState["status"];
  permissions?: string[];
  accessToken?: string;
  task?: CrawlTaskDetailTask | null;
  taskHang?: boolean;
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
  // 非 authenticated（loading/unauthenticated）时 data 为 null，贴近 next-auth 语义
  testSessionMock.status = options.sessionStatus ?? "authenticated";
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
    options.task === undefined ? buildCrawlTaskDetailTask() : options.task,
  );
  apollo.taskHang = options.taskHang ?? false;
  const taskId = options.taskId ?? "task-1";
  const link = createCrawlApolloLink(apollo);
  const result = renderWithProviders(
    <MockedProvider link={link}>
      <CrawlTaskDetail taskId={taskId} />
    </MockedProvider>,
  );
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
