import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CrawlTaskStatus } from "@/graphql/generated";
import { testMessages, testTaskLogs } from "@/test/component-mock-state";

import {
  buildCrawlTaskDetailTask,
  buildTaskLog,
  queueTaskLogsResponse,
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

describe("CrawlTaskDetail presentation（加载态 / 头部 / 告警 / 策略 / 配置 / logs）", () => {
  it("query 初始 loading 且无 task：整页 Spin，不渲染详情", async () => {
    const { container } = renderCrawlTaskDetail({ taskHang: true });

    expect(container.querySelector(".ant-spin")).not.toBeNull();
    expect(screen.queryByText("Task not found")).not.toBeInTheDocument();
    expect(screen.queryByText("Back to tasks")).not.toBeInTheDocument();
  });

  it("task 为 null：Task not found", async () => {
    renderCrawlTaskDetail({ task: null });

    expect(await screen.findByText("Task not found")).toBeInTheDocument();
    expect(screen.queryByText("Back to tasks")).not.toBeInTheDocument();
  });

  it("头部：返回任务列表链接、状态 Tag、live Tag、open source 链接", async () => {
    renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        targetUrl: "https://example.com/target",
        status: CrawlTaskStatus.Running,
      }),
    });

    const backLink = await screen.findByRole("link", {
      name: "Back to tasks",
    });
    expect(backLink).toHaveAttribute("href", "/admin/ops/crawl-tasks");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    const openSource = screen.getByRole("link", { name: "Open source" });
    expect(openSource).toHaveAttribute("href", "https://example.com/target");
  });

  it("lastError Alert 类型随任务状态变化：failed=error / completed=success / running=warning", async () => {
    const failed = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        status: CrawlTaskStatus.Failed,
        lastError: "boom",
      }),
    });
    expect(await screen.findByText("Latest error")).toBeInTheDocument();
    expect(failed.container.querySelector(".ant-alert-error")).not.toBeNull();
    expect(screen.getByText("boom")).toBeInTheDocument();
    failed.unmount();

    const completed = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        status: CrawlTaskStatus.Completed,
        lastError: "recovered",
      }),
    });
    expect(await screen.findByText("Latest error")).toBeInTheDocument();
    expect(
      completed.container.querySelector(".ant-alert-success"),
    ).not.toBeNull();
    completed.unmount();

    const running = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        status: CrawlTaskStatus.Running,
        lastError: "partial",
      }),
    });
    expect(await screen.findByText("Latest error")).toBeInTheDocument();
    expect(
      running.container.querySelector(".ant-alert-warning"),
    ).not.toBeNull();
    running.unmount();
  });

  it("headed 任务：运行时指引 Alert；lastError 命中 display / timeout 分类", async () => {
    const headed = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ headless: false }),
      }),
    });
    expect(await screen.findByText("Headed mode and Xvfb")).toBeInTheDocument();
    headed.unmount();

    const display = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ headless: false }),
        lastError: "Cannot open display :99",
      }),
    });
    expect(
      await screen.findByText("Detected DISPLAY/Xvfb dependency issue"),
    ).toBeInTheDocument();
    display.unmount();

    const timeout = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ headless: false }),
        lastError: "Navigation timed out after 30000ms",
      }),
    });
    expect(await screen.findByText("Headed runtime timed out")).toBeInTheDocument();
    timeout.unmount();
  });

  it("策略 Tag 卡片：scanFullPage/virtualScroll/qualityProfile/pageTypeHint/autoExpandDetails；无策略时无卡片", async () => {
    const withStrategy = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({
          scanFullPage: true,
          virtualScroll: { containerSelector: ".main" },
          qualityProfile: "balanced",
          pageTypeHint: "list",
          autoExpandDetails: true,
        }),
      }),
    });
    expect(await screen.findByText("Crawl strategy")).toBeInTheDocument();
    for (const tag of [
      "Scan full page",
      "Virtual scroll",
      "Auto expand details",
    ]) {
      expect(screen.getByText(tag)).toBeInTheDocument();
    }
    // qualityProfile / pageTypeHint 摘要同时呈现在策略 Tag 与 Descriptions 字段
    expect(screen.getAllByText("Balanced")).toHaveLength(2);
    expect(screen.getAllByText("List page")).toHaveLength(2);
    expect(
      screen.getByText(
        "Crawl stage is deterministic (fetch + clean markdown only). Run LLM summarization and analysis in downstream pipelines.",
      ),
    ).toBeInTheDocument();
    withStrategy.unmount();

    const noStrategy = renderCrawlTaskDetail({});
    await screen.findByText("Concurrency");
    expect(screen.queryByText("Crawl strategy")).not.toBeInTheDocument();
    noStrategy.unmount();
  });

  it("代理路由摘要：Direct / legacy proxy 字段文案", async () => {
    const direct = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({ config: JSON.stringify({}) }),
    });
    await screen.findByText("Concurrency");
    expect(screen.getByText("Direct")).toBeInTheDocument();
    direct.unmount();

    const legacy = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ proxyUrl: "http://legacy:1" }),
      }),
    });
    await screen.findByText("Concurrency");
    expect(
      screen.getByText("Unsupported legacy proxy config: http://legacy:1"),
    ).toBeInTheDocument();
    legacy.unmount();
  });

  it("Descriptions 字段：显示名回退、关键词 Tag、上次运行汇总、内存字段", async () => {
    renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        keywords: ["alpha", "beta"],
        lastRunSummary: {
          inserted: 5,
          skipped: 2,
          itemsQueued: 3,
          itemsQueueFailed: 1,
        },
        memoryStats: {
          serverMemoryMb: 512,
          peakMemoryMb: 768,
          efficiencyPercent: 66,
        },
      }),
    });

    await screen.findByText("Concurrency");
    // displayName 回退 targetUrl
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("5 inserted, 2 skipped")).toBeInTheDocument();
    expect(screen.getByText("3 queued, 1 failed")).toBeInTheDocument();
    // 当前 en 文案模板未内插数值（characterization 记录现状）
    expect(screen.getAllByText("Memory value").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Percent value").length).toBeGreaterThan(0);
  });

  it("原始配置 JSON 以 markdown-preview pre 展示", async () => {
    const { container } = renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({ foo: "bar" }),
      }),
    });

    await screen.findByText("Concurrency");
    const configPre = container.querySelector(".markdown-preview");
    expect(configPre?.textContent).toContain('"foo": "bar"');
  });

  it("Multi URL 卡片：策略名、URL 链接", async () => {
    renderCrawlTaskDetail({
      task: buildCrawlTaskDetailTask({
        config: JSON.stringify({
          multiUrlConfigs: [
            {
              name: "Strategy A",
              matcher: { matchMode: "glob", patterns: ["news/*"] },
              urls: ["https://a.com/1"],
              options: { cacheMode: "read" },
            },
          ],
        }),
      }),
    });

    expect(await screen.findByText("Multi URL")).toBeInTheDocument();
    expect(screen.getByText("Strategy A")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://a.com/1" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Patterns")).toBeInTheDocument();
  });

  it("Task logs：表格行、展开 data/error JSON、刷新后清理失效 expanded keys", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: ["crawl.read", "settings.manage"],
      taskLogs: [
        buildTaskLog({ id: "log-1", stage: "fetch", message: "fetched ok" }),
        buildTaskLog({
          id: "log-2",
          stage: "expansion",
          message: "expanded",
          data: { candidateCount: 10 },
        }),
      ],
    });

    await screen.findByText("expanded");
    // expandRowByClick：点击行展开 data/error JSON
    fireEvent.click(screen.getByText("expanded"));
    await waitFor(() =>
      expect(container.querySelectorAll(".ant-table-expanded-row")).toHaveLength(1),
    );
    const expandedPre = container.querySelector(
      ".ant-table-expanded-row pre",
    );
    expect(expandedPre?.textContent).toContain('"candidateCount": 10');

    // 刷新返回不含 log-2 的响应 → expanded keys 被清理
    queueTaskLogsResponse([
      buildTaskLog({ id: "log-9", stage: "fetch", message: "again" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("again")).toBeInTheDocument());
    await waitFor(() =>
      expect(container.querySelectorAll(".ant-table-expanded-row")).toHaveLength(0),
    );
  });

  it("Task logs 刷新失败：错误 Alert 与 message.error", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: ["crawl.read", "settings.manage"],
      taskLogs: [],
    });

    await screen.findByText("Task logs");
    queueTaskLogsResponse(new Error("logs failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(
        testMessages.filter((m) => m.kind === "error").map((m) => m.content),
      ).toContain("logs failed"),
    );
    expect(screen.getByText("Unexpected error")).toBeInTheDocument();
    expect(screen.getByText("logs failed")).toBeInTheDocument();
    expect(container.querySelector(".ant-alert-error")).not.toBeNull();
  });

  it("taskId 变化：清空 expanded keys 并按新 jobId 重新请求 logs", async () => {
    const logs = [
      buildTaskLog({ id: "log-1", stage: "fetch", message: "fetched ok" }),
    ];
    const { container, rerenderTaskId } = renderCrawlTaskDetail({
      permissions: ["crawl.read", "settings.manage"],
      taskLogs: logs,
    });

    await screen.findByText("fetched ok");
    fireEvent.click(screen.getByText("fetched ok"));
    await waitFor(() =>
      expect(container.querySelectorAll(".ant-table-expanded-row")).toHaveLength(1),
    );

    queueTaskLogsResponse(logs);
    rerenderTaskId("task-2");
    await waitFor(() => expect(testTaskLogs.calls)).toHaveLength(2);
    expect(testTaskLogs.calls[1]!.params).toEqual({
      queue: "crawl4ai",
      jobId: "task-2",
      limit: 100,
    });
    // 同样的 logs 返回下 expanded keys 仍被清空（来自 taskId 变化 effect）
    await waitFor(() =>
      expect(container.querySelectorAll(".ant-table-expanded-row")).toHaveLength(0),
    );
  });

  it("expansion 指标与 head signal 摘要来自 task logs", async () => {
    renderCrawlTaskDetail({
      permissions: ["crawl.read", "settings.manage"],
      taskLogs: [
        buildTaskLog({
          id: "log-e",
          stage: "expansion",
          data: {
            candidateCount: 10,
            batchCount: 2,
            improvedSuccesses: 5,
            primaryCandidatePool: 8,
            headSignalEnrichment: {
              attempted: 4,
              succeeded: 3,
              softFailureCount: 2,
              softFailures: { httpStatus: 2 },
              urlPathFallbackCount: 1,
              totalSignalCandidates: 4,
            },
          },
        }),
      ],
    });

    await screen.findByText("Expansion metrics");
    for (const line of [
      "candidateCount=10",
      "batchCount=2",
      "improvedSuccesses=5",
      "primaryCandidatePool=8",
      "headSignalAttempted=4",
      "headSignalSucceeded=3",
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    // soft failure 告警
    expect(
      screen.getByText(
        "2 publish-signal enrichment fetches soft-failed (non-blocking)",
      ),
    ).toBeInTheDocument();
    // url-path fallback 告警（1/4，ratio 25%）
    expect(
      screen.getByText(
        "1/4 candidates fell back to url-path publish confidence",
      ),
    ).toBeInTheDocument();
  });
});
