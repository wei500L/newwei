import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { i18n, renderWithProviders } from "@/test/render";

import { CandlestickCard } from "./candlestick-card";

// jsdom 无 echarts 渲染能力，图表替换为可断言的占位节点。
vi.mock("@/components/echart", async () => {
  const React = await import("react");
  return {
    DashboardChart: (props: { height?: number }) =>
      React.createElement("div", {
        "data-testid": "candlestick-test-chart",
        "data-height": String(props.height ?? ""),
      }),
  };
});

// jsdom 无完整 antd token 上下文与真实 CSS 变量；图表主题走确定性替身。
vi.mock("@/hooks/use-chart-theme", () => ({
  useChartTheme: () => ({
    echartsTheme: "smart-light",
    colors: {
      primary: "#1f3b7b",
      bullish: "#1b9e77",
      bearish: "#d95f02",
      destructive: "#dc2626",
      accent: "#d97706",
      background: "transparent",
      foreground: "#475569",
      border: "#e2e8f0",
      grid: "rgba(15, 23, 42, 0.08)",
      tooltipBg: "#0f172a",
      tooltipText: "#f8fafc",
      secondary: "#e2e8f0",
    },
    fontFamily: "var(--font-mono), monospace",
  }),
}));

describe("CandlestickCard bare 模式", () => {
  it("默认渲染 Card 标题", () => {
    renderWithProviders(<CandlestickCard title="沪深300 K线" />);
    expect(screen.getByText("沪深300 K线")).toBeTruthy();
  });

  it("bare 时不渲染卡片标题，子内容可见", () => {
    const emptyText = i18n.t("dashboard.charts.noCandlestick");
    const { queryByText } = renderWithProviders(
      <CandlestickCard title="沪深300 K线" bare />,
    );
    expect(queryByText("沪深300 K线")).toBeNull();
    expect(screen.getByText(emptyText)).toBeTruthy();
  });
});
