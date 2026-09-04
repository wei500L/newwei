import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertMetricProvider } from "@/graphql/generated";

import {
  alertTestNavigation,
  buildAlertEvent,
  holdAlertTestMutations,
  renderAlertCenter,
  resetAlertTestState,
} from "./alert-center-test-support";

// ⚠️ vi.mock 工厂只 import 零依赖模块（component-mock-state /
// url-navigation）：工厂在 alert-center.tsx 加载过程中执行，若 import
// 了会传递 import 被测模块的文件（如 ./alert-center-test-support），
// 会形成模块加载死锁（远端 CI 表现为测试 45 分钟挂起）。
vi.mock("next-auth/react", async () => {
  const { testSessionMock } = await import("@/test/component-mock-state");
  return {
    useSession: () => ({
      status: testSessionMock.status,
      data: testSessionMock.data,
    }),
  };
});

vi.mock("next/navigation", async () => {
  const React = await import("react");
  const { applyTestNavigationHref, testNavigation } = await import(
    "@/test/url-navigation"
  );
  return {
    useRouter: () => ({
      replace: (href: string) =>
        applyTestNavigationHref(href, testNavigation.replaceCalls),
      push: (href: string) =>
        applyTestNavigationHref(href, testNavigation.pushCalls),
      prefetch: () => undefined,
      back: () => undefined,
    }),
    usePathname: () => testNavigation.pathname,
    useSearchParams: () => {
      const [, forceUpdate] = React.useReducer((tick: number) => tick + 1, 0);
      React.useEffect(() => {
        testNavigation.listeners.add(forceUpdate);
        return () => {
          testNavigation.listeners.delete(forceUpdate);
        };
      }, [forceUpdate]);
      return testNavigation.params;
    },
  };
});

vi.mock("@/components/echart", async () => {
  const React = await import("react");
  return {
    DashboardChart: (props: { height?: number }) =>
      React.createElement("div", {
        "data-testid": "alert-test-chart",
        "data-height": String(props.height ?? ""),
      }),
  };
});

// jsdom 无完整 antd token 上下文与真实 CSS 变量；图表主题走确定性替身
// （Alert Center 仅消费 colors/fontFamily/echartsTheme 三个值）。
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

vi.mock("@tanstack/react-virtual", async () => {
  const { testVirtualizerMock } = await import("@/test/component-mock-state");
  return {
    useWindowVirtualizer: (options: {
      count: number;
      enabled?: boolean;
      estimateSize: () => number;
    }) => {
      testVirtualizerMock.enabled = options.enabled ?? true;
      testVirtualizerMock.count = options.count;
      const estimate = options.estimateSize();
      return {
        getVirtualItems: () =>
          Array.from({ length: options.count }, (_, index) => ({
            index,
            key: index,
            start: index * estimate,
            end: (index + 1) * estimate,
          })),
        getTotalSize: () => options.count * estimate,
        measure: () => {
          testVirtualizerMock.measureCalls += 1;
        },
      };
    },
  };
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function eventRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".ant-list-items > li.ant-list-item"),
  );
}

function paginationEl(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>(".ant-pagination");
  if (!node) {
    throw new Error("pagination not rendered");
  }
  return node;
}

/** 等待事件数据渲染完成（resultCount 在折叠面板内，不可作为就绪信号）。 */
async function awaitEventsLoaded(
  container: HTMLElement,
  expectedRows: number,
): Promise<void> {
  await waitFor(() => expect(eventRows(container)).toHaveLength(expectedRows));
}

/** 构造 35 条事件：默认按索引降序时间（第一条最新）。 */
function buildPagedEvents(): ReturnType<typeof buildAlertEvent>[] {
  return Array.from({ length: 35 }, (_, index) =>
    buildAlertEvent({
      id: `h-${String(index + 1).padStart(3, "0")}`,
      triggeredAt: minutesAgo(index + 1),
    }),
  );
}

/** 最近一次 router.replace 的 href（空串表示尚未写入）。 */
function lastReplaceHref(): string {
  const calls = alertTestNavigation.replaceCalls;
  return calls[calls.length - 1] ?? "";
}

