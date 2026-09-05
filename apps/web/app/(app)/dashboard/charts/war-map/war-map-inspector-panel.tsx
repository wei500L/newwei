"use client";

import {
  InspectorPanelFrame,
  InspectorPanelShellHeader,
} from "./war-map-inspector-shell";
import type { WarMapInspectorPanelProps } from "./war-map-inspector-types";
import {
  EventClusterInspectorContent,
  EventInspectorContent,
} from "./war-map-event-cluster-inspector";
import { NewsClusterInspectorContent } from "./war-map-news-cluster-inspector";
import { NewsInspectorContent } from "./war-map-news-inspector";
import { TransportInspectorContent } from "./war-map-transport-inspector";
import type { WarMapInspectorContentContext } from "./war-map-inspector-types";

/**
 * Inspector 面板根编排层（FE-批4B：原 667 行拆分后收敛为编排）。
 * 外壳（头部/三种呈现）由 war-map-inspector-shell.tsx 承载；各选择
 * 类型的内容由独立内容组件渲染。props 收敛为领域切片
 * （selectedInspector/transportDetail/layout/actions）。
 */
export function WarMapInspectorPanel({
  selectedInspector,
  transportDetail,
  transportDetailLoading,
  layout,
  locale,
  actions,
  t,
}: WarMapInspectorPanelProps) {
  if (!selectedInspector) {
    return null;
  }

  const inspectorHeaderGradient =
    selectedInspector.kind === "event" ||
    selectedInspector.kind === "event-cluster"
      ? "from-amber-50 via-white to-white dark:from-amber-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]"
      : selectedInspector.kind === "flight"
        ? "from-sky-50 via-white to-white dark:from-sky-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]"
        : selectedInspector.kind === "vessel"
          ? "from-cyan-50 via-white to-white dark:from-cyan-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]"
          : "from-emerald-50 via-white to-white dark:from-emerald-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]";

  const context: WarMapInspectorContentContext = {
    locale,
    onOpenNewsLink: actions.onOpenNewsLink,
    t,
  };

  return (
    <InspectorPanelFrame
      selectedInspector={selectedInspector}
      layout={layout}
      actions={actions}
      t={t}
      content={
        <>
          <InspectorPanelShellHeader
            selectedInspector={selectedInspector}
            inspectorHeaderGradient={inspectorHeaderGradient}
            useDesktopInspector={layout.useDesktopInspector}
            onZoom={actions.onZoom}
            onMinimize={actions.onMinimize}
            onClose={actions.onClose}
            t={t}
          />
          {selectedInspector.kind === "event-cluster" ? (
            <EventClusterInspectorContent
              members={selectedInspector.members}
              context={context}
            />
          ) : selectedInspector.kind === "news-cluster" ? (
            <NewsClusterInspectorContent
              members={selectedInspector.members}
              context={context}
            />
          ) : selectedInspector.kind === "event" ? (
            <EventInspectorContent
              item={selectedInspector.item}
              context={context}
            />
          ) : selectedInspector.kind === "flight" ||
            selectedInspector.kind === "vessel" ? (
            <TransportInspectorContent
              kind={selectedInspector.kind}
              item={selectedInspector.item}
              transportDetail={transportDetail}
              transportDetailLoading={transportDetailLoading}
              context={context}
            />
          ) : (
            <NewsInspectorContent
              item={selectedInspector.item}
              context={context}
            />
          )}
        </>
      }
    />
  );
}
