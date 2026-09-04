import type { AlertRuleTuningSuggestionQuery } from "@/graphql/generated";

import type { LocaleCode } from "./alert-center-list-model";
import type { AlertEventItem } from "./alert-center.utils";
import type { useAlertCenterCharts } from "./hooks/use-alert-center-charts";
import type { useAlertEventBatch } from "./hooks/use-alert-event-batch";
import type { useAlertEventDetail } from "./hooks/use-alert-event-detail";
import type { useAlertEventSelection } from "./hooks/use-alert-event-selection";

type ChartsResult = ReturnType<typeof useAlertCenterCharts>;

/**
 * Alert Center 领域契约（第四轮静态收口 + 第五轮最终收口）。
 *
 * 职责：把编排层与 List/Toolbar/Detail 组件之间的平铺 props 收敛为
 * **少量具名领域对象**。每个对象的字段同属一个职责，由对应 hook 结果
 * 或纯 view-model 工厂产生，消费方只接触自身需要的切片。
 *
 * 设计规则（硬性）：
 * - 显式 TypeScript interface，无 any / 无万能大对象；
 * - 不用 React Context 掩盖 props drilling；
 * - 命令（controller）与纯展示（model）分离；
 * - 类型直接派生自 hooks 的返回类型，避免双份声明漂移；
 * - 本模块不依赖任何展示组件（依赖方向：编排层 → 领域契约 → 展示组件）。
 */

/** 导出范围两档：当前勾选集合 / 当前页。 */
export type AlertExportScope = "selected" | "page";

// ---------------------------------------------------------------------------
// 列表域（AlertEventList / Toolbar）
// ---------------------------------------------------------------------------

/** 列表展示模型：当前页数据 + 分页位置 + loading + 行渲染所需上下文。 */
export interface AlertEventListModel {
  currentPageEvents: AlertEventItem[];
  filteredEventsCount: number;
  eventsLoading: boolean;
  locale: LocaleCode;
  objectKeyLabels: { key: string; label: string }[];
}

/** 选择控制器：单项选中 + 批量勾选命令（useAlertEventBatch 切片）。 */
export interface AlertEventSelectionController {
  selectedEventId: string | null;
  selectedEventIdSet: Set<string>;
  selectedEventIdsCount: number;
  allVisibleSelected: boolean;
  selectedVisibleCount: number;
  hiddenSelectedCount: number;
  toggleSelectAllVisible: (checked: boolean) => void;
  clearHiddenSelection: () => void;
  toggleEventSelection: (eventId: string, checked: boolean) => void;
}

/** 导出控制器：scope/raw 开关状态 + 行数 + CSV/JSON 命令。 */
export interface AlertEventExportController {
  exportScope: AlertExportScope;
  setExportScope: (scope: AlertExportScope) => void;
  includeRawExport: boolean;
  setIncludeRawExport: (checked: boolean) => void;
  exportEventsCount: number;
  exportCsv: () => void;
  exportJson: () => void;
}

/** 状态修改控制器：alerts.manage 门禁 + 批量备注/进度/命令。 */
export interface AlertEventStatusController {
  canManageAlerts: boolean;
  bulkNote: string;
  setBulkNote: (note: string) => void;
  batchProgress: { done: number; total: number } | null;
  updatingStatus: boolean;
  bulkUpdate: (status: "confirmed" | "ignored") => void;
}

/** 分页控制器：URL-backed 分页命令（FE-01 优先级 2/3 写入路径）。 */
export interface AlertEventPaginationController {
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
}

// ---------------------------------------------------------------------------
// 详情域（AlertEventDetail）
// ---------------------------------------------------------------------------

/** 详情展示模型：选中事件 + filtered-out 判定 + 跨页签展示上下文。 */
export interface AlertEventDetailModel {
  selectedEvent: AlertEventItem | null;
  /** 选中事件被当前筛选排除（原判定：index === -1 && filtered.length > 0）。 */
  isFilteredOut: boolean;
  locale: LocaleCode;
  objectKeyLabels: { key: string; label: string }[];
}

