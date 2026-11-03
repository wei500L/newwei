"use client";

import { GlobalOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { buildGlobeHref, isValidLatLon } from "@/lib/globe/globe-link";

export interface EventGlobeButtonProps {
  lat?: number | null;
  lon?: number | null;
  /** 事件标题（用于地球上的标签与飞行提示）。 */
  label?: string | null;
}

/**
 * G6：「在 3D 地球查看」入口。没有合法坐标时不渲染。
 *
 * 事件图层的点是国家/地区聚合而不是单个事件，事件 id 在图层里并不存在，
 * 因此这里**不带 `focus`**：只飞到该坐标并用 `label` 显示标题。
 */
export function EventGlobeButton({ lat, lon, label }: EventGlobeButtonProps) {
  const { t } = useTranslation();
  const router = useRouter();
  if (!isValidLatLon(lat, lon)) return null;

  const href = buildGlobeHref({ lat, lon, label });

  return (
    <Button
      type="default"
      icon={<GlobalOutlined />}
      onClick={() => router.push(href)}
    >
      {t("globe.intel.viewOnGlobe")}
    </Button>
  );
}
