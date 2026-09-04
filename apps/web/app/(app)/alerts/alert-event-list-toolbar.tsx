"use client";

import {
  Button,
  Checkbox,
  Input,
  Progress,
  Segmented,
  Space,
  Tag,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";

import type {
  AlertEventSelectionController,
  AlertEventToolbarController,
} from "./alert-event-controllers";

/**
 * Alert Center 事件列表工具栏（FE-批3B 从 alert-center.tsx 提取，
 * 第四轮收口：按职责消费领域切片而非平铺字段）。
 *
 * - 选择切片：Select visible、已选计数、筛选外隐藏选中数 + 清理；
 * - 批量/导出控制器：scope 两档（selected/page）、行数、includeRaw
 *   开关、CSV/JSON 按钮、批量备注 + 确认/忽略（仅 alerts.manage）、
 *   batch progress 条（20 条分批进度展示）。
 */

export type AlertExportScope = "selected" | "page";

export interface AlertEventListToolbarProps {
  selection: AlertEventSelectionController;
  toolbar: AlertEventToolbarController;
}

export function AlertEventListToolbar({
  selection,
  toolbar,
}: AlertEventListToolbarProps) {
  const { t } = useTranslation();
  const {
    canManageAlerts,
    bulkNote,
    setBulkNote,
    includeRawExport,
    setIncludeRawExport,
    exportScope,
    setExportScope,
    exportEventsCount,
    exportCsv,
    exportJson,
    batchProgress,
    updatingStatus,
    bulkUpdate,
  } = toolbar;
  const {
    selectedEventIdsCount,
    allVisibleSelected,
    selectedVisibleCount,
    hiddenSelectedCount,
    toggleSelectAllVisible,
    clearHiddenSelection,
  } = selection;
  const bulkPending = updatingStatus || Boolean(batchProgress);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <div className="flex w-full flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <Space wrap size={[8, 8]} className="w-full md:w-auto">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={selectedVisibleCount > 0 && !allVisibleSelected}
            onChange={(event) => toggleSelectAllVisible(event.target.checked)}
          >
            {t("alerts.center.batch.selectVisible")}
          </Checkbox>
          <Typography.Text type="secondary">
            {t("alerts.center.batch.selectedCount", {
              count: selectedEventIdsCount,
            })}
          </Typography.Text>
          {hiddenSelectedCount > 0 ? (
            <>
              <Tag color="gold">
                {t("alerts.center.batch.hiddenSelected", {
                  count: hiddenSelectedCount,
                })}
              </Tag>
              <Button
                type="link"
                size="small"
                onClick={clearHiddenSelection}
              >
                {t("alerts.center.batch.clearHidden")}
              </Button>
            </>
          ) : null}
        </Space>

        <Space wrap size={[8, 8]} className="w-full md:w-auto">
          <Segmented
            size="small"
            value={exportScope}
            onChange={(value) => setExportScope(value as AlertExportScope)}
            options={[
              {
                label: t("alerts.center.export.scopeSelected"),
                value: "selected",
              },
              {
                label: t("alerts.center.export.scopePage"),
                value: "page",
              },
            ]}
          />
          <Typography.Text type="secondary">
            {t("alerts.center.export.scopeCount", {
              count: exportEventsCount,
            })}
          </Typography.Text>
          <Checkbox
            checked={includeRawExport}
            onChange={(event) => setIncludeRawExport(event.target.checked)}
          >
            {t("alerts.center.export.includeRaw")}
          </Checkbox>
          {canManageAlerts ? (
            <>
              <Input
                size="small"
                style={{ width: 180 }}
                value={bulkNote}
                onChange={(event) => setBulkNote(event.target.value)}
                placeholder={t("alerts.center.batch.notePlaceholder")}
              />
              <Button
                size="small"
                type="primary"
                loading={bulkPending}
                disabled={selectedEventIdsCount === 0}
                onClick={() => bulkUpdate("confirmed")}
              >
                {t("alerts.center.batch.confirm")}
              </Button>
              <Button
                size="small"
                loading={bulkPending}
                disabled={selectedEventIdsCount === 0}
                onClick={() => bulkUpdate("ignored")}
              >
                {t("alerts.center.batch.ignore")}
              </Button>
            </>
          ) : null}

          <Button
            size="small"
            disabled={exportEventsCount === 0}
            onClick={exportCsv}
          >
            {t("alerts.center.export.csv")}
          </Button>
          <Button
            size="small"
            disabled={exportEventsCount === 0}
            onClick={exportJson}
          >
            {t("alerts.center.export.json")}
          </Button>
        </Space>
      </div>

      {batchProgress ? (
        <Progress
          percent={Math.round(
            (batchProgress.done / Math.max(batchProgress.total, 1)) * 100,
          )}
          size="small"
          status="active"
          format={() =>
            t("alerts.center.batch.progress", {
              done: batchProgress.done,
              total: batchProgress.total,
            })
          }
        />
      ) : null}
    </Space>
  );
}
