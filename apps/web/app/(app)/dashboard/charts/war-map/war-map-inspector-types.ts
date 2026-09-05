/**
 * Inspector 领域契约（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 * 纯类型叶子模块：无 React 组件、无 "use client"。
 */
import type { WarMapTransportDetail } from "@modular/utils";

import type { SupportedLocale } from "@/lib/i18n";

import type {
  SelectedInspector,
  WarMapTranslateFn,
} from "./war-map-overlay-model";

export interface WarMapInspectorPanelProps {
  /** Inspector 只读模型切片：当前选择。 */
  selectedInspector: SelectedInspector | null;
  /** transport 详情切片：轨迹数据与加载态。 */
  transportDetail?: WarMapTransportDetail | null;
  transportDetailLoading?: boolean;
  /** 布局切片：桌面/移动呈现与尺寸。 */
  layout: {
    useDesktopInspector: boolean;
    minimized: boolean;
    width: number;
    height: number;
  };
  locale: SupportedLocale;
  /** Inspector 命令切片。 */
  actions: {
    onZoom: () => void;
    onMinimize: () => void;
    onExpand: () => void;
    onClose: () => void;
    onOpenNewsLink: (url: string | null | undefined) => void;
  };
  t: WarMapTranslateFn;
}

/** 各内容组件共享的展示上下文。 */
export interface WarMapInspectorContentContext {
  locale: SupportedLocale;
  onOpenNewsLink: (url: string | null | undefined) => void;
  t: WarMapTranslateFn;
}

export function getSelectedInspectorTitle(
  selectedInspector: SelectedInspector,
  t: WarMapTranslateFn,
): string {
  if ("item" in selectedInspector) {
    return selectedInspector.item.label;
  }

  return selectedInspector.kind === "event-cluster"
    ? t("dashboard.charts.warMap.panel.signalsSummary", {
        count: selectedInspector.count,
      })
    : t("dashboard.charts.warMap.panel.newsSummary", {
        count: selectedInspector.count,
      });
}
