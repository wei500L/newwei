import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  advanceToAdvanced,
  renderCreateCrawlTaskDrawer,
  type CreateCrawlTaskDrawerHandle,
} from "./create-crawl-task-drawer-test-support";

/** 巨型表单树（153 个 Form.Item 常驻挂载）在 jsdom 中单测渲染需 2-7s：
 *  提升本文件用例/钩子超时，避免默认 5s 误杀（误杀会污染 act 环境并
 *  级联拖垮后续用例的渲染）。 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * FE-批5B characterization tests —— 8.3 条件字段与字段联动。
 * 通过真实 UI 交互与 Form values 观察行为（watch 驱动的条件渲染、
 * waitUntil 规范化、LLM 阻断、proxy 检测、自动 Header 合并等）。
 */

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function openAdvanced(
  handle: CreateCrawlTaskDrawerHandle,
): Promise<void> {
  await advanceToAdvanced(handle);
}

/** multi URL 区块头部（含 Add 按钮）。 */
function multiUrlHeader(): HTMLElement {
  const header = screen.getByText("Multi URL").closest("div");
  expect(header).not.toBeNull();
  return header as HTMLElement;
}

function addMultiUrlStrategy(): void {
  fireEvent.click(
    within(multiUrlHeader()).getByRole("button", { name: /Add/ }),
  );
}

