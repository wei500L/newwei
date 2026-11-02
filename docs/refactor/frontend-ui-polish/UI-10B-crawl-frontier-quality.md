# FE-UI 批10B：crawl-frontier 两大文件与质量页收尾（`admin/ops/crawl-frontier/**`、`admin/quality/**`）

> **一句话目标**：UI-9E 处理 crawl-frontier 时碰到了上限，留下了三块：
> 1. `crawl-workflow-studio.tsx` 仍有 **4 层卡片嵌套**（`content-card` > 区块 Card > 对比子 Card > 列表项 Card），共 27 个 `<Card`，还有 5 处废弃的 `bodyStyle`。
> 2. `crawl-frontier-console.tsx` 仍有约 **127 处英文 `label=` / `title=` / `placeholder=`**（集中在 profile 配置表单 `:1818-1900` 一带）和 **44 个彩色 Tag**（10 种颜色）。
> 3. `admin/quality/quality-content.tsx` 有 2 处浏览器原生 `window.prompt`，以及延迟分位卡片（`:2565` 一带）的卡中卡。
>
> **依赖**：UI-9 全部合入。可与 UI-10A、UI-10C 并行。本批只改：`app/(app)/admin/ops/crawl-frontier/**`、`app/(app)/admin/quality/**`，以及 `lib/locales/zh.json`、`lib/locales/en.json`（只追加）。
>
> **开工前必读**：README §3.5、§4、§5、§7。行号是审查快照，执行前先用片段定位。**分 4 次提交**（B1 → B4），做不完就在报告里写明停在哪。

---

## B1 workflow-studio 去多层嵌套（§3.5-A）

**现状**（`crawl-workflow-studio.tsx`）：

```
:890  <Card className="content-card" title=workflowStudio.title>      ← 第 1 层（保留）
:971    <Card size="small" title=sections.workflows   bodyStyle=…>      ← 第 2 层
:1046   <Card size="small" title=sections.compare     bodyStyle=…>      ← 第 2 层
:1311     <Card size="small" title=compare.cards.edgeDiff>              ← 第 3 层
:1352     <Card size="small" title=compare.cards.bindingImpact>         ← 第 3 层
:1387       <Card key=profile-impact-… size="small">                    ← 第 4 层（列表项）
:1461   <Card … sections.nodePalette> / :1535 linkedFrontierRuns（:1555 列表项 Card）
:1594   <Card … sections.canvas> / :1636 inspector / :1854 workflowSettings
:2030   trial.cards.stepTimeline（:2042 列表项 Card）/ :2086 candidateFlow / :2101 systemEvents（:2120 列表项 Card）/ :2188 parameterSources
:2323   列表项 Card / :2411 drawer.before（Drawer 内部）
```

**改法**（照这个映射逐个替换）：

| 层级 | 改成 |
|---|---|
| 第 1 层 `:890` content-card | 保留 |
| 第 2 层 `<Card size="small" title={X} bodyStyle={{ padding: 12 }}>` | `<section className="surface-inset flex flex-col gap-3"><SectionHeader title={X} />…</section>`；原 Card 的 `extra` 放进 `SectionHeader` 的 `extra` |
| 第 2 层但需要零内边距的画布 `:1594`（`styles={{ body: { padding: 0 } }}`） | `<section className="flex flex-col gap-2"><SectionHeader title={X} extra={…} /><div className="overflow-hidden rounded-md border border-[var(--border)]">画布</div></section>` |
| 第 3 层 `<Card size="small" title={Y}>`（在第 2 层内部） | `<div className="flex flex-col gap-2"><p className="kicker m-0">{Y}</p>…</div>`，与兄弟块之间靠父级 `gap-3` |
| 第 4 层 / 列表项 `<Card key=… size="small">`（`:1387`、`:1555`、`:2042`、`:2120`、`:2323`） | `<div key=… className="hairline-b py-2 last:border-b-0">`；`:2042` 原有的 `className="bg-surface-muted"` 删除 |
| Drawer 内的 `:2411` 等 Card | 改成第 3 层写法（kicker + div），Drawer 本身就是容器 |

`SectionHeader` 从 `@/components/section-header` 导入。改完自查：

```bash
grep -c "<Card" "app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx"   # 期望 1
grep -n "bodyStyle" "app/(app)/admin/ops/crawl-frontier/crawl-workflow-studio.tsx"  # 期望无输出
```

