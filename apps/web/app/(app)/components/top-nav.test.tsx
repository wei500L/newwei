import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { MobileNavDrawer } from "./mobile-nav-drawer";
import { TopNav } from "./top-nav";
import { ViewportSizeProvider } from "./use-viewport-width";

const mocks = vi.hoisted(() => ({
  permissions: ["crawl.write"] as string[],
  pathname: "/today",
  push: vi.fn(),
  signOut: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      permissions: mocks.permissions,
      orgId: "org-1",
      user: {
        firstName: "Wei",
        lastName: "Lin",
        email: "wei@example.com",
      },
    },
    status: "authenticated",
  }),
  signOut: (...args: unknown[]) => mocks.signOut(...args),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "light",
    isDark: false,
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

vi.mock("./ticker-tape", () => ({
  TickerTape: () => <div data-testid="ticker-stub" />,
}));
vi.mock("./command-bar", () => ({
  CommandBar: () => <div data-testid="command-bar-stub" />,
}));
vi.mock("./notification-center", () => ({
  NotificationCenter: () => (
    <button type="button" aria-label="notification-center-stub" />
  ),
}));
vi.mock("./system-defcon", () => ({
  SystemDefcon: () => <div data-testid="system-defcon-stub" />,
}));
vi.mock("./organization-switcher", () => ({
  OrganizationSwitcher: () => <div data-testid="organization-switcher-stub" />,
}));
vi.mock("./user-ui-settings-sync-indicator", () => ({
  UserUiSettingsSyncIndicator: () => <div data-testid="sync-indicator-stub" />,
}));

/** 密度由挂载后的真实视口宽度决定（Shell 级 ViewportSizeProvider）。 */
function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  mocks.permissions = ["crawl.write"];
  mocks.pathname = "/today";
  mocks.push.mockReset();
  mocks.signOut.mockReset();
  mocks.fetchMock.mockReset();
  mocks.fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", mocks.fetchMock);
  setViewportWidth(1920);
});

describe("TopNav（常驻入口与响应式优先级）", () => {
  it("宽屏：菜单/品牌/命令面板/通知/用户/主题常驻，抓取为主按钮", async () => {
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open navigation menu" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Modular")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "notification-center-stub" }),
    ).toBeInTheDocument();
    expect(screen.getByText("WL")).toBeInTheDocument(); // 用户头像入口
    expect(
      screen.getByRole("button", { name: "切换到深色主题" }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("command-bar-stub")).toBeInTheDocument();
    });
    // 主按钮带 PlusOutlined 图标（子树参与可访问名），用正则匹配
    expect(
      screen.getByRole("button", { name: /new crawl/i }),
    ).toBeInTheDocument();
    // 窄屏搜索兜底入口不在宽屏出现
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  });

  it("窄屏：命令面板让位于搜索兜底入口，组织切换保留", async () => {
    setViewportWidth(1024);
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("command-bar-stub")).toBeNull();
    // 组织切换在窄屏仍可达（Popover 形态，断言其触发按钮）
    expect(
      screen.getByRole("button", { name: "Switch organization" }),
    ).toBeInTheDocument();
  });

  it("品牌容器保持 min-w-0，长文本不挤压右侧操作区", () => {
    renderWithProviders(<TopNav />);
    const brandCluster = screen.getByText("Modular").closest("div");
    expect(brandCluster).toHaveClass("min-w-0");
  });
});

describe("TopNav（移动导航 Drawer）", () => {
  it("菜单按钮打开五组导航，点击入口后导航并关闭 Drawer", async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    renderWithProviders(<TopNav />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    expect(await screen.findByText("Today & Feeds")).toBeInTheDocument();
    expect(screen.getByText("Events & Situation")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "News Events" }));
    expect(mocks.push).toHaveBeenCalledWith("/events");
  });
});

describe("MobileNavDrawer（导航后关闭契约）", () => {
  it("点击导航项：push 目标路由并调用 onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <MobileNavDrawer open onClose={onClose} className="" />,
    );

    const item = screen.getByRole("button", { name: "Today" });
    // 触控目标尺寸 + 长文案截断约束（防横向溢出）
    expect(item).toHaveClass("min-h-[var(--rail-item-size)]");
    expect(screen.getByText("Today")).toHaveClass("truncate");

    await user.click(item);
    expect(mocks.push).toHaveBeenCalledWith("/today");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("活跃项带 aria-current 与 active 状态类", () => {
    renderWithProviders(<MobileNavDrawer open onClose={vi.fn()} className="" />);
    const active = screen.getByRole("button", { name: "Today" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveClass("nav-item--active");
  });
});

describe("TopNav（退出登录）", () => {
  it("用户菜单退出：POST /api/logout（trace 头）后 signOut 回登录页", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopNav />);

    await user.click(screen.getByText("WL"));
    const logoutItem = await screen.findByText("Sign out");
    await user.click(logoutItem);

    await waitFor(() => {
      expect(mocks.fetchMock).toHaveBeenCalledWith(
        "/api/logout",
        expect.objectContaining({
          method: "POST",
          // createTraceHeaders 会把头键小写化并附加 x-trace-id / traceparent
          headers: expect.objectContaining({
            "content-type": "application/json",
            "x-trace-id": expect.any(String),
            traceparent: expect.any(String),
          }),
          body: JSON.stringify({ logoutAll: false }),
        }),
      );
    });
    await waitFor(() => {
      expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
    });
  });

  it("退出接口失败时带上 logoutFailed 标记回登录页", async () => {
    const user = userEvent.setup();
    mocks.fetchMock.mockResolvedValue({ ok: false });
    renderWithProviders(<TopNav />);

    await user.click(screen.getByText("WL"));
    await user.click(await screen.findByText("Sign out"));

    await waitFor(() => {
      expect(mocks.signOut).toHaveBeenCalledWith({
        callbackUrl: "/login?logoutFailed=1",
      });
    });
  });
});
