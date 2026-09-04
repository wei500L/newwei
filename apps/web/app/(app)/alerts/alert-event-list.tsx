"use client";

import { Button, Card, List, Pagination, Space } from "antd";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import type { resolveLocale } from "@/lib/i18n";

import type { AlertEventItem } from "./alert-center-list-model";
import { ALERT_URL_PAGE_SIZES } from "./alert-center-url-state";
import { AlertEventListToolbar, type AlertExportScope } from "./alert-event-list-toolbar";
import { AlertEventRow } from "./alert-event-row";
import { useAlertEventVirtualization } from "./hooks/use-alert-event-virtualization";

/**
 * Alert Center 事件列表域（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - 当前页 List + 行渲染（悬浮摘要/context 摘要/threshold 摘要在行组件）；
 * - 25 条虚拟化阈值 + scrollMargin/spacer（useAlertEventVirtualization）；
 * - 工具栏（选择计数/导出 scope/批量操作/进度）在 alert-event-list-toolbar；
 * - 分页：手动分页写入路径（FE-01 优先级 2/3 的 pageSize 与 page 区分）。
 */

export interface AlertEventListProps {
  currentPageEvents: AlertEventItem[];
  filteredEventsCount: number;
  selectedEventId: string | null;
  selectedEventIdSet: Set<string>;
  locale: ReturnType<typeof resolveLocale>;
  objectKeyLabels: { key: string; label: string }[];
  listPage: number;
  listPageSize: number;
  eventsLoading: boolean;
  canManageAlerts: boolean;
  selectedEventIdsCount: number;
  allVisibleSelected: boolean;
  selectedVisibleCount: number;
  hiddenSelectedCount: number;
  exportScope: AlertExportScope;
  exportEventsCount: number;
  includeRawExport: boolean;
  bulkNote: string;
  batchProgress: { done: number; total: number } | null;
  updatingStatus: boolean;
  onToggleSelectAllVisible: (checked: boolean) => void;
  onClearHiddenSelection: () => void;
  onSetExportScope: (scope: AlertExportScope) => void;
  onSetIncludeRawExport: (checked: boolean) => void;
  onSetBulkNote: (note: string) => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  onBulkUpdate: (status: "confirmed" | "ignored") => void;
  onToggleEventSelection: (eventId: string, checked: boolean) => void;
  onSelectEvent: (eventId: string) => void;
  onSetPage: (page: number) => void;
  onSetPageSize: (pageSize: number) => void;
  onRefresh: () => void;
}

export function AlertEventList({
  currentPageEvents,
  filteredEventsCount,
  selectedEventId,
  selectedEventIdSet,
  locale,
  objectKeyLabels,
  listPage,
  listPageSize,
  eventsLoading,
  canManageAlerts,
  selectedEventIdsCount,
  allVisibleSelected,
  selectedVisibleCount,
  hiddenSelectedCount,
  exportScope,
  exportEventsCount,
  includeRawExport,
  bulkNote,
  batchProgress,
  updatingStatus,
  onToggleSelectAllVisible,
  onClearHiddenSelection,
  onSetExportScope,
  onSetIncludeRawExport,
  onSetBulkNote,
  onExportCsv,
  onExportJson,
  onBulkUpdate,
  onToggleEventSelection,
  onSelectEvent,
  onSetPage,
  onSetPageSize,
  onRefresh,
}: AlertEventListProps) {
  const { t } = useTranslation();

  const {
    eventsListRef,
    topSpacer,
    bottomSpacer,
    entries,
    shouldVirtualize,
  } = useAlertEventVirtualization(currentPageEvents);

  return (
    <Card
      className="content-card"
      title={t("alerts.center.eventsTitle")}
      extra={
        <Button size="small" onClick={onRefresh}>
          {t("common.refresh")}
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <AlertEventListToolbar
          canManageAlerts={canManageAlerts}
          selectedEventIdsCount={selectedEventIdsCount}
          allVisibleSelected={allVisibleSelected}
          selectedVisibleCount={selectedVisibleCount}
          hiddenSelectedCount={hiddenSelectedCount}
          exportScope={exportScope}
          exportEventsCount={exportEventsCount}
          includeRawExport={includeRawExport}
          bulkNote={bulkNote}
          batchProgress={batchProgress}
          updatingStatus={updatingStatus}
          onToggleSelectAllVisible={onToggleSelectAllVisible}
          onClearHiddenSelection={onClearHiddenSelection}
          onSetExportScope={onSetExportScope}
          onSetIncludeRawExport={onSetIncludeRawExport}
          onSetBulkNote={onSetBulkNote}
          onExportCsv={onExportCsv}
          onExportJson={onExportJson}
          onBulkUpdate={onBulkUpdate}
        />

        <div ref={eventsListRef}>
          <List
            loading={eventsLoading}
            dataSource={entries}
            header={
              shouldVirtualize && topSpacer > 0 ? (
                <div style={{ height: topSpacer }} />
              ) : null
            }
            footer={
              shouldVirtualize && bottomSpacer > 0 ? (
                <div style={{ height: bottomSpacer }} />
              ) : null
            }
            locale={{
              emptyText: (
                <ChartEmptyState
                  className="h-auto py-6"
                  description={t("alerts.center.emptyEvents")}
                />
              ),
            }}
            renderItem={(entry) => (
              <AlertEventRow
                event={entry.event}
                isSelected={entry.event.id === selectedEventId}
                isChecked={selectedEventIdSet.has(entry.event.id)}
                locale={locale}
                objectKeyLabels={objectKeyLabels}
                onToggleChecked={onToggleEventSelection}
                onSelectEvent={onSelectEvent}
              />
            )}
          />
        </div>

        {filteredEventsCount > listPageSize ? (
          <Pagination
            size="small"
            current={listPage}
            pageSize={listPageSize}
            total={filteredEventsCount}
            showSizeChanger
            pageSizeOptions={[...ALERT_URL_PAGE_SIZES]}
            onChange={(page, pageSize) => {
              if (pageSize !== listPageSize) {
                // 用户改 pageSize（优先级 3）：page 重置 1 且清除旧
                // eventId；不采纳 antd 传入的 page，避免停留在旧行号
                // 对应的页码
                onSetPageSize(pageSize);
                return;
              }
              // 用户翻页（优先级 2）：分页意图优先，setPage 清除与
              // 分页冲突的旧 eventId，页面稳定停留目标页
              onSetPage(page);
            }}
            showTotal={(total, range) =>
              t("alerts.center.batch.pageSummary", {
                start: total === 0 ? 0 : range[0],
                end: total === 0 ? 0 : range[1],
                total,
              })
            }
          />
        ) : null}
      </Space>
    </Card>
  );
}
