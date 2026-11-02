import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PageHeader } from "@/components/page-header";
import { renderWithProviders } from "@/test/render";

describe("PageHeader", () => {
  it("renders the h1 title and the kicker", () => {
    renderWithProviders(<PageHeader title="事件" kicker="事件与态势" />);
    expect(screen.getByRole("heading", { level: 1, name: "事件" })).toBeInTheDocument();
    expect(screen.getByText("事件与态势")).toBeInTheDocument();
  });

  it("invokes the action handler when the action button is clicked", () => {
    const onRefresh = vi.fn();
    renderWithProviders(
      <PageHeader title="事件" actions={<button onClick={onRefresh}>刷新</button>} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders the back link with the provided href", () => {
    renderWithProviders(
      <PageHeader title="事件详情" back={{ href: "/events", label: "返回" }} />,
    );
    expect(screen.getByRole("link", { name: /返回/ })).toHaveAttribute("href", "/events");
  });

  it("does not render description/meta/actions containers when omitted", () => {
    const { container } = renderWithProviders(<PageHeader title="事件" />);
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    // 只有一个 heading（h1），没有空的说明/元信息段落
    expect(header?.querySelectorAll("h1")).toHaveLength(1);
    expect(header?.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
