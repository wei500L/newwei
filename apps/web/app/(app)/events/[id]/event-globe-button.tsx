"use client";

import { GlobalOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { buildGlobeHref, isValidLatLon } from "@/lib/globe/globe-link";

export interface EventGlobeButtonProps {
  lat?: number | null;
  lon?: number | null;
  /** 事件标题（用于地球上的标签与飞行提示）。 */
  label?: string | null;
  /** 事件 id（用于地球上的 focus 选中）。 */
  eventId?: string | null;
}

/**
 * G6：「在 3D 地球查看」入口。没有合法坐标时不渲染。
 */
export function EventGlobeButton({
  lat,
  lon,
  label,
  eventId,
}: EventGlobeButtonProps) {
  const { t } = useTranslation();
  if (!isValidLatLon(lat, lon)) return null;

  const href = buildGlobeHref({
    lat,
    lon,
    label,
    focus: eventId
      ? { layerId: "newwei-events", newweiId: String(eventId) }
      : undefined,
  });

  return (
    <Button type="default" icon={<GlobalOutlined />} href={href}>
      {t("globe.intel.viewOnGlobe")}
    </Button>
  );
}
