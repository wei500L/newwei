"use client";

import type {
  WarMapTransportDetail,
  WarMapTransportTrackPoint,
} from "@modular/utils";
import { List, Space, Spin, Tag, Typography } from "antd";
import { formatDateTime } from "@/lib/i18n";

import type { WarMapInspectorContentContext } from "./war-map-inspector-types";
import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  type RenderableWarMapTransportSelection,
} from "./war-map-overlay-model";

/**
 * Flight/Vessel 详情（FE-批4B：自 war-map-inspector-panel.tsx 拆出）。
 * 最新状态标签、单位格式与最近轨迹点（上限 20）。
 */
export function TransportInspectorContent({
  kind,
  item,
  transportDetail,
  transportDetailLoading,
  context,
}: {
  kind: "flight" | "vessel";
  item: RenderableWarMapTransportSelection;
  transportDetail: WarMapTransportDetail | null | undefined;
  transportDetailLoading: boolean;
  context: WarMapInspectorContentContext;
}) {
  const { locale, t } = context;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      <Space size={[6, 6]} wrap>
        <Tag color="blue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
          {kind === "flight"
            ? (item.displayCategoryZh ??
              item.displayCategory ??
              t("dashboard.charts.warMap.overlay.flights"))
            : (item.shipTypeLabelZh ??
              item.shipTypeLabel ??
              t("dashboard.charts.warMap.stats.aisVessels"))}
        </Tag>
        {kind === "flight" ? (
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
            {item.roleZh ?? item.role}
          </Tag>
        ) : item.vesselRoleZh || item.vesselRole ? (
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
            {item.vesselRoleZh ?? item.vesselRole}
          </Tag>
        ) : null}
        {kind === "vessel" && item.isMilitaryCandidate ? (
          <Tag color="red" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.legend.aisMilitary")}
          </Tag>
        ) : null}
      </Space>
      <Space size={[6, 6]} wrap>
        {item.callsign ? (
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>{item.callsign}</Tag>
        ) : null}
        {item.registration ? (
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
            {item.registration}
          </Tag>
        ) : null}
        {item.icao24 ? (
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
            ICAO24 {item.icao24.toUpperCase()}
          </Tag>
        ) : null}
        {item.mmsi ? (
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>MMSI {item.mmsi}</Tag>
        ) : null}
      </Space>
      {item.latestAt ? (
        <Typography.Text type="secondary">
          {t("dashboard.charts.warMap.tooltip.observed")}:{" "}
          {formatDateTime(item.latestAt, locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </Typography.Text>
      ) : null}
      {item.sourceUpdatedAt ? (
        <Typography.Text type="secondary">
          {t("dashboard.charts.warMap.tooltip.updated")}:{" "}
          {formatDateTime(item.sourceUpdatedAt, locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </Typography.Text>
      ) : null}
      {kind === "flight" ? (
        <Space size={[6, 6]} wrap>
          {item.countryName || item.countryCode ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {item.countryName ?? item.countryCode}
            </Tag>
          ) : null}
          {typeof item.altitudeFt === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {Math.round(item.altitudeFt)} ft
            </Tag>
          ) : null}
          {typeof item.groundSpeedKt === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {Math.round(item.groundSpeedKt)} kt
            </Tag>
          ) : null}
          {typeof item.heading === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {Math.round(item.heading)}°
            </Tag>
          ) : null}
        </Space>
      ) : (
        <Space size={[6, 6]} wrap>
          {typeof item.speed === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {Math.round(item.speed)} kn
            </Tag>
          ) : null}
          {typeof item.heading === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.tooltip.heading")}:{" "}
              {Math.round(item.heading)}°
            </Tag>
          ) : null}
          {typeof item.course === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.tooltip.course")}:{" "}
              {Math.round(item.course)}°
            </Tag>
          ) : null}
        </Space>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-white/70 px-3 py-3 dark:bg-slate-950/55">
        <Typography.Text
          strong
          className="block text-xs text-slate-700 dark:text-slate-200"
        >
          {t("dashboard.charts.warMap.panel.recentTrackPoints")}
        </Typography.Text>
        {transportDetailLoading ? (
          <div className="py-4 text-center">
            <Spin size="small" />
          </div>
        ) : transportDetail?.trackPoints?.length ? (
          <List<WarMapTransportTrackPoint>
            className="mt-2 [&_.ant-list-item]:!border-[var(--border)] [&_.ant-list-item]:!px-0 [&_.ant-list-item]:!py-2"
            dataSource={transportDetail.trackPoints.slice(0, 20)}
            renderItem={(point) => (
              <List.Item key={point.id}>
                <div className="flex w-full flex-col gap-1 text-xs">
                  <Typography.Text>
                    {formatDateTime(point.observedAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {point.lat.toFixed(3)}, {point.lng.toFixed(3)}
                    {typeof point.speed === "number"
                      ? ` · ${Math.round(point.speed)} ${kind === "flight" ? "kt" : "kn"}`
                      : ""}
                    {typeof point.heading === "number"
                      ? ` · ${Math.round(point.heading)}°`
                      : ""}
                  </Typography.Text>
                </div>
              </List.Item>
            )}
          />
        ) : (
          <Typography.Text type="secondary" className="mt-2 block text-xs">
            {t("dashboard.charts.warMap.panel.noTrackPoints")}
          </Typography.Text>
        )}
      </div>
      {transportDetail?.summary ? (
        <Space size={[6, 6]} wrap>
          <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
            {t("dashboard.charts.warMap.panel.trackPointCount")}:{" "}
            {transportDetail.summary.pointCount}
          </Tag>
          {typeof transportDetail.summary.totalDistanceKm === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.panel.trackDistance")}:{" "}
              {transportDetail.summary.totalDistanceKm} km
            </Tag>
          ) : null}
          {typeof transportDetail.summary.maxSpeed === "number" ? (
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.tooltip.speed")}:{" "}
              {transportDetail.summary.maxSpeed}
            </Tag>
          ) : null}
        </Space>
      ) : null}
    </div>
  );
}
