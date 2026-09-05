import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrawlTaskStatus } from "@/graphql/generated";
import { testMessages, testModalConfirm } from "@/test/component-mock-state";
import { testNavigation } from "@/test/url-navigation";

import {
  buildCrawlTaskDetailTask,
  renderCrawlTaskDetail,
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
  const actual = await importOriginal<typeof import("antd")>();
  const { createCrawlAntdMock } = await import("@/test/component-mock-state");
  return createCrawlAntdMock(actual);
});

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: () => undefined,
}));

const FULL_PERMISSIONS = [
  "crawl.read",
  "crawl.write",
  "items.read",
  "items.write",
  "settings.manage",
];

const TASK_WITH_RESULT = buildCrawlTaskDetailTask({
  results: [{ id: "r1" }],
  lastResultAt: "2026-01-15T08:00:00.000Z",
});

function backfillMessageCalls(kind: "success" | "error" | "info" | "warning" | "loading") {
  return testMessages.filter((call) => call.kind === kind);
}

/** 点击 Backfill 并确认 Modal（等待 runBackfillToItems 完成）。 */
async function confirmAndRunBackfill(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Backfill to Items" }));
  await waitFor(() => expect(testModalConfirm.calls).toHaveLength(1));
  expect(testModalConfirm.calls[0].title).toBe(
    "Send missing results to Items?",
  );
  await act(async () => {
    await testModalConfirm.calls[0].onOk?.();
  });
}

