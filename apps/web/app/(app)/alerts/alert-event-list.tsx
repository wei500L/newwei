"use client";

import { Button, Card, List, Pagination, Space } from "antd";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";

import { ALERT_URL_PAGE_SIZES } from "./alert-center-url-state";
import type {
  AlertEventExportController,
  AlertEventListModel,
  AlertEventPaginationController,
  AlertEventSelectionController,
  AlertEventStatusController,
} from "./alert-event-controllers";
import { AlertEventListToolbar } from "./alert-event-list-toolbar";
import { AlertEventRow } from "./alert-event-row";
import { useAlertEventVirtualization } from "./hooks/use-alert-event-virtualization";

/**
 * Alert Center 事件列表域（FE-批3B 从 alert-center.tsx 提取，
 * 第四轮收口：消费领域契约而非平铺字段）。
 *
 * - 列表展示模型（model）+ 选择/工具栏/分页三个控制器；
 * - 当前页 List + 行渲染（悬浮摘要/context 摘要/threshold 摘要在行组件）；
 * - 25 条虚拟化阈值 + scrollMargin/spacer（useAlertEventVirtualization）；
 * - 分页：手动分页写入路径（FE-01 优先级 2/3 的 pageSize 与 page 区分）。
 */

export interface AlertEventListProps {
  model: AlertEventListModel;
  selection: AlertEventSelectionController;
  exportController: AlertEventExportController;
  statusController: AlertEventStatusController;
  pagination: AlertEventPaginationController;
  onSelectEvent: (eventId: string) => void;
  onRefresh: () => void;
}

export function AlertEventList({
  model,
  selection,
  exportController,
  statusController,
  pagination,
  onSelectEvent,
  onRefresh,
}: AlertEventListProps) {
  const { t } = useTranslation();
  const {
    currentPageEvents,
    filteredEventsCount,
    eventsLoading,
    locale,
    objectKeyLabels,
  } = model;
  const {
    page: listPage,
    pageSize: listPageSize,
    setPage: onSetPage,
    setPageSize: onSetPageSize,
  } = pagination;

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
          selection={selection}
          exportController={exportController}
          statusController={statusController}
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
                isSelected={entry.event.id === selection.selectedEventId}
                isChecked={selection.selectedEventIdSet.has(entry.event.id)}
                locale={locale}
                objectKeyLabels={objectKeyLabels}
                onToggleChecked={selection.toggleEventSelection}
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
