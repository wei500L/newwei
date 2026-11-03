"use client";

import { GlobalOutlined } from "@ant-design/icons";
import { Button, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";

import { buildGlobeHref } from "@/lib/globe/globe-link";
import { formatDateTime } from "@/lib/i18n";

import type { WarMapInspectorContentContext } from "./war-map-inspector-types";
import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  resolveOverlayButtonClassName,
  type RenderableWarMapNewsMarker,
} from "./war-map-overlay-model";

/**
 * News 详情（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 * 位置/geoSource 标签、时间与打开原文（经安全回调）。
 */
export function NewsInspectorContent({
  item,
  context,
}: {
  item: RenderableWarMapNewsMarker;
  context: WarMapInspectorContentContext;
}) {
  const { locale, t, onOpenNewsLink } = context;
  const router = useRouter();
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
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
      {item.publishedAt || item.ingestedAt ? (
        <Typography.Text type="secondary">
          {item.publishedAt
            ? t("dashboard.charts.warMap.tooltip.published")
            : t("dashboard.charts.warMap.tooltip.ingested")}
          :{" "}
          {formatDateTime(item.publishedAt ?? item.ingestedAt ?? "", locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </Typography.Text>
      ) : null}
      <Space size={[8, 8]} wrap>
        <NewsOpenOriginalButton
          url={item.url}
          onOpenNewsLink={onOpenNewsLink}
          t={t}
        />
        <Button
          type="link"
          size="small"
          icon={<GlobalOutlined />}
          onClick={() =>
            router.push(
              buildGlobeHref({
                lat: item.lat,
                lon: item.lng,
                label: item.label,
                focus: { layerId: "newwei-news", newweiId: item.id },
              }),
            )
          }
        >
          {t("globe.intel.viewOnGlobe")}
        </Button>
      </Space>
    </div>
  );
}

/** 预留：openOriginal 按钮共享实现（news 详情使用）。 */
export function NewsOpenOriginalButton({
  url,
  onOpenNewsLink,
  t,
}: {
  url: string | null | undefined;
  onOpenNewsLink: (url: string | null | undefined) => void;
  t: WarMapInspectorContentContext["t"];
}) {
  return (
    <Button
      type="default"
      size="small"
      className={resolveOverlayButtonClassName({ tone: "active" })}
      disabled={!url}
      onClick={() => onOpenNewsLink(url)}
    >
      {t("dashboard.charts.warMap.panel.openOriginal")}
    </Button>
  );
}
