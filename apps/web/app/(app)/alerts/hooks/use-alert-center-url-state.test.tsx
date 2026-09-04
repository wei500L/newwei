import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useAlertCenterUrlState,
  type UseAlertCenterUrlStateResult,
} from "@/app/(app)/alerts/hooks/use-alert-center-url-state";
import {
  resetTestNavigation,
  setTestUrl,
  testNavigation,
} from "@/test/url-navigation";

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

/** 探针：暴露 hook 结果并渲染可点击的 setter。 */
function Probe({ onState }: { onState?: (state: UseAlertCenterUrlStateResult) => void }) {
  const state = useAlertCenterUrlState();
  onState?.(state);
  return (
    <div>
      <span data-testid="probe">
        {state.filterState.severities.join(",")}|{state.filterState.ruleKeyword}|
        {state.filterState.datePreset}|{state.page}|{state.pageSize}|
        {state.eventId ?? ""}
      </span>
      <button
        type="button"
        onClick={() =>
          state.updateFilters({ severities: ["high"], datePreset: "7d" })
        }
      >
        apply-filters
      </button>
      <button type="button" onClick={() => state.setPage(4)}>
        set-page
      </button>
      <button type="button" onClick={() => state.setPageSize(50)}>
        set-pagesize
      </button>
      <button type="button" onClick={() => state.setEventId("e-7")}>
        set-event
      </button>
      <input
        aria-label="keyword"
        value={state.ruleKeywordInput}
        onChange={(event) => state.setRuleKeywordInput(event.target.value)}
      />
    </div>
  );
}

function lastReplace(): string {
  return testNavigation.replaceCalls[
    testNavigation.replaceCalls.length - 1
  ] ?? "";
}

beforeEach(() => {
  resetTestNavigation("/alerts");
});

describe("useAlertCenterUrlState URL 恢复与写回", () => {
  it("完整 URL 恢复筛选与分页状态", () => {
    setTestUrl(
      "/alerts?severity=high&status=pending&q=cpi&range=7d&page=3&pageSize=50&eventId=e-7",
    );
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe(
      "high|cpi|7d|3|50|e-7",
    );
  });

  it("默认 URL：全默认状态且无写回", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("||30d|1|30|");
    expect(testNavigation.replaceCalls).toHaveLength(0);
  });

  it("筛选更新写入 URL 且 page 重置为 1", async () => {
    setTestUrl("/alerts?page=3&eventId=e-7");
    render(<Probe />);

    await userEvent.click(screen.getByText("apply-filters"));

    expect(lastReplace()).toContain("severity=high");
    expect(lastReplace()).toContain("range=7d");
    expect(lastReplace()).not.toContain("page=");
    expect(lastReplace()).toContain("eventId=e-7");
    expect(screen.getByTestId("probe").textContent).toBe(
      "high||7d|1|30|e-7",
    );
  });

  it("page 与 pageSize 独立写回；pageSize 变化重置 page", async () => {
    render(<Probe />);

    await userEvent.click(screen.getByText("set-page"));
    expect(lastReplace()).toContain("page=4");

    await userEvent.click(screen.getByText("set-pagesize"));
    const finalCall = lastReplace();
    expect(finalCall).toContain("pageSize=50");
    expect(finalCall).not.toContain("page=");
  });

  it("eventId 写回并保留未知参数", async () => {
    setTestUrl("/alerts?foo=bar");
    render(<Probe />);

    await userEvent.click(screen.getByText("set-event"));
    expect(lastReplace()).toContain("eventId=e-7");
    expect(lastReplace()).toContain("foo=bar");
  });

  it("back/forward：URL 外部变化同步进状态且无回写", () => {
    const { unmount } = render(<Probe />);
    testNavigation.replaceCalls.length = 0;

    // act 内变更 URL：强制 React flush 采纳 effect
    act(() => {
      setTestUrl("/alerts?severity=low&range=today&page=2");
    });
    expect(screen.getByTestId("probe").textContent).toBe(
      "low||today|2|30|",
    );
    expect(testNavigation.replaceCalls).toHaveLength(0);
    unmount();
  });
});

describe("useAlertCenterUrlState rule keyword debounce", () => {
  it("220ms 静默后才写入 URL；输入值即时生效于输入框", async () => {
    vi.useFakeTimers();
    try {
      render(<Probe />);
      const input = screen.getByLabelText("keyword");

      // fake timers 下用 fireEvent（userEvent.type 内部依赖真实计时器）
      fireEvent.change(input, { target: { value: "cpi" } });
      // 输入框即时值
      expect(input).toHaveValue("cpi");
      // URL 尚未写入
      expect(testNavigation.params.get("q")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(lastReplace()).toContain("q=cpi");
      expect(screen.getByLabelText("keyword")).toHaveValue("cpi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("URL 外部变化的 q 回灌输入框（刷新/分享恢复输入态）", () => {
    render(<Probe />);
    expect(screen.getByLabelText("keyword")).toHaveValue("");

    act(() => {
      setTestUrl("/alerts?q=shared");
    });
    expect(screen.getByLabelText("keyword")).toHaveValue("shared");
    expect(testNavigation.replaceCalls).toHaveLength(0);
  });
});
