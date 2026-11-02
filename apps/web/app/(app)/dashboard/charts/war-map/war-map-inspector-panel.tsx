"use client";

import {
  EventClusterInspectorContent,
  EventInspectorContent,
} from "./war-map-event-cluster-inspector";
import {
  InspectorPanelFrame,
  InspectorPanelShellHeader,
} from "./war-map-inspector-shell";
import type {
  WarMapInspectorContentContext,
  WarMapInspectorPanelProps,
} from "./war-map-inspector-types";
import { NewsClusterInspectorContent } from "./war-map-news-cluster-inspector";
import { NewsInspectorContent } from "./war-map-news-inspector";
import { TransportInspectorContent } from "./war-map-transport-inspector";

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

  const inspectorAccentClass =
    selectedInspector.kind === "event" ||
    selectedInspector.kind === "event-cluster"
      ? "border-l-[var(--accent)]"
      : selectedInspector.kind === "flight"
        ? "border-l-[var(--primary)]"
        : selectedInspector.kind === "vessel"
          ? "border-l-[var(--border-strong)]"
          : "border-l-[var(--destructive)]";

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
            inspectorAccentClass={inspectorAccentClass}
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
