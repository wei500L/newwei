import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderCreateCrawlTaskDrawer } from "./create-crawl-task-drawer-test-support";

/** 模板行为断言只依赖模板步交互与表单 store（setFieldsValue 写入/
 *  getFieldValue 读取不要求字段挂载）：将 153 字段的高级配置步 mock
 *  为空哨兵，避免 jsdom 全树挂载。超时保持 30s 不变（本轮不调整）。 */
vi.mock("./create-crawl-task-drawer/advanced-step", () => ({
  AdvancedStep: () => null,
}));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * CreateCrawlTaskDrawer 模板行为：模板默认值写入、headless→headlessMode
 * 转换、defaultTemplateKey 初始化契约、权限门禁与草稿保护。
 *
 * 注：
 * - 模板切换为 setFieldsValue 合并语义（未包含的字段保留前值）；
 * - defaultTemplateKey 持续回写问题（用户主动选择被 effect 改回
 *   news）为已确认缺陷（见 bug-ledger），已由 FE-TPL-01 修复，
 *   回归测试保留在下方。
 */

function templateCard(label: string): HTMLElement {
  const card = screen.getByText(label).closest(".ant-card");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

function selectTemplate(label: string): void {
  fireEvent.click(screen.getByText(label));
}

describe("CreateCrawlTaskDrawer（模板行为）", () => {
  it("选择 news 模板写入模板默认值（含 waitUntil=networkidle 与 markdown 剪枝）", () => {
    const handle = renderCreateCrawlTaskDrawer();

    selectTemplate("News Website");

    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");
    expect(handle.form.getFieldValue("meanDelayMs")).toBe(800);
    expect(handle.form.getFieldValue("pageTimeoutMs")).toBe(45000);
    expect(handle.form.getFieldValue("qualityProfile")).toBe("quality_first");
    expect(handle.form.getFieldValue("pageTypeHint")).toBe("detail");
    expect(handle.form.getFieldValue("markdownOptions")).toMatchObject({
      contentSource: "cleaned_html",
      escapeHtml: true,
      bodyWidth: 80,
    });
    expect(handle.form.getFieldValue("markdownFilter")).toMatchObject({
      type: "pruning",
      thresholdType: "dynamic",
      minWordThreshold: 80,
    });
    expect(handle.form.getFieldValue("cleanMarkdown")).toMatchObject({
      cssSelector: "article,main,.article-body",
      removeOverlayElements: true,
      wordCountThreshold: 120,
    });
  });

  it("选择 reuters_cf 模板：headless=false 转换为 headlessMode=headed，legacy headless 字段不携带值", () => {
    const handle = renderCreateCrawlTaskDrawer();

    selectTemplate("Reuters + Cloudflare");

    expect(handle.form.getFieldValue("headlessMode")).toBe("headed");
    expect(handle.form.getFieldValue("headless")).toBeUndefined();
    expect(handle.form.getFieldValue("enableUndetectedBrowser")).toBe(true);
    expect(handle.form.getFieldValue("waitForSelector")).toBe("article");
    expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(12000);
  });

  it("canWriteItems=false 时模板不能偷偷启用 ingestToItems", () => {
    const handle = renderCreateCrawlTaskDrawer({ canWriteItems: false });

    selectTemplate("News Website");
    expect(handle.form.getFieldValue("ingestToItems")).toBe(false);

    selectTemplate("Reuters + Cloudflare");
    expect(handle.form.getFieldValue("ingestToItems")).toBe(false);
  });

  it("无 defaultTemplateKey（crawl-tasks 入口）：冷启动应用 general，用户可在模板间自由切换", () => {
    const handle = renderCreateCrawlTaskDrawer();

    // 冷启动（FE-TPL-01 修复后）：会话初始化应用 selectedTemplate=general
    expect(templateCard("General")).toHaveClass("border-primary");
    expect(handle.form.getFieldValue("onlyMainContent")).toBe(true);
    expect(handle.form.getFieldValue("userAgentMode")).toBe("random");

    selectTemplate("News Website");
    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");
    expect(templateCard("News Website")).toHaveClass("border-primary");

    // 切到 forum：forum 显式声明的字段被改写；未声明的保留前值（合并语义）
    selectTemplate("Forum");
    expect(templateCard("Forum")).toHaveClass("border-primary");
    expect(handle.form.getFieldValue("scanFullPage")).toBe(true);
    expect(handle.form.getFieldValue("autoExpandDetails")).toBe(true);
    expect(handle.form.getFieldValue("qualityProfile")).toBe("balanced");
    expect(handle.form.getFieldValue("detailExpansion")).toMatchObject({
      maxDetailUrls: 12,
      minRelevanceScore: 0.25,
      requireSameDomain: true,
    });

    selectTemplate("Social Media");
    expect(templateCard("Social Media")).toHaveClass("border-primary");
    expect(handle.form.getFieldValue("headlessMode")).toBe("headed");
    expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(5000);
    expect(handle.form.getFieldValue("scrollDelayMs")).toBe(2000);
    expect(handle.form.getFieldValue("qualityProfile")).toBe("speed_first");
  });

  it("defaultTemplateKey=news（news-sources 契约）：打开即应用 news 默认值", () => {
    const handle = renderCreateCrawlTaskDrawer({ defaultTemplateKey: "news" });

    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");
    expect(handle.form.getFieldValue("meanDelayMs")).toBe(800);
    expect(handle.form.getFieldValue("ingestToItems")).toBe(true);
    expect(templateCard("News Website")).toHaveClass("border-primary");
  });

  it("已填写 URL 或字段已 touched 时，重新打开不被初始化逻辑覆盖（草稿保护）", () => {
    const handle = renderCreateCrawlTaskDrawer({ defaultTemplateKey: "news" });

    // 用户在 news 默认值基础上手动改值并填写 URL（touched）
    act(() => {
      handle.form.setFieldsValue({ meanDelayMs: 1234 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com/draft" },
    });

    // 关闭（不 reset，crawl-tasks 语义）再打开
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => handle.setOpen(true));

    // effect 初始化逻辑因 hasUrl/touched 提前返回，用户值保留
    expect(handle.form.getFieldValue("meanDelayMs")).toBe(1234);
    expect(handle.form.getFieldValue("url")).toBe("https://example.com/draft");
  });

  it("FE-TPL-01 回归：news 默认打开后用户可主动切换模板且不被回写", async () => {
    const handle = renderCreateCrawlTaskDrawer({ defaultTemplateKey: "news" });

    // 打开即应用 news
    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");

    // 用户主动切换到 forum——不再被 defaultTemplateKey 回写
    fireEvent.click(screen.getByText("Forum"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(templateCard("Forum")).toHaveClass("border-primary");
    expect(handle.form.getFieldValue("scanFullPage")).toBe(true);
    expect(handle.form.getFieldValue("autoExpandDetails")).toBe(true);
    // forum 未声明的字段保留前值（合并语义）
    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");

    // 再切换到 social——用户选择持续优先
    fireEvent.click(screen.getByText("Social Media"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(templateCard("Social Media")).toHaveClass("border-primary");
    expect(handle.form.getFieldValue("headlessMode")).toBe("headed");
    expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(5000);
  });

  it("news-sources 语义：父在关闭时 resetFields，重开后重新应用 news 默认值", () => {
    const handle = renderCreateCrawlTaskDrawer({
      defaultTemplateKey: "news",
      resetOnClose: true,
    });

    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");

    act(() => {
      handle.form.setFieldsValue({ meanDelayMs: 9999 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handle.form.getFieldValue("waitUntil")).toBeUndefined();

    act(() => handle.setOpen(true));
    // 重开后表单为空，effect 重新应用 defaultTemplateKey=news
    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");
    expect(handle.form.getFieldValue("meanDelayMs")).toBe(800);
  });
});
