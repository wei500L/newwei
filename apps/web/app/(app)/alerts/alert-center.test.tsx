import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertMetricProvider } from "@/graphql/generated";

import {
  alertTestNavigation,
  alertTestVirtualizer,
  buildAlertEvent,
  emitAlertTestSubscriptionEvent,
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

/** 指定分钟前的 ISO 时间戳（保证多事件排序确定）。 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** 事件列表 li 行（antd List 渲染 .ant-list-items > li）。 */
function eventRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".ant-list-items > li.ant-list-item"),
  );
}

/** 详情卡（标题 Evidence Details 的 Card）。 */
function detailCard(): HTMLElement {
  return screen.getByText("Evidence Details").closest(".ant-card") as HTMLElement;
}

function statCard(title: string): HTMLElement {
  return screen.getByText(title).closest(".ant-card") as HTMLElement;
}

/**
 * 展开筛选面板：severity/status/provider Select、关键字输入、时间
 * Segmented 与 resultCount 都在 Collapse 面板内，默认收起时不在 DOM。
 */
async function openFilters(): Promise<void> {
  await userEvent.click(screen.getByText("Filters"));
}

/** fake timers 下展开筛选面板（userEvent 依赖真实计时器）。 */
function openFiltersSync(): void {
  fireEvent.click(screen.getByText("Filters"));
}

/** 在筛选下拉中选择一个选项（severity=0 / status=1 / provider=2）。 */
async function selectFilterOption(
  comboboxIndex: number,
  optionName: string,
): Promise<void> {
  await userEvent.click(screen.getAllByRole("combobox")[comboboxIndex]!);
  await userEvent.click(
    await screen.findByRole("option", { name: optionName }),
  );
}

/** 等待事件数据渲染（选中事件的消息会同时出现在行与详情卡）。 */
async function awaitEvent(message: string): Promise<void> {
  await waitFor(() =>
    expect(screen.getAllByText(message).length).toBeGreaterThan(0),
  );
}

afterEach(() => {
  resetAlertTestState();
});

describe("Alert Center 会话与权限门禁（迁移前行为）", () => {
  it("session loading：渲染标题与加载态，不渲染主内容", () => {
    renderAlertCenter({ sessionStatus: "loading" });

    expect(screen.getByText("Alert Center")).toBeInTheDocument();
    expect(screen.queryByText("Trigger History")).not.toBeInTheDocument();
    expect(screen.queryByText("Filters")).not.toBeInTheDocument();
  });

  it("authenticated 但无 alerts.read：显示拒绝访问，且不发起事件查询与订阅", async () => {
    const view = renderAlertCenter({ permissions: [] });

    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You don't have permission to view this data. Contact an administrator if you need access.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Trigger History")).not.toBeInTheDocument();

    // fail-closed：查询与订阅路径本身都不可达
    expect(view.apollo.operations).not.toContain("AlertEvents");
    expect(view.apollo.operations).not.toContain("AlertEventsStream");
  });

  it("unauthenticated：查询与订阅均不启动", () => {
    const view = renderAlertCenter({ sessionStatus: "unauthenticated" });

    expect(view.apollo.operations).not.toContain("AlertEvents");
    expect(view.apollo.operations).not.toContain("AlertEventsStream");
  });

  it("有 alerts.read：发起查询并建立订阅，事件渲染", async () => {
    const view = renderAlertCenter({
      events: [buildAlertEvent({ id: "e-1", message: "readable event" })],
    });

    await awaitEvent("readable event");
    expect(view.apollo.operations).toContain("AlertEvents");
    expect(view.apollo.operations).toContain("AlertEventsStream");
  });
});

