import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders, i18n } from "@/test/render";

import { MobileNavDrawer } from "./mobile-nav-drawer";
import { TopNav } from "./top-nav";
import { ViewportSizeProvider } from "./use-viewport-width";

const mocks = vi.hoisted(() => ({
  permissions: ["crawl.write"] as string[],
  pathname: "/today",
  push: vi.fn(),
  signOut: vi.fn(),
  fetchMock: vi.fn(),
  isDark: false,
  toggleTheme: vi.fn(),
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
    theme: mocks.isDark ? "dark" : "light",
    isDark: mocks.isDark,
    setTheme: vi.fn(),
    toggleTheme: mocks.toggleTheme,
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

/** 用户菜单触发器（头像按钮）的可访问名称（英文界面）。 */
const USER_MENU_BUTTON = "Open user menu";

beforeEach(() => {
  mocks.permissions = ["crawl.write"];
  mocks.pathname = "/today";
  mocks.push.mockReset();
  mocks.signOut.mockReset();
  mocks.fetchMock.mockReset();
  mocks.fetchMock.mockResolvedValue({ ok: true });
  mocks.isDark = false;
  mocks.toggleTheme.mockReset();
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
    expect(
      screen.getByRole("button", { name: USER_MENU_BUTTON }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch to dark theme" }),
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

  it("compact：命令面板/主题/组织/同步保留，系统状态与搜索兜底不出现", async () => {
    setViewportWidth(1400);
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("command-bar-stub")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    expect(screen.queryByTestId("system-defcon-stub")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Switch to dark theme" }),
    ).toBeInTheDocument();
    // 组织切换 Popover 触发按钮仍在（compact 档）
    expect(
      screen.getByRole("button", { name: "Switch organization" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sync-indicator-stub")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /new crawl/i }),
    ).toBeInTheDocument();
  });

  it("minimal：顶部只保留菜单/品牌/搜索/通知/用户，其余入口不占栏", async () => {
    setViewportWidth(1024);
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    // 核心五项
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Open navigation menu" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Modular")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "notification-center-stub" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: USER_MENU_BUTTON }),
    ).toBeInTheDocument();

    // 让位项：命令面板、系统状态、组织、主题、同步、抓取按钮都不在栏上
    expect(screen.queryByTestId("command-bar-stub")).toBeNull();
    expect(screen.queryByTestId("sync-indicator-stub")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Switch organization" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Switch to dark theme" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /new crawl/i })).toBeNull();
  });

  it("minimal：组织/主题/语言/抓取从用户菜单可达，动作仍有效", async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    await user.click(screen.getByRole("button", { name: USER_MENU_BUTTON }));

    // 抓取（有权限）：菜单项导航到抓取任务页
    const crawlItem = await screen.findByText("New Crawl");
    await user.click(crawlItem);
    expect(mocks.push).toHaveBeenCalledWith("/admin/ops/crawl-tasks?new=true");

    // 主题 / 语言 / 组织切换（复用既有 OrganizationSwitcher）
    await user.click(screen.getByRole("button", { name: USER_MENU_BUTTON }));
    expect(await screen.findByText("Switch to dark theme")).toBeInTheDocument();
    expect(screen.getByText("Simplified Chinese")).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(
      screen.getByTestId("organization-switcher-stub"),
    ).toBeInTheDocument();

    // 主题菜单项触发既有 toggleTheme
    await user.click(screen.getByText("Switch to dark theme"));
    expect(mocks.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("无抓取权限：full 档顶部主按钮不出现", () => {
    mocks.permissions = [];
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );
    expect(screen.queryByRole("button", { name: /new crawl/i })).toBeNull();
  });

  it("无抓取权限（minimal）：用户菜单中的抓取项同样不存在", async () => {
    const user = userEvent.setup();
    mocks.permissions = [];
    setViewportWidth(1024);
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    await user.click(screen.getByRole("button", { name: USER_MENU_BUTTON }));
    expect(await screen.findByText("Sign out")).toBeInTheDocument();
    expect(screen.queryByText("New Crawl")).toBeNull();
  });
});

describe("TopNav（品牌宽度策略）", () => {
  it("品牌区可收缩：全名/短名带截断约束，容器不锁 shrink，菜单按钮不压缩", () => {
    renderWithProviders(<TopNav />);
    const brandCluster = screen.getByText("Modular").closest("div");
    expect(brandCluster).toHaveClass("min-w-0");
    expect(brandCluster).not.toHaveClass("shrink-0");
    // 长翻译下截断生效（truncate = overflow hidden + ellipsis + nowrap）
    expect(screen.getByText("Modular")).toHaveClass("truncate");
    expect(screen.getByText("M")).toHaveClass("truncate");
    const menuButton = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    expect(menuButton).toHaveClass("shrink-0");
  });
});

describe("TopNav（用户菜单键盘可访问性）", () => {
  it("头像触发器是原生按钮：本地化名称 + haspopup + Enter 可打开", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopNav />);

    const trigger = screen.getByRole("button", { name: USER_MENU_BUTTON });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByText("WL")).toBeInTheDocument(); // 头像首字母仍在触发器内

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Sign out")).toBeInTheDocument();
  });

  it("中文界面下头像触发器与主题文案均为中文", async () => {
    try {
      await i18n.changeLanguage("zh-CN");
      renderWithProviders(<TopNav />);

      expect(
        screen.getByRole("button", { name: "打开用户菜单" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "切换到深色主题" }),
      ).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en-US");
    }
  });
});