/** 详情卡（标题 Evidence Details 的 Card）。 */
function detailCard(): HTMLElement {
  return screen.getByText("Evidence Details").closest(".ant-card") as HTMLElement;
}

/**
 * 等待定位/收敛 effect 完成（拉回缺陷的回归探测：等待一段时间后
 * 页面内容仍保持当前状态）。
 */
async function settleEffects(ms = 50): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(() => {
  resetAlertTestState();
});

describe("Alert Center 分页与 eventId 优先级（FE-01 契约）", () => {
  it("默认 page=1 pageSize=30：35 条分页器出现，当前页 30 行", async () => {
    const view = renderAlertCenter({ events: buildPagedEvents() });

    expect(
      await screen.findByText("Showing 1-30 of 35"),
    ).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(30);
  });

  it("用户翻页：点击第 2 页稳定停留在第 2 页，URL 写入 page=2（优先级 2，回归：不再被默认选中事件拉回）", async () => {
    const view = renderAlertCenter({ events: buildPagedEvents() });

    await awaitEventsLoaded(view.container, 30);

    // 默认选中 h-001（第 1 页）——用户分页意图必须优先于组件内选中状态
    fireEvent.click(within(paginationEl(view.container)).getByText("2"));

    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(5);
    // 等待 effect 完成后仍不得返回第一页（旧缺陷：定位 effect 持续
    // 监听 listPage 并把页面拉回选中事件所在页）
    await settleEffects();
    expect(screen.getByText("Showing 31-35 of 35")).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(5);
    // URL 出现正确的 page=2，且不携带与分页意图冲突的 eventId
    expect(lastReplaceHref()).toContain("page=2");
    expect(lastReplaceHref()).not.toContain("eventId=");
  }, 20000);

  it("URL page 恢复：?page=2&foo=bar 直接展示第 2 页，未知参数保留且无写回（优先级 5/7/9）", async () => {
    const view = renderAlertCenter({
      events: buildPagedEvents(),
      initialUrl: "/alerts?page=2&foo=bar",
    });

    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(5);
    // 不被默认选中事件（第 1 页的 h-001）拉回
    await settleEffects();
    expect(screen.getByText("Showing 31-35 of 35")).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(5);
    // 无意义 router 写回循环：恢复 URL 不产生任何 replace 调用
    expect(alertTestNavigation.replaceCalls).toHaveLength(0);
  }, 20000);

  it("eventId 深链：选中 h-035 并自动定位到第 2 页，URL 状态稳定（优先级 1/8）", async () => {
    const view = renderAlertCenter({
      events: buildPagedEvents(),
      initialUrl: "/alerts?eventId=h-035",
    });

    // h-035 位于第 2 页（30/页）→ 直接展示第 2 页并选中
    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(5);
    expect(
      within(detailCard()).getByText("Rule h-035"),
    ).toBeInTheDocument();

    // URL 写回 page=2 + eventId=h-035，且状态稳定（无持续写回循环）
    expect(lastReplaceHref()).toContain("page=2");
    expect(lastReplaceHref()).toContain("eventId=h-035");
    const callCountAfterPosition = alertTestNavigation.replaceCalls.length;
    await settleEffects();
    expect(screen.getByText("Showing 31-35 of 35")).toBeInTheDocument();
    expect(alertTestNavigation.replaceCalls).toHaveLength(
      callCountAfterPosition,
    );
  }, 20000);

  it("eventId 定位后手动翻页：稳定停留在第 1 页，URL 清除冲突 eventId、保留未知参数（优先级 2）", async () => {
    const view = renderAlertCenter({
      events: buildPagedEvents(),
      initialUrl: "/alerts?eventId=h-035&foo=bar",
    });
    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();

    fireEvent.click(within(paginationEl(view.container)).getByText("1"));

    expect(
      await screen.findByText("Showing 1-30 of 35"),
    ).toBeInTheDocument();
    // 等待 effect 完成后不被 h-035（第 2 页）再次拉回
    await settleEffects();
    expect(screen.getByText("Showing 1-30 of 35")).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(30);
    // URL 不保留会导致刷新后重新强制定位的冲突 eventId；
    // page 重置默认 1（省略）；未知参数保留
    const finalHref = lastReplaceHref();
    expect(finalHref).not.toContain("page=");
    expect(finalHref).not.toContain("eventId=");
    expect(finalHref).toContain("foo=bar");
  }, 20000);

  it("pageSize 切换：page 重置 1 且不被旧选中事件拉回，URL 符合契约（优先级 3）", async () => {
    const view = renderAlertCenter({
      events: buildPagedEvents(),
      // h-035 深链定位到第 2 页；改 pageSize 后旧选中事件不得把页码拉走
      initialUrl: "/alerts?eventId=h-035",
    });
    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();

    const sizeChanger = within(
      paginationEl(view.container),
    ).getByRole("combobox");
    await userEvent.click(sizeChanger);
    await userEvent.click(
      await screen.findByRole("option", { name: "20 / page" }),
    );

    expect(
      await screen.findByText("Showing 1-20 of 35"),
    ).toBeInTheDocument();
    await settleEffects();
    // h-035 在 pageSize=20 时位于第 2 页（索引 34）——页面稳定停在第 1 页
    expect(screen.getByText("Showing 1-20 of 35")).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(20);
    // URL：pageSize=20 写入；page 重置默认 1（省略）；eventId 清除
    const finalHref = lastReplaceHref();
    expect(finalHref).toContain("pageSize=20");
    expect(finalHref).not.toContain("page=");
    expect(finalHref).not.toContain("eventId=");
  }, 20000);

  it("pageSize 下拉选项与 URL 契约一致：含默认 30，且默认值可重新选择（单一事实源）", async () => {
    const view = renderAlertCenter({ events: buildPagedEvents() });
    await awaitEventsLoaded(view.container, 30);

    const sizeChanger = within(
      paginationEl(view.container),
    ).getByRole("combobox");
    await userEvent.click(sizeChanger);
    // 修复前选项只有 20/50/100：默认 30 存在却无法从下拉重新选择
    for (const optionName of [
      "20 / page",
      "30 / page",
      "50 / page",
      "100 / page",
    ]) {
      expect(
        await screen.findByRole("option", { name: optionName }),
      ).toBeInTheDocument();
    }
    await userEvent.click(
      await screen.findByRole("option", { name: "20 / page" }),
    );
    expect(
      await screen.findByText("Showing 1-20 of 35"),
    ).toBeInTheDocument();

    // 从 20 重选默认 30：可重新选择，且 URL 回到默认（pageSize 省略）
    await userEvent.click(
      within(paginationEl(view.container)).getByRole("combobox"),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "30 / page" }),
    );
    expect(
      await screen.findByText("Showing 1-30 of 35"),
    ).toBeInTheDocument();
    await settleEffects();
    expect(lastReplaceHref()).not.toContain("pageSize=");
  }, 20000);

  it("pageSize 可切换：切到 20 后每页 20 条", async () => {
    const view = renderAlertCenter({ events: buildPagedEvents() });

    await awaitEventsLoaded(view.container, 30);

    const sizeChanger = within(
      paginationEl(view.container),
    ).getByRole("combobox");
    await userEvent.click(sizeChanger);
    await userEvent.click(
      await screen.findByRole("option", { name: "20 / page" }),
    );

    expect(
      await screen.findByText("Showing 1-20 of 35"),
    ).toBeInTheDocument();
    expect(eventRows(view.container)).toHaveLength(20);
  }, 20000);

  it("URL 指定 eventId 时页码自动定位到包含该事件的页", async () => {
    const view = renderAlertCenter({
      events: buildPagedEvents(),
      initialUrl: "/alerts?eventId=h-035",
    });

    // h-035 位于第 2 页（30/页）→ 直接展示第 2 页
    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Alert message h-035").length,
    ).toBeGreaterThan(0);
    expect(eventRows(view.container)).toHaveLength(5);
  });

  it("筛选排除当前事件后页码收敛回第 1 页", async () => {
    const events = Array.from({ length: 35 }, (_, index) =>
      buildAlertEvent({
        id: `h-${String(index + 1).padStart(3, "0")}`,
        triggeredAt: minutesAgo(index + 1),
        metricProvider:
          index < 30
            ? AlertMetricProvider.EconomicAnomaly
            : AlertMetricProvider.RealtimeSignal,
      }),
    );
    // URL eventId=h-035（realtime，第 2 页）
    const view = renderAlertCenter({
      events,
      initialUrl: "/alerts?eventId=h-035",
    });
    expect(
      await screen.findByText("Showing 31-35 of 35"),
    ).toBeInTheDocument();

    // 筛选收敛：仅剩 economic_anomaly 的 30 条 → 回到第 1 页
    //（30 条 === pageSize 30，分页器不渲染，用行数断言页码收敛）
    fireEvent.click(screen.getByText("Economic anomaly"));

    await waitFor(() => expect(eventRows(view.container)).toHaveLength(30));
    expect(
      screen.queryByText("Showing 31-35 of 35"),
    ).not.toBeInTheDocument();
    // h-035 被筛选排除 → 详情保留 + 排除提示
    expect(
      screen.getByText("Selected event is outside the current filters."),
    ).toBeInTheDocument();
  }, 20000);
});

