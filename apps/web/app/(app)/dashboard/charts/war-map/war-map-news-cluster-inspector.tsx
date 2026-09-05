"use client";

import { Button, List, Space, Tag, Typography } from "antd";
import { formatDateTime } from "@/lib/i18n";

import type { WarMapInspectorContentContext } from "./war-map-inspector-types";
import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  resolveOverlayButtonClassName,
  type RenderableWarMapNewsMarker,
} from "./war-map-overlay-model";

/**
 * News cluster 列表（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 * 成员含打开原文动作（无 url 时禁用）。
 */
export function NewsClusterInspectorContent({
  members,
  context,
}: {
  members: RenderableWarMapNewsMarker[];
  context: WarMapInspectorContentContext;
}) {
  const { locale, t, onOpenNewsLink } = context;
  return (
    <List
      className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [&_.ant-list-item]:!border-[var(--border)] [&_.ant-list-item]:!px-2 [&_.ant-list-item]:!py-3 [&_.ant-list-item-meta-title]:!mb-1 [&_.ant-list-item-meta-description]:!text-slate-600 dark:[&_.ant-list-item-meta-description]:!text-slate-300"
      dataSource={members}
      renderItem={(item) => {
        const timestampLabel = item.publishedAt
          ? t("dashboard.charts.warMap.tooltip.published")
          : item.ingestedAt
            ? t("dashboard.charts.warMap.tooltip.ingested")
            : null;
        const timestamp = item.publishedAt ?? item.ingestedAt;

        return (
          <List.Item
            key={item.id}
            actions={[
              <Button
                key="open"
                size="small"
                type="link"
                className={resolveOverlayButtonClassName({ tone: "link" })}
                disabled={!item.url}
                onClick={() => onOpenNewsLink(item.url)}
              >
                {t("dashboard.charts.warMap.panel.openOriginal")}
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <Typography.Text
                  strong
                  className="block"
                  ellipsis={{ tooltip: item.label }}
                >
                  {item.label}
                </Typography.Text>
              }
              description={
                <div className="flex flex-col gap-2">
                  <Space size={[6, 6]} wrap>
                    <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                      {item.locationLabel}
                    </Tag>
                    <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                      {t(
                        item.geoSource === "fallback-country"
                          ? "dashboard.charts.warMap.stats.fallbackCountry"
                          : "dashboard.charts.warMap.stats.geocoded",
                        {
                          defaultValue:
                            item.geoSource === "fallback-country"
                              ? "Fallback country"
                              : "Geocoded",
                        },
                      )}
                    </Tag>
                  </Space>
                  {timestamp && timestampLabel ? (
                    <Typography.Text type="secondary" className="text-xs">
                      {timestampLabel}:{" "}
                      {formatDateTime(timestamp, locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </Typography.Text>
                  ) : null}
                </div>
              }
            />
          </List.Item>
        );
      }}
    />
  );
}
