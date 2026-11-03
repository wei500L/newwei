import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TargetView } from "@/lib/globe/target-format";
import { renderWithProviders } from "@/test/render";

import { TargetCard } from "./target-card";

const view: TargetView = {
  kindKey: "globe.target.kinds.flights",
  title: "UAL123",
  subtitle: "N12345",
  fields: [
    { labelKey: "globe.target.field.callsign", value: "UAL123" },
    { labelKey: "globe.target.field.altitude", value: "35,000 ft", mono: true },
  ],
  links: [],
  layerId: "flights",
};

describe("TargetCard", () => {
  it("渲染标题、副标题与字段", () => {
    renderWithProviders(
      <TargetCard
        view={view}
        layerName="Live Flights"
        tracking
        isTracked={false}
        onTrack={vi.fn()}
        onUntrack={vi.fn()}
        onFlyTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "UAL123" })).toBeInTheDocument();
    expect(screen.getByText("N12345")).toBeInTheDocument();
    expect(screen.getByText("35,000 ft")).toBeInTheDocument();
    expect(screen.getByText("Live Flights")).toBeInTheDocument();
  });

  it("点击关闭按钮会调用回调", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <TargetCard
        view={view}
        layerName="Live Flights"
        tracking
        isTracked={false}
        onTrack={vi.fn()}
        onUntrack={vi.fn()}
        onFlyTo={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /关闭目标详情|Close target details/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("跟踪/停止跟踪文案随状态切换", () => {
    const { rerender } = renderWithProviders(
      <TargetCard
        view={view}
        layerName="Live Flights"
        tracking
        isTracked={false}
        onTrack={vi.fn()}
        onUntrack={vi.fn()}
        onFlyTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /跟踪|Track/ })).toBeInTheDocument();
    rerender(
      <TargetCard
        view={view}
        layerName="Live Flights"
        tracking
        isTracked
        onTrack={vi.fn()}
        onUntrack={vi.fn()}
        onFlyTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /停止跟踪|Stop tracking/ }),
    ).toBeInTheDocument();
  });

  it("external 主按钮在新标签页打开并带 noopener noreferrer", () => {
    const externalView: TargetView = {
      ...view,
      console: {
        labelKey: "globe.intel.openSource",
        href: "https://example.com/article",
        external: true,
      },
    };
    renderWithProviders(
      <TargetCard
        view={externalView}
        layerName="News"
        tracking={false}
        isTracked={false}
        onTrack={vi.fn()}
        onUntrack={vi.fn()}
        onFlyTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const link = screen.getByRole("link", { name: /打开原文|Open source/ });
    expect(link).toHaveAttribute("href", "https://example.com/article");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
  });

  it("external href 不是合法 http(s) 时不渲染主按钮", () => {
    const badView: TargetView = {
      ...view,
      console: {
        labelKey: "globe.intel.openSource",
        href: "javascript:alert(1)",
        external: true,
      },
    };
    renderWithProviders(
      <TargetCard
        view={badView}
        layerName="News"
        tracking={false}
        isTracked={false}
        onTrack={vi.fn()}
        onUntrack={vi.fn()}
        onFlyTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("link", { name: /打开原文|Open source/ }),
    ).toBeNull();
  });
});