function firstStrategyCard(): HTMLElement {
  const card = screen.getByText("Strategy 1").closest(".ant-card");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

/** validateFields 拒绝（rc-field-form 的 rejection 非 Error 实例）。 */
async function expectValidationRejected(
  handle: CreateCrawlTaskDrawerHandle,
  namePaths?: Parameters<
    CreateCrawlTaskDrawerHandle["form"]["validateFields"]
  >[0],
): Promise<void> {
  let rejected = false;
  await handle.form.validateFields(namePaths).catch(() => {
    rejected = true;
  });
  expect(rejected).toBe(true);
}

describe("CreateCrawlTaskDrawer（条件字段与字段联动）", () => {
  it("waitUntil=networkidle 时 waitForTimeoutMs<5000 自动提升为 5000", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    // 经 store 写入 waitUntil（watch 驱动的规范化 effect 为被测行为；
    // antd 下拉弹层在 jsdom 中不随 mouseDown 渲染，交互路径不可靠）
    act(() => {
      handle.form.setFieldsValue({
        waitForTimeoutMs: 1000,
        waitUntil: "networkidle",
      });
    });

    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(5000),
    );
  });

  it("waitUntil=networkidle 时 waitForTimeoutMs>=5000 保持原值", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    act(() => {
      handle.form.setFieldsValue({
        waitForTimeoutMs: 8000,
        waitUntil: "networkidle",
      });
    });

    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(8000),
    );
  });

  it("waitUntil 非 networkidle 不改动 waitForTimeoutMs", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    act(() => {
      handle.form.setFieldsValue({
        waitForTimeoutMs: 1000,
        waitUntil: "load",
      });
    });

    await waitFor(() =>
      expect(handle.form.getFieldValue("waitForTimeoutMs")).toBe(1000),
    );
  });

  it("scoreLinks=false 时 Link Preview 相关项禁用；开启后恢复", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    const includeInternal = screen.getByRole("switch", {
      name: "Include internal",
    });
    const maxLinks = screen.getByLabelText("Max links");
    expect(includeInternal).toBeDisabled();
    expect(maxLinks).toBeDisabled();

    fireEvent.click(screen.getByRole("switch", { name: "Score links" }));
    expect(includeInternal).toBeEnabled();
    expect(maxLinks).toBeEnabled();
  });

  it("开启根级 virtual scroll：字段展开、scanFullPage 关闭、scrollDelayMs 清空", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    act(() => {
      handle.form.setFieldsValue({
        scanFullPage: true,
        scrollDelayMs: 900,
      });
    });

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable virtual scroll" }),
    );

    expect(screen.getByLabelText("Container selector")).toBeInTheDocument();
    expect(handle.form.getFieldValue("scanFullPage")).toBe(false);
    expect(handle.form.getFieldValue("scrollDelayMs")).toBeUndefined();
    expect(handle.form.getFieldValue("virtualScroll")).toMatchObject({
      enabled: true,
      containerSelector: "body",
      scrollCount: 10,
      scrollBy: "page_height",
      scrollByPixels: 500,
      waitAfterScrollMs: 600,
    });
  });

  it("根级 virtual scroll 已有值时开关保留既有配置", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    act(() => {
      handle.form.setFieldsValue({
        virtualScroll: {
          containerSelector: ".feed",
          scrollCount: 3,
          scrollBy: "pixels",
          scrollByPixels: 250,
          waitAfterScrollMs: 200,
        },
      });
    });

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable virtual scroll" }),
    );

    expect(handle.form.getFieldValue("virtualScroll")).toMatchObject({
      enabled: true,
      containerSelector: ".feed",
      scrollCount: 3,
      scrollBy: "pixels",
      scrollByPixels: 250,
      waitAfterScrollMs: 200,
    });
  });

  it("关闭根级 virtual scroll：整个 virtualScroll 值被清除", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable virtual scroll" }),
    );
    expect(handle.form.getFieldValue("virtualScroll")).toMatchObject({
      enabled: true,
    });

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable virtual scroll" }),
    );
    expect(handle.form.getFieldValue("virtualScroll")).toBeUndefined();
    expect(
      screen.queryByLabelText("Container selector"),
    ).not.toBeInTheDocument();
  });

  it("根级 virtual scroll 的 scrollBy=pixels 时显示 scrollByPixels 字段", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable virtual scroll" }),
    );
    act(() => {
      handle.form.setFields([
        { name: ["virtualScroll", "scrollBy"], value: "pixels" },
      ]);
    });
    expect(screen.getByLabelText("Scroll by (px)")).toBeInTheDocument();

    act(() => {
      handle.form.setFields([
        { name: ["virtualScroll", "scrollBy"], value: "page_height" },
      ]);
    });
    expect(
      screen.queryByLabelText("Scroll by (px)"),
    ).not.toBeInTheDocument();
  });

  it("开启 autoExpandDetails：详情展开字段出现；关闭时清除 detailExpansion", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.click(screen.getByRole("switch", { name: "Auto expand details" }));
    expect(screen.getByLabelText("Max detail URLs")).toBeInTheDocument();
    expect(screen.getByLabelText("Min relevance score")).toBeInTheDocument();
    expect(handle.form.getFieldValue("detailExpansion")).toMatchObject({
      maxDetailUrls: 8,
      minRelevanceScore: 0.2,
      requireSameDomain: true,
      allowExternalLinks: true,
      minPublishTimeConfidence: 0.55,
      preferFitMarkdownForQuality: true,
    });

    fireEvent.click(screen.getByRole("switch", { name: "Auto expand details" }));
    expect(handle.form.getFieldValue("detailExpansion")).toBeUndefined();
    expect(
      screen.queryByLabelText("Max detail URLs"),
    ).not.toBeInTheDocument();
  });

  it("markdownFilter=pruning 显示剪枝参数；bm25 显示 BM25 参数", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    act(() => {
      handle.form.setFieldsValue({ markdownFilter: { type: "pruning" } });
    });
    expect(screen.getByLabelText("Pruning threshold")).toBeInTheDocument();
    expect(screen.getByLabelText("BM25 query")).not.toBeVisible();

    act(() => {
      handle.form.setFieldsValue({ markdownFilter: { type: "bm25" } });
    });
    expect(screen.getByLabelText("Pruning threshold")).not.toBeVisible();
    expect(screen.getByLabelText("BM25 query")).toBeInTheDocument();
  });

  it("markdown 自定义 strategy：LLM 类型被阻断（Alert）", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.change(screen.getByLabelText("Type"), {
      target: { value: "LLMExtractionStrategy" },
    });

    expect(
      await screen.findByText("Crawl-stage LLM extraction is not allowed."),
    ).toBeInTheDocument();
  });

  it("markdown 自定义 strategy：params 含 llmConfig 被阻断", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.change(screen.getByLabelText("Params"), {
      target: { value: '{"llmConfig": {"provider": "openai"}}' },
    });

    expect(
      await screen.findByText("Crawl-stage LLM extraction is not allowed."),
    ).toBeInTheDocument();
  });

  it("markdown 自定义 strategy：合法非 LLM JSON 不触发阻断", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

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

  it("markdown 自定义 strategy：params 非 JSON 触发既有校验错误", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.change(screen.getByLabelText("Params"), {
      target: { value: "not-json" },
    });

    // url 已由 advanceToAdvanced 填写、其余字段合法——全表单校验的
    // 唯一失败项即 params（错误文案另行断言）
    await expectValidationRejected(handle);
    expect(
      await screen.findByText("Params must be valid JSON."),
    ).toBeInTheDocument();
  });

  it("multi URL：新增策略卡显示 Strategy 1 及其 options 字段；删除后消失", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    expect(screen.getByText("No Multi URL")).toBeInTheDocument();

    addMultiUrlStrategy();
    expect(screen.getByText("Strategy 1")).toBeInTheDocument();
    const card = firstStrategyCard();
    expect(within(card).getByLabelText("Label")).toBeInTheDocument();
    expect(within(card).getByLabelText("Match mode")).toBeInTheDocument();
    expect(within(card).getByLabelText("Patterns")).toBeInTheDocument();
    expect(within(card).getByLabelText("Urls")).toBeInTheDocument();
    expect(within(card).getByLabelText("Cache mode")).toBeInTheDocument();
    expect(within(card).getByLabelText("Quality profile")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /Remove/ }));
    expect(screen.queryByText("Strategy 1")).not.toBeInTheDocument();
    expect(screen.getByText("No Multi URL")).toBeInTheDocument();
  });

  it("multiUrl strategyTitle 使用真实 index（FE-I18N-01 修复后的插值）", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    addMultiUrlStrategy();
    addMultiUrlStrategy();

    expect(screen.getByText("Strategy 1")).toBeInTheDocument();
    expect(screen.getByText("Strategy 2")).toBeInTheDocument();
  });

  it("multi URL 策略内：嵌套 jsCode 列表可新增并写入嵌套路径", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    addMultiUrlStrategy();
    const card = firstStrategyCard();

    fireEvent.click(within(card).getByRole("button", { name: /Add JS step/ }));
    // FE-I18N-02 修复后 jsStep 带序号
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
  });

  it("multi URL 策略内：嵌套 virtual scroll 开关写入嵌套路径", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    addMultiUrlStrategy();
    const card = firstStrategyCard();

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
    expect(
      within(card).getByLabelText("Container selector"),
    ).toBeInTheDocument();

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

  it("根级 jsCode 列表：增删与必填校验", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.click(screen.getByRole("button", { name: /Add JS step/ }));
    // FE-I18N-02 修复后 jsStep 带序号
    expect(screen.getAllByText("JS step 1").length).toBeGreaterThan(0);

    await expectValidationRejected(handle);
    expect(await screen.findAllByText("JS required")).not.toHaveLength(0);

    fireEvent.change(screen.getByPlaceholderText("Enter JS snippet"), {
      target: { value: "window.scrollBy(0, 200)" },
    });
    const values = await handle.form.validateFields();
    expect(values.jsCode).toEqual(["window.scrollBy(0, 200)"]);
  });

  it("headlessMode=headed 显示 Xvfb 警告；auto 不显示", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    // 经 store 写入 headlessMode（watch 驱动的警告 Alert 为被测行为）
    act(() => {
      handle.form.setFieldsValue({ headlessMode: "headed" });
    });
    expect(
      screen.getByText("Headed mode requires Xvfb"),
    ).toBeInTheDocument();

    act(() => {
      handle.form.setFieldsValue({ headlessMode: "auto" });
    });
    expect(
      screen.queryByText("Headed mode requires Xvfb"),
    ).not.toBeInTheDocument();
  });

  it("useManagedBrowser 控制 userDataDir 可用性", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    expect(screen.getByLabelText("User data dir")).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Managed" }));
    expect(screen.getByLabelText("User data dir")).toBeEnabled();
  });

  it("userAgentMode=random 时 generator 三项可用；清除后禁用", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    // FE-TPL-01 修复后冷启动应用 general（userAgentMode=random）；显式设置保持确定性
    act(() => {
      handle.form.setFieldsValue({ userAgentMode: "random" });
    });

    const platform = screen.getByLabelText("Generator platform");
    const browser = screen.getByLabelText("Generator browser");
    const device = screen.getByLabelText("Generator device");
    expect(platform).toBeEnabled();
    expect(browser).toBeEnabled();
    expect(device).toBeEnabled();

    act(() => {
      handle.form.setFieldsValue({ userAgentMode: undefined });
    });
    expect(platform).toBeDisabled();
    expect(browser).toBeDisabled();
    expect(device).toBeDisabled();
  });

  it("geolocation 三个数值字段渲染并可写入", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.change(screen.getByPlaceholderText("Enter Latitude"), {
      target: { value: "31.2" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter Longitude"), {
      target: { value: "121.5" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter Accuracy"), {
      target: { value: "100" },
    });

    expect(handle.form.getFieldValue("geolocation")).toEqual({
      latitude: 31.2,
      longitude: 121.5,
      accuracy: 100,
    });
  });

  it("browser headers / cookies 列表可新增条目", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    // 带图标 Add 按钮的可访问名为 "plus Add"；DOM 顺序：multiUrl / headers / cookies
    const addButtons = screen.getAllByRole("button", { name: "plus Add" });
    fireEvent.click(addButtons[1]!); // headers
    fireEvent.click(addButtons[2]!); // cookies

    // headers 行在 cookies 行之前（DOM 顺序）
    fireEvent.change(screen.getAllByPlaceholderText("Enter Name")[0]!, {
      target: { value: "X-Custom" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("Enter Value")[0]!, {
      target: { value: "mine" },
    });
    expect(handle.form.getFieldValue("browserHeaders")).toEqual([
      { name: "X-Custom", value: "mine" },
    ]);
  });

  it("session：sessionId / storageState 字段渲染并可写入", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    fireEvent.change(screen.getByLabelText("Session ID"), {
      target: { value: "sess-1" },
    });
    expect(handle.form.getFieldValue("sessionId")).toBe("sess-1");
    expect(screen.getByLabelText("Storage state")).toBeInTheDocument();
  });

  it("proxy：恒为 error 级 legacy 提示（观察到的缺陷：undefined 键亦被 hasOwn 计入）", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    // 当前行为：传入 {proxyUrl: undefined, proxyConfig: undefined} 字面量时
    // hasOwn 命中两个键，警告分支（Custom upstream proxies are disabled）
    // 实际不可达——已登记 bug-ledger，不在此轮修复。
    expect(
      screen.getByText("Unsupported legacy proxy configuration detected"),
    ).toBeInTheDocument();
    expect(screen.getByText(/options\.proxyUrl/)).toBeInTheDocument();
    expect(screen.getByText(/options\.proxyConfig/)).toBeInTheDocument();
  });

  it("自动 Header 合并：Chromium UA 派生 sec-ch 头，且用户显式值优先", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

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

  it("table extraction 字段渲染并可写入（Tables 卡内限定查询）", async () => {
    const handle = renderCreateCrawlTaskDrawer();
    await openAdvanced(handle);

    const tablesCard = screen
      .getByText("Tables")
      .closest(".ant-card") as HTMLElement;
    expect(within(tablesCard).getByLabelText("Strategy type")).toBeInTheDocument();
    expect(within(tablesCard).getByLabelText("Min rows")).toBeInTheDocument();
    expect(within(tablesCard).getByLabelText("Min cols")).toBeInTheDocument();

    fireEvent.change(within(tablesCard).getByLabelText("Score threshold"), {
      target: { value: "3.5" },
    });
    expect(handle.form.getFieldValue("tableScoreThreshold")).toBe(3.5);
  });

  it("提交时 bm25 分支的 userQuery 必填校验生效", async () => {
    const onSubmit = vi.fn();
    const handle = renderCreateCrawlTaskDrawer({ onSubmit });
    await openAdvanced(handle);

    act(() => {
      handle.form.setFieldsValue({ markdownFilter: { type: "bm25" } });
    });

    const form = document.querySelector("form");
    fireEvent.submit(form!);

    expect(
      await screen.findByText(
        "BM25 query is required when BM25 filter is selected.",
      ),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
