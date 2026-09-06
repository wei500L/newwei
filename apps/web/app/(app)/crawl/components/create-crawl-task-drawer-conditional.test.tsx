import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserHeadersCookiesFields } from "./create-crawl-task-drawer/browser-headers-cookies-fields";
import { MarkdownFields } from "./create-crawl-task-drawer/markdown-fields";
import { MultiUrlFields } from "./create-crawl-task-drawer/multi-url-fields";
import {
  advanceToAdvanced,
  renderCreateCrawlTaskDrawer,
  renderCreateCrawlTaskFormFields,
  type CreateCrawlTaskDrawerHandle,
} from "./create-crawl-task-drawer-test-support";

/** 仅两个用例保留全树挂载（153 个 Form.Item 常驻挂载在 jsdom 中单渲染
 *  需 2-7s）：waitUntil 规范化（控制器的 useWatch 依赖高级字段注册）
 *  与主提交路径。其余高级配置业务在对应领域组件上直测
 *  （renderCreateCrawlTaskFormFields）。超时保持 30s 不变。 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * CreateCrawlTaskDrawer 高级配置领域与主提交路径：
 * - LLM 配置阻断（安全边界，option-guards 的唯一测试覆盖）；
 * - multi URL 嵌套字段路径与提交结构；
 * - bm25 分支必填校验；
 * - 自动 Header 合并（crawl-browser-headers 的唯一测试覆盖）；
 * - waitUntil=networkidle 的 5000ms 业务约束（全树挂载）；
 * - 主提交路径（全树挂载，news 模板默认值进入提交 payload）。
 */

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** multi URL 区块头部（含 Add 按钮）。 */
function multiUrlHeader(): HTMLElement {
  const header = screen.getByText("Multi URL").closest("div");
  expect(header).not.toBeNull();
  return header as HTMLElement;
}

