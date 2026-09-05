import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CrawlTaskStatus } from "@/graphql/generated";
import {
  testMessages,
  testOpsSocket,
  testTaskLogs,
} from "@/test/component-mock-state";
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
  const { createCrawlAntdMock } = await import("@/test/component-mock-state");
  return createCrawlAntdMock(await importOriginal());
});

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: () => undefined,
}));

describe("CrawlTaskDetail access（权限 fail-closed）", () => {
  it("session loading：显示加载态且不发起任何 GraphQL 请求", async () => {
    const { apollo } = renderCrawlTaskDetail({ sessionStatus: "loading" });

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(apollo.operations).toEqual([]);
  });

  it("无 crawl.read/crawl.write：Admin only 卡片，query skip、无 socket、无 REST", async () => {
    const { apollo, container } = renderCrawlTaskDetail({
      permissions: ["items.read"],
      accessToken: "token-1",
    });

    expect(screen.getByText("Admin only")).toBeInTheDocument();
    expect(screen.getByText("Admin only description")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(apollo.operations).toEqual([]);
    expect(testOpsSocket.namespaces).toEqual([]);
    expect(testTaskLogs.calls).toEqual([]);
    expect(container.querySelector(".ant-spin")).toBeNull();
  });

  it("crawl.read 只读：query 变量契约 resultLimit=20 / resultSearch=null，无管理操作", async () => {
    const { apollo, container } = renderCrawlTaskDetail({
      permissions: ["crawl.read"],
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    await screen.findByText("Concurrency");
    await waitFor(() =>
      expect(apollo.taskVariables).toEqual([
        { id: "task-1", resultLimit: 20, resultSearch: null },
      ]),
    );
    // canManage=false：无 Retry / 无 ingest Switch
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".ant-switch")).toBeNull();
    // canCreateItem=false：无 Backfill / 无 Send to Items
    expect(
      screen.queryByRole("button", { name: "Backfill to Items" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send to Items" }),
    ).not.toBeInTheDocument();
    // canViewItems=false：itemId 结果也不显示 Open Item
    expect(
      screen.queryByRole("button", { name: "Open Item" }),
    ).not.toBeInTheDocument();
    // canViewTaskLogs=false：无 Task logs 卡片
    expect(screen.queryByText("Task logs")).not.toBeInTheDocument();
    expect(testTaskLogs.calls).toEqual([]);
  });

  it("crawl.write：Retry 可见，但无 items.write 时无 Backfill 与 Send to Items", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: ["crawl.read", "crawl.write"],
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    expect(
      await screen.findByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".ant-switch")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Backfill to Items" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send to Items" }),
    ).not.toBeInTheDocument();
  });

  it("crawl.read + items.write：Backfill 可用且结果行显示 Send to Items", async () => {
    renderCrawlTaskDetail({
      permissions: ["crawl.read", "items.write"],
      task: buildCrawlTaskDetailTask({
        results: [{ id: "r1" }],
        lastResultAt: "2026-01-15T08:00:00.000Z",
      }),
    });

    const backfill = await screen.findByRole("button", {
      name: "Backfill to Items",
    });
    expect(backfill).not.toBeDisabled();
    expect(
      await screen.findByRole("button", { name: "Send to Items" }),
    ).toBeInTheDocument();
    // 无 crawl.write：Retry 仍不可见
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("crawl.read + items.read：itemId 结果显示状态 Tag 与 Open Item，点击跳转 /items/{id}", async () => {
    renderCrawlTaskDetail({
      permissions: ["crawl.read", "items.read"],
      task: buildCrawlTaskDetailTask({
        status: CrawlTaskStatus.Failed,
        results: [{ id: "r1", itemId: "item-9", itemStatus: "COMPLETED" }],
      }),
    });

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    const openButton = await screen.findByRole("button", {
      name: "Open Item",
    });
    expect(
      screen.queryByRole("button", { name: "Send to Items" }),
    ).not.toBeInTheDocument();

    fireEvent.click(openButton);
    await waitFor(() =>
      expect(testNavigation.pushCalls).toContain("/items/item-9"),
    );
  });

  it("settings.manage：初次进入请求 task logs 一次，REST 参数符合契约，手动可刷新", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: ["crawl.read", "settings.manage"],
    });

    expect(await screen.findByText("Task logs")).toBeInTheDocument();
    await waitFor(() => expect(testTaskLogs.calls).toHaveLength(1));
    expect(testTaskLogs.calls[0]!).toEqual({
      url: "admin/quality/task-logs",
      params: { queue: "crawl4ai", jobId: "task-1", limit: 100 },
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(testTaskLogs.calls).toHaveLength(2));
    expect(testMessages.filter((m) => m.kind === "error")).toEqual([]);
    expect(container.querySelector(".ant-alert-error")).toBeNull();
  });
});