describe("Alert Center 批量选择（迁移前行为）", () => {
  it("行勾选累计；Select visible 勾选当前页全部", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", triggeredAt: minutesAgo(1) }),
        buildAlertEvent({ id: "e-2", triggeredAt: minutesAgo(2) }),
        buildAlertEvent({ id: "e-3", triggeredAt: minutesAgo(3) }),
      ],
    });
    await awaitEventsLoaded(view.container, 3);

    const rows = eventRows(view.container);
    await userEvent.click(within(rows[1]!).getByRole("checkbox"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Select visible"));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("筛选排除部分选中项：显示隐藏选中数，可一键清理", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          metricProvider: AlertMetricProvider.EconomicAnomaly,
          triggeredAt: minutesAgo(1),
          message: "economic event",
        }),
        buildAlertEvent({
          id: "e-2",
          metricProvider: AlertMetricProvider.RealtimeSignal,
          triggeredAt: minutesAgo(2),
          message: "realtime event",
        }),
      ],
    });
    await awaitEventsLoaded(view.container, 2);

    // 全选两行
    await userEvent.click(screen.getByText("Select visible"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    // provider 筛选排除 e-2 → 1 条隐藏选中
    fireEvent.click(screen.getByText("Economic anomaly"));
    expect(
      await screen.findByText("1 selected outside current filters"),
    ).toBeInTheDocument();

    // 清理隐藏选中：仅保留筛选内选中
    await userEvent.click(screen.getByText("Clear hidden selection"));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    expect(
      screen.queryByText(/selected outside current filters/),
    ).not.toBeInTheDocument();
  });
});

