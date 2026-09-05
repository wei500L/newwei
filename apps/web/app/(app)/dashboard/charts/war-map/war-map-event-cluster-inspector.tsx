"use client";

import { List, Space, Tag, Typography } from "antd";

import { formatDateTime } from "@/lib/i18n";

import type { WarMapInspectorContentContext } from "./war-map-inspector-types";
import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  severityTagColor,
  type RenderableWarMapEvent,
} from "./war-map-overlay-model";

/**
 * Event cluster 列表（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 */
export function EventClusterInspectorContent({
  members,
  context,
}: {
  members: RenderableWarMapEvent[];
  context: WarMapInspectorContentContext;
}) {
  const { locale, t } = context;
  return (
    <List
      className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [&_.ant-list-item]:!border-[var(--border)] [&_.ant-list-item]:!px-2 [&_.ant-list-item]:!py-3 [&_.ant-list-item-meta-title]:!mb-1 [&_.ant-list-item-meta-description]:!text-slate-600 dark:[&_.ant-list-item-meta-description]:!text-slate-300"
      dataSource={members}
      renderItem={(item) => (
        <List.Item key={item.id}>
          <List.Item.Meta
            title={
              <div className="flex items-start justify-between gap-3">
                <Typography.Text strong>{item.label}</Typography.Text>
                <Tag
                  color={severityTagColor(item.severity)}
                  className={OVERLAY_STATUS_TAG_CLASS_NAME}
                >
                  {t(`dashboard.charts.warMap.stats.${item.severity}`, {
                    defaultValue:
                      item.severity.charAt(0).toUpperCase() +
                      item.severity.slice(1),
                  })}
                </Tag>
              </div>
            }
            description={
              <div className="flex flex-col gap-2">
                <Space size={[6, 6]} wrap>
                  <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                    {t("dashboard.charts.warMap.tooltip.alerts")}:{" "}
                    {item.alertCount ?? 0}
                  </Tag>
                  <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                    {t("dashboard.charts.warMap.stats.news")}:{" "}
                    {item.newsCount ?? 0}
                  </Tag>
                </Space>
                {item.latestAt ? (
                  <Typography.Text type="secondary" className="text-xs">
                    {t("dashboard.charts.warMap.panel.latest")}:{" "}
                    {formatDateTime(item.latestAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Typography.Text>
                ) : null}
              </div>
            }
          />
        </List.Item>
      )}
    />
  );
}

/**
 * Event 详情（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 */
export function EventInspectorContent({
  item,
  context,
}: {
  item: RenderableWarMapEvent;
  context: WarMapInspectorContentContext;
}) {
  const { locale, t } = context;
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      <Space size={[6, 6]} wrap>
        <Tag
          color={severityTagColor(item.severity)}
          className={OVERLAY_STATUS_TAG_CLASS_NAME}
        >
          {t(`dashboard.charts.warMap.stats.${item.severity}`, {
            defaultValue:
              item.severity.charAt(0).toUpperCase() + item.severity.slice(1),
          })}
        </Tag>
        <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
          {t("dashboard.charts.warMap.tooltip.alerts")}: {item.alertCount ?? 0}
        </Tag>
        <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
          {t("dashboard.charts.warMap.stats.news")}: {item.newsCount ?? 0}
        </Tag>
      </Space>
      {item.latestAt ? (
        <Typography.Text type="secondary">
          {t("dashboard.charts.warMap.panel.latest")}:{" "}
          {formatDateTime(item.latestAt, locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </Typography.Text>
      ) : null}
    </div>
  );
}