describe("Alert Center 订阅与 coalesced refetch（迁移前行为）", () => {
  it("订阅推送触发合并 refetch：两次推送只发一次查询，新事件出现", async () => {
    vi.useFakeTimers();
    try {
      const view = renderAlertCenter({
        events: [buildAlertEvent({ id: "e-1", message: "initial event" })],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getAllByText("initial event").length).toBeGreaterThan(0);
      const initialQueryCount = view.apollo.eventsLimits.length;

      view.apollo.events.push(
        buildAlertEvent({ id: "e-2", message: "streamed event" }),
      );
      emitAlertTestSubscriptionEvent(view.apollo);
      emitAlertTestSubscriptionEvent(view.apollo);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });

      // 两次订阅事件在 800ms 合并窗口内 → 只触发一次 refetch
      expect(view.apollo.eventsLimits.length).toBe(initialQueryCount + 1);
      expect(screen.getAllByText("streamed event").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("卸载后订阅与调度器被清理：不再产生 refetch", async () => {
    vi.useFakeTimers();
    try {
      const view = renderAlertCenter({
        events: [buildAlertEvent({ id: "e-1", message: "initial event" })],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const initialQueryCount = view.apollo.eventsLimits.length;

      emitAlertTestSubscriptionEvent(view.apollo);
      view.unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      expect(view.apollo.eventsLimits.length).toBe(initialQueryCount);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Alert Center alerts.manage 能力矩阵（迁移前行为）", () => {
  it("只读（无 alerts.manage）：无批量按钮、Feedback 页签只读、不发起 tuning 查询", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", ruleId: "rule-1", message: "read only event" }),
      ],
      permissions: ["alerts.read"],
    });

    await awaitEvent("read only event");

    expect(screen.queryByText("Batch confirm")).not.toBeInTheDocument();
    expect(screen.queryByText("Batch ignore")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));
    expect(
      screen.getByText("Feedback actions are available to administrators only."),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Optional note (why confirmed/ignored)"),
    ).not.toBeInTheDocument();

    expect(view.apollo.operations).not.toContain("AlertRuleTuningSuggestion");
  });

  it("alerts.manage：批量按钮渲染、Feedback 可操作、tuning 查询发起", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", ruleId: "rule-1", message: "managed event" }),
      ],
      permissions: ["alerts.read", "alerts.manage"],
    });

    await awaitEvent("managed event");

    expect(screen.getByText("Batch confirm")).toBeInTheDocument();
    expect(screen.getByText("Batch ignore")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));
    expect(
      screen.getByPlaceholderText("Optional note (why confirmed/ignored)"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Reviewed 8 · Confirmed 5 · Ignored 3 · FP rate 37.5%",
      ),
    ).toBeInTheDocument();

    expect(view.apollo.operations).toContain("AlertRuleTuningSuggestion");
  });
});

