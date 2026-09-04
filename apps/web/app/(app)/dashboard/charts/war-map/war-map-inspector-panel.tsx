"use client";

import { CloseOutlined, ExpandOutlined } from "@ant-design/icons";
import type {
  WarMapTransportDetail,
  WarMapTransportTrackPoint,
} from "@modular/utils";
import { Button, Drawer, List, Space, Spin, Tag, Typography } from "antd";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME,
  resolveOverlayButtonClassName,
  severityTagColor,
  type SelectedInspector,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";

export interface WarMapInspectorPanelProps {
  selectedInspector: SelectedInspector | null;
  transportDetail?: WarMapTransportDetail | null;
  transportDetailLoading?: boolean;
  useDesktopInspector: boolean;
  desktopInspectorMinimized: boolean;
  inspectorPanelWidth: number;
  inspectorPanelHeight: number;
  locale: SupportedLocale;
  onZoomToSelectedInspector: () => void;
  onMinimizeInspector: () => void;
  onExpandInspector: () => void;
  onCloseInspector: () => void;
  onOpenNewsLink: (url: string | null | undefined) => void;
  t: WarMapTranslateFn;
}

function getSelectedInspectorTitle(
  selectedInspector: SelectedInspector,
  t: WarMapTranslateFn,
): string {
  if ("item" in selectedInspector) {
    return selectedInspector.item.label;
  }

  return selectedInspector.kind === "event-cluster"
    ? t("dashboard.charts.warMap.panel.signalsSummary", {
        count: selectedInspector.count,
      })
    : t("dashboard.charts.warMap.panel.newsSummary", {
        count: selectedInspector.count,
      });
}