同文件 `:1864`、`:1894`、`:1924`、`:1951` 的 `<Col span={12}>` 改成 `<Col xs={24} md={12}>`（§3.5-E）。

同文件还有 5 处 `<Empty`：区块内的空态改成 `<ChartEmptyState presentation="banner" description={原文案} />`；Table `locale.emptyText` 里的保留不改。

## B2 crawl-frontier-console 嵌套与 Tag（§3.5-A / C）

- `:2251` 一带：Drawer 里 `systemEventsTitle` Card 内部的事件列表项 `<Card key={event.id …} size="small">` → `<div key=… className="hairline-b py-2 last:border-b-0">`。外层那张 Card 改成 B1 的第 3 层写法（kicker + div）。
- 同文件其余 `<Card size="small" title=…>` 只要**在另一张 Card 内部**，都按 B1 的第 2 / 3 层规则处理；页面级、同级的 content-card 不动。
- **44 个彩色 Tag**：按 §3.5-C 分两类处理：

| 类型 | 举例 | 改法 |
|---|---|---|
| 信息 / 维度 Tag（运行角色、workflow、shadow-profile、judge 数、judge 方法、置信度、策略名、模式名……） | `:1425` `<Tag color="blue">{diagnostics.runRole}</Tag>`、`:1426` `color="geekblue">workflow`、`:1431` `color="purple">shadow-profile`、`:1432` `color="cyan">judge:N`、`:1481-1482` | **删掉 `color`**；带数字的（`judge:3`、`conf:0.82`）改成 `<span className="font-mono text-xs text-muted-foreground">judge 3</span>` |
| 状态 Tag（成功 / 失败 / 运行中 / 跳过 / 阻断……） | `OK` / `FAILED` / `blocked` 等 | 只用 `success` / `processing` / `warning` / `error` / 不传 color 五种。原来是 `green` → `success`，`red` → `error`，`orange` / `gold` → `warning`，`blue`（表示运行中时）→ `processing` |

workflow-studio 的 21 个彩色 Tag 用同一规则处理。改完后两个文件的彩色预设 Tag 合计应 ≤ 10，并且都是状态 Tag。

自查：`grep -cE 'color="(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，期望 0。

## B3 crawl-frontier 英文文案 i18n（§4）

**现状**：`crawl-frontier-console.tsx` 中仍有约 127 处 `label="Strategy"`、`label="Discovery mode"`、`label="Freshness hours"`、`label="Max seed URLs"`、`label="Min article ratio"`… 这类硬编码英文，集中在 profile 配置表单（`:1818-1900` 及前后）；`crawl-workflow-studio.tsx` 还有 5 处。

**改法**：

1. 先 `grep -n '"crawlFrontier\.' lib/locales/zh.json | head` 看现有 key 的命名风格，沿用 `crawlFrontier.console.*` 前缀。profile 表单字段放 `crawlFrontier.console.profileForm.<字段名>`，字段名用 Form.Item `name` 数组的最后一段（例如 `name={["config","seedDiscovery","maxSeedUrls"]}` → `crawlFrontier.console.profileForm.maxSeedUrls`）。如果有重名，加上倒数第二段（`seedDiscovery.strategy`）。
2. zh 文案给出准确的中文术语，英文保留原文。参考：Strategy 策略、Discovery mode 发现模式、Freshness hours 新鲜度窗口（小时）、Max seed URLs 种子 URL 上限、Topology pages 拓扑页数预算、Topology depth 拓扑深度预算、Min candidates 最少候选数、Min article ratio 最低正文页占比、Max noise ratio 最高噪声占比、Min fresh ratio 最低新鲜内容占比、Max depth 最大深度、Max pages 最大页数、Max children 单节点子链接上限、Score threshold 评分阈值、Pagination pages 分页保留页数。
3. Select 的 `options` 里像 `"auto"`、`"seed_first"` 这样的**枚举值保持原样**（它们是协议值，可以显示原文）。
4. **上限 160 处**。超出就停下，在报告里列出剩余行号。

自查：`grep -cE '\b(label|title|placeholder|tooltip|okText|cancelText)="[A-Z][a-z]+' <文件>`，两个文件都期望 0。

## B4 质量页（`admin/quality/quality-content.tsx`）

### `window.prompt` → Modal（`:1721` 单条修正、`:2767` 批量修正）

两个按钮共用一个受控 Modal：

```tsx
// 组件内新增状态
const [correctTarget, setCorrectTarget] = useState<{ mode: "single"; id: string } | { mode: "batch" } | null>(null);
const [correctPath, setCorrectPath] = useState("");