function firstStrategyCard(): HTMLElement {
  const card = screen.getByText("Strategy 1").closest(".ant-card");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

/** validateFields 拒绝（rc-field-form 的 rejection 非 Error 实例）。 */
async function expectValidationRejected(
  handle: Pick<CreateCrawlTaskDrawerHandle, "form">,
): Promise<void> {
  let rejected = false;
  await handle.form.validateFields().catch(() => {
    rejected = true;
  });
  expect(rejected).toBe(true);
}

describe("CreateCrawlTaskDrawer（高级配置领域与主提交路径）", () => {
  it("markdown 自定义 strategy：LLM 类型与 params llmConfig 均被阻断；合法非 LLM 配置通过", async () => {
    const handle = renderCreateCrawlTaskFormFields(<MarkdownFields />);

    // 类型名阻断
    fireEvent.change(screen.getByLabelText("Type"), {
      target: { value: "LLMExtractionStrategy" },
    });
    expect(
      await screen.findByText("Crawl-stage LLM extraction is not allowed."),
    ).toBeInTheDocument();

    // 清空类型后，仅 params 含 llmConfig 亦阻断
    fireEvent.change(screen.getByLabelText("Type"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Params"), {
      target: { value: '{"llmConfig": {"provider": "openai"}}' },
    });
    expect(
      await screen.findByText("Crawl-stage LLM extraction is not allowed."),
    ).toBeInTheDocument();

    // 合法非 LLM JSON：不阻断且进入提交结构
    fireEvent.change(screen.getByLabelText("Type"), {
      target: { value: "PruningContentFilter" },
    });
    fireEvent.change(screen.getByLabelText("Params"), {
      target: { value: '{"threshold": 0.4, "threshold_type": "fixed"}' },
    });
    expect(
      screen.queryByText("Crawl-stage LLM extraction is not allowed."),
    ).not.toBeInTheDocument();
    const values = await handle.form.validateFields();
    expect(values.markdownStrategy).toEqual({
      type: "PruningContentFilter",
      params: '{"threshold": 0.4, "threshold_type": "fixed"}',
    });
  });

  it("multi URL：策略编号、嵌套 jsCode 与嵌套 virtual scroll 写入嵌套路径并进入提交结构", async () => {
    const handle = renderCreateCrawlTaskFormFields(<MultiUrlFields />);

    // 新增两个策略：标题使用真实 index（FE-I18N-01 插值回归）
    const add = within(multiUrlHeader()).getByRole("button", { name: /Add/ });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(screen.getByText("Strategy 1")).toBeInTheDocument();
    expect(screen.getByText("Strategy 2")).toBeInTheDocument();

    const card = firstStrategyCard();

    // 嵌套 jsCode 列表（FE-I18N-02 修复后 jsStep 带序号）
    fireEvent.click(within(card).getByRole("button", { name: /Add JS step/ }));
    expect(within(card).getByText("JS step 1")).toBeInTheDocument();
    const textarea = within(card).getAllByPlaceholderText(
      "Enter JS snippet",
    )[0]!;
    fireEvent.change(textarea, {
      target: { value: "window.scrollTo(0, 100)" },
    });
    expect(
      handle.form.getFieldValue(["multiUrlConfigs", 0, "options", "jsCode"]),
    ).toEqual(["window.scrollTo(0, 100)"]);

    // 嵌套 virtual scroll：默认值写入嵌套路径，并关闭同级 scanFullPage
    fireEvent.click(
      within(card).getByRole("switch", { name: "Enable virtual scroll" }),
    );
    expect(
      handle.form.getFieldValue([
        "multiUrlConfigs",
        0,
        "options",
        "virtualScroll",
      ]),
    ).toMatchObject({
      enabled: true,
      containerSelector: "body",
      scrollCount: 10,
    });
    expect(
      handle.form.getFieldValue(["multiUrlConfigs", 0, "options", "scanFullPage"]),
    ).toBe(false);
    expect(within(card).getByLabelText("Container selector")).toBeInTheDocument();

    // 提交结构：嵌套 options 进入 multiUrlConfigs
    const values = await handle.form.validateFields();
    expect(values.multiUrlConfigs?.length).toBe(2);
    expect(values.multiUrlConfigs?.[0]).toMatchObject({
      options: {
        jsCode: ["window.scrollTo(0, 100)"],
        virtualScroll: {
          enabled: true,
          containerSelector: "body",
          scrollCount: 10,
        },
      },
    });

    // 关闭后嵌套值清除
    fireEvent.click(
      within(card).getByRole("switch", { name: "Enable virtual scroll" }),
    );
    expect(
      handle.form.getFieldValue([
        "multiUrlConfigs",
        0,
        "options",
        "virtualScroll",
      ]),
    ).toBeUndefined();
  });

  it("markdownFilter=bm25：分支切换显示 BM25 参数，userQuery 必填校验拦截提交", async () => {
    const handle = renderCreateCrawlTaskFormFields(<MarkdownFields />);

    act(() => {
      handle.form.setFieldsValue({ markdownFilter: { type: "bm25" } });
    });
    expect(screen.getByLabelText("BM25 query")).toBeInTheDocument();
    expect(screen.getByLabelText("Pruning threshold")).not.toBeVisible();

    // userQuery 为空：校验拒绝并显示必填错误
    await expectValidationRejected(handle);
    expect(
      await screen.findByText(
        "BM25 query is required when BM25 filter is selected.",
      ),
    ).toBeInTheDocument();

    // 填写后通过并进入提交结构
    fireEvent.change(screen.getByLabelText("BM25 query"), {
      target: { value: "market news" },
    });
    const values = await handle.form.validateFields();
    expect(values.markdownFilter).toMatchObject({
      type: "bm25",
      userQuery: "market news",
    });
  });

  it("自动 Header 合并：Chromium UA 派生 sec-ch 头，且用户显式值优先", () => {
    const handle = renderCreateCrawlTaskFormFields(
      <BrowserHeadersCookiesFields />,
    );

    act(() => {
      handle.form.setFieldsValue({
        userAgent: CHROME_UA,
        browserHeaders: [
          { name: "X-Custom", value: "mine" },
          { name: "sec-ch-ua", value: '"MyBrand";v="1"' },
        ],
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Auto-fill Sec-CH headers" }),
    );

    const headers = handle.form.getFieldValue("browserHeaders") as {
      name: string;
      value: string;
    }[];
    const byName = new Map(
      headers.map((header) => [header.name.toLowerCase(), header.value]),
    );
    // 用户显式值保留
    expect(byName.get("x-custom")).toBe("mine");
    expect(byName.get("sec-ch-ua")).toBe('"MyBrand";v="1"');
    // 自动补充缺失的 sec-ch 与 sec-fetch 默认
    expect(byName.get("sec-ch-ua-mobile")).toBe("?0");
    expect(byName.get("sec-ch-ua-platform")).toBe('"Windows"');
    expect(byName.get("sec-fetch-site")).toBe("none");
    expect(byName.get("sec-fetch-mode")).toBe("navigate");
  });

  it("waitUntil=networkidle 时 waitForTimeoutMs 规范化：<5000 提升至 5000，其余保持", async () => {
    // 完整挂载：控制器的 Form.useWatch 只观察已注册字段，waitUntil 的
    // Form.Item 在高级配置步（常驻挂载，display:none），模板步即生效
    const handle = renderCreateCrawlTaskDrawer();

    // 非 networkidle：不改动
    act(() => {
      handle.form.setFieldsValue({ waitForTimeoutMs: 1000, waitUntil: "load" });
    });
    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(1000),
    );

    // networkidle 且 <5000：提升为 5000（业务下限约束）
    act(() => {
      handle.form.setFieldsValue({ waitUntil: "networkidle" });
    });
    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(5000),
    );

    // networkidle 且 >=5000：保持原值
    act(() => {
      handle.form.setFieldsValue({ waitUntil: "load", waitForTimeoutMs: 8000 });
    });
    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(8000),
    );
    act(() => {
      handle.form.setFieldsValue({ waitUntil: "networkidle" });
    });
    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(8000),
    );
  });

  it("主提交路径：news 模板默认值进入提交 payload（含 headless→headlessMode 转换）", async () => {
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
});
