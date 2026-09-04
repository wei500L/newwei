import type { TFunction } from "i18next";

import type { DataStateBoundaryState } from "@/components/data-state-boundary";
import type { RequestErrorEmptyState } from "@/lib/request-error-empty-state";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";
import { classifyRequestError } from "@/lib/request-error";

/**
 * Alert Center 数据状态分派（FE-批3B 从 alert-center.tsx 提取）。
 *
 * DataStateBoundary 首个消费方的既有语义（PR #4，行为保持）：
 * - 会话 loading / 无读权限 / 无数据 blockingError → 整页状态；
 * - 有旧数据时刷新失败 → nonBlockingError（内容保留 + 非阻断提示）；
 * - ready → 内容；空态仍由事件列表 emptyText 承载；
 * - refreshing / empty 不在本页接入（notifyOnNetworkStatusChange 未启用）。
 */

export interface BuildAlertDataStateOptions {
  sessionStatus: string;
  authenticated: boolean;
  canReadAlerts: boolean;
  eventsError: Error | undefined;
  hasEventsData: boolean;
  onRetry: () => void;
  eventsLoading: boolean;
  t: TFunction;
}

/** blockingError 的 errorStateOverride 构造（复用 buildRequestErrorEmptyState）。 */
export function buildBlockingEventsErrorState(options: {
  error: Error;
  onRetry: () => void;
  eventsLoading: boolean;
  t: TFunction;
}): RequestErrorEmptyState {
  const { error, onRetry, eventsLoading, t } = options;
  const baseState = buildRequestErrorEmptyState({
    t,
    error,
    onRetry,
    actionLoading: eventsLoading,
    actionLabelOverride: t("dashboard.actions.retryFetch"),
    includeDetailText: false,
  });
  const errorKind = classifyRequestError(error).kind;
  const description =
    errorKind === "permission" || errorKind === "auth"
      ? t("alerts.center.loadFailed.permission")
      : errorKind === "network" ||
          errorKind === "timeout" ||
          errorKind === "service"
        ? t("alerts.center.loadFailed.service")
        : t("alerts.center.loadFailed.default");

  return {
    ...baseState,
    title: t("alerts.center.loadFailed.title"),
    description: (
      <div className="flex flex-col items-center gap-1">
        <span>{description}</span>
        {baseState.detailText ? (
          <span className="font-mono text-[10px] opacity-80">
            {t("alerts.center.loadFailed.detail")}
            {": "}
            {baseState.detailText}
          </span>
        ) : null}
      </div>
    ),
  };
}

/** 页面级 DataStateBoundary 状态分派（单一函数，行为保持）。 */
export function buildAlertDataState(
  options: BuildAlertDataStateOptions,
): DataStateBoundaryState {
  const {
    sessionStatus,
    authenticated,
    canReadAlerts,
    eventsError,
    hasEventsData,
    onRetry,
    eventsLoading,
    t,
  } = options;

  if (sessionStatus === "loading") {
    return { kind: "initialLoading" };
  }
  if (authenticated && !canReadAlerts) {
    return { kind: "permissionDenied" };
  }
  if (eventsError && !hasEventsData) {
    return {
      kind: "blockingError",
      error: eventsError,
      errorStateOverride: buildBlockingEventsErrorState({
        error: eventsError,
        onRetry,
        eventsLoading,
        t,
      }),
    };
  }
  if (eventsError && hasEventsData) {
    return { kind: "nonBlockingError", error: eventsError };
  }
  return { kind: "ready" };
}
