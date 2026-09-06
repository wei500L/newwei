import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  renderCreateCrawlTaskDrawer,
  renderCreateCrawlTaskFormFields,
} from "./create-crawl-task-drawer-test-support";
import { GeneralCrawlFields } from "./create-crawl-task-drawer/general-crawl-fields";

/** ingest 权限门禁在 GeneralCrawlFields 领域组件上直测（不挂载
 *  153 字段全树）；模板按钮语义断言只依赖模板步，高级配置步 mock
 *  为空哨兵。超时保持 30s 不变（本轮不调整）。 */
vi.mock("./create-crawl-task-drawer/advanced-step", () => ({
  AdvancedStep: () => null,
}));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * CreateCrawlTaskDrawer 权限门禁与模板选择器可访问性：
 * - canWriteItems=false 时 ingest 开关 fail-closed（禁用 + 无权限提示）；
 * - 模板选择器为原生 button：可聚焦、Tab 可达，aria-pressed 表达选中态
 *   （FE-A11Y-03 修复后语义）。
 */

describe("CreateCrawlTaskDrawer（权限与可访问性）", () => {
  it("canWriteItems=false：ingest 开关禁用并显示无权限提示，且默认未开启", () => {
    renderCreateCrawlTaskFormFields(
      <GeneralCrawlFields canWriteItems={false} />,
    );

    const ingest = screen.getByRole("switch", { name: "Auto send to Items" });
    expect(ingest).toBeDisabled();
    expect(
      screen.getByText("Requires items.write permission."),
    ).toBeInTheDocument();
    expect(ingest).toHaveAttribute("aria-checked", "false");
  });

  it("canWriteItems=true：ingest 开关可用并显示常规提示", () => {
    renderCreateCrawlTaskFormFields(
      <GeneralCrawlFields canWriteItems={true} />,
    );

    const ingest = screen.getByRole("switch", { name: "Auto send to Items" });
    expect(ingest).toBeEnabled();
    expect(
      screen.getByText(
        "New crawl results will be converted into Items and queued for LLM processing.",
      ),
    ).toBeInTheDocument();
  });

  it("模板选择器为原生 button：可聚焦且 aria-pressed 表达选中态（FE-A11Y-03）", () => {
    renderCreateCrawlTaskDrawer();

    const news = screen.getByRole("button", { name: /News Website/ });
    expect(news).toHaveAttribute("type", "button");
    expect(news).toHaveAttribute("aria-pressed", "false");

    // 五个模板按钮均可聚焦（Tab 可达；Enter/Space 由原生 button 语义保证）
    const buttons = [
      screen.getByRole("button", { name: /General/ }),
      screen.getByRole("button", { name: /News Website/ }),
      screen.getByRole("button", { name: /Reuters \+ Cloudflare/ }),
      screen.getByRole("button", { name: /Forum/ }),
      screen.getByRole("button", { name: /Social Media/ }),
    ];
    for (const button of buttons) {
      button.focus();
      expect(button).toHaveFocus();
    }

    fireEvent.click(news);
    expect(news).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /General/ }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});
