"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";
import {
  classifyQueueOpsError,
  cleanQueue,
  countQueueOpsDlqResiduals,
  deleteDlqJobs,
  deleteJob,
  fetchQueueOpsJobDetail,
  fetchQueueOpsJobs,
  fetchQueueOpsQueues,
  pauseQueue,
  promoteJob,
  QUEUE_OPS_DEFAULT_BATCH_LIMIT,
  replayDlqJobs,
  resumeQueue,
  retryFailedQueueJobs,
  retryJob,
  type QueueOpsDlqReplayRequest,
  type QueueOpsJobDetail,
  type QueueOpsJobState,
  type QueueOpsJobSummary,
  type QueueOpsQueue,
} from "@/lib/queue-ops";

/**
 * 队列运维页面数据层（照 news-sources 的 use-*-data.ts 的组织方式）：
 * - useQueueOpsData：队列列表 + 暂停/恢复/清理
 * - useQueueOpsJobs：某个队列（可选状态）的作业列表、详情与行级操作
 * - useQueueOpsDlq：死信重放 / 删除与残留提示
 *
 * 403（权限不足）不进入常规错误态，而是通过 onRequestIssue 上报给页面，由页面
 * 统一渲染提示 Alert。404 只有「队列列表」这一个入口才代表 api-go 未开启队列
 * 运维（legacy 下 12 条端点全部 404）；单个 job 已过期或被清理同样返回 404，
 * 所以 job 列表/详情把 404 当作普通「资源不存在」错误，不能误报成开关提示。
 */

export interface QueueOpsMessageApi {
  success: (content: string) => void;
  error: (content: string) => void;
}

export type QueueOpsRequestIssue = "notFound" | "forbidden";

export interface QueueOpsFeedbackParams {
  t: ReturnType<typeof useTranslation>["t"];
  messageApi: QueueOpsMessageApi;
  onRequestIssue: (issue: QueueOpsRequestIssue) => void;
}

function useQueueOpsErrorReporter(
  params: QueueOpsFeedbackParams,
): (requestError: unknown) => void {
  const { messageApi, onRequestIssue, t } = params;
  return useCallback(
    (requestError: unknown) => {
      const kind = classifyQueueOpsError(requestError);
      // A mutation only reports the permission problem to the page. A 404 here
      // means the queue or job disappeared between the read and the write, not
      // that the console is disabled, so it stays a normal error toast.
      if (kind === "forbidden") {
        onRequestIssue(kind);
        return;
      }
      if (kind === "notFound") {
        messageApi.error(t("common.operationFailed"));
        return;
      }
      captureClientError("Queue ops request failed", requestError);
      messageApi.error(
        requestError instanceof Error
          ? requestError.message
          : t("common.operationFailed"),
      );
    },
    [messageApi, onRequestIssue, t],
  );
}

export interface QueueOpsCleanInput {
  queue: string;
  state: QueueOpsJobState;
  grace: number;
  limit: number;
}

export interface UseQueueOpsDataParams extends QueueOpsFeedbackParams {
  canView: boolean;
}

export interface UseQueueOpsDataResult {
  queues: QueueOpsQueue[];
  loading: boolean;
  error: unknown;
  busyAction: string | null;
  reload: () => void;
  pause: (queueName: string) => Promise<boolean>;
  resume: (queueName: string) => Promise<boolean>;
  clean: (input: QueueOpsCleanInput) => Promise<boolean>;
}

