"use client";

import { Spin } from "antd";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import {
  buildRequestErrorEmptyState,
  type RequestErrorEmptyState,
} from "@/lib/request-error-empty-state";

/**
 * DataStateBoundary：数据状态边界的展示原语（FE-批3）。
 *
 * 只做「状态 → 展示」的分派，不发起任何数据请求（无 Apollo / TanStack /
 * fetch），不包含调用方业务逻辑。错误分类与文案构建复用现有
 * classifyRequestError / buildRequestErrorEmptyState / RequestErrorBanner，
 * 不引入第二套错误分类。
 *
 * 状态语义：
 * - initialLoading   无可用数据、首次加载 → 居中 Spin（role=status）
 * - permissionDenied 无读权限 → 权限空态（数据请求不应发起，由调用方门禁保证）
 * - blockingError    无可用数据且请求失败 → 错误空态 + 现有 retry 语义
 * - empty            请求完成但结果为空 → 空态
 * - ready            正常渲染 children
 * - refreshing       已有数据、正在刷新 → 保留 children（aria-busy）
 * - nonBlockingError 已有数据但刷新失败 → 保留 children + 非阻断提示横幅
 *
 * 核心规则：有可用旧数据时（refreshing / nonBlockingError），任何加载或
 * 刷新错误都不把内容替换成整页 Spin / 错误页。
 *
 * 文案：默认使用现有 common.* i18n key；调用方可覆盖（不得硬编码中英文）。
 */
export type DataStateBoundaryState =
  | { kind: "initialLoading" }
  | { kind: "permissionDenied" }
  | {
      kind: "blockingError";
      error: unknown;
      /** 预构建的错误视图（如调用方已有定制文案），覆盖默认构建。 */
      errorStateOverride?: RequestErrorEmptyState;
    }
  | { kind: "empty" }
  | { kind: "ready" }
  | { kind: "refreshing" }
  | { kind: "nonBlockingError"; error: unknown };

export interface DataStateBoundaryProps {
  state: DataStateBoundaryState;
  /** ready / refreshing / nonBlockingError 时渲染的数据内容。 */
  children?: ReactNode;
  /** blockingError / nonBlockingError 的重试回调（沿用现有 retry 语义）。 */
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  /** 权限空态文案（默认 common.accessDenied / common.accessDeniedDescription）。 */
  permissionTitle?: string;
  permissionDescription?: ReactNode;
  /** 空态文案（默认 common.empty）。 */
  emptyDescription?: ReactNode;
  /** 加载态可访问名称（默认 common.loading）。 */
  loadingLabel?: string;
  className?: string;
}

export function DataStateBoundary({
  state,
  children,
  onRetry,
  retrying,
  retryLabel,
  permissionTitle,
  permissionDescription,
  emptyDescription,
  loadingLabel,
  className,
}: DataStateBoundaryProps) {
  const { t } = useTranslation();

  switch (state.kind) {
    case "initialLoading":
      return (
        <div
          role="status"
          aria-live="polite"
          aria-label={loadingLabel ?? t("common.loading")}
          className={className}
        >
          <div className="flex justify-center py-16">
            <Spin />
          </div>
        </div>
      );
    case "permissionDenied":
      return (
        <ChartEmptyState
          className={className ?? "h-auto py-10"}
          variant="permission"
          title={permissionTitle ?? t("common.accessDenied")}
          description={
            permissionDescription ?? t("common.accessDeniedDescription")
          }
        />
      );
    case "blockingError": {
      const errorState =
        state.errorStateOverride ??
        buildRequestErrorEmptyState({
          t,
          error: state.error,
          onRetry,
          actionLoading: retrying,
          actionLabelOverride: retryLabel,
        });
      return <ChartEmptyState className={className ?? "h-auto py-10"} {...errorState} />;
    }
    case "empty":
      return (
        <ChartEmptyState
          className={className ?? "h-auto py-10"}
          description={emptyDescription ?? t("common.empty")}
        />
      );
    case "ready":
      return <>{children}</>;
    case "refreshing":
      return (
        <div aria-busy="true" className={className}>
          {children}
        </div>
      );
    case "nonBlockingError":
      return (
        <div className={className}>
          <RequestErrorBanner
            error={state.error}
            onRetry={onRetry}
            actionLoading={retrying}
            showCachedDataHint
          />
          {children}
        </div>
      );
  }
}