describe("Alert Center 数据状态（迁移前行为）", () => {
  it("blocking error：显示加载失败与重试；重试成功后渲染事件", async () => {
    const view = renderAlertCenter({
      eventsError: new Error("network down"),
    });

    expect(
      await screen.findByText("Unable to load alert history"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Alert history is temporarily unavailable. Check API connectivity or alert service health, then retry.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Retry fetch")).toBeInTheDocument();
    expect(screen.queryByText("Trigger History")).not.toBeInTheDocument();

    view.apollo.eventsError = null;
    view.apollo.events = [
      buildAlertEvent({ id: "e-1", message: "recovered event" }),
    ];
    await userEvent.click(screen.getByText("Retry fetch"));

    await awaitEvent("recovered event");
    expect(screen.getByText("Trigger History")).toBeInTheDocument();
  });

  it("空列表：显示空态文案", async () => {
    renderAlertCenter({ events: [] });

    expect(await screen.findByText("No alert events yet.")).toBeInTheDocument();
  });

  it("refetch 挂起但有旧数据：保留可用内容，不退化为整页错误", async () => {
    const view = renderAlertCenter({
      events: [buildAlertEvent({ id: "e-1", message: "stale but visible" })],
    });

    await awaitEvent("stale but visible");

    // 下一次 refetch 永不返回
    view.apollo.eventsHang = true;
    await userEvent.click(screen.getAllByText("Refresh")[0]!);

    expect(
      screen.getAllByText("stale but visible").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("Unable to load alert history"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Trigger History")).toBeInTheDocument();
  });

  it("事件按 triggeredAt 倒序排列（乱序输入 → 首行最新）", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-old",
          triggeredAt: minutesAgo(5),
          message: "five minutes ago",
        }),
        buildAlertEvent({
          id: "e-new",
          triggeredAt: minutesAgo(1),
          message: "one minute ago",
        }),
        buildAlertEvent({
          id: "e-mid",
          triggeredAt: minutesAgo(3),
          message: "three minutes ago",
        }),
      ],
    });

    await waitFor(() => expect(eventRows(view.container)).toHaveLength(3));
    const rows = eventRows(view.container);
    expect(within(rows[0]!).getByText("one minute ago")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("five minutes ago")).toBeInTheDocument();

    // 最新事件默认被选中（详情显示其规则名）
    expect(within(detailCard()).getByText("Rule e-new")).toBeInTheDocument();
  });

  it("统计卡按筛选结果计数", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", status: "confirmed", severity: "low" }),
        buildAlertEvent({ id: "e-2", status: "ignored", severity: "medium" }),
        buildAlertEvent({ id: "e-3", status: "pending", severity: "high" }),
      ],
    });

    await waitFor(() => expect(eventRows(view.container)).toHaveLength(3));
    expect(within(statCard("Total alerts")).getByText("3")).toBeInTheDocument();
    expect(within(statCard("Pending")).getByText("1")).toBeInTheDocument();
    expect(within(statCard("Confirmed")).getByText("1")).toBeInTheDocument();
    expect(within(statCard("Ignored")).getByText("1")).toBeInTheDocument();
  });
});

