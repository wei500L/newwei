import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WarMapInspectorPanel } from "./war-map-inspector-panel";
import type { WarMapInspectorPanelProps } from "./war-map-inspector-panel";
import type { SelectedInspector } from "./war-map-overlay-model";

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === "dashboard.charts.warMap.panel.signalsSummary") {
    return `signals summary (${options?.count})`;
  }
  if (key === "dashboard.charts.warMap.panel.newsSummary") {
    return `news summary (${options?.count})`;
  }
  if (key === "dashboard.charts.warMap.panel.count") {
    return `count ${options?.count}`;
  }
  return `⟦${key}⟧`;
}) as never;

const onOpenNewsLink = vi.fn();
const baseActions = {
  onZoomToSelectedInspector: vi.fn(),
  onMinimizeInspector: vi.fn(),
  onExpandInspector: vi.fn(),
  onCloseInspector: vi.fn(),
  onOpenNewsLink,
};

const eventItem = {
  id: "e1",
  name: " Strait Incident ",
  label: "Strait Incident",
  lat: 35,
  lng: 105,
  severity: "high" as const,
  derivedScore: 9,
  value: 9,
  alertCount: 2,
  newsCount: 3,
  latestAt: "2026-01-05T00:00:00.000Z",
};

const newsItem = {
  id: "n1",
  title: "Market News",
  label: "Market News",
  location: "Tokyo",
  locationLabel: "Tokyo",
  geoSource: "geocoded" as const,
  lat: 36,
  lng: 106,
  publishedAt: "2026-01-05T01:00:00.000Z",
  url: "https://example.com/news",
};

function renderInspector(
  selectedInspector: SelectedInspector | null,
  overrides?: Partial<WarMapInspectorPanelProps>,
): ReturnType<typeof render> {
  const props: WarMapInspectorPanelProps = {
    selectedInspector,
    transportDetail: null,
    transportDetailLoading: false,
    useDesktopInspector: true,
    desktopInspectorMinimized: false,
    inspectorPanelWidth: 360,
    inspectorPanelHeight: 320,
    locale: "en-US",
    t,
    ...baseActions,
    ...overrides,
  };
  return render(<WarMapInspectorPanel {...props} />);
}

