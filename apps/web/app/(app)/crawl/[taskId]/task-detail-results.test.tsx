import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

const FULL_PERMISSIONS = [
  "crawl.read",
  "crawl.write",
  "items.read",
  "items.write",
  "settings.manage",
];

describe("CrawlTaskDetail results（搜索 / limit / variants / media / tables / links）", () => {
  it("resultSearch 与输入框分离：Enter 提交 trim 后的搜索词", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    const input = await screen.findByPlaceholderText("Enter Search");
    await waitFor(() =>
      expect(apollo.taskVariables[0]).toEqual({
        id: "task-1",
        resultLimit: 20,
        resultSearch: null,
      }),
    );
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(apollo.taskVariables.at(-1)).toEqual({
        id: "task-1",
        resultLimit: 20,
        resultSearch: "hello",
      }),
    );
    // 输入框同步为 trim 后的值
    expect(input).toHaveValue("hello");
  });

  it("清空输入立即清除 search（不等 Enter）", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    const input = await screen.findByPlaceholderText("Enter Search");
    fireEvent.change(input, { target: { value: "foo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(apollo.taskVariables.at(-1)).toMatchObject({ resultSearch: "foo" }),
    );

    // 清空 → 已提交 search 立即复位；随后切 limit 触发新请求，
    // 其变量应携带 resultSearch: null（若清空未生效会残留 "foo"）
    fireEvent.change(input, { target: { value: "" } });
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Latest 50" }),
    );
    await waitFor(() =>
      expect(apollo.taskVariables.at(-1)).toEqual({
        id: "task-1",
        resultLimit: 50,
        resultSearch: null,
      }),
    );
  });

  it("搜索按钮提交已输入的搜索词", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    const input = await screen.findByPlaceholderText("Enter Search");
    fireEvent.change(input, { target: { value: "bar" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter Search" }));

    await waitFor(() =>
      expect(apollo.taskVariables.at(-1)).toEqual({
        id: "task-1",
        resultLimit: 20,
        resultSearch: "bar",
      }),
    );
  });

  it("resultLimit 切换 50 后 query 变量更新", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [{ id: "r1" }] }),
    });

    await screen.findByPlaceholderText("Enter Search");
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Latest 50" }),
    );

    await waitFor(() =>
      expect(apollo.taskVariables.at(-1)).toEqual({
        id: "task-1",
        resultLimit: 50,
        resultSearch: null,
      }),
    );
  });

  it("仅单一 markdown variant 时不渲染 Tabs；多 variant 渲染并可切换", async () => {
    const single = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [{ id: "r1", markdown: "# only" }],
      }),
    });
    await screen.findByText("# only");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    single.unmount();

    renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [
          {
            id: "r1",
            markdown: "# raw",
            markdownWithCitations: "# cited",
            referencesMarkdown: "# refs",
            fitMarkdown: "# fit",
          },
        ],
      }),
    });
    expect(await screen.findByText("# raw")).toBeInTheDocument();
    for (const tabName of ["Raw", "Citations", "References", "Cleaned"]) {
      expect(
        screen.getByRole("tab", { name: tabName }),
      ).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Citations" }));
    expect(await screen.findByText("# cited")).toBeInTheDocument();
  });

  it("refetch 期间保留旧结果展示，不退化为整页 loading", async () => {
    const { apollo } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [{ id: "r1", sourceUrl: "https://example.com/r1" }],
      }),
    });
    await screen.findByText("https://example.com/r1");

    apollo.taskHang = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(apollo.taskVariables).toHaveLength(2));
    expect(screen.getByText("https://example.com/r1")).toBeInTheDocument();
    expect(screen.queryByText("Task not found")).not.toBeInTheDocument();
  });

  it("空结果列表显示空态文案", async () => {
    renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({ results: [] }),
    });

    expect(await screen.findByText("No results")).toBeInTheDocument();
  });

  it("media JSON：Media 卡片、图片预览、srcset 变体与来源列表", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [
          {
            id: "r1",
            media: JSON.stringify({
              images: [
                {
                  src: "https://example.com/i.png",
                  alt: "An image",
                  width: 120,
                  height: 60,
                  score: 3.256,
                  type: "image/png",
                  srcset: ["a 1x", "b 2x"],
                  pictureSources: [{ src: "ps", type: "image/webp" }],
                },
              ],
            }),
          },
        ],
      }),
    });

    expect(await screen.findByText("Media")).toBeInTheDocument();
    expect(screen.getByText("images (1)")).toBeInTheDocument();
    const img = screen.getByAltText("An image");
    expect(img).toHaveAttribute("src", "https://example.com/i.png");
    // 资源链接
    expect(
      screen.getByRole("link", { name: "https://example.com/i.png" }),
    ).toBeInTheDocument();
    // srcset 变体
    expect(screen.getByText("Srcset variants")).toBeInTheDocument();
    const srcsetBlock = screen
      .getByText("Srcset variants")
      .closest("div")
      ?.querySelector("pre");
    expect(srcsetBlock?.textContent).toContain("a 1x");
    // 来源列表（Picture/Responsive）
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toContain("ps");
  });

  it("stored media：preview/download 解析 /api/ 前缀到 apiRoot，字节数与缺失提示", async () => {
    const { container } = renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [
          {
            id: "r1",
            mediaAssets: JSON.stringify([
              {
                id: "asset-1",
                kind: "image",
                sourceUrl: "https://example.com/s.jpg",
                bytes: 1_572_864,
                contentType: "image/png",
                previewUrl: "/api/crawl-media/preview.jpg",
                downloadUrl: "/api/crawl-media/download.jpg",
              },
              {
                id: "asset-2",
                kind: "pdf",
                sourceUrl: "https://example.com/doc.pdf",
                bytes: 0,
              },
            ]),
          },
        ],
      }),
    });

    expect(await screen.findByText("Stored media")).toBeInTheDocument();
    expect(
      container.querySelector('img[src="http://localhost:4000/api/crawl-media/preview.jpg"]'),
    ).not.toBeNull();
    expect(screen.getByText("IMAGE/PNG • 1.5 MB")).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute(
      "href",
      "http://localhost:4000/api/crawl-media/download.jpg",
    );
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://example.com/s.jpg",
    );
    // 缺少 stored access 链接的资产提示
    expect(
      screen.getByText("Stored media access link is unavailable."),
    ).toBeInTheDocument();
  });

  it("tables：标题、维度 Tag、行预览与剩余数量", async () => {
    renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [
          {
            id: "r1",
            tables: [
              {
                id: "t1",
                caption: "Prices",
                headers: ["Name", "Price"],
                rows: [
                  ["a", "1"],
                  ["b", "2"],
                ],
                rowCount: 7,
                columnCount: 2,
              },
            ],
          },
        ],
      }),
    });

    expect(await screen.findByText("Tables")).toBeInTheDocument();
    expect(screen.getByText("Prices")).toBeInTheDocument();
    expect(screen.getByText("7 × 2")).toBeInTheDocument();
    expect(screen.getByText("Row 1")).toBeInTheDocument();
    expect(screen.getByText("Remaining")).toBeInTheDocument();
    expect(screen.getByText("Release notes")).toBeInTheDocument();
  });

  it("result metadata 与源链接展示", async () => {
    renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [
          {
            id: "r1",
            sourceUrl: "https://example.com/article",
            metadata: "meta info",
          },
        ],
      }),
    });

    expect(
      await screen.findByRole("link", { name: "https://example.com/article" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("meta info")).toBeInTheDocument();
  });

  it("Link Overview：跨结果聚合统计、top 去重排序、low 排序、buckets", async () => {
    const linkStats = {
      totalLinks: 10,
      internalLinks: 6,
      externalLinks: 4,
      averageIntrinsicScore: 3.5,
      highQualityLinks: 7,
      lowQualityLinks: 2,
    };
    renderCrawlTaskDetail({
      permissions: FULL_PERMISSIONS,
      task: buildCrawlTaskDetailTask({
        results: [
          {
            id: "r1",
            linkAnalysis: {
              stats: linkStats,
              topLinks: [
                { href: "https://a.com", text: "A", totalScore: 9 },
                { href: "https://b.com", text: "B", totalScore: 4 },
                { href: "https://c.com", text: "C", contextualScore: 6 },
              ],
              lowQualityLinks: [
                { href: "https://x.com", text: "X", intrinsicScore: 0.1 },
                { href: "https://y.com", text: "Y", intrinsicScore: 0.9 },
              ],
              buckets: [
                { kind: "social", links: [{ href: "https://s.com", text: "S" }] },
              ],
            },
          },
          {
            id: "r2",
            linkAnalysis: {
              stats: {
                ...linkStats,
                totalLinks: 5,
                internalLinks: 2,
                externalLinks: 3,
                averageIntrinsicScore: 1,
                highQualityLinks: 3,
                lowQualityLinks: 1,
              },
              topLinks: [
                // href 重复，聚合去重
                { href: "https://a.com", text: "A", totalScore: 9 },
                { href: "https://d.com", text: "D", totalScore: 8 },
              ],
              lowQualityLinks: [
                { href: "https://z.com", text: "Z", intrinsicScore: 0.5 },
              ],
              buckets: [
                { kind: "social", links: [{ href: "https://t.com", text: "T" }] },
              ],
            },
          },
        ],
      }),
    });

    expect(await screen.findByText("Links")).toBeInTheDocument();
    // 聚合统计：15/8/7/10/3 与加权均值 2.67
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2.67")).toBeInTheDocument();

    // top links 去重后按分数降序：A(9) D(8) C(6) B(4)
    const topContainer = screen.getByText("Top links").closest("div");
    expect(topContainer).not.toBeNull();
    const topLinks = within(topContainer as HTMLElement).getAllByRole("link");
    expect(topLinks.map((link) => link.textContent)).toEqual([
      "A",
      "D",
      "C",
      "B",
    ]);

    // low quality 按 intrinsic 升序：X(0.1) Z(0.5) Y(0.9)
    const lowContainer = screen.getByText("Low quality").closest("div");
    expect(lowContainer).not.toBeNull();
    const lowLinks = within(lowContainer as HTMLElement).getAllByRole("link");
    expect(lowLinks.map((link) => link.textContent)).toEqual(["X", "Z", "Y"]);

    // buckets 聚合 Tag
    expect(screen.getByText("Bucket item")).toBeInTheDocument();
    expect(screen.getByText("Buckets")).toBeInTheDocument();
  });
});