describe("Alert Center 批量状态更新（迁移前行为）", () => {
  it("批量确认：每批 20 条、部分成功提示、成功后 refetch 并清空选择", async () => {
    const view = renderAlertCenter({
      events: buildPagedEvents().slice(0, 25),
      permissions: ["alerts.read", "alerts.manage"],
      rejectEventIds: ["h-024", "h-025"],
    });

    await awaitEventsLoaded(view.container, 25);
    await userEvent.click(screen.getByText("Select visible"));
    expect(screen.getByText("25 selected")).toBeInTheDocument();

    const releaseMutations = holdAlertTestMutations(view.apollo);
    await userEvent.click(screen.getByText("Batch confirm"));

    // 第一批 20 条在途（进度进行中）时：第二批不发出
    await screen.findByText("0 / 25 processed");
    await waitFor(() => expect(view.apollo.mutations).toHaveLength(20));

    releaseMutations();

    // 23 成功 + 2 失败（h-024/h-025 被拒绝）
    expect(
      await screen.findByText("Updated 23 alerts to confirmed.", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("2 alerts failed to update."),
    ).toBeInTheDocument();
    expect(view.apollo.mutations).toHaveLength(25);
    expect(
      new Set(view.apollo.mutations.map((call) => call.eventId)).size,
    ).toBe(25);
    expect(view.apollo.mutations.every((call) => call.status === "confirmed")).toBe(
      true,
    );

    // 成功后：清空选择 + 事件 refetch
    expect(await screen.findByText("0 selected")).toBeInTheDocument();
    await waitFor(() =>
      expect(view.apollo.eventsLimits.length).toBeGreaterThan(1),
    );
    expect(screen.queryByText(/processed/)).not.toBeInTheDocument();
  }, 20000);

  it("批量备注随 mutation 传递", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", triggeredAt: minutesAgo(1) }),
        buildAlertEvent({ id: "e-2", triggeredAt: minutesAgo(2) }),
      ],
      permissions: ["alerts.read", "alerts.manage"],
    });

    await awaitEventsLoaded(view.container, 2);
    await userEvent.click(screen.getByText("Select visible"));

    await userEvent.type(
      screen.getByPlaceholderText("Optional batch note"),
      "team decision",
    );
    await userEvent.click(screen.getByText("Batch ignore"));

    await waitFor(() => expect(view.apollo.mutations).toHaveLength(2));
    expect(
      view.apollo.mutations.every((call) => call.status === "ignored"),
    ).toBe(true);
    expect(
      view.apollo.mutations.every((call) => call.note === "team decision"),
    ).toBe(true);
  });

  it("单项确认：feedback note 作为备注传递；一键确认不带备注", async () => {
    const view = renderAlertCenter({
      events: [buildAlertEvent({ id: "e-1", ruleId: "rule-1" })],
      permissions: ["alerts.read", "alerts.manage"],
    });

    await awaitEventsLoaded(view.container, 1);
    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));

    await userEvent.type(
      screen.getByPlaceholderText("Optional note (why confirmed/ignored)"),
      "please review",
    );
    await userEvent.click(screen.getByText("Confirm"));

    await waitFor(() => expect(view.apollo.mutations).toHaveLength(1));
    expect(view.apollo.mutations[0]).toEqual({
      eventId: "e-1",
      status: "confirmed",
      note: "please review",
    });

    await userEvent.click(screen.getByText("One-click confirm"));
    await waitFor(() => expect(view.apollo.mutations).toHaveLength(2));
    expect(view.apollo.mutations[1]).toEqual({
      eventId: "e-1",
      status: "confirmed",
      note: null,
    });
  });
});

