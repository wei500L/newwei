import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrawlTaskStatus } from "@/graphql/generated";
import {
  emitCrawlSocketEvent,
  testOpsSocket,
} from "@/test/component-mock-state";

import {
  buildCrawlTaskDetailTask,
  renderCrawlTaskDetail,
  type RenderCrawlTaskDetailResult,
} from "./task-detail-test-support";

// ⚠️ vi.mock 工厂只动态 import 零依赖模块（@/test/component-mock-state、
// @/test/url-navigation），避免工厂↔被测模块加载死锁（见 alert-center.test.tsx）。
vi.mock("next-auth/react", async () => {
  const { createCrawlSessionMock } = await import("@/test/component-mock-state");
  return createCrawlSessionMock();
});

vi.mock("next/navigation", async () => {
  const { applyTestNavigationHref, testNavigation } = await import(
    "@/test/url-navigation"
  );
  const { createCrawlNavigationMock } = await import(
    "@/test/component-mock-state"
  );
  return createCrawlNavigationMock(testNavigation, applyTestNavigationHref);
});

vi.mock("socket.io-client", async () => {
  const { createCrawlIoMock } = await import("@/test/component-mock-state");
  return createCrawlIoMock();
});

vi.mock("@/lib/api-client", async () => {
  const { createCrawlApiClientMock } = await import(
    "@/test/component-mock-state"
  );
  return createCrawlApiClientMock();
});

vi.mock("antd", async (importOriginal) => {
  const { createCrawlAntdMock } = await import("@/test/component-mock-state");
  return createCrawlAntdMock(await importOriginal());
});

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: () => undefined,
}));

function crawlTaskRequestCount(view: RenderCrawlTaskDetailResult): number {
  return view.apollo.operations.filter((name) => name === "CrawlTask").length;
}