/** 详情导航控制器：前后事件 + 行选择 + 深链打开（含 ensureEventLoaded）。 */
export interface AlertEventDetailNavigation {
  previousEventId: string | null;
  nextEventId: string | null;
  selectEvent: (eventId: string) => void;
  openEvent: (eventId: string) => void;
}

/** 详情视图控制器：tab / 展开状态与命令（useAlertEventDetail 切片）。 */
export interface AlertEventDetailView {
  detailTab: string;
  setDetailTab: (tab: string) => void;
  expandMessage: boolean;
  expandContext: boolean;
  toggleExpandMessage: () => void;
  toggleExpandContext: () => void;
}

/** 详情剪贴板控制器：raw context / Markdown 复制命令。 */
export interface AlertEventDetailClipboard {
  copyRawContext: () => void;
  copyAlertMarkdown: () => void;
}

/** 详情分析模型：相似告警 + 规则趋势（useAlertCenterCharts 切片）。 */
export interface AlertEventDetailAnalysis {
  similarAlerts: ChartsResult["similarAlerts"];
  ruleTrendAnalysis: ChartsResult["ruleTrendAnalysis"];
  ruleTrendOption: ChartsResult["ruleTrendOption"];
}

/** 详情 replay 控制器：懒加载门禁下的数据与重载命令。 */
export interface AlertEventDetailReplay {
  replay: ReturnType<typeof useAlertEventDetail>["replay"];
  replayPoints: ReturnType<typeof useAlertEventDetail>["replayPoints"];
  replayLoading: boolean;
  replayError: Error | undefined;
  replayOption: ChartsResult["replayOption"];
  reloadReplay: () => void;
}

/** 详情 feedback 控制器：复核命令 + tuning 建议数据（含权限门禁）。 */
export interface AlertEventDetailFeedback {
  canManageAlerts: boolean;
  feedbackNote: string;
  setFeedbackNote: (note: string) => void;
  updatingStatus: boolean;
  eventStatusUpdate: (status: "confirmed" | "ignored") => void;
  quickConfirm: () => void;
  tuning: {
    data: AlertRuleTuningSuggestionQuery | undefined;
    loading: boolean;
    error: Error | undefined;
  };
}

/** 详情展示主题：图表主题色与字体（useChartTheme 切片）。 */
export interface AlertEventDetailTheme {
  echartsTheme: string;
  colors: { primary: string; accent: string };
  fontFamily: string;
}

// ---------------------------------------------------------------------------
// 装配函数：hook 结果 → 领域对象（纯函数，不产生新行为）
// ---------------------------------------------------------------------------

/** 由 batch hook 结果装配选择控制器。 */
export function buildSelectionController(
  batch: ReturnType<typeof useAlertEventBatch>,
  selectedEventId: string | null,
): AlertEventSelectionController {
  return {
    selectedEventId,
    selectedEventIdSet: batch.selectedEventIdSet,
    selectedEventIdsCount: batch.selectedEventIds.length,
    allVisibleSelected: batch.allVisibleSelected,
    selectedVisibleCount: batch.selectedVisibleCount,
    hiddenSelectedCount: batch.hiddenSelectedCount,
    toggleSelectAllVisible: batch.toggleSelectAllVisible,
    clearHiddenSelection: batch.clearHiddenSelection,
    toggleEventSelection: batch.toggleEventSelection,
  };
}

/** 由选择 hook 结果装配详情导航控制器。 */
export function buildDetailNavigation(
  selection: ReturnType<typeof useAlertEventSelection>,
  openEvent: (eventId: string) => void,
): AlertEventDetailNavigation {
  return {
    previousEventId: selection.previousEventId,
    nextEventId: selection.nextEventId,
    selectEvent: selection.handleSelectEvent,
    openEvent,
  };
}

/** 由 detail hook 结果装配详情视图控制器。 */
export function buildDetailView(
  detail: ReturnType<typeof useAlertEventDetail>,
): AlertEventDetailView {
  return {
    detailTab: detail.detailTab,
    setDetailTab: detail.setDetailTab,
    expandMessage: detail.expandMessage,
    expandContext: detail.expandContext,
    toggleExpandMessage: detail.toggleExpandMessage,
    toggleExpandContext: detail.toggleExpandContext,
  };
}
