import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUrlState } from "@/hooks/use-url-state";
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

interface ProbeState {
  tag: string;
  page: number;
}

/** 与被测 hook 契约一致的典型 codec：parse 安全回退 + serialize 只写自己的 key。 */
const PROBE_CODEC = {
  parse: (params: URLSearchParams): ProbeState => ({
    tag: (params.get("tag") ?? "").trim(),
    page: Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
  }),
  serialize: (state: ProbeState, params: URLSearchParams): void => {
    params.delete("tag");
    params.delete("page");
    if (state.tag) {
      params.set("tag", state.tag);
    }
    if (state.page > 1) {
      params.set("page", String(state.page));
    }
  },
};

function Probe({
  codec = PROBE_CODEC,
  onChange,
}: {
  codec?: typeof PROBE_CODEC;
  onChange?: (state: ProbeState) => void;
}) {
  const [state, setState] = useUrlState<ProbeState>(codec);
  onChange?.(state);
  return (
    <div>
      <span data-testid="probe-state">
        {state.tag}|{state.page}
      </span>
      <button
        type="button"
        onClick={() =>
          setState((previous) => ({ ...previous, page: previous.page + 1 }))
        }
      >
        next-page
      </button>
      <input
        aria-label="tag"
        value={state.tag}
        onChange={(event) =>
          setState((previous) => ({ ...previous, tag: event.target.value }))
        }
      />
    </div>
  );
}

beforeEach(() => {
  resetTestNavigation("/probe");
});

describe("useUrlState 读取与写入", () => {
  it("初始从 URL 读取状态", () => {
    setTestUrl("/probe?tag=alpha&page=3");
    render(<Probe />);
    expect(screen.getByTestId("probe-state").textContent).toBe("alpha|3");
  });

  it("默认 URL 时首次挂载不写回（无 replace 调用）", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe-state").textContent).toBe("|1");
    expect(testNavigation.replaceCalls).toHaveLength(0);
  });

  it("非法 URL 读取时回退默认，且不立即改写 URL", () => {
    setTestUrl("/probe?page=0&tag=");
    render(<Probe />);
    expect(screen.getByTestId("probe-state").textContent).toBe("|1");
    expect(testNavigation.replaceCalls).toHaveLength(0);
    expect(testNavigation.params.get("page")).toBe("0");
  });

  it("setState 写回使用 replace 并更新 URL", async () => {
    render(<Probe />);
    await userEvent.click(screen.getByText("next-page"));

    expect(testNavigation.replaceCalls).toEqual(["/probe?page=2"]);
    expect(screen.getByTestId("probe-state").textContent).toBe("|2");
  });

  it("默认值不写入 URL：写回 page=1 时删除 query", async () => {
    setTestUrl("/probe?tag=alpha&page=3");
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId("probe-state").textContent).toBe("alpha|3");

    // URL 外部变化采纳后写回默认值
    setTestUrl("/probe?tag=alpha");
    rerender(<Probe />);
    expect(testNavigation.replaceCalls).toHaveLength(0);
  });

  it("serialize 只动自己的 key：未知参数保留", async () => {
    setTestUrl("/probe?foo=bar&tag=alpha");
    render(<Probe />);
    await userEvent.click(screen.getByText("next-page"));

    expect(testNavigation.replaceCalls).toHaveLength(1);
    const href = testNavigation.replaceCalls[0]!;
    expect(href).toContain("foo=bar");
    expect(href).toContain("tag=alpha");
    expect(href).toContain("page=2");
  });

  it("连续 setState 以最近写入为基底，不丢失前序变更", async () => {
    const user = userEvent.setup();
    render(<Probe />);

    const input = screen.getByLabelText("tag");
    await user.type(input, "a");
    await user.type(input, "b");

    // 最终 URL 包含 tag=ab（而非被中途查询覆盖回 a）
    const lastHref =
      testNavigation.replaceCalls[testNavigation.replaceCalls.length - 1]!;
    expect(lastHref).toContain("tag=ab");
    expect(screen.getByTestId("probe-state").textContent).toBe("ab|1");
  });
});

describe("useUrlState 外部 URL 变化", () => {
  it("back/forward（URL 外部变化）时状态重新同步且不产生回写", () => {
    setTestUrl("/probe?tag=alpha&page=2");
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId("probe-state").textContent).toBe("alpha|2");
    testNavigation.replaceCalls.length = 0;

    // act 内变更 URL：强制 React flush 采纳 effect
    act(() => {
      setTestUrl("/probe?tag=beta");
    });
    expect(screen.getByTestId("probe-state").textContent).toBe("beta|1");
    expect(testNavigation.replaceCalls).toHaveLength(0);
    unmount();
  });

  it("URL 与状态一致的外部变化不触发循环写回", () => {
    setTestUrl("/probe?tag=alpha");
    const { unmount } = render(<Probe />);

    act(() => {
      for (let index = 0; index < 3; index += 1) {
        setTestUrl("/probe?tag=alpha");
      }
    });
    expect(testNavigation.replaceCalls).toHaveLength(0);
    expect(screen.getByTestId("probe-state").textContent).toBe("alpha|1");
    unmount();
  });
});

describe("useUrlState equals 与 push 模式", () => {
  it("自定义 equals 避免等价状态的写回", async () => {
    const codec = {
      ...PROBE_CODEC,
      // tag 大小写不敏感比较
      equals: (a: ProbeState, b: ProbeState) =>
        a.tag.toLowerCase() === b.tag.toLowerCase() && a.page === b.page,
    };
    const onChange = vi.fn();
    setTestUrl("/probe?tag=Alpha");
    const { unmount } = render(<Probe codec={codec} onChange={onChange} />);

    setTestUrl("/probe?tag=ALPHA");
    // URL 外部变化（大小写不同）→ equals 判等，state 不重置
    expect(screen.getByTestId("probe-state").textContent).toBe("Alpha|1");
    unmount();
  });

  it("method=push 使用 router.push", async () => {
    function PushProbe() {
      const [state, setState] = useUrlState<ProbeState>({
        ...PROBE_CODEC,
        method: "push",
      });
      return (
        <button type="button" onClick={() => setState({ ...state, page: 5 })}>
          jump
        </button>
      );
    }
    render(<PushProbe />);
    await userEvent.click(screen.getByText("jump"));

    expect(testNavigation.pushCalls).toEqual(["/probe?page=5"]);
    expect(testNavigation.replaceCalls).toHaveLength(0);
  });
});