describe("Alert Center 导出（迁移前行为）", () => {
  it("导出 scope：selected 与 page 两档，空选择时按钮不可执行", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", triggeredAt: minutesAgo(1) }),
        buildAlertEvent({ id: "e-2", triggeredAt: minutesAgo(2) }),
      ],
    });
    await awaitEventsLoaded(view.container, 2);

    // 默认 scope=selected 且未勾选 → 0 行，按钮禁用（断言落到 button 元素）
    expect(screen.getByText("0 rows ready")).toBeInTheDocument();
    expect(
      screen.getByText("Export CSV").closest("button"),
    ).toBeDisabled();
    expect(
      screen.getByText("Export JSON").closest("button"),
    ).toBeDisabled();

    // 勾选 1 行 → selected scope 1 行
    const rows = eventRows(view.container);
    await userEvent.click(within(rows[0]!).getByRole("checkbox"));
    expect(await screen.findByText("1 rows ready")).toBeInTheDocument();
    expect(
      screen.getByText("Export CSV").closest("button"),
    ).toBeEnabled();

    // 切到 page scope → 当前页 2 行
    await userEvent.click(screen.getByText("Current page"));
    expect(await screen.findByText("2 rows ready")).toBeInTheDocument();
    expect(
      screen.getByText("Export CSV").closest("button"),
    ).toBeEnabled();
    expect(
      screen.getByText("Export JSON").closest("button"),
    ).toBeEnabled();
  });

  it("导出 JSON/CSV：生成下载并提示成功", async () => {
    const createObjectURL = vi.fn(() => "blob:alert-test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });

    renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", triggeredAt: minutesAgo(1) }),
        buildAlertEvent({ id: "e-2", triggeredAt: minutesAgo(2) }),
      ],
    });

    await waitFor(() =>
      expect(screen.getByText("Export CSV")).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText("Current page"));
    expect(await screen.findByText("2 rows ready")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Export JSON"));
    expect(await screen.findByText("Export completed.")).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByText("Export CSV"));
    await waitFor(() =>
      expect(screen.getAllByText("Export completed.").length).toBeGreaterThanOrEqual(2),
    );
  });
});
