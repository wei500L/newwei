"use client";

import { CloseOutlined, ExpandOutlined } from "@ant-design/icons";
import { Button, Drawer, List, Space, Tag, Typography } from "antd";

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
        defaultValue: "{{count}} nearby signals",
        count: selectedInspector.count,
      })
    : t("dashboard.charts.warMap.panel.newsSummary", {
        defaultValue: "{{count}} nearby news items",
        count: selectedInspector.count,
      });
}

export function WarMapInspectorPanel({
  selectedInspector,
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
                ? t("dashboard.charts.warMap.overlay.signalLegend", {
                    defaultValue: "Signals",
                  })
                : t("dashboard.charts.warMap.overlay.newsLegend", {
                    defaultValue: "News & monitors",
                  })}
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
                  ? t("dashboard.charts.warMap.panel.signalsTitle", {
                      defaultValue: "Nearby signals",
                    })
                  : t("dashboard.charts.warMap.panel.newsTitle", {
                      defaultValue: "Nearby news",
                    })}
              </Tag>
              {"count" in selectedInspector ? (
                <Tag color="default" className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.panel.count", {
                    defaultValue: "{{count}} items",
                    count: selectedInspector.count,
                  })}
                </Tag>
              ) : null}
            </Space>
            <Typography.Title level={5} className="!mb-1 !mt-2 !text-slate-900 dark:!text-slate-50">
              {"item" in selectedInspector
                ? selectedInspector.item.label
                : selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsTitle", {
                      defaultValue: "Nearby signals",
                    })
                  : t("dashboard.charts.warMap.panel.newsTitle", {
                      defaultValue: "Nearby news",
                    })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {"item" in selectedInspector
                ? selectedInspector.kind === "event"
                  ? t("dashboard.charts.warMap.panel.signalDetailSummary", {
                      defaultValue: "Signal details for the selected location.",
                    })
                  : t("dashboard.charts.warMap.panel.newsDetailSummary", {
                      defaultValue: "News details for the selected marker.",
                    })
                : selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsSummary", {
                      defaultValue:
                        "{{count}} nearby signals at this zoom level.",
                      count: selectedInspector.count,
                    })
                  : t("dashboard.charts.warMap.panel.newsSummary", {
                      defaultValue:
                        "{{count}} nearby news items at this zoom level.",
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
              {t("dashboard.charts.warMap.panel.zoomIn", {
                defaultValue: "Zoom in",
              })}
            </Button>
            {useDesktopInspector ? (
              <Button
                size="small"
                type="default"
                className={resolveOverlayButtonClassName()}
                onClick={onMinimizeInspector}
              >
                {t("common.minimize", { defaultValue: "Minimize" })}
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
                aria-label={t("common.close", {
                  defaultValue: "Close",
                })}
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
                        {t("dashboard.charts.warMap.tooltip.alerts", {
                          defaultValue: "Alerts",
                        })}
                        : {item.alertCount ?? 0}
                      </Tag>
                      <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
                        {t("dashboard.charts.warMap.stats.news", {
                          defaultValue: "News",
                        })}
                        : {item.newsCount ?? 0}
                      </Tag>
                    </Space>
                    {item.latestAt ? (
                      <Typography.Text type="secondary" className="text-xs">
                        {t("dashboard.charts.warMap.panel.latest", {
                          defaultValue: "Latest",
                        })}
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
              ? t("dashboard.charts.warMap.tooltip.published", {
                  defaultValue: "Published",
                })
              : item.ingestedAt
                ? t("dashboard.charts.warMap.tooltip.ingested", {
                    defaultValue: "Ingested",
                  })
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
                    {t("dashboard.charts.warMap.panel.openOriginal", {
                      defaultValue: "Open",
                    })}
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
              {t("dashboard.charts.warMap.tooltip.alerts", {
                defaultValue: "Alerts",
              })}
              : {selectedInspector.item.alertCount ?? 0}
            </Tag>
            <Tag className={OVERLAY_NEUTRAL_TAG_CLASS_NAME}>
              {t("dashboard.charts.warMap.stats.news", {
                defaultValue: "News",
              })}
              : {selectedInspector.item.newsCount ?? 0}
            </Tag>
          </Space>
          {selectedInspector.item.latestAt ? (
            <Typography.Text type="secondary">
              {t("dashboard.charts.warMap.panel.latest", {
                defaultValue: "Latest",
              })}
              :{" "}
              {formatDateTime(selectedInspector.item.latestAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
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
                ? t("dashboard.charts.warMap.tooltip.published", {
                    defaultValue: "Published",
                  })
                : t("dashboard.charts.warMap.tooltip.ingested", {
                    defaultValue: "Ingested",
                  })}
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
            {t("dashboard.charts.warMap.panel.openOriginal", {
              defaultValue: "Open original",
            })}
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
                ? t("dashboard.charts.warMap.panel.signalsTitle", {
                    defaultValue: "Nearby signals",
                  })
                : t("dashboard.charts.warMap.panel.newsTitle", {
                    defaultValue: "Nearby news",
                  })}
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
            {t("dashboard.charts.warMap.overlay.expandInspector", {
              defaultValue: "Expand details",
            })}
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
            aria-label={t("common.close", {
              defaultValue: "Close",
            })}
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
