import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  advanceToAdvanced,
  clickNext,
  clickPrevious,
  closeDrawer,
  renderCreateCrawlTaskDrawer,
} from "./create-crawl-task-drawer-test-support";

/** 巨型表单树（153 个 Form.Item 常驻挂载）在 jsdom 中单测渲染需 2-7s：
 *  提升本文件用例/钩子超时，避免默认 5s 误杀（误杀会污染 act 环境并
 *  级联拖垮后续用例的渲染）。 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * FE-批5B characterization tests —— 8.1 公共入口与三步流程。
 * 在旧生产实现上锁定行为；拆分后必须保持。
 *
 * 步骤指示采用底部按钮的存在性（Previous/Next/Submit 仅按 currentStep
 * 渲染），避免依赖 jsdom 中 antd 动画的可见性语义。
 */

function expectStepIndicator(step: 0 | 1 | 2): void {
  const previous = screen.queryByRole("button", { name: "Previous" });
  const next = screen.queryByRole("button", { name: "Next" });
  const submit = screen.queryByRole("button", { name: "Submit" });
  if (step === 0) {
    expect(previous).not.toBeInTheDocument();
    expect(next).toBeInTheDocument();
    expect(submit).not.toBeInTheDocument();
  } else if (step === 1) {
    expect(previous).toBeInTheDocument();
    expect(next).toBeInTheDocument();
    expect(submit).not.toBeInTheDocument();
  } else {
    expect(previous).toBeInTheDocument();
    expect(next).not.toBeInTheDocument();
    expect(submit).toBeInTheDocument();
  }
}

