import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  WarMapLegendSwatch,
  type WarMapLegendItem,
} from "./war-map-symbols";

const baseItem: WarMapLegendItem = {
  key: "signal-high",
  symbolKey: "signal-high",
  label: "High severity signal",
};

describe("WarMapLegendSwatch（FE-批4B characterization）", () => {
  it("静态形态：渲染 div 容器、label 与 SVG 图标", () => {
    const { container } = render(<WarMapLegendSwatch {...baseItem} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("High severity signal")).toBeInTheDocument();
  });

  it("静态形态：note 作为次级文本、countLabel 叠加为文本", () => {
    render(
      <WarMapLegendSwatch
        {...baseItem}
        note="3 active alerts"
        countLabel="3"
      />,
    );
    expect(screen.getByText("3 active alerts")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("可交互形态必须是真实 button 且可点击触发 onClick", async () => {
    const onClick = vi.fn();
    render(
      <WarMapLegendSwatch
        {...baseItem}
        interactive
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button", {
      name: /High severity signal/,
    });
    expect(button.tagName).toBe("BUTTON");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("hover/leave 回调在可交互形态下触发", async () => {
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    render(
      <WarMapLegendSwatch
        {...baseItem}
        interactive
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />,
    );
    const button = screen.getByRole("button");
    await userEvent.hover(button);
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    await userEvent.unhover(button);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
  });

  it("非交互形态不触发回调（无 button）", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <WarMapLegendSwatch {...baseItem} onClick={onClick} />,
    );
    fireEventCompatClick(container);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("quick 与 panel 变体均渲染同一 label 与图标结构", () => {
    const { rerender } = render(
      <WarMapLegendSwatch {...baseItem} variant="quick" />,
    );
    expect(screen.getByText("High severity signal")).toBeInTheDocument();
    rerender(<WarMapLegendSwatch {...baseItem} variant="panel" />);
    expect(screen.getByText("High severity signal")).toBeInTheDocument();
  });

  it("endAdornment 渲染在尾部（pinned 徽标由调用方注入）", () => {
    render(
      <WarMapLegendSwatch
        {...baseItem}
        endAdornment={<span>pinned</span>}
      />,
    );
    expect(screen.getByText("pinned")).toBeInTheDocument();
  });

  it("degraded tone 与 muted 状态不改可访问名称", () => {
    render(<WarMapLegendSwatch {...baseItem} tone="degraded" muted />);
    expect(screen.getByText("High severity signal")).toBeInTheDocument();
  });
});

function fireEventCompatClick(container: HTMLElement) {
  container.querySelector("div")?.dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
}
