import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/test/render";

import {
  advanceToAdvanced,
  renderCreateCrawlTaskDrawer,
} from "./create-crawl-task-drawer-test-support";

/** 巨型表单树（153 个 Form.Item 常驻挂载）在 jsdom 中单测渲染需 2-7s：
 *  提升本文件用例/钩子超时，避免默认 5s 误杀（误杀会污染 act 环境并
 *  级联拖垮后续用例的渲染）。 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * FE-批5B characterization tests —— 8.4 权限、i18n 与可访问性基线。
 * 键盘可访问性现状（模板 Card 为 div+onClick，无 button 语义/Tab 可达）
 * 记录于 PR 描述与 bug-ledger；正面键盘测试随 9.2 修复提交加入。
 */

describe("CreateCrawlTaskDrawer（权限与 i18n 基线）", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("canWriteItems=false：ingest 开关禁用并显示无权限提示", async () => {
    const handle = renderCreateCrawlTaskDrawer({ canWriteItems: false });
    await advanceToAdvanced(handle);

    const ingest = screen.getByRole("switch", {
      name: "Auto send to Items",
    });
    expect(ingest).toBeDisabled();
    expect(
      screen.getByText("Requires items.write permission."),
    ).toBeInTheDocument();
  });

  it("canWriteItems=true：ingest 开关可用并显示常规提示", async () => {
    const handle = renderCreateCrawlTaskDrawer({ canWriteItems: true });
    await advanceToAdvanced(handle);

    const ingest = screen.getByRole("switch", {
      name: "Auto send to Items",
    });
    expect(ingest).toBeEnabled();
    expect(
      screen.getByText(
        "New crawl results will be converted into Items and queued for LLM processing.",
      ),
    ).toBeInTheDocument();
  });

  it("canWriteItems=false 时 ingest 默认未开启（未选模板时无值）", async () => {
    const handle = renderCreateCrawlTaskDrawer({ canWriteItems: false });
    await advanceToAdvanced(handle);

    // 打开时未应用任何模板 → ingestToItems 无值；开关呈现未选中
    expect(handle.form.getFieldValue("ingestToItems")).toBeFalsy();
    expect(screen.getByRole("switch", { name: "Auto send to Items" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  describe("zh-CN 文案", () => {
    beforeEach(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    it("关键文案：标题、三步、按钮", () => {
      renderCreateCrawlTaskDrawer({ submitLabel: "创建" });

      expect(screen.getByText("创建抽屉")).toBeInTheDocument();
      expect(screen.getByText("选择模板")).toBeInTheDocument();
      expect(screen.getByText("基础信息")).toBeInTheDocument();
      expect(screen.getByText("详细配置")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();
      // antd Button 对两个中文字符自动插入空格（autoInsertSpace），可访问名为 "取 消"
      expect(screen.getByRole("button", { name: /取\s*消/ })).toBeInTheDocument();
      expect(
        screen.getByText("选择一个模板开始"),
      ).toBeInTheDocument();
    });

    it("basic 步字段标签为中文", () => {
      renderCreateCrawlTaskDrawer();
      fireEvent.click(screen.getByRole("button", { name: "下一步" }));

      expect(screen.getByLabelText("展示名称")).toBeInTheDocument();
      expect(screen.getByLabelText("目标 URL")).toBeInTheDocument();
    });

    it("multiUrl strategyTitle 显示真实 index（策略 1/策略 2）", () => {
      renderCreateCrawlTaskDrawer();

      // 步骤内容常驻挂载（display:none），可直接查询；标题为中文
      const header = screen.getByText("多 URL").closest("div");
      expect(header).not.toBeNull();
      // 图标使可访问名为 "plus 添加"
      fireEvent.click(within(header!).getByRole("button", { name: /添加/ }));
      fireEvent.click(within(header!).getByRole("button", { name: /添加/ }));

      expect(screen.getByText("策略 1")).toBeInTheDocument();
      expect(screen.getByText("策略 2")).toBeInTheDocument();
    });

    it("ingest 无权限提示为中文", () => {
      renderCreateCrawlTaskDrawer({ canWriteItems: false });

      expect(
        screen.getByText("需要 items.write 权限。"),
      ).toBeInTheDocument();
      // 步骤内容常驻挂载（display:none）——getByRole 不可见即不可查，改用 label
      expect(
        screen.getByLabelText("自动发送到 Items"),
      ).toBeDisabled();
    });
  });

  it("模板 Card 通过鼠标点击选择（当前唯一交互路径）", () => {
    const handle = renderCreateCrawlTaskDrawer();

    fireEvent.click(screen.getByText("News Website"));
    expect(handle.form.getFieldValue("waitUntil")).toBe("networkidle");
    expect(handle.form.getFieldValue("ingestToItems")).toBe(true);

    // 切回 general：显式字段被改写（模板切换为合并语义）
    fireEvent.click(screen.getByText("General"));
    expect(handle.form.getFieldValue("ingestToItems")).toBe(false);
    expect(handle.form.getFieldValue("pageTypeHint")).toBe("auto");
  });
});