describe("Alert Center 筛选语义（迁移前行为）", () => {
  it("severity 筛选：选择 High 只保留 high 事件", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          severity: "high",
          triggeredAt: minutesAgo(1),
          message: "high event",
        }),
        buildAlertEvent({
          id: "e-2",
          severity: "low",
          triggeredAt: minutesAgo(2),
          message: "low event",
        }),
      ],
    });
    await awaitEvent("high event");

    await openFilters();
    await selectFilterOption(0, "High");

    expect(await screen.findByText("1 / 2 alerts")).toBeInTheDocument();
    await waitFor(() => expect(eventRows(view.container)).toHaveLength(1));
    expect(
      within(eventRows(view.container)[0]!).getAllByText("high event").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("low event")).not.toBeInTheDocument();
  });

  it("status 筛选：选择 Confirmed 只保留 confirmed 事件", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          status: "confirmed",
          triggeredAt: minutesAgo(1),
          message: "confirmed event",
        }),
        buildAlertEvent({
          id: "e-2",
          status: "pending",
          triggeredAt: minutesAgo(2),
          message: "pending event",
        }),
      ],
    });
    await awaitEvent("confirmed event");

    await openFilters();
    await selectFilterOption(1, "Confirmed");

    expect(await screen.findByText("1 / 2 alerts")).toBeInTheDocument();
    await waitFor(() => expect(eventRows(view.container)).toHaveLength(1));
    expect(screen.queryByText("pending event")).not.toBeInTheDocument();
  });

  it("provider 快速标签与完整筛选器同源：快速标签写入同一筛选状态", async () => {
    renderAlertCenter({
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
    await awaitEvent("economic event");

    await userEvent.click(screen.getByText("Economic anomaly"));

    expect(await screen.findByText("1 / 2 alerts")).toBeInTheDocument();
    expect(screen.queryByText("realtime event")).not.toBeInTheDocument();

    // 完整筛选器的 provider Select 显示同一份选中值
    await openFilters();
    const providerSelect = screen.getAllByRole("combobox")[2]!;
    const providerSelector = providerSelect.closest(".ant-select");
    expect(providerSelector).not.toBeNull();
    expect(
      within(providerSelector as HTMLElement).getAllByText("Economic anomaly")
        .length,
    ).toBeGreaterThan(0);
  });

  it("rule keyword：220ms debounce 后才生效过滤", async () => {
    vi.useFakeTimers();
    try {
      const view = renderAlertCenter({
        events: [
          buildAlertEvent({
            id: "e-1",
            ruleName: "Alpha rule",
            triggeredAt: minutesAgo(1),
            message: "alpha event",
          }),
          buildAlertEvent({
            id: "e-2",
            ruleName: "Beta rule",
            triggeredAt: minutesAgo(2),
            message: "beta event",
          }),
        ],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await waitFor(() => expect(eventRows(view.container)).toHaveLength(2));

      openFiltersSync();
      fireEvent.change(screen.getByPlaceholderText("Search by rule name"), {
        target: { value: "alpha" },
      });

      // debounce 窗口内：过滤未生效
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(eventRows(view.container)).toHaveLength(2);
      expect(screen.getAllByText("beta event").length).toBeGreaterThan(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(screen.getByText("1 / 2 alerts")).toBeInTheDocument();
      await waitFor(() => expect(eventRows(view.container)).toHaveLength(1));
      expect(screen.queryByText("beta event")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("时间窗口：默认 30d 排除更早事件；Today 进一步收敛", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00") });
    try {
      const view = renderAlertCenter({
        events: [
          buildAlertEvent({
            id: "e-today",
            triggeredAt: "2026-06-15T10:00:00",
            message: "today event",
          }),
          buildAlertEvent({
            id: "e-yesterday",
            triggeredAt: "2026-06-14T10:00:00",
            message: "yesterday event",
          }),
          buildAlertEvent({
            id: "e-ancient",
            triggeredAt: "2026-05-01T10:00:00",
            message: "ancient event",
          }),
        ],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await waitFor(() => expect(eventRows(view.container)).toHaveLength(2));

      // 默认 30d：today/yesterday 在窗内，ancient 被排除
      expect(screen.queryByText("ancient event")).not.toBeInTheDocument();

      openFiltersSync();
      fireEvent.click(screen.getByText("Today"));

      // fake timers 下用同步断言（findByText 的轮询间隔被 fake 会永久挂起）
      expect(screen.getByText("1 / 3 alerts")).toBeInTheDocument();
      expect(screen.queryByText("yesterday event")).not.toBeInTheDocument();
      expect(screen.getAllByText("today event").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重置筛选：回到默认全量视图", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          severity: "high",
          triggeredAt: minutesAgo(1),
          message: "high event",
        }),
        buildAlertEvent({
          id: "e-2",
          severity: "low",
          triggeredAt: minutesAgo(2),
          message: "low event",
        }),
      ],
    });
    await awaitEvent("high event");

    await openFilters();
    await selectFilterOption(0, "High");
    expect(await screen.findByText("1 / 2 alerts")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Reset"));

    expect(await screen.findByText("2 / 2 alerts")).toBeInTheDocument();
    await waitFor(() => expect(eventRows(view.container)).toHaveLength(2));
    expect(screen.getAllByText("low event").length).toBeGreaterThan(0);
  });
});

describe("Alert Center eventId URL 行为（迁移前行为）", () => {
  it("合法 URL eventId 优先选中该事件", async () => {
    renderAlertCenter({
      events: [
        buildAlertEvent({ id: "e-1", triggeredAt: minutesAgo(1), message: "first event" }),
        buildAlertEvent({ id: "e-2", triggeredAt: minutesAgo(2), message: "second event" }),
      ],
      initialUrl: "/alerts?eventId=e-2",
    });

    await waitFor(() =>
      expect(within(detailCard()).getByText("Rule e-2")).toBeInTheDocument(),
    );
  });

  it("URL eventId 指向不存在的事件时回退到筛选结果首项", async () => {
    renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          triggeredAt: minutesAgo(1),
          message: "first event",
        }),
        buildAlertEvent({
          id: "e-2",
          triggeredAt: minutesAgo(2),
          message: "second event",
        }),
      ],
      initialUrl: "/alerts?eventId=missing",
    });

    await waitFor(() =>
      expect(within(detailCard()).getByText("Rule e-1")).toBeInTheDocument(),
    );
  });

  it("点击行写回 eventId 并保留 URL 中的其他参数", async () => {
    const view = renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          triggeredAt: minutesAgo(2),
          message: "first event",
        }),
        buildAlertEvent({
          id: "e-2",
          triggeredAt: minutesAgo(1),
          message: "second event",
        }),
      ],
      initialUrl: "/alerts?eventId=e-1&foo=bar",
    });

    await waitFor(() => expect(eventRows(view.container)).toHaveLength(2));

    // 首行是 e-2（更新）：点击后 URL eventId 写回 e-2，未知参数 foo 保留
    const rows = eventRows(view.container);
    await userEvent.click(within(rows[0]!).getByRole("button"));

    expect(alertTestNavigation.replaceCalls.length).toBeGreaterThan(0);
    const lastCall =
      alertTestNavigation.replaceCalls[
        alertTestNavigation.replaceCalls.length - 1
      ]!;
    expect(lastCall).toContain("eventId=e-2");
    expect(lastCall).toContain("foo=bar");
    expect(within(detailCard()).getByText("Rule e-2")).toBeInTheDocument();
  });

  it("当前选中事件被筛选排除：详情保留并显示排除提示", async () => {
    renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          severity: "high",
          triggeredAt: minutesAgo(1),
          message: "high event",
        }),
        buildAlertEvent({
          id: "e-2",
          severity: "low",
          triggeredAt: minutesAgo(2),
          message: "low event",
        }),
      ],
      initialUrl: "/alerts?eventId=e-2",
    });

    await waitFor(() =>
      expect(within(detailCard()).getByText("Rule e-2")).toBeInTheDocument(),
    );

    await openFilters();
    await selectFilterOption(0, "High");

    expect(
      await screen.findByText("Selected event is outside the current filters."),
    ).toBeInTheDocument();
    // 详情仍显示被排除的事件
    expect(within(detailCard()).getByText("Rule e-2")).toBeInTheDocument();
  });
});

