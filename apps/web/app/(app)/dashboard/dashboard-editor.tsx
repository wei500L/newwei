"use client";

import { Button, Card, Input, Select, Space, Typography, message } from "antd";
import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { useEffect, useMemo } from "react";
import type { Layout } from "react-grid-layout";
import { useTranslation } from "react-i18next";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { TimeRangeControls } from "@/components/time-range-controls";
import type {
  DashboardsQuery,
  DashboardWidgetType as GraphqlDashboardWidgetType,
  UpsertDashboardInput,
} from "@/graphql/generated";
import { useDashboardEditorStore, type DashboardWidgetType } from "@/store/dashboard-editor";

import { WidgetRenderer } from "./charts/widget-renderer";

type GridLayoutComponent = ComponentType<Record<string, unknown>>;

const ResponsiveGridLayout = dynamic(
  () =>
    import("react-grid-layout").then((mod) => {
      const responsive =
        mod.Responsive ??
        (typeof mod.default === "function" || typeof mod.default === "object"
          ? (mod.default as { Responsive?: unknown }).Responsive
          : undefined);

      const widthProvider =
        mod.WidthProvider ??
        (typeof mod.default === "function" || typeof mod.default === "object"
          ? (mod.default as { WidthProvider?: unknown }).WidthProvider
          : undefined);

      if (typeof responsive !== "function" || typeof widthProvider !== "function") {
        throw new Error("react-grid-layout exports are not available");
      }

      return (widthProvider as (component: GridLayoutComponent) => GridLayoutComponent)(responsive as GridLayoutComponent);
    }),
  {
    ssr: false,
  },
);

const defaultWidgetSize: Record<DashboardWidgetType, { w: number; h: number }> =
  {
    line: { w: 4, h: 6 },
    bar: { w: 4, h: 6 },
    pie: { w: 3, h: 5 },
    scatter: { w: 4, h: 6 },
    kline: { w: 5, h: 7 },
    radar: { w: 4, h: 6 },
    table: { w: 6, h: 8 },
  };

const datasourceOptions = [
  { labelKey: "dashboard.editor.dataSources.sp500", value: "economic:sp500_index" },
  { labelKey: "dashboard.editor.dataSources.nasdaq", value: "economic:nasdaq_index" },
  { labelKey: "dashboard.editor.dataSources.dowjones", value: "economic:dowjones_index" },
  { labelKey: "dashboard.editor.dataSources.usdIndex", value: "economic:usd_index_history" },
  { labelKey: "dashboard.editor.dataSources.brentOil", value: "economic:brent_oil_price" },
  { labelKey: "dashboard.editor.dataSources.cmeBitcoin", value: "economic:crypto_bitcoin_cme" },
  { labelKey: "dashboard.editor.dataSources.cryptoSpot", value: "economic:crypto_js_spot" },
];

type DashboardRecord = DashboardsQuery["dashboards"][number] | undefined;

