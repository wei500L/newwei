import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { KpiStrip } from "./kpi-strip";

describe("KpiStrip", () => {
  it("渲染每个 item 的 label 与 value", () => {
    const { getByText } = renderWithProviders(
      <KpiStrip
        items={[
          { key: "total", label: "总数", value: 42 },
          { key: "pending", label: "待处理", value: 7 },
          { key: "done", label: "已完成", value: 35 },
        ]}
      />,
    );

    expect(getByText("总数")).toBeInTheDocument();
    expect(getByText("42")).toBeInTheDocument();
    expect(getByText("待处理")).toBeInTheDocument();
    expect(getByText("7")).toBeInTheDocument();
    expect(getByText("已完成")).toBeInTheDocument();
    expect(getByText("35")).toBeInTheDocument();
  });

  it("suffix 渲染在 value 旁边", () => {
    const { getByText } = renderWithProviders(
      <KpiStrip
        items={[{ key: "rate", label: "误报率", value: 12.5, suffix: "%" }]}
      />,
    );

    expect(getByText("12.5")).toBeInTheDocument();
    expect(getByText("%")).toBeInTheDocument();
  });

  it("bare 为 true 时不渲染 content-card 外层", () => {
    const { container } = renderWithProviders(
      <KpiStrip bare items={[{ key: "total", label: "总数", value: 1 }]} />,
    );

    expect(container.querySelector(".content-card")).toBeNull();
  });
});