describe("Alert Center 详情页签（迁移前行为）", () => {
  it("五个详情页签可达且内容切换", async () => {
    renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          metricProvider: AlertMetricProvider.EconomicAnomaly,
          context: {
            observed: 10,
            expected: 8,
            sigma: 1,
            lower: 7,
            upper: 9,
            score: 3.5,
            itemName: "CPI",
            model: { kind: "zscore" },
          },
          message: "detailed event",
        }),
      ],
      permissions: ["alerts.read", "alerts.manage"],
    });

    await awaitEvent("detailed event");

    // 五个页签入口
    for (const label of [
      "Overview",
      "Evidence",
      "Replay",
      "Feedback",
      "Deliveries",
    ]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }

    // Overview 默认内容
    expect(within(detailCard()).getByText("Triggered at")).toBeInTheDocument();

    // Evidence：economic_anomaly 证据分发（score 标签）+ 相似告警卡
    await userEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(await screen.findByText("score 3.500")).toBeInTheDocument();
    expect(screen.getByText("Similar alerts")).toBeInTheDocument();

    // Replay：懒加载图表渲染
    await userEvent.click(screen.getByRole("tab", { name: "Replay" }));
    expect(await screen.findByTestId("alert-test-chart")).toBeInTheDocument();

    // Feedback：管理能力下的操作区
    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));
    expect(
      screen.getByPlaceholderText("Optional note (why confirmed/ignored)"),
    ).toBeInTheDocument();
    expect(screen.getByText("One-click confirm")).toBeInTheDocument();

    // Deliveries：投递记录
    await userEvent.click(screen.getByRole("tab", { name: "Deliveries" }));
    expect(screen.getByText("Ops mailbox")).toBeInTheDocument();
  });

  it("feedback note 从事件 context.feedback.note 预填", async () => {
    renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          message: "feedback event",
          context: { feedback: { note: "preset review note", status: "confirmed" } },
        }),
      ],
      permissions: ["alerts.read", "alerts.manage"],
    });

    await awaitEvent("feedback event");
    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));

    expect(screen.getByDisplayValue("preset review note")).toBeInTheDocument();
  });

  it("复制原始上下文：写剪贴板并提示成功", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderAlertCenter({
      events: [
        buildAlertEvent({
          id: "e-1",
          message: "context event",
          context: { sourceName: "internal-feed" },
        }),
      ],
    });

    await awaitEvent("context event");
    await userEvent.click(screen.getByText("Copy raw"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toMatchObject({
      sourceName: "internal-feed",
    });
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });
});

