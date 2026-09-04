"use client";

import type { RefObject, ReactNode } from "react";
import { Space, Spin, Typography } from "antd";

import { ChartEmptyState } from "@/components/chart-empty-state";

export interface WarMapFatalOverlayState {
  title: string;
  description: string;
  actionLabel: string;
  actionLoading: boolean;
  onAction: () => void;
}

export interface WarMapMapSurfaceProps {
  mapContainerRef: RefObject<HTMLDivElement | null>;
  viewportClassName: string;
  hasFatalOverlay: boolean;
  hasNonFatalDataError: boolean;
  /** 非致命错误横幅（RequestErrorBanner 组合结果）。 */
  errorBanner?: ReactNode;
  /** 顶部 overlay rail（含桌面面板）。 */
  rail?: ReactNode;
  /** AIS 视口空态提示条。 */
  aisEmptyStateBanner?: ReactNode;
  /** Inspector 面板。 */
  inspector?: ReactNode;
  /** 底部 Drawer（minimal 密度 / standalone）。 */
  bottomDrawer?: ReactNode;
  showBootOverlay: boolean;
  bootOverlayLabel: string;
  showEmptyState: boolean;
  emptyStateDescription: string;
  fatalOverlay: WarMapFatalOverlayState | null;
}

/**
 * 地图表面布局域（FE-批4A）：地图视口的层级结构与条件分派
 * （rail / 容器 / Inspector / Drawer / boot / 空态 / 致命错误覆盖层）。
 * 内容槽位由编排层组合后传入，本组件只负责放置与 z-index 层级。
 */
export function WarMapMapSurface({
  mapContainerRef,
  viewportClassName,
  hasFatalOverlay,
  hasNonFatalDataError,
  errorBanner,
  rail,
  aisEmptyStateBanner,
  inspector,
  bottomDrawer,
  showBootOverlay,
  bootOverlayLabel,
  showEmptyState,
  emptyStateDescription,
  fatalOverlay,
}: WarMapMapSurfaceProps) {
  return (
    <div className={viewportClassName}>
      {!hasFatalOverlay ? (
        <>
          {hasNonFatalDataError ? errorBanner : null}
          {rail}
        </>
      ) : null}

      <div
        ref={mapContainerRef}
        className="h-full w-full overflow-hidden rounded-lg"
      />

      {!hasFatalOverlay ? (
        <>
          {aisEmptyStateBanner}
          {inspector}
          {bottomDrawer}
        </>
      ) : null}

      {showBootOverlay ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl border border-[var(--border)] bg-white/[0.92] px-4 py-3 shadow-lg backdrop-blur dark:bg-slate-950/[0.78] dark:shadow-[0_22px_40px_-30px_rgba(2,6,23,0.9)]">
            <Space size={10}>
              <Spin size="small" />
              <Typography.Text>{bootOverlayLabel}</Typography.Text>
            </Space>
          </div>
        </div>
      ) : null}

      {showEmptyState ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ChartEmptyState description={emptyStateDescription} />
        </div>
      ) : null}

      {fatalOverlay ? (
        <div className="absolute inset-0 z-30 rounded-lg bg-white/80 backdrop-blur-sm dark:bg-slate-950/[0.72]">
          <ChartEmptyState
            variant="error"
            title={fatalOverlay.title}
            description={fatalOverlay.description}
            actionLabel={fatalOverlay.actionLabel}
            actionLoading={fatalOverlay.actionLoading}
            onAction={fatalOverlay.onAction}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 准备态（未进入视口）占位渲染（保留 wrapper ref 供观察器挂载）。 */
export function WarMapPreparingSurface({
  wrapperRef,
  className,
  viewportClassName,
  stacked,
  label,
}: {
  wrapperRef: RefObject<HTMLDivElement | null>;
  className: string;
  viewportClassName: string;
  stacked: boolean;
  label: string;
}) {
  return (
    <div ref={wrapperRef} className={className}>
      <div className={stacked ? "flex flex-col gap-5" : "h-full"}>
        <div className={viewportClassName}>
          <div className="flex h-full items-center justify-center">
            <Space size={8}>
              <Spin size="small" />
              <Typography.Text type="secondary">{label}</Typography.Text>
            </Space>
          </div>
        </div>
      </div>
    </div>
  );
}
