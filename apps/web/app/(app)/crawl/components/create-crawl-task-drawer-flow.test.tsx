import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  advanceToAdvanced,
  clickNext,
  clickPrevious,
  closeDrawer,
  renderCreateCrawlTaskDrawer,
} from "./create-crawl-task-drawer-test-support";

/** 步骤状态机/草稿/提交门禁断言只依赖 basic 步字段与表单 store：
 *  将 153 字段的高级配置步 mock 为空哨兵，避免 jsdom 全树挂载
 *  （单渲染 2-7s）。高级配置业务与完整提交路径在 conditional 文件
 *  保留全树挂载用例。超时保持 30s 不变（CI 满载余量，本轮不调整）。 */
vi.mock("./create-crawl-task-drawer/advanced-step", () => ({
  AdvancedStep: () => null,
}));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * CreateCrawlTaskDrawer 公共入口与三步流程（步骤状态机、草稿保留、
 * 关闭复位语义、提交门禁）。
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

  it("提交入口只在 advanced 步出现；loading 与自定义 submitLabel 反映在提交按钮上", async () => {
    const handle = renderCreateCrawlTaskDrawer({
      loading: true,
      submitLabel: "Create",
    });

    expectStepIndicator(0);

    await advanceToAdvanced(handle);

    // loading 图标参与可访问名，用正则匹配；自定义 label 优先于默认值
    const submit = screen.getByRole("button", { name: /Create/ });
    expect(submit).toBeInTheDocument();
    expect(submit).toHaveClass("ant-btn-loading");
    expect(
      screen.queryByRole("button", { name: "Submit" }),
    ).not.toBeInTheDocument();
  });

  it("FE-SUBMIT-01 回归：loading 期间表单 submit 事件不触发 onSubmit", async () => {
    const onSubmit = vi.fn();
    const handle = renderCreateCrawlTaskDrawer({ onSubmit, loading: true });
    await advanceToAdvanced(handle, "https://example.com/guard");

    // Enter 提交路径/编程式 submit 不经过按钮 disabled——由 Drawer 边界门禁拦截
    const form = document.querySelector("form");
    fireEvent.submit(form!);

    // 等待微任务链落定后确认门禁拦截（非空 async 体）
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("关闭后 step 复位为 0，重新打开回到模板步（Cancel 路径触发 onClose）", async () => {
    const onClose = vi.fn();
    const handle = renderCreateCrawlTaskDrawer({ onClose });

    await advanceToAdvanced(handle);
    expectStepIndicator(2);

    closeDrawer();
    expect(handle.closeCalls()).toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);

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
});