describe("TopNav（主题切换 i18n）", () => {
  it("同一文案同时用于 aria-label 与 title，中英文各自本地化", async () => {
    const { unmount } = renderWithProviders(<TopNav />);

    // 英文浅色态：可访问名与 tooltip 同源，提示切换到深色
    const enButton = screen.getByRole("button", {
      name: "Switch to dark theme",
    });
    expect(enButton).toHaveAttribute("title", "Switch to dark theme");
    expect(enButton).toHaveAttribute("aria-pressed", "false");
    unmount();

    // 深色态：文案切换为“切到浅色”，状态同步
    mocks.isDark = true;
    const { unmount: unmountDark } = renderWithProviders(<TopNav />);
    const darkButton = screen.getByRole("button", {
      name: "Switch to light theme",
    });
    expect(darkButton).toHaveAttribute("title", "Switch to light theme");
    expect(darkButton).toHaveAttribute("aria-pressed", "true");
    unmountDark();
    mocks.isDark = false;

    // 中文界面：中文读屏文案
    try {
      await i18n.changeLanguage("zh-CN");
      renderWithProviders(<TopNav />);
      expect(
        await screen.findByRole("button", { name: "切换到深色主题" }),
      ).toHaveAttribute("title", "切换到深色主题");
    } finally {
      await i18n.changeLanguage("en-US");
    }
  });
});

describe("TopNav（移动导航 Drawer）", () => {
  it("菜单按钮打开五组导航，入口为链接（href 可中键/复制）", async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    renderWithProviders(
      <ViewportSizeProvider>
        <TopNav />
      </ViewportSizeProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    expect(await screen.findByText("Today & Feeds")).toBeInTheDocument();
    expect(screen.getByText("Events & Situation")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "News Events" });
    expect(link).toHaveAttribute("href", "/events");
  });
});

describe("MobileNavDrawer（Link 语义与关闭契约）", () => {
  it("导航入口是链接：href 指向目标路由，点击后关闭 Drawer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <MobileNavDrawer open onClose={onClose} className="" />,
    );

    const item = screen.getByRole("link", { name: "Today" });
    expect(item).toHaveAttribute("href", "/today");
    // 触控目标尺寸 + 长文案截断约束（防横向溢出）
    expect(item).toHaveClass("min-h-[var(--rail-item-size)]");
    expect(screen.getByText("Today")).toHaveClass("truncate");

    await user.click(item);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("活跃链接带 aria-current 与 active 状态类", () => {
    renderWithProviders(<MobileNavDrawer open onClose={vi.fn()} className="" />);
    const active = screen.getByRole("link", { name: "Today" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveClass("nav-item--active");

    const idle = screen.getByRole("link", { name: "News Events" });
    expect(idle).not.toHaveAttribute("aria-current");
    expect(idle).toHaveClass("nav-item--idle-strong");
  });
});

describe("TopNav（退出登录）", () => {
  it("用户菜单退出：POST /api/logout（trace 头）后 signOut 回登录页", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopNav />);

    await user.click(screen.getByRole("button", { name: USER_MENU_BUTTON }));
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

    await user.click(screen.getByRole("button", { name: USER_MENU_BUTTON }));
    await user.click(await screen.findByText("Sign out"));

    await waitFor(() => {
      expect(mocks.signOut).toHaveBeenCalledWith({
        callbackUrl: "/login?logoutFailed=1",
      });
    });
  });
});
