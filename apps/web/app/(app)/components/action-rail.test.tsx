import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { ActionRail } from "./action-rail";

const mocks = vi.hoisted(() => ({
  permissions: [] as string[],
  pathname: "/today",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { permissions: mocks.permissions },
    status: "authenticated",
  }),
}));

const FULL_PERMISSIONS = [
  "dashboards.read",
  "analysis.read",
  "assistant.read",
  "crawl.read",
  "settings.manage",
];

describe("ActionRail（五组导航的桌面呈现）", () => {
  beforeEach(() => {
    mocks.permissions = [];
    mocks.pathname = "/today";
  });

  it("渲染五个分组，每组带可访问名称（组标题 i18n）", () => {
    mocks.permissions = FULL_PERMISSIONS;
    renderWithProviders(<ActionRail mode="rail" />);

    for (const label of [
      "Today & Feeds",
      "Events & Situation",
      "Analysis & Research",
      "My Workspace",
      "Admin",
    ]) {
      expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    }
  });

  it("全权限下保留全部 20 个入口，活跃项带 aria-current 与 active 状态类", () => {
    mocks.permissions = FULL_PERMISSIONS;
    mocks.pathname = "/events";
    renderWithProviders(<ActionRail mode="rail" />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(20);

    const active = screen.getByRole("link", { name: "News Events" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveClass("nav-item--active");

    const idle = screen.getByRole("link", { name: "Today" });
    expect(idle).not.toHaveAttribute("aria-current");
    expect(idle).toHaveClass("nav-item--idle");
  });

  it("无权限时管理组整组消失（不显示空标题），受限项被过滤", () => {
    renderWithProviders(<ActionRail mode="rail" />);

    expect(screen.queryByRole("region", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Analysis & Research" })).toBeNull();
    // 无门禁的入口仍然可达
    expect(screen.getByRole("link", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alert Center" })).toBeInTheDocument();
    // dashboards.read 门禁项被过滤
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("rail 仅在 md 及以上显示（移动端让位给 Drawer）", () => {
    const { container } = renderWithProviders(<ActionRail mode="rail" />);
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside).toHaveClass("hidden");
    expect(aside).toHaveClass("md:flex");
  });

  it("navMode=drawer 时不渲染 rail（Shell 改用菜单按钮 + Drawer）", () => {
    const { container } = renderWithProviders(<ActionRail mode="drawer" />);
    expect(container.querySelector("aside")).toBeNull();
  });
});
