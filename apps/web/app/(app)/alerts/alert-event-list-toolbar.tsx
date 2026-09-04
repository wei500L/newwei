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

/**
 * Alert Center 事件列表工具栏（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - 批量选择区：Select visible、已选计数、筛选外隐藏选中数 + 清理；
 * - 导出区：scope 两档（selected/page）、行数、includeRaw 开关、
 *   CSV/JSON 按钮；
 * - 批量操作（仅 alerts.manage）：备注输入、批量确认/忽略；
 * - batch progress 条（20 条分批进度展示）。
 */

export type AlertExportScope = "selected" | "page";

export interface AlertEventListToolbarProps {
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
}

export function AlertEventListToolbar({
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
}: AlertEventListToolbarProps) {
  const { t } = useTranslation();

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <div className="flex w-full flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <Space wrap size={[8, 8]} className="w-full md:w-auto">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={selectedVisibleCount > 0 && !allVisibleSelected}
            onChange={(event) => onToggleSelectAllVisible(event.target.checked)}
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
                onClick={onClearHiddenSelection}
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
            onChange={(value) => onSetExportScope(value as AlertExportScope)}
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
            onChange={(event) => onSetIncludeRawExport(event.target.checked)}
          >
            {t("alerts.center.export.includeRaw")}
          </Checkbox>
          {canManageAlerts ? (
            <>
              <Input
                size="small"
                style={{ width: 180 }}
                value={bulkNote}
                onChange={(event) => onSetBulkNote(event.target.value)}
                placeholder={t("alerts.center.batch.notePlaceholder")}
              />
              <Button
                size="small"
                type="primary"
                loading={updatingStatus || Boolean(batchProgress)}
                disabled={selectedEventIdsCount === 0}
                onClick={() => onBulkUpdate("confirmed")}
              >
                {t("alerts.center.batch.confirm")}
              </Button>
              <Button
                size="small"
                loading={updatingStatus || Boolean(batchProgress)}
                disabled={selectedEventIdsCount === 0}
                onClick={() => onBulkUpdate("ignored")}
              >
                {t("alerts.center.batch.ignore")}
              </Button>
            </>
          ) : null}

          <Button
            size="small"
            disabled={exportEventsCount === 0}
            onClick={onExportCsv}
          >
            {t("alerts.center.export.csv")}
          </Button>
          <Button
            size="small"
            disabled={exportEventsCount === 0}
            onClick={onExportJson}
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