interface DashboardEditorProps {
  dashboard?: DashboardRecord;
  saving?: boolean;
  onSave: (input: UpsertDashboardInput) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

export function DashboardEditor({
  dashboard,
  saving,
  onSave,
  onDelete,
}: DashboardEditorProps) {
  const { t } = useTranslation();
  const {
    widgets,
    addWidget,
    updateWidget,
    updateLayout,
    removeWidget,
    name,
    slug,
    description,
    primaryColor,
    setMeta,
    reset,
    setWidgets,
  } = useDashboardEditorStore();

  useEffect(() => {
    if (!dashboard) {
      reset();
      return;
    }
    setMeta({
      name: dashboard.name,
      slug: dashboard.slug,
      description: dashboard.description ?? undefined,
    });
    const configPrimaryColor = (() => {
      const config = dashboard.config;
      if (!config || typeof config !== "object") {
        return undefined;
      }
      const raw = (config as Record<string, unknown>).primaryColor;
      return typeof raw === "string" ? raw : undefined;
    })();

    if (configPrimaryColor) {
      setMeta({ primaryColor: configPrimaryColor });
    }
    setWidgets(
      dashboard.widgets.map((widget, idx) => ({
        id: widget.id ?? `temp-${idx}`,
        title: widget.title ?? undefined,
        type: widget.type as DashboardWidgetType,
        dataSource: widget.dataSource,
        dataConfig: widget.dataConfig ?? undefined,
        layout: {
          x: widget.layoutX,
          y: widget.layoutY,
          w: widget.layoutW,
          h: widget.layoutH,
        },
        sortOrder: widget.sortOrder ?? 0,
        options: widget.options ?? undefined,
      })),
    );
  }, [dashboard, reset, setMeta, setWidgets]);

  const layouts = useMemo(
    () => ({
      lg: widgets.map((widget) => ({
        i: widget.id,
        x: widget.layout.x,
        y: widget.layout.y,
        w: widget.layout.w,
        h: widget.layout.h,
      })),
    }),
    [widgets],
  );

  const handleAddWidget = (type: DashboardWidgetType) => {
    if (!datasourceOptions.length) {
      return;
    }
    const size = defaultWidgetSize[type];
    const defaultDataSource = datasourceOptions[0]?.value ?? "economic:default";
    addWidget({
      type,
      title: t("dashboard.editor.widgetTitle", { type }),
      dataSource: defaultDataSource,
      layout: { x: 0, y: Infinity, w: size.w, h: size.h },
      options: {},
      dataConfig: {},
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title={t("dashboard.editor.layoutTitle")} extra={<TimeRangeControls />}>
        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Space wrap>
            <Input
              style={{ width: 220 }}
              value={name}
              placeholder={t("dashboard.editor.fields.name")}
              onChange={(e) => setMeta({ name: e.target.value })}
            />
            <Input
              style={{ width: 200 }}
              value={slug}
              placeholder={t("dashboard.editor.fields.slug")}
              onChange={(e) => setMeta({ slug: e.target.value })}
            />
            <Input
              style={{ width: 320 }}
              value={description}
              placeholder={t("dashboard.editor.fields.description")}
              onChange={(e) => setMeta({ description: e.target.value })}
            />
            <Select
              style={{ width: 120 }}
              value={
                (dashboard?.theme as "light" | "dark" | undefined) ?? "light"
              }
              options={[
                { label: t("dashboard.editor.theme.light"), value: "light" },
                { label: t("dashboard.editor.theme.dark"), value: "dark" },
              ]}
              onChange={(theme) => setMeta({ theme })}
            />
            <Space align="center">
              <Typography.Text type="secondary">{t("dashboard.editor.fields.primary")}</Typography.Text>
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setMeta({ primaryColor: e.target.value })}
                style={{
                  width: 48,
                  height: 32,
                  border: "none",
                  background: "transparent",
                  padding: 0,
                }}
              />
            </Space>
            <Space>
              <Button
                type="primary"
                loading={saving}
                onClick={async () => {
                  const payload: UpsertDashboardInput = {
                    id: dashboard?.id,
                    version: dashboard?.version ?? undefined,
                    name,
                    slug,
                    description: description ?? undefined,
                    theme: dashboard?.theme ?? "light",
                    config: { primaryColor },
                    widgets: widgets.map((widget) => ({
                      id: widget.id.startsWith("temp-") ? undefined : widget.id,
                      title: widget.title,
                      type: widget.type as unknown as GraphqlDashboardWidgetType,
                      dataSource: widget.dataSource,
                      dataConfig: widget.dataConfig ?? {},
                      layoutX: widget.layout.x,
                      layoutY: widget.layout.y,
                      layoutW: widget.layout.w,
                      layoutH: widget.layout.h,
                      sortOrder: widget.sortOrder,
                      options: widget.options ?? {},
                    })),
                  };
                  try {
                    await onSave(payload);
                    message.success(t("dashboard.editor.saved"));
                  } catch (error: unknown) {
                    const errorMessage =
                      error instanceof Error ? error.message : t("dashboard.editor.saveFailed");
                    message.error(errorMessage);
                  }
                }}
              >
                {t("common.save")}
              </Button>
              {dashboard?.id && onDelete ? (
                <Button danger onClick={() => onDelete(dashboard.id)}>
                  {t("common.delete")}
                </Button>
              ) : null}
              <Button onClick={() => reset()}>{t("common.reset")}</Button>
            </Space>
          </Space>
        </Space>
        <Space wrap>
          <Button onClick={() => handleAddWidget("line")}>{t("dashboard.editor.add.line")}</Button>
          <Button onClick={() => handleAddWidget("bar")}>{t("dashboard.editor.add.bar")}</Button>
          <Button onClick={() => handleAddWidget("pie")}>{t("dashboard.editor.add.pie")}</Button>
          <Button onClick={() => handleAddWidget("kline")}>{t("dashboard.editor.add.kline")}</Button>
        </Space>
      </Card>
      <ResponsiveGridLayout
        className="layout"
        layouts={layouts}
        cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
        rowHeight={30}
        isResizable
        isDraggable
        margin={[16, 16]}
        onLayoutChange={(layout: Layout[]) => updateLayout(layout)}
      >
        {widgets.map((widget) => (
          <div
            key={widget.id}
            data-grid={{
              x: widget.layout.x,
              y: widget.layout.y,
              w: widget.layout.w,
              h: widget.layout.h,
            }}
          >
            <Card
              title={widget.title ?? widget.type}
              extra={
                <Space size="small">
                  <Select
                    size="small"
                    style={{ width: 180 }}
                    value={widget.dataSource}
                    onChange={(val) =>
                      updateWidget(widget.id, { dataSource: val })
                    }
                    options={datasourceOptions.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey)
                    }))}
                  />
                  <input
                    type="color"
                    value={(typeof widget.options?.color === "string" ? widget.options.color : undefined) ?? primaryColor ?? "#1677ff"}
                    onChange={(e) =>
                      updateWidget(widget.id, {
                        options: {
                          ...(widget.options ?? {}),
                          color: e.target.value,
                        },
                      })
                    }
                    style={{
                      width: 48,
                      height: 32,
                      border: "none",
                      background: "transparent",
                      padding: 0,
                    }}
                  />
                  <Button
                    danger
                    size="small"
                    onClick={() => removeWidget(widget.id)}
                  >
                    {t("common.remove")}
                  </Button>
                </Space>
              }
              style={{ height: "100%" }}
            >
              <WidgetRenderer
                type={widget.type}
                title={widget.title}
                dataSource={widget.dataSource}
                color={widget.options?.color as string | undefined}
              />
            </Card>
          </div>
        ))}
      </ResponsiveGridLayout>
    </Space>
  );
}