describe("CreateCrawlTaskDrawer（公共入口与三步流程）", () => {
  it("默认 title 为 crawl.createDrawer.title（Create drawer）", () => {
    renderCreateCrawlTaskDrawer();

    expect(screen.getByText("Create drawer")).toBeInTheDocument();
  });

  it("自定义 title 优先于默认值（news-sources 入口契约）", () => {
    renderCreateCrawlTaskDrawer({ title: "New source" });

    expect(screen.getByText("New source")).toBeInTheDocument();
    expect(screen.queryByText("Create drawer")).not.toBeInTheDocument();
  });

  it("三步标题：Template / Basic Info / Configuration", () => {
    renderCreateCrawlTaskDrawer();

    expect(screen.getByText("Template")).toBeInTheDocument();
    expect(screen.getByText("Basic Info")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
  });

  it("初始停留在模板步：模板选择标题在文档中，basic 字段不可见", () => {
    renderCreateCrawlTaskDrawer();

    expectStepIndicator(0);
    expect(
      screen.getByText("Select a template to start"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Target URL")).not.toBeVisible();
    expect(screen.getByLabelText("Display name")).not.toBeVisible();
  });

  it("Next 进入 basic 步并渲染 displayName/url；Previous 返回模板步", async () => {
    renderCreateCrawlTaskDrawer();

    await clickNext();
    expectStepIndicator(1);
    expect(screen.getByLabelText("Target URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();

    clickPrevious();
    expectStepIndicator(0);
    expect(screen.getByText("Select a template to start")).toBeInTheDocument();
    expect(screen.getByLabelText("Target URL")).not.toBeVisible();
  });

  it("basic 步 URL 为空时无法进入 advanced，并显示必填错误", async () => {
    renderCreateCrawlTaskDrawer();

    await clickNext();
    await clickNext();

    expect(await screen.findByText("URL is required")).toBeInTheDocument();
    expectStepIndicator(1);
  });

  it("displayName 80 字符边界：80 通过、81 报错", async () => {
    renderCreateCrawlTaskDrawer();

    await clickNext();
    const displayName = screen.getByLabelText("Display name");
    fireEvent.change(displayName, { target: { value: "a".repeat(80) } });
    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com" },
    });
    await clickNext();
    expectStepIndicator(2);

    // 回到 basic 输入 81 字符
    clickPrevious();
    expectStepIndicator(1);
    fireEvent.change(displayName, { target: { value: "a".repeat(81) } });
    await clickNext();
    expect(
      await screen.findByText("Display name must be at most 80 characters"),
    ).toBeInTheDocument();
    expectStepIndicator(1);
  });

  it("提交入口只在 advanced 步出现；loading 反映在提交按钮上", async () => {
    const handle = renderCreateCrawlTaskDrawer({ loading: true });

    expectStepIndicator(0);

    await advanceToAdvanced(handle);

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeInTheDocument();
    expect(submit).toHaveClass("ant-btn-loading");
  });

  it("默认 submit label 为 Submit；自定义 submitLabel 优先（news-sources 契约）", async () => {
    const handle = renderCreateCrawlTaskDrawer({ submitLabel: "Create" });
    await advanceToAdvanced(handle);
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Submit" }),
    ).not.toBeInTheDocument();
  });

  it("提交（点击 submit 按钮）向 onSubmit 传递完整 Form values", async () => {
    const onSubmit = vi.fn();
    const handle = renderCreateCrawlTaskDrawer({ onSubmit });

    // 选择 news 模板写入默认值
    fireEvent.click(screen.getByText("News Website"));
    await advanceToAdvanced(handle, "https://example.com/a");

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0]![0];
    expect(values.url).toBe("https://example.com/a");
    // 模板默认值进入提交 values
    expect(values.waitUntil).toBe("networkidle");
    expect(values.meanDelayMs).toBe(800);
    expect(values.markdownFilter?.type).toBe("pruning");
    // headless 旧字段被转换；news 模板无 headless 偏好 → headlessMode=auto
    expect(values.headless).toBeUndefined();
    expect(values.headlessMode).toBe("auto");
  });

  it("表单 submit 事件（Enter 提交路径）同样触发 onSubmit", async () => {
    const onSubmit = vi.fn();
    const handle = renderCreateCrawlTaskDrawer({ onSubmit });
    await advanceToAdvanced(handle, "https://example.com/b");

    // Drawer 内容渲染在 body portal，不在 render container 内
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].url).toBe("https://example.com/b");
  });

  it("隐藏 step 的表单值在步骤切换时不丢失", async () => {
    const handle = renderCreateCrawlTaskDrawer();

    await clickNext();
    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com/keep" },
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "kept-name" },
    });
    // 进入 advanced 再返回，值仍在
    await clickNext();
    expectStepIndicator(2);
    clickPrevious();
    expectStepIndicator(1);
    expect(screen.getByLabelText("Target URL")).toHaveValue(
      "https://example.com/keep",
    );
    expect(screen.getByLabelText("Display name")).toHaveValue("kept-name");
    expect(handle.form.getFieldValue("displayName")).toBe("kept-name");
  });

  it("关闭后 step 复位为 0，重新打开回到模板步", async () => {
    const handle = renderCreateCrawlTaskDrawer();

    await advanceToAdvanced(handle);
    expectStepIndicator(2);

    closeDrawer();
    expect(handle.closeCalls()).toBe(1);

    act(() => handle.setOpen(true));
    expectStepIndicator(0);
    expect(
      screen.getByText("Select a template to start"),
    ).toBeInTheDocument();
  });

  it("关闭态（open=false 初始）不渲染表单字段（destroyOnHidden 语义）", () => {
    renderCreateCrawlTaskDrawer({ open: false });

    expect(
      screen.queryByText("Select a template to start"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target URL")).not.toBeInTheDocument();
  });

  it("crawl-tasks 语义：关闭不 reset，草稿跨开合保留，重新打开字段恢复渲染", async () => {
    const handle = renderCreateCrawlTaskDrawer();

    await clickNext();
    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com/draft" },
    });
    fireEvent.click(screen.getByText("News Website"));

    closeDrawer();
    act(() => handle.setOpen(true));
    expectStepIndicator(0);

    await clickNext();
    expectStepIndicator(1);
    expect(screen.getByLabelText("Target URL")).toHaveValue(
      "https://example.com/draft",
    );
    // 模板写入的值同样保留（Form 实例由父持有）
    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");
  });

  it("news-sources 语义：父在关闭时 resetFields，重开后表单为空", async () => {
    const handle = renderCreateCrawlTaskDrawer({ resetOnClose: true });

    await clickNext();
    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com/ephemeral" },
    });

    closeDrawer();
    act(() => handle.setOpen(true));

    await clickNext();
    expect(screen.getByLabelText("Target URL")).toHaveValue("");
    expect(handle.form.getFieldValue("url")).toBeUndefined();
  });

  it("Cancel 触发 onClose（取消按钮路径）", () => {
    const onClose = vi.fn();
    renderCreateCrawlTaskDrawer({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