export function WarMapInspectorPanel({
  selectedInspector,
  transportDetail,
  transportDetailLoading,
  useDesktopInspector,
  desktopInspectorMinimized,
  inspectorPanelWidth,
  inspectorPanelHeight,
  locale,
  onZoomToSelectedInspector,
  onMinimizeInspector,
  onExpandInspector,
  onCloseInspector,
  onOpenNewsLink,
  t,
}: WarMapInspectorPanelProps) {
  if (!selectedInspector) {
    return null;
  }

  const selectedInspectorTitle = getSelectedInspectorTitle(selectedInspector, t);
  const inspectorHeaderGradient =
    selectedInspector.kind === "event" ||
    selectedInspector.kind === "event-cluster"
      ? "from-amber-50 via-white to-white dark:from-amber-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]"
      : selectedInspector.kind === "flight"
        ? "from-sky-50 via-white to-white dark:from-sky-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]"
        : selectedInspector.kind === "vessel"
          ? "from-cyan-50 via-white to-white dark:from-cyan-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]"
      : "from-emerald-50 via-white to-white dark:from-emerald-500/10 dark:via-slate-950/95 dark:to-slate-950/[0.92]";

  const inspectorPanelContent = (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-white/[0.92] shadow-2xl backdrop-blur-xl dark:bg-slate-950/[0.78] dark:shadow-[0_26px_56px_-34px_rgba(2,6,23,0.92)]">
      <div
        className={`border-b border-[var(--border)] bg-gradient-to-br ${inspectorHeaderGradient} px-4 py-4`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Typography.Text
              type="secondary"
              className="block text-[11px] uppercase tracking-[0.14em]"
            >
              {selectedInspector.kind === "event" ||
              selectedInspector.kind === "event-cluster"
                ? t("dashboard.charts.warMap.overlay.signalLegend")
                : selectedInspector.kind === "flight"
                  ? t("dashboard.charts.warMap.overlay.flights")
                  : selectedInspector.kind === "vessel"
                    ? t("dashboard.charts.warMap.layerNames.ais")
                : t("dashboard.charts.warMap.overlay.newsLegend")}
            </Typography.Text>
            <Space size={[6, 6]} wrap>
              <Tag
                color={
                  selectedInspector.kind === "event" ||
                  selectedInspector.kind === "event-cluster"
                    ? "gold"
                    : "green"
                }
                className={OVERLAY_STATUS_TAG_CLASS_NAME}
              >
                {selectedInspector.kind === "event" ||
                selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsTitle")
                  : selectedInspector.kind === "flight"
                    ? t("dashboard.charts.warMap.overlay.flights")
                    : selectedInspector.kind === "vessel"
                      ? t("dashboard.charts.warMap.layerNames.ais")
                  : t("dashboard.charts.warMap.panel.newsTitle")}
              </Tag>
              {"count" in selectedInspector ? (
                <Tag color="default" className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.panel.count", {
                    count: selectedInspector.count,
                  })}
                </Tag>
              ) : null}
            </Space>
            <Typography.Title level={5} className="!mb-1 !mt-2 !text-slate-900 dark:!text-slate-50">
              {"item" in selectedInspector
                ? selectedInspector.item.label
                : selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsTitle")
                  : t("dashboard.charts.warMap.panel.newsTitle")}
            </Typography.Title>
            <Typography.Text type="secondary">
              {"item" in selectedInspector
                ? selectedInspector.kind === "event"
                  ? t("dashboard.charts.warMap.panel.signalDetailSummary")
                  : selectedInspector.kind === "flight"
                    ? t("dashboard.charts.warMap.panel.flightDetailSummary")
                    : selectedInspector.kind === "vessel"
                      ? t("dashboard.charts.warMap.panel.vesselDetailSummary")
                  : t("dashboard.charts.warMap.panel.newsDetailSummary")
                : selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsSummary", {
                      count: selectedInspector.count,
                    })
                  : t("dashboard.charts.warMap.panel.newsSummary", {
                      count: selectedInspector.count,
                    })}
            </Typography.Text>
          </div>
          <Space size={8}>
            <Button
              size="small"
              type="default"
              className={resolveOverlayButtonClassName()}
              icon={<ExpandOutlined />}
              onClick={onZoomToSelectedInspector}
            >
              {t("dashboard.charts.warMap.panel.zoomIn")}
            </Button>
            {useDesktopInspector ? (
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName()}
                onClick={onMinimizeInspector}
              >
                {t("common.minimize")}
              </Button>
            ) : null}
            {useDesktopInspector ? (
              <Button
                size="small"
                type="text"
                className={resolveOverlayButtonClassName({
                  tone: "ghost",
                  iconOnly: true,
                })}
                icon={<CloseOutlined />}
                onClick={onCloseInspector}
                aria-label={t("common.close")}
              />
            ) : null}
          </Space>
        </div>
      </div>

      {selectedInspector.kind === "event-cluster" ? (
        <List
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [&_.ant-list-item]:!border-[var(--border)] [&_.ant-list-item]:!px-2 [&_.ant-list-item]:!py-3 [&_.ant-list-item-meta-title]:!mb-1 [&_.ant-list-item-meta-description]:!text-slate-600 dark:[&_.ant-list-item-meta-description]:!text-slate-300"
          dataSource={selectedInspector.members}
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
                        {t("dashboard.charts.warMap.tooltip.alerts")}
                        : {item.alertCount ?? 0}
                      </Tag>
                      <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                        {t("dashboard.charts.warMap.stats.news")}
                        : {item.newsCount ?? 0}
                      </Tag>
                    </Space>
                    {item.latestAt ? (
                      <Typography.Text type="secondary" className="text-xs">
                        {t("dashboard.charts.warMap.panel.latest")}
                        :{" "}
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
      ) : selectedInspector.kind === "news-cluster" ? (
        <List
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [&_.ant-list-item]:!border-[var(--border)] [&_.ant-list-item]:!px-2 [&_.ant-list-item]:!py-3 [&_.ant-list-item-meta-title]:!mb-1 [&_.ant-list-item-meta-description]:!text-slate-600 dark:[&_.ant-list-item-meta-description]:!text-slate-300"
          dataSource={selectedInspector.members}
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
      ) : selectedInspector.kind === "event" ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <Space size={[6, 6]} wrap>
            <Tag
              color={severityTagColor(selectedInspector.item.severity)}
              className={OVERLAY_STATUS_TAG_CLASS_NAME}
            >
              {t(
                `dashboard.charts.warMap.stats.${selectedInspector.item.severity}`,
                {
                  defaultValue:
                    selectedInspector.item.severity.charAt(0).toUpperCase() +
                    selectedInspector.item.severity.slice(1),
                },
              )}
            </Tag>
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.tooltip.alerts")}
              : {selectedInspector.item.alertCount ?? 0}
            </Tag>
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.stats.news")}
              : {selectedInspector.item.newsCount ?? 0}
            </Tag>
          </Space>
          {selectedInspector.item.latestAt ? (
            <Typography.Text type="secondary">
              {t("dashboard.charts.warMap.panel.latest")}
              :{" "}
              {formatDateTime(selectedInspector.item.latestAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
          ) : null}
        </div>
      ) : selectedInspector.kind === "flight" ||
        selectedInspector.kind === "vessel" ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <Space size={[6, 6]} wrap>
            <Tag color="blue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
              {selectedInspector.kind === "flight"
                ? (selectedInspector.item.displayCategoryZh ??
                  selectedInspector.item.displayCategory ??
                  t("dashboard.charts.warMap.overlay.flights"))
                : (selectedInspector.item.shipTypeLabelZh ??
                  selectedInspector.item.shipTypeLabel ??
                  t("dashboard.charts.warMap.stats.aisVessels"))}
            </Tag>
            {selectedInspector.kind === "flight" ? (
              <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                {selectedInspector.item.roleZh ?? selectedInspector.item.role}
              </Tag>
            ) : selectedInspector.item.vesselRoleZh ||
              selectedInspector.item.vesselRole ? (
              <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                {selectedInspector.item.vesselRoleZh ??
                  selectedInspector.item.vesselRole}
              </Tag>
            ) : null}
            {selectedInspector.kind === "vessel" &&
            selectedInspector.item.isMilitaryCandidate ? (
              <Tag color="red" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                {t("dashboard.charts.warMap.legend.aisMilitary")}
              </Tag>
            ) : null}
          </Space>
          <Space size={[6, 6]} wrap>
            {selectedInspector.item.callsign ? (
              <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                {selectedInspector.item.callsign}
              </Tag>
            ) : null}
            {selectedInspector.item.registration ? (
              <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                {selectedInspector.item.registration}
              </Tag>
            ) : null}
            {selectedInspector.item.icao24 ? (
              <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                ICAO24 {selectedInspector.item.icao24.toUpperCase()}
              </Tag>
            ) : null}
            {selectedInspector.item.mmsi ? (
              <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                MMSI {selectedInspector.item.mmsi}
              </Tag>
            ) : null}
          </Space>
          {selectedInspector.item.latestAt ? (
            <Typography.Text type="secondary">
              {t("dashboard.charts.warMap.tooltip.observed")}
              :{" "}
              {formatDateTime(selectedInspector.item.latestAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
          ) : null}
          {selectedInspector.item.sourceUpdatedAt ? (
            <Typography.Text type="secondary">
              {t("dashboard.charts.warMap.tooltip.updated")}
              :{" "}
              {formatDateTime(selectedInspector.item.sourceUpdatedAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
          ) : null}
          {selectedInspector.kind === "flight" ? (
            <Space size={[6, 6]} wrap>
              {selectedInspector.item.countryName ||
              selectedInspector.item.countryCode ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {selectedInspector.item.countryName ??
                    selectedInspector.item.countryCode}
                </Tag>
              ) : null}
              {typeof selectedInspector.item.altitudeFt === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {Math.round(selectedInspector.item.altitudeFt)} ft
                </Tag>
              ) : null}
              {typeof selectedInspector.item.groundSpeedKt === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {Math.round(selectedInspector.item.groundSpeedKt)} kt
                </Tag>
              ) : null}
              {typeof selectedInspector.item.heading === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {Math.round(selectedInspector.item.heading)}°
                </Tag>
              ) : null}
            </Space>
          ) : (
            <Space size={[6, 6]} wrap>
              {typeof selectedInspector.item.speed === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {Math.round(selectedInspector.item.speed)} kn
                </Tag>
              ) : null}
              {typeof selectedInspector.item.heading === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.tooltip.heading")}
                  : {Math.round(selectedInspector.item.heading)}°
                </Tag>
              ) : null}
              {typeof selectedInspector.item.course === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.tooltip.course")}
                  : {Math.round(selectedInspector.item.course)}°
                </Tag>
              ) : null}
            </Space>
          )}

          <div className="rounded-xl border border-[var(--border)] bg-white/70 px-3 py-3 dark:bg-slate-950/55">
            <Typography.Text strong className="block text-xs text-slate-700 dark:text-slate-200">
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
                          ? ` · ${Math.round(point.speed)} ${selectedInspector.kind === "flight" ? "kt" : "kn"}`
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
                {t("dashboard.charts.warMap.panel.trackPointCount")}
                : {transportDetail.summary.pointCount}
              </Tag>
              {typeof transportDetail.summary.totalDistanceKm === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.panel.trackDistance")}
                  : {transportDetail.summary.totalDistanceKm} km
                </Tag>
              ) : null}
              {typeof transportDetail.summary.maxSpeed === "number" ? (
                <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.tooltip.speed")}
                  : {transportDetail.summary.maxSpeed}
                </Tag>
              ) : null}
            </Space>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <Space size={[6, 6]} wrap>
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {selectedInspector.item.locationLabel}
            </Tag>
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t(
                selectedInspector.item.geoSource === "fallback-country"
                  ? "dashboard.charts.warMap.stats.fallbackCountry"
                  : "dashboard.charts.warMap.stats.geocoded",
                {
                  defaultValue:
                    selectedInspector.item.geoSource === "fallback-country"
                      ? "Fallback country"
                      : "Geocoded",
                },
              )}
            </Tag>
          </Space>
          {selectedInspector.item.publishedAt ||
          selectedInspector.item.ingestedAt ? (
            <Typography.Text type="secondary">
              {selectedInspector.item.publishedAt
                ? t("dashboard.charts.warMap.tooltip.published")
                : t("dashboard.charts.warMap.tooltip.ingested")}
              :{" "}
              {formatDateTime(
                selectedInspector.item.publishedAt ??
                  selectedInspector.item.ingestedAt ??
                  "",
                locale,
                {
                  dateStyle: "medium",
                  timeStyle: "short",
                },
              )}
            </Typography.Text>
          ) : null}
          <Button
            type="default"
            size="small"
            className={resolveOverlayButtonClassName({ tone: "active" })}
            disabled={!selectedInspector.item.url}
            onClick={() => onOpenNewsLink(selectedInspector.item.url)}
          >
            {t("dashboard.charts.warMap.panel.openOriginal")}
          </Button>
        </div>
      )}
    </div>
  );

  if (useDesktopInspector && !desktopInspectorMinimized) {
    return (
      <div className="pointer-events-none absolute bottom-4 right-4 z-20">
        <div
          className="pointer-events-auto transition-all duration-200"
          style={{
            width: inspectorPanelWidth,
            height: inspectorPanelHeight,
          }}
        >
          {inspectorPanelContent}
        </div>
      </div>
    );
  }

  if (useDesktopInspector && desktopInspectorMinimized) {
    return (
      <div className="pointer-events-none absolute bottom-4 right-4 z-20">
        <div
          className={`${OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME} pointer-events-auto flex items-center gap-3 px-3 py-2`}
          style={{ width: inspectorPanelWidth }}
        >
          <div className="min-w-0 flex-1">
            <Typography.Text
              type="secondary"
              className="block text-[11px] uppercase tracking-[0.14em]"
            >
              {selectedInspector.kind === "event" ||
              selectedInspector.kind === "event-cluster"
                ? t("dashboard.charts.warMap.panel.signalsTitle")
                : selectedInspector.kind === "flight"
                  ? t("dashboard.charts.warMap.overlay.flights")
                  : selectedInspector.kind === "vessel"
                    ? t("dashboard.charts.warMap.layerNames.ais")
                : t("dashboard.charts.warMap.panel.newsTitle")}
            </Typography.Text>
            <Typography.Text strong className="block truncate text-sm text-slate-900 dark:text-slate-100">
              {selectedInspectorTitle}
            </Typography.Text>
          </div>
          <Button
            size="small"
            type="default"
            className={resolveOverlayButtonClassName({ tone: "active" })}
            onClick={onExpandInspector}
          >
            {t("dashboard.charts.warMap.overlay.expandInspector")}
          </Button>
          <Button
            size="small"
            type="text"
            className={resolveOverlayButtonClassName({
              tone: "ghost",
              iconOnly: true,
            })}
            icon={<CloseOutlined />}
            onClick={onCloseInspector}
            aria-label={t("common.close")}
          />
        </div>
      </div>
    );
  }

  return (
    <Drawer
      open
      onClose={onCloseInspector}
      placement="right"
      width="100%"
      destroyOnClose={false}
      title={null}
    >
      {inspectorPanelContent}
    </Drawer>
  );
}
