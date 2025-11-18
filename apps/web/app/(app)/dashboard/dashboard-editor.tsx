"use client";

import { Button, Card, Input, Select, Space, Typography, message } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo } from "react";
import { DashboardWidgetType, useDashboardEditorStore } from "@/store/dashboard-editor";
import { TimeRangeControls } from "@/components/time-range-controls";
import type { DashboardsQuery, UpsertDashboardInput } from "@/graphql/generated";
import { WidgetRenderer } from "./charts/widget-renderer";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ResponsiveGridLayout = dynamic(
  () => import("react-grid-layout").then((mod) => mod.WidthProvider(mod.Responsive)),
  {
    ssr: false
  }
);

const defaultWidgetSize: Record<DashboardWidgetType, { w: number; h: number }> = {
  line: { w: 4, h: 6 },
  bar: { w: 4, h: 6 },
  pie: { w: 3, h: 5 },
  scatter: { w: 4, h: 6 },
  kline: { w: 5, h: 7 },
  radar: { w: 4, h: 6 },
  table: { w: 6, h: 8 }
};

const datasourceOptions = [
  { label: "标普500", value: "economic:sp500_index" },
  { label: "纳斯达克", value: "economic:nasdaq_index" },
  { label: "道琼斯", value: "economic:dowjones_index" },
  { label: "美元指数", value: "economic:usd_index_history" },
  { label: "布伦特原油", value: "economic:brent_oil_price" },
  { label: "CME Bitcoin", value: "economic:crypto_bitcoin_cme" },
  { label: "Crypto Spot", value: "economic:crypto_js_spot" },
  { label: "默认演示", value: "economic:economic-short" }
];

type DashboardRecord = DashboardsQuery["dashboards"][number] | undefined;

interface DashboardEditorProps {
  dashboard?: DashboardRecord;
  saving?: boolean;
  onSave: (input: UpsertDashboardInput) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

export function DashboardEditor({ dashboard, saving, onSave, onDelete }: DashboardEditorProps) {
  const { widgets, addWidget, updateLayout, removeWidget, name, slug, description, primaryColor, setMeta, reset, setWidgets } =
    useDashboardEditorStore();

  useEffect(() => {
    if (!dashboard) {
      reset();
      return;
    }
    setMeta({ name: dashboard.name, slug: dashboard.slug, description: dashboard.description ?? undefined });
    if (dashboard.config && (dashboard.config as any).primaryColor) {
      setMeta({ primaryColor: (dashboard.config as any).primaryColor });
    }
    setWidgets(
      dashboard.widgets.map((widget) => ({
        id: widget.id,
        title: widget.title ?? undefined,
        type: widget.type as DashboardWidgetType,
        dataSource: widget.dataSource,
        dataConfig: widget.dataConfig ?? undefined,
        layout: { x: widget.layoutX, y: widget.layoutY, w: widget.layoutW, h: widget.layoutH },
        sortOrder: widget.sortOrder ?? 0,
        options: widget.options ?? undefined
      }))
    );
  }, [dashboard, reset, setMeta, setWidgets]);

  const layouts = useMemo(
    () => ({
      lg: widgets.map((widget) => ({
        i: widget.id,
        x: widget.layout.x,
        y: widget.layout.y,
        w: widget.layout.w,
        h: widget.layout.h
      }))
    }),
    [widgets]
  );

  const handleAddWidget = (type: DashboardWidgetType) => {
    const size = defaultWidgetSize[type];
    addWidget({
      type,
      title: `${type} widget`,
      dataSource: datasourceOptions[0].value,
      layout: { x: 0, y: Infinity, w: size.w, h: size.h },
      options: {},
      dataConfig: {}
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Dashboard Layout" extra={<TimeRangeControls />}>
        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Space wrap>
            <Input
              style={{ width: 220 }}
              value={name}
              placeholder="Dashboard name"
              onChange={(e) => setMeta({ name: e.target.value })}
            />
            <Input
              style={{ width: 200 }}
              value={slug}
              placeholder="Slug"
              onChange={(e) => setMeta({ slug: e.target.value })}
            />
            <Input
              style={{ width: 320 }}
              value={description}
              placeholder="Description"
              onChange={(e) => setMeta({ description: e.target.value })}
            />
            <Select
              style={{ width: 120 }}
              value={dashboard?.theme ?? "light"}
              options={[
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" }
              ]}
              onChange={(theme) => setMeta({ theme })}
            />
            <Space align="center">
              <Typography.Text type="secondary">Primary</Typography.Text>
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setMeta({ primaryColor: e.target.value })}
                style={{ width: 48, height: 32, border: "none", background: "transparent", padding: 0 }}
              />
            </Space>
            <Space>
              <Button
                type="primary"
                loading={saving}
                onClick={async () => {
                  const payload: UpsertDashboardInput = {
                    id: dashboard?.id,
                    name,
                    slug,
                    description: description ?? undefined,
                    theme: dashboard?.theme ?? "light",
                    config: { primaryColor },
                    widgets: widgets.map((widget) => ({
                      id: widget.id.startsWith("temp-") ? undefined : widget.id,
                      title: widget.title,
                      type: widget.type as any,
                      dataSource: widget.dataSource,
                      dataConfig: widget.dataConfig ?? {},
                      layoutX: widget.layout.x,
                      layoutY: widget.layout.y,
                      layoutW: widget.layout.w,
                      layoutH: widget.layout.h,
                      sortOrder: widget.sortOrder,
                      options: widget.options ?? {}
                    }))
                  };
                  await onSave(payload);
                  message.success("Dashboard saved");
                }}
              >
                Save
              </Button>
              {dashboard?.id && onDelete ? (
                <Button danger onClick={() => onDelete(dashboard.id)}>
                  Delete
                </Button>
              ) : null}
              <Button onClick={() => reset()}>Reset</Button>
            </Space>
          </Space>
        </Space>
        <Space wrap>
          <Button onClick={() => handleAddWidget("line")}>Add Line</Button>
          <Button onClick={() => handleAddWidget("bar")}>Add Bar</Button>
          <Button onClick={() => handleAddWidget("pie")}>Add Pie</Button>
          <Button onClick={() => handleAddWidget("kline")}>Add K线</Button>
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
        onLayoutChange={(layout) => updateLayout(layout as any)}
      >
        {widgets.map((widget) => (
          <div key={widget.id} data-grid={{ x: widget.layout.x, y: widget.layout.y, w: widget.layout.w, h: widget.layout.h }}>
            <Card
              title={widget.title ?? widget.type}
              extra={
                <Space size="small">
                  <Select
                    size="small"
                    style={{ width: 180 }}
                    value={widget.dataSource}
                    onChange={(val) => updateWidget(widget.id, { dataSource: val })}
                    options={datasourceOptions}
                  />
                  <input
                    type="color"
                    value={(widget.options as any)?.color ?? primaryColor ?? "#1677ff"}
                    onChange={(e) => updateWidget(widget.id, { options: { ...(widget.options ?? {}), color: e.target.value } })}
                    style={{ width: 48, height: 32, border: "none", background: "transparent", padding: 0 }}
                  />
                  <Button danger size="small" onClick={() => removeWidget(widget.id)}>
                    Remove
                  </Button>
                </Space>
              }
              style={{ height: "100%" }}
            >
              <WidgetRenderer type={widget.type} title={widget.title} dataSource={widget.dataSource} color={widget.options?.color as string | undefined} />
            </Card>
          </div>
        ))}
      </ResponsiveGridLayout>
    </Space>
  );
}