export function useQueueOpsData(
  params: UseQueueOpsDataParams,
): UseQueueOpsDataResult {
  const { canView, messageApi, onRequestIssue, t } = params;
  const [queues, setQueues] = useState<QueueOpsQueue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);
  const reportRequestError = useQueueOpsErrorReporter(params);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!canView) {
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchQueueOpsQueues()
      .then((response) => {
        if (cancelled || requestIdRef.current !== requestId) {
          return;
        }
        setQueues(response.queues);
      })
      .catch((requestError: unknown) => {
        if (cancelled || requestIdRef.current !== requestId) {
          return;
        }
        const kind = classifyQueueOpsError(requestError);
        if (kind === "notFound" || kind === "forbidden") {
          onRequestIssue(kind);
          return;
        }
        captureClientError("Failed to load queue ops queues", requestError);
        setError(requestError);
      })
      .finally(() => {
        if (!cancelled && requestIdRef.current === requestId) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canView, onRequestIssue, reloadToken]);

  const pause = useCallback(
    async (queueName: string): Promise<boolean> => {
      setBusyAction(`pause:${queueName}`);
      try {
        await pauseQueue(queueName);
        messageApi.success(t("ops.queueOps.confirm.pauseSuccess"));
        reload();
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, reload, reportRequestError, t],
  );

  const resume = useCallback(
    async (queueName: string): Promise<boolean> => {
      setBusyAction(`resume:${queueName}`);
      try {
        await resumeQueue(queueName);
        messageApi.success(t("ops.queueOps.confirm.resumeSuccess"));
        reload();
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, reload, reportRequestError, t],
  );

  const clean = useCallback(
    async (input: QueueOpsCleanInput): Promise<boolean> => {
      setBusyAction(`clean:${input.queue}`);
      try {
        const result = await cleanQueue(input);
        messageApi.success(
          t("ops.queueOps.queues.clean.success", { removed: result.removed }),
        );
        reload();
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, reload, reportRequestError, t],
  );

  return {
    queues,
    loading,
    error,
    busyAction,
    reload,
    pause,
    resume,
    clean,
  };
}

export interface UseQueueOpsJobsParams extends QueueOpsFeedbackParams {
  queue: string | null;
  state: QueueOpsJobState;
  onCountsChanged: () => void;
}

export interface UseQueueOpsJobsResult {
  jobs: QueueOpsJobSummary[];
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  hasMore: boolean;
  busyAction: string | null;
  reload: () => void;
  loadMore: () => void;
  detail: QueueOpsJobDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  activeJobId: string | null;
  openDetail: (jobId: string) => void;
  closeDetail: () => void;
  retry: (jobId: string) => Promise<boolean>;
  remove: (jobId: string) => Promise<boolean>;
  promote: (jobId: string) => Promise<boolean>;
  retryFailed: () => Promise<boolean>;
}

export function useQueueOpsJobs(
  params: UseQueueOpsJobsParams,
): UseQueueOpsJobsResult {
  const { messageApi, onCountsChanged, onRequestIssue, queue, state, t } =
    params;
  const [jobs, setJobs] = useState<QueueOpsJobSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QueueOpsJobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const generationRef = useRef(0);
  const reportRequestError = useQueueOpsErrorReporter(params);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!queue) {
      setJobs([]);
      setNextCursor(null);
      setError(null);
      setLoading(false);
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchQueueOpsJobs({ queue, state })
      .then((response) => {
        if (cancelled || generationRef.current !== generation) {
          return;
        }
        setJobs(response.jobs);
        setNextCursor(response.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (cancelled || generationRef.current !== generation) {
          return;
        }
        const kind = classifyQueueOpsError(requestError);
        if (kind === "forbidden") {
          onRequestIssue(kind);
          return;
        }
        captureClientError("Failed to load queue ops jobs", requestError);
        setError(requestError);
      })
      .finally(() => {
        if (!cancelled && generationRef.current === generation) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onRequestIssue, queue, reloadToken, state]);

  useEffect(() => {
    if (!queue || !activeJobId) {
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    fetchQueueOpsJobDetail({ queue, jobId: activeJobId })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setDetail(response.job);
      })
      .catch((requestError: unknown) => {
        if (cancelled) {
          return;
        }
        const kind = classifyQueueOpsError(requestError);
        if (kind === "forbidden") {
          onRequestIssue(kind);
          setDetail(null);
          return;
        }
        captureClientError("Failed to load queue ops job detail", requestError);
        setDetailError(requestError);
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeJobId, onRequestIssue, queue]);

  const loadMore = useCallback(() => {
    if (!queue || !nextCursor || loadingMore) {
      return;
    }
    const generation = generationRef.current;
    setLoadingMore(true);
    fetchQueueOpsJobs({ queue, state, cursor: nextCursor })
      .then((response) => {
        if (generationRef.current !== generation) {
          return;
        }
        setJobs((previous) => [...previous, ...response.jobs]);
        setNextCursor(response.nextCursor);
      })
      .catch(reportRequestError)
      .finally(() => {
        setLoadingMore(false);
      });
  }, [loadingMore, nextCursor, queue, reportRequestError, state]);

  const openDetail = useCallback((jobId: string) => {
    setDetail(null);
    setDetailError(null);
    setActiveJobId(jobId);
  }, []);

  const closeDetail = useCallback(() => {
    setActiveJobId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  const retry = useCallback(
    async (jobId: string): Promise<boolean> => {
      if (!queue) {
        return false;
      }
      setBusyAction(`retry:${jobId}`);
      try {
        await retryJob({ queue, jobId });
        messageApi.success(t("ops.queueOps.detail.retrySuccess"));
        reload();
        onCountsChanged();
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, onCountsChanged, queue, reload, reportRequestError, t],
  );

  const remove = useCallback(
    async (jobId: string): Promise<boolean> => {
      if (!queue) {
        return false;
      }
      setBusyAction(`delete:${jobId}`);
      try {
        await deleteJob({ queue, jobId });
        messageApi.success(t("ops.queueOps.detail.deleteSuccess"));
        reload();
        onCountsChanged();
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, onCountsChanged, queue, reload, reportRequestError, t],
  );

  const promote = useCallback(
    async (jobId: string): Promise<boolean> => {
      if (!queue) {
        return false;
      }
      setBusyAction(`promote:${jobId}`);
      try {
        await promoteJob({ queue, jobId });
        messageApi.success(t("ops.queueOps.detail.promoteSuccess"));
        reload();
        onCountsChanged();
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, onCountsChanged, queue, reload, reportRequestError, t],
  );

  const retryFailed = useCallback(async (): Promise<boolean> => {
    if (!queue) {
      return false;
    }
    setBusyAction(`retryFailed:${queue}`);
    try {
      const result = await retryFailedQueueJobs({
        queue,
        limit: QUEUE_OPS_DEFAULT_BATCH_LIMIT,
      });
      messageApi.success(
        t("ops.queueOps.jobs.retryFailed.success", {
          matched: result.matched,
          retried: result.retried,
        }),
      );
      reload();
      onCountsChanged();
      return true;
    } catch (requestError) {
      reportRequestError(requestError);
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [messageApi, onCountsChanged, queue, reload, reportRequestError, t]);

  return {
    jobs,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    busyAction,
    reload,
    loadMore,
    detail,
    detailLoading,
    detailError,
    activeJobId,
    openDetail,
    closeDetail,
    retry,
    remove,
    promote,
    retryFailed,
  };
}

export type UseQueueOpsDlqParams = QueueOpsFeedbackParams;

export interface UseQueueOpsDlqResult {
  busyAction: string | null;
  residualCount: number;
  replayOne: (jobId: string) => Promise<boolean>;
  replayMany: (jobIds: readonly string[]) => Promise<boolean>;
  deleteOne: (jobId: string) => Promise<boolean>;
}

export function useQueueOpsDlq(
  params: UseQueueOpsDlqParams,
): UseQueueOpsDlqResult {
  const { messageApi, t } = params;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [residualCount, setResidualCount] = useState(0);
  const reportRequestError = useQueueOpsErrorReporter(params);

  const replay = useCallback(
    async (
      request: QueueOpsDlqReplayRequest,
      actionKey: string,
    ): Promise<boolean> => {
      setBusyAction(actionKey);
      try {
        const response = await replayDlqJobs(request);
        const replayed = response.results.filter(
          (result) => result.replayed,
        ).length;
        setResidualCount(countQueueOpsDlqResiduals(response.results));
        messageApi.success(
          t("ops.queueOps.dlq.replaySuccess", { replayed }),
        );
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, reportRequestError, t],
  );

  const replayOne = useCallback(
    (jobId: string) => replay({ jobId }, `dlqReplay:${jobId}`),
    [replay],
  );

  const replayMany = useCallback(
    (jobIds: readonly string[]) => replay({ jobIds }, "dlqReplay:batch"),
    [replay],
  );

  const deleteOne = useCallback(
    async (jobId: string): Promise<boolean> => {
      setBusyAction(`dlqDelete:${jobId}`);
      try {
        await deleteDlqJobs({ jobId });
        messageApi.success(t("ops.queueOps.dlq.deleteSuccess"));
        return true;
      } catch (requestError) {
        reportRequestError(requestError);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [messageApi, reportRequestError, t],
  );

  return { busyAction, residualCount, replayOne, replayMany, deleteOne };
}