// 单条按钮 onClick
onClick={() => {
  setCorrectPath(record.predictedCategoryPath || "");
  setCorrectTarget({ mode: "single", id: record.id });
}}

// 批量按钮 onClick
onClick={() => {
  setCorrectPath("");
  setCorrectTarget({ mode: "batch" });
}}

// 在组件 return 的最外层容器末尾渲染一次
<Modal
  open={correctTarget !== null}
  title={correctTarget?.mode === "batch"
    ? t("quality.classification.review.batch.correct")
    : t("quality.classification.review.actions.correct")}
  okButtonProps={{ disabled: !correctPath.trim(), loading: classificationReviewSubmitting }}
  onCancel={() => setCorrectTarget(null)}
  onOk={() => {
    const path = correctPath.trim();
    if (!path || !correctTarget) return;
    if (correctTarget.mode === "single") {
      void submitClassificationReviewDecision(correctTarget.id, "corrected", path);
    } else {
      void submitClassificationBatchDecision("corrected", path);
    }
    setCorrectTarget(null);
  }}
  destroyOnClose
>
  <Typography.Paragraph type="secondary" className="!mb-2">
    {correctTarget?.mode === "batch"
      ? t("quality.classification.review.correct.batchPrompt")
      : t("quality.classification.review.correct.prompt")}
  </Typography.Paragraph>
  <Input value={correctPath} onChange={(e) => setCorrectPath(e.target.value)} autoFocus />
</Modal>
```

`submitClassificationReviewDecision` / `submitClassificationBatchDecision` 的调用参数与原来完全一致，**不改它们的实现**。如果 `classificationReviewColumns` 是在 `useMemo` 里定义的，记得把 `setCorrectTarget`、`setCorrectPath` 放进依赖（setter 稳定，加不加都不影响行为，以 lint 为准）。

### 延迟分位卡中卡（`:2565` 一带）

```tsx
<Col xs={24} md={8}>
  <Card size="small" title="LLM">
    <Space direction="vertical" size={4}>
      <Typography.Text>p50: {…} ms</Typography.Text> …
```

改成：

```tsx
<Col xs={24} md={8}>
  <div className="surface-inset flex flex-col gap-1">
    <p className="kicker m-0">LLM</p>
    <span className="font-mono text-sm">p50 {… ?? "-"} ms</span>
    <span className="font-mono text-sm">p95 {… ?? "-"} ms</span>
    <span className="font-mono text-sm">p99 {… ?? "-"} ms</span>
  </div>
</Col>
```

同一行的其它分位卡（规则、向量等）用同样写法。改完后用 B1 的方法确认文件里没有 Card 套 Card。

---

## 禁止事项

- README §4；只改上面两个目录和 locale 文件。
- 不改表单 `name`、校验规则、提交逻辑、请求、表格 columns 的业务逻辑（只允许改 render 里 Tag 的 color 和外层容器）。
- 不拆分文件（拆分是重构，不在本批范围）。

## 测试

- 已有测试必须通过。按英文 label 断言的测试（`getByLabelText("Strategy")` 之类）改为 i18n 后的文案；测试环境的语言以 `test/render.tsx` 的设置为准，先看一眼再改。
- 为质量页新增 1 个用例：点击单条「修正」按钮后出现 Modal 输入框，输入路径并点确定后，提交函数（mock 对应的 API）以 `"corrected"` 和输入的路径被调用。

## 验证与提交

- `💄 style(web): FE-UI 批10B workflow-studio 去四层卡片嵌套`
- `💄 style(web): FE-UI 批10B crawl-frontier 嵌套与彩色 Tag 收敛`
- `🌐 i18n(web): FE-UI 批10B crawl-frontier 配置表单文案国际化`
- `💄 style(web): FE-UI 批10B 质量页修正改用弹窗并去卡中卡`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/admin/ops/crawl-frontier` 的 Workflow Studio | 亮 + 暗 | ✓ | 最多两层层次（大卡 + 内嵌浅底区块），列表项用发丝线分隔 |
| `/admin/ops/crawl-frontier` 编辑 profile | 亮 | ✓ | 表单标签全是中文；Tag 只有状态色 |
| `/admin/quality` 分类审核 | 亮 | ✓ | 点「修正」弹出的是页面内的 Modal 而不是浏览器对话框；延迟分位是等宽数字 |