describe("Alert Center 虚拟化阈值与资源清理（迁移前行为）", () => {
  it("当前页 25 条以内不启用虚拟化，26 条启用", async () => {
    const eventsAt = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        buildAlertEvent({
          id: `v-${String(index + 1).padStart(2, "0")}`,
          triggeredAt: minutesAgo(index + 1),
        }),
      );

    const small = renderAlertCenter({ events: eventsAt(25) });
    await waitFor(() => expect(eventRows(small.container)).toHaveLength(25));
    expect(alertTestVirtualizer.enabled).toBe(false);
    expect(alertTestVirtualizer.count).toBe(25);
    small.unmount();

    const large = renderAlertCenter({ events: eventsAt(26) });
    await waitFor(() => expect(eventRows(large.container)).toHaveLength(26));
    expect(alertTestVirtualizer.enabled).toBe(true);
    expect(alertTestVirtualizer.count).toBe(26);
    // 虚拟化路径下行集合变化触发 measure
    expect(alertTestVirtualizer.measureCalls).toBeGreaterThan(0);
  });

  it("虚拟化启用时注册滚动/缩放监听，卸载后全部清理", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const view = renderAlertCenter({
      events: Array.from({ length: 26 }, (_, index) =>
        buildAlertEvent({
          id: `v-${String(index + 1).padStart(2, "0")}`,
          triggeredAt: minutesAgo(index + 1),
        }),
      ),
    });
    await waitFor(() => expect(eventRows(view.container)).toHaveLength(26));

    const registeredTypes = addSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((type) => type === "resize" || type === "scroll");
    expect(registeredTypes).toContain("resize");
    expect(registeredTypes).toContain("scroll");

    view.unmount();

    const removedTypes = removeSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((type) => type === "resize" || type === "scroll");
    expect(removedTypes.length).toBe(registeredTypes.length);
  });
});

describe("Alert Center 历史加载 300→500（迁移前行为）", () => {
  it("达到当前 limit 显示采样提示；加载更多后以 500 上限 refetch 且提示消失", async () => {
    const events = Array.from({ length: 300 }, (_, index) =>
      buildAlertEvent({
        id: `h-${String(index + 1).padStart(3, "0")}`,
        triggeredAt: minutesAgo(index + 1),
      }),
    );
    const view = renderAlertCenter({ events });

    expect(
      await screen.findByText(
        "Metrics and trends are based on the latest 300 alerts currently loaded.",
      ),
    ).toBeInTheDocument();
    expect(view.apollo.eventsLimits[0]).toBe(300);

    await userEvent.click(screen.getByText("Load more history"));

    await waitFor(() => expect(view.apollo.eventsLimits).toContain(500));
    // 300 条 < 500 上限：采样提示消失
    expect(
      screen.queryByText(/Metrics and trends are based on the latest/),
    ).not.toBeInTheDocument();
  });
});