describe("CrawlTaskDetail actions（retry / ingest / backfill / create item）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retry：变量 {id}，成功提示，成功后 refetch", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ status: CrawlTaskStatus.Failed }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(apollo.retryVariables).toEqual([{ id: "task-1" }]),
    );
    await waitFor(() =>
      expect(backfillMessageCalls("success")).toEqual([
        { kind: "success", content: "Retry queued" },
      ]),
    );
    await waitFor(() => expect(apollo.taskVariables).toHaveLength(2));
  });

  it("retry 失败：错误消息，不 refetch", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
    });

    await screen.findByText("Concurrency");
    apollo.retryError = new Error("retry exploded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(backfillMessageCalls("error")).toEqual([
        { kind: "error", content: "retry exploded" },
      ]),
    );
    expect(apollo.taskVariables).toHaveLength(1);
  });

  it("unsupported legacy proxy：Retry 禁用，错误告警列出策略问题", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ proxyUrl: "http://legacy-proxy:8080" }),
      }),
    });

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    expect(retryButton).toBeDisabled();
    expect(
      screen.getByText("Unsupported legacy proxy configuration detected"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "task.config.proxyUrl: Custom upstream proxies are no longer supported.",
      ),
    ).toBeInTheDocument();
    expect(container.querySelector(".ant-alert-error")).not.toBeNull();
  });

  it("ingest-to-items 开关：开启需 items.write，成功后 refetch", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });

    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() =>
      expect(apollo.ingestToItemsVariables).toEqual([
        { id: "task-1", enabled: true },
      ]),
    );
    await waitFor(() =>
      expect(backfillMessageCalls("success")).toEqual([
        { kind: "success", content: "Updated." },
      ]),
    );
    await waitFor(() => expect(apollo.taskVariables).toHaveLength(2));
  });

  it("无 items.write 时开启 ingest：权限错误消息，不调用 mutation", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: ["crawl.read", "crawl.write"],
      task: TASK_WITH_RESULT,
    });

    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() =>
      expect(backfillMessageCalls("error")).toEqual([
        { kind: "error", content: "Requires items.write permission." },
      ]),
    );
    expect(apollo.ingestToItemsVariables).toEqual([]);
  });

  it("backfill：确认弹窗后单批执行，变量 {taskId, after:null, limit:50, onlyMissing:true}，成功提示与 refetch", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push({
      scanned: 3,
      ingested: 2,
      skippedExisting: 1,
      failed: 0,
      hasMore: false,
    });

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(apollo.backfillVariables).toEqual([
        { taskId: "task-1", after: null, limit: 50, onlyMissing: true },
      ]),
    );
    // loading message 使用稳定 key，内容按进度推进
    await waitFor(() =>
      expect(
        backfillMessageCalls("loading").map((call) => call.content),
      ).toEqual(["Backfilling results...", "Backfilling... (2 ingested, 1 skipped, 0 failed)"]),
    );
    expect(
      backfillMessageCalls("loading").every(
        (call) => call.key === "crawl-backfill-task-1",
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        backfillMessageCalls("success").map((call) => call.content),
      ).toContain("Queued for processing. Refreshing..."),
    );
    // 成功 notice Alert 常驻可关闭
    expect(
      screen.getByText("Queued for processing. Refreshing..."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 ingested, 1 skipped, 0 failed across 3 scanned results."),
    ).toBeInTheDocument();
    await waitFor(() => expect(apollo.taskVariables).toHaveLength(2));
  });

  it("backfill 游标迭代：第一批 hasMore 后以 after=cursor 继续第二批", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push(
      {
        scanned: 50,
        ingested: 50,
        skippedExisting: 0,
        failed: 0,
        nextCursor: "cursor-1",
        hasMore: true,
      },
      {
        scanned: 10,
        ingested: 5,
        skippedExisting: 5,
        failed: 0,
        hasMore: false,
      },
    );

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(apollo.backfillVariables).toEqual([
        { taskId: "task-1", after: null, limit: 50, onlyMissing: true },
        { taskId: "task-1", after: "cursor-1", limit: 50, onlyMissing: true },
      ]),
    );
  });

  it("backfill 部分失败：warning notice（文案与全失败一致，仅类型不同）", async () => {
    const { container, apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push({
      scanned: 5,
      ingested: 2,
      skippedExisting: 0,
      failed: 3,
      hasMore: false,
    });

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(
        backfillMessageCalls("warning").map((call) => call.content),
      ).toContain("Backfill finished with failures."),
    );
    expect(container.querySelector(".ant-alert-warning")).not.toBeNull();
    expect(
      screen.getByText("Backfill finished with failures."),
    ).toBeInTheDocument();
  });

  it("backfill 全部失败：error 类型 notice 与 message.error", async () => {
    const { container, apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push({
      scanned: 5,
      ingested: 0,
      skippedExisting: 0,
      failed: 5,
      hasMore: false,
    });

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(
        backfillMessageCalls("error").map((call) => call.content),
      ).toContain("Backfill finished with failures."),
    );
    expect(container.querySelector(".ant-alert-error")).not.toBeNull();
    expect(screen.getByText("Backfill finished with failures.")).toBeInTheDocument();
  });

  it("backfill 无缺失结果：info notice『全部已在 Items』", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push({
      scanned: 10,
      ingested: 0,
      skippedExisting: 10,
      failed: 0,
      hasMore: false,
    });

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(
        backfillMessageCalls("info").map((call) => call.content),
      ).toContain("All crawl results are already in Items."),
    );
    expect(
      screen.getByText("All crawl results are already in Items."),
    ).toBeInTheDocument();
  });

  it("backfill mutation 报错：error notice 携带错误描述", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push(new Error("backfill exploded"));

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(screen.getByText("Backfill failed.")).toBeInTheDocument(),
    );
    expect(screen.getByText("backfill exploded")).toBeInTheDocument();
  });

  it("backfill 批次 15s 超时：timeout 描述的 error notice，running 复位", async () => {
    vi.useFakeTimers();
    const { apollo, container } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: TASK_WITH_RESULT,
    });
    apollo.backfillBatches.push("hang");

    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Backfill to Items" }));
    // Modal.confirm mock 同步记录
    expect(testModalConfirm.calls).toHaveLength(1);
    await act(async () => {
      void testModalConfirm.calls[0].onOk?.();
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByText("Backfill failed.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Backfill request timed out. Please try again after refreshing the task.",
      ),
    ).toBeInTheDocument();
    await act(async () => {});
    expect(container.querySelector(".ant-btn-loading")).toBeNull();
  });

  it("无结果且无 lastResultAt：Backfill 禁用并显示空态提示，点击无副作用", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [] }),
    });

    const backfill = await screen.findByRole("button", {
      name: "Backfill to Items",
    });
    expect(backfill).toBeDisabled();
    expect(
      screen.getByText("No crawl results available yet."),
    ).toBeInTheDocument();
    fireEvent.click(backfill);
    await act(async () => {});
    expect(testModalConfirm.calls).toEqual([]);
    expect(apollo.backfillVariables).toEqual([]);
  });

  it("无结果但有 lastResultAt：确认后执行，扫描 0 走空态 notice", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [],
        lastResultAt: "2026-01-15T08:00:00.000Z",
      }),
    });

    await screen.findByText("Concurrency");
    await confirmAndRunBackfill();

    await waitFor(() =>
      expect(apollo.backfillVariables).toEqual([
        { taskId: "task-1", after: null, limit: 50, onlyMissing: true },
      ]),
    );
    await waitFor(() =>
      expect(
        backfillMessageCalls("info").map((call) => call.content),
      ).toContain("No results to backfill yet."),
    );
    expect(
      screen.getByText("No results to backfill yet."),
    ).toBeInTheDocument();
  });

  it("create item：变量 {resultId}，成功提示并跳转 /items/{createdId}", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Send to Items" }),
    );
    await waitFor(() =>
      expect(apollo.createItemVariables).toEqual([{ resultId: "r1" }]),
    );
    await waitFor(() =>
      expect(
        backfillMessageCalls("success").map((call) => call.content),
      ).toContain("Queued for LLM processing and added to Items."),
    );
    // createItemResult 默认 id 为 item-r1
    await waitFor(() =>
      expect(testNavigation.pushCalls).toContain("/items/item-r1"),
    );
  });

  it("create item 行级 loading：只落在当前 result", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [{ id: "r1" }, { id: "r2" }],
      }),
    });

    const buttons = await screen.findAllByRole("button", {
      name: "Send to Items",
    });
    expect(buttons).toHaveLength(2);
    apollo.createItemHang = true;
    fireEvent.click(buttons[0]);

    await waitFor(() =>
      expect(buttons[0].className).toContain("ant-btn-loading"),
    );
    expect(buttons[1].className).not.toContain("ant-btn-loading");
  });

  it("create item 失败：错误消息，不跳转", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    await screen.findByRole("button", { name: "Send to Items" });
    apollo.createItemError = new Error("create failed");
    fireEvent.click(screen.getByRole("button", { name: "Send to Items" }));

    await waitFor(() =>
      expect(backfillMessageCalls("error")).toEqual([
        { kind: "error", content: "create failed" },
      ]),
    );
    expect(testNavigation.pushCalls).toEqual([]);
    // finally 清理行级 loading
    const button = screen.getByRole("button", { name: "Send to Items" });
    expect(button.className).not.toContain("ant-btn-loading");
  });
});