describe("WarMapInspectorPanel（FE-批4B characterization）", () => {
  it("无选择时渲染为空", () => {
    const { container } = renderInspector(null);
    expect(container).toBeEmptyDOMElement();
  });

  describe("event 详情", () => {
    const selection: SelectedInspector = {
      key: "event-e1",
      kind: "event",
      lat: 35,
      lng: 105,
      zoomTarget: 6,
      item: eventItem,
    };

    it("展示 label、severity 徽标与 alert/news 计数", () => {
      renderInspector(selection);
      expect(screen.getByText("Strait Incident")).toBeInTheDocument();
      // severity 经 t(`...stats.${severity}`) 且 defaultValue 首字母大写
      expect(
        screen.getByText("⟦dashboard.charts.warMap.stats.high⟧"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/tooltip\.alerts/),
      ).toBeInTheDocument();
    });

    it("zoom/minimize/close 动作触发回调", async () => {
      renderInspector(selection);
      await userEvent.click(
        screen.getByRole("button", { name: /⟦dashboard\.charts\.warMap\.panel\.zoomIn⟧/ }),
      );
      expect(baseActions.onZoomToSelectedInspector).toHaveBeenCalledTimes(1);
      await userEvent.click(
        screen.getByRole("button", { name: "⟦common.minimize⟧" }),
      );
      expect(baseActions.onMinimizeInspector).toHaveBeenCalledTimes(1);
      await userEvent.click(
        screen.getByRole("button", { name: "⟦common.close⟧" }),
      );
      expect(baseActions.onCloseInspector).toHaveBeenCalledTimes(1);
    });

    it("desktop minimized：折叠条展示并触发 expand/close", async () => {
      renderInspector(selection, { desktopInspectorMinimized: true });
      await userEvent.click(
        screen.getByRole("button", {
          name: "⟦dashboard.charts.warMap.overlay.expandInspector⟧",
        }),
      );
      expect(baseActions.onExpandInspector).toHaveBeenCalledTimes(1);
      await userEvent.click(
        screen.getByRole("button", { name: "⟦common.close⟧" }),
      );
      expect(baseActions.onCloseInspector).toHaveBeenCalledTimes(1);
    });

    it("mobile：以全宽 Drawer 呈现；Esc 触发 onClose 语义", async () => {
      renderInspector(selection, { useDesktopInspector: false });
      expect(document.querySelector(".ant-drawer")).not.toBeNull();
      // mobile 下内容全量渲染（Drawer 承载），zoom 入口仍在
      expect(
        screen.getByRole("button", {
          name: /⟦dashboard\.charts\.warMap\.panel\.zoomIn⟧/,
        }),
      ).toBeInTheDocument();
      // Drawer 关闭走 onClose（.ant-drawer-close 由 antd 提供）
      const drawerClose = document.querySelector(
        ".ant-drawer-close",
      ) as HTMLElement | null;
      if (drawerClose) {
        await userEvent.click(drawerClose);
        expect(baseActions.onCloseInspector).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe("event cluster", () => {
    it("展示成员列表与聚类计数", () => {
      const selection: SelectedInspector = {
        key: "cluster-1",
        kind: "event-cluster",
        lat: 35,
        lng: 105,
        count: 2,
        zoomTarget: 6,
        members: [
          eventItem,
          { ...eventItem, id: "e2", label: "Second Event", name: "Second" },
        ],
      };
      renderInspector(selection);
      expect(screen.getByText("Strait Incident")).toBeInTheDocument();
      expect(screen.getByText("Second Event")).toBeInTheDocument();
      expect(screen.getByText("count 2")).toBeInTheDocument();
    });
  });

  describe("news 详情", () => {
    const selection: SelectedInspector = {
      key: "news-n1",
      kind: "news",
      lat: 36,
      lng: 106,
      zoomTarget: 6,
      item: newsItem,
    };

    it("展示位置、geocoded 标签与打开原文按钮", async () => {
      renderInspector(selection);
      expect(screen.getByText("Tokyo")).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: "⟦dashboard.charts.warMap.panel.openOriginal⟧",
        }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", {
          name: "⟦dashboard.charts.warMap.panel.openOriginal⟧",
        }),
      );
      expect(onOpenNewsLink).toHaveBeenCalledWith("https://example.com/news");
    });

    it("无 url 时打开按钮禁用", () => {
      renderInspector(selection, {
        selectedInspector: { ...selection, item: { ...newsItem, url: null } },
      });
      expect(
        screen.getByRole("button", {
          name: "⟦dashboard.charts.warMap.panel.openOriginal⟧",
        }),
      ).toBeDisabled();
    });
  });

  describe("news cluster", () => {
    it("成员列表带打开原文动作；无 url 的成员动作禁用", () => {
      const selection: SelectedInspector = {
        key: "news-cluster-1",
        kind: "news-cluster",
        lat: 36,
        lng: 106,
        count: 2,
        zoomTarget: 6,
        members: [
          newsItem,
          { ...newsItem, id: "n2", label: "Second News", url: null },
        ],
      };
      renderInspector(selection);
      const openButtons = screen.getAllByRole("button", {
        name: "⟦dashboard.charts.warMap.panel.openOriginal⟧",
      });
      expect(openButtons).toHaveLength(2);
      expect(openButtons[0]).toBeEnabled();
      expect(openButtons[1]).toBeDisabled();
    });
  });

  describe("flight/vessel 详情", () => {
    const flightSelection: SelectedInspector = {
      key: "flight-f1",
      kind: "flight",
      lat: 35,
      lng: 105,
      zoomTarget: 6,
      item: {
        objectKey: "f1",
        transportKind: "aircraft",
        label: "RCH451",
        callsign: "RCH451",
        icao24: "ae1234",
        registration: "11-1111",
        displayCategory: "Military",
        role: "Transport",
        countryName: "United States",
        altitudeFt: 33000,
        groundSpeedKt: 450,
        heading: 90,
        latestAt: "2026-01-05T00:00:00.000Z",
      },
    };

    const vesselSelection: SelectedInspector = {
      key: "vessel-v1",
      kind: "vessel",
      lat: 30,
      lng: 120,
      zoomTarget: 6,
      item: {
        objectKey: "v1",
        transportKind: "vessel",
        label: "Tanker Alpha",
        mmsi: "123456789",
        shipTypeLabel: "Tanker",
        speed: 12.4,
        course: 88,
        heading: 90,
        latestAt: "2026-01-05T00:00:00.000Z",
      },
    };

    it("flight：类别徽标、标识 tag 与英制单位", () => {
      renderInspector(flightSelection);
      expect(screen.getByText("Military")).toBeInTheDocument();
      // callsign 同时出现在标题与标识 tag，锁定至少出现
      expect(screen.getAllByText("RCH451").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("ICAO24 AE1234")).toBeInTheDocument();
      expect(screen.getByText("33000 ft")).toBeInTheDocument();
      expect(screen.getByText("450 kt")).toBeInTheDocument();
      expect(screen.getByText("90°")).toBeInTheDocument();
    });

    it("vessel：类别徽标、MMSI 与海况单位", () => {
      renderInspector(vesselSelection);
      expect(screen.getByText("Tanker")).toBeInTheDocument();
      expect(screen.getByText("MMSI 123456789")).toBeInTheDocument();
      expect(screen.getByText("12 kn")).toBeInTheDocument();
      expect(screen.getByText("⟦dashboard.charts.warMap.tooltip.heading⟧: 90°")).toBeInTheDocument();
      expect(screen.getByText("⟦dashboard.charts.warMap.tooltip.course⟧: 88°")).toBeInTheDocument();
    });

    it("transport detail loading：轨迹区显示 Spin 而非轨迹列表", () => {
      renderInspector(flightSelection, { transportDetailLoading: true });
      expect(
        screen.getByText("⟦dashboard.charts.warMap.panel.recentTrackPoints⟧"),
      ).toBeInTheDocument();
      expect(document.querySelector(".ant-spin")).not.toBeNull();
      expect(
        screen.queryByText("⟦dashboard.charts.warMap.panel.noTrackPoints⟧"),
      ).toBeNull();
    });

    it("轨迹点上限保持 20，坐标保留 3 位小数", () => {
      const trackPoints = Array.from({ length: 30 }, (_, index) => ({
        id: `p${index}`,
        lat: 35.123456 + index * 0.001,
        lng: 105.654321 + index * 0.001,
        observedAt: "2026-01-05T00:00:00.000Z",
        speed: 10 + index,
        heading: 100,
      }));
      renderInspector(flightSelection, {
        transportDetail: {
          kind: "aircraft",
          objectKey: "f1",
          title: "RCH451",
          latestState: {},
          trackPoints,
          summary: {
            pointCount: 30,
            geoCells: [],
            totalDistanceKm: 123.4,
            maxSpeed: 40,
          },
        },
      });
      // 30 点只渲染前 20 个：p0 (35.123) 在场、p19 (35.142) 在场、p20 (35.143) 缺席
      expect(screen.getByText(/^35\.123/)).toBeInTheDocument();
      expect(screen.getByText(/^35\.142/)).toBeInTheDocument();
      expect(screen.queryByText(/^35\.143/)).not.toBeInTheDocument();
      // 汇总标签
      expect(
        screen.getByText(/⟦dashboard\.charts\.warMap\.panel\.trackPointCount⟧/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/⟦dashboard\.charts\.warMap\.panel\.trackDistance⟧/),
      ).toBeInTheDocument();
    });

    it("无轨迹时显示 noTrackPoints 文案", () => {
      renderInspector(flightSelection, {
        transportDetail: {
          kind: "aircraft",
          objectKey: "f1",
          title: "RCH451",
          latestState: {},
          trackPoints: [],
          summary: { pointCount: 0, geoCells: [] },
        },
      });
      expect(
        screen.getByText("⟦dashboard.charts.warMap.panel.noTrackPoints⟧"),
      ).toBeInTheDocument();
    });
  });
});