/** fake timers 下推进时间并冲刷 microtask + React 渲染。 */
async function flushAsync(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CrawlTaskDetail realtime（Socket /ops + 合并刷新 + fallback polling）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("以 access token 连接 {apiRoot}/ops：websocket、withCredentials、autoConnect=false、10s timeout，且经 0ms timer 才 connect", async () => {
    vi.useFakeTimers();
    renderCrawlTaskDetail({ accessToken: "token-1" });

    expect(testOpsSocket.namespaces).toEqual(["http://localhost:4000/ops"]);
    expect(testOpsSocket.options[0]).toMatchObject({
      auth: { token: "token-1" },
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
      timeout: 10_000,
    });
    // 零延迟 timer 尚未触发时不得 connect
    expect(testOpsSocket.instances[0].connectCalls).toBe(0);
    await flushAsync(0);
    expect(testOpsSocket.instances[0].connectCalls).toBe(1);
    // 5 类监听：connect/disconnect/connect_error/ops:error/ops:event
    expect(
      testOpsSocket.instances[0].listeners.map((listener) => listener.event),
    ).toEqual(
      expect.arrayContaining([
        "connect",
        "disconnect",
        "connect_error",
        "ops:error",
        "ops:event",
      ]),
    );
  });

  it("无 access token 时不创建 socket，状态停留 Disconnected", async () => {
    renderCrawlTaskDetail({ permissions: ["crawl.read"] });

    expect(await screen.findByText("Disconnected")).toBeInTheDocument();
    expect(testOpsSocket.namespaces).toEqual([]);
  });

  it("首次连接不强制 refetch；重连触发一次 refetch", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({ accessToken: "token-1" });
    await flushAsync(0);
    const initial = crawlTaskRequestCount(view);
    expect(initial).toBe(1);

    act(() => {
      emitCrawlSocketEvent("connect");
    });
    await flushAsync(700);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(crawlTaskRequestCount(view)).toBe(initial);

    act(() => {
      emitCrawlSocketEvent("disconnect", "transport close");
    });
    await flushAsync(0);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();

    act(() => {
      emitCrawlSocketEvent("connect");
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial + 1);
  });

  it("客户端主动断开（io client disconnect）不设置错误提示", async () => {
    vi.useFakeTimers();
    renderCrawlTaskDetail({ accessToken: "token-1" });
    await flushAsync(0);
    act(() => {
      emitCrawlSocketEvent("connect");
    });
    act(() => {
      emitCrawlSocketEvent("disconnect", "io client disconnect");
    });
    await flushAsync(0);

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(
      screen.queryByText("Realtime updates unavailable"),
    ).not.toBeInTheDocument();
  });

  it("connect_error：断开、错误告警与本地化文案，并启动 3s fallback polling", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({
      accessToken: "token-1",
      task: buildCrawlTaskDetailTask({ status: CrawlTaskStatus.Running }),
    });
    await flushAsync(0);
    const initial = crawlTaskRequestCount(view);

    act(() => {
      emitCrawlSocketEvent("connect_error", { message: "Unauthorized" });
    });
    await flushAsync(0);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Realtime updates unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Crawl realtime access expired. Please sign in again."),
    ).toBeInTheDocument();

    // 断线 + running 任务 → 3 秒 polling
    await flushAsync(3_000);
    expect(crawlTaskRequestCount(view)).toBe(initial + 1);
    await flushAsync(3_000);
    expect(crawlTaskRequestCount(view)).toBe(initial + 2);

    // 恢复连接后停止 polling
    act(() => {
      emitCrawlSocketEvent("connect");
    });
    await flushAsync(6_000);
    expect(crawlTaskRequestCount(view)).toBe(initial + 2);
  });

  it("connecting（bootstrapping）阶段不 fallback polling", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({
      accessToken: "token-1",
      task: buildCrawlTaskDetailTask({ status: CrawlTaskStatus.Running }),
    });
    await flushAsync(0);
    const initial = crawlTaskRequestCount(view);

    // socket 已创建但尚未 connect（connecting/bootstrapping）→ 不 polling
    await flushAsync(9_000);
    expect(crawlTaskRequestCount(view)).toBe(initial);
  });

  it("已完成任务即使断线也不 polling", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({
      accessToken: "token-1",
      task: buildCrawlTaskDetailTask({ status: CrawlTaskStatus.Completed }),
    });
    await flushAsync(0);
    const initial = crawlTaskRequestCount(view);

    act(() => {
      emitCrawlSocketEvent("connect");
    });
    act(() => {
      emitCrawlSocketEvent("disconnect", "io client disconnect");
    });
    await flushAsync(9_000);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(crawlTaskRequestCount(view)).toBe(initial);
  });

  it("ops:event 匹配当前 task：700ms 窗口内多事件只 refetch 一次，窗口后复位", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({ accessToken: "token-1" });
    await flushAsync(0);
    const initial = crawlTaskRequestCount(view);

    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "ACTIVE",
        taskId: "task-1",
      });
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "COMPLETED",
        taskId: "task-1",
      });
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial + 1);
    await flushAsync(2_000);
    expect(crawlTaskRequestCount(view)).toBe(initial + 1);

    // pending 状态复位：窗口后再来一事件会再次 refetch
    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "COMPLETED",
        taskId: "task-1",
      });
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial + 2);
  });

  it("ops:event 匹配 pipelineJobId 前缀与 ${taskId}- jobId 前缀；无关事件不 refetch", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({
      accessToken: "token-1",
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ pipelineJobId: "pipeline-9" }),
      }),
    });
    await flushAsync(0);
    // config 派生 pipelineJobId 变化会重建 socket，取最新实例
    const initial = crawlTaskRequestCount(view);

    // 无关 taskId
    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "COMPLETED",
        taskId: "other-task",
      });
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial);

    // jobId 前缀匹配（task-1-run-2）
    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "COMPLETED",
        jobId: "task-1-run-2",
      });
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial + 1);

    // pipeline source + pipelineJobId 匹配
    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "pipeline",
        event: "COMPLETED",
        pipelineJobId: "pipeline-9",
      });
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial + 2);

    // 不可刷新事件
    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "PONG",
        taskId: "task-1",
      });
    });
    await flushAsync(700);
    expect(crawlTaskRequestCount(view)).toBe(initial + 2);
  });

  it("卸载清理：connect timer、监听器、socket 连接、pending refresh timer 全部清理", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({ accessToken: "token-1" });
    await flushAsync(0);
    const initial = crawlTaskRequestCount(view);

    // 安排一次 700ms 刷新后卸载
    act(() => {
      emitCrawlSocketEvent("ops:event", {
        source: "crawl",
        event: "COMPLETED",
        taskId: "task-1",
      });
    });
    view.unmount();

    await flushAsync(1_000);
    expect(crawlTaskRequestCount(view)).toBe(initial);
    expect(testOpsSocket.instances[0].destroyed).toBe(true);
    expect(testOpsSocket.instances[0].listeners).toEqual([]);
    expect(
      testOpsSocket.instances[0].offCalls.map((call) => call.event),
    ).toEqual(
      expect.arrayContaining([
        "connect",
        "disconnect",
        "connect_error",
        "ops:error",
        "ops:event",
      ]),
    );

    // 未触发的 connect timer 也被清理
    const view2 = renderCrawlTaskDetail({ accessToken: "token-2" });
    expect(testOpsSocket.instances.at(-1)?.connectCalls).toBe(0);
    view2.unmount();
    await flushAsync(1_000);
    expect(testOpsSocket.instances.at(-1)?.connectCalls).toBe(0);
  });

  it("taskId 变化：旧 socket 断开并解绑，新 socket 建立且复用查询 client", async () => {
    vi.useFakeTimers();
    const view = renderCrawlTaskDetail({ accessToken: "token-1" });
    await flushAsync(0);
    expect(testOpsSocket.instances).toHaveLength(1);

    view.rerenderTaskId("task-2");
    await flushAsync(0);

    expect(testOpsSocket.instances).toHaveLength(2);
    expect(testOpsSocket.instances[0].destroyed).toBe(true);
    expect(testOpsSocket.instances[0].listeners).toEqual([]);
    expect(testOpsSocket.namespaces[1]).toBe("http://localhost:4000/ops");
  });
});
