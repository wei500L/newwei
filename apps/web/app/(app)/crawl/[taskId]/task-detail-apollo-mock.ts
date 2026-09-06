import { ApolloLink, Observable, type FetchResult } from "@apollo/client";

import {
  CrawlTaskStatus,
  type CrawlTaskQuery,
} from "@/graphql/generated";

/**
 * Crawl Task Detail 的 Apollo link 受控替身（characterization tests 用）。
 * query / mutation / refetch 全部经过真实 Apollo 客户端执行，仅把网络
 * 出口替换为受控响应；skip 由「无请求到达 link」观察（客户端短路）。
 */

/** Backfill 单批响应（IngestCrawlTaskResultsToItems）。 */
export interface CrawlBackfillBatch {
  scanned: number;
  ingested: number;
  skippedExisting: number;
  failed: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

type CrawlTaskDetailTask = NonNullable<CrawlTaskQuery["crawlTask"]>;

/**
 * Apollo link 受控状态：task=null 模拟 not found；taskHang 挂起 CrawlTask
 * （观察慢 refetch）；backfillBatches 按到达顺序消费（Error=拒绝，
 * "hang"=永不返回）；operations 记录全部请求（含 polling/refetch 重复）。
 */
export interface TestCrawlApolloState {
  task: CrawlTaskDetailTask | null;
  taskError: Error | null;
  taskHang: boolean;
  taskVariables: Record<string, unknown>[];
  retryVariables: Record<string, unknown>[];
  retryError: Error | null;
  ingestToItemsVariables: Record<string, unknown>[];
  ingestToItemsError: Error | null;
  backfillBatches: (CrawlBackfillBatch | Error | "hang")[];
  backfillVariables: Record<string, unknown>[];
  createItemVariables: Record<string, unknown>[];
  createItemResult: { id: string; title: string; status: string } | null;
  createItemError: Error | null;
  createItemHang: boolean;
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
            ? { __typename: "ItemModel", ...state.createItemResult }
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
