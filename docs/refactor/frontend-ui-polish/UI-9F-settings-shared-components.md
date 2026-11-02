# FE-UI 批9F：设置面板与共享组件版面纪律（`components/`）

> **一句话目标**：按 README §3.5 清理 `components/`（约 4.2 万行）。一是 settings 面板普遍卡中卡（外壳已有边框，面板根还是 Card，最深嵌套三层）、28 处手写 Spin 居中、Tag 彩虹、大量英文硬编码；二是高复用的共享组件（markdown-viewer、empty-digest-svg、news-image、analysis-toolbar、sentiment-badge、enhanced-search-box）还留着玻璃、光晕和渐变。
>
> **依赖**：UI-9A 已合入（9A 改了 `components/data-state-boundary.tsx`、`components/time-range-controls.tsx`，**本批不要再动这两个文件**）。可与 9B ~ 9E、9G 并行。本批只改 `components/**`。
>
> **开工前必读**：README §3（**§3.5**）、§4、§5、§7。行号是审查快照，执行前先用片段定位。分 3 次提交：F1 共享组件、F2 settings 结构、F3 settings 细节与 i18n。

---

## F1 共享组件（影响 /assistant、/today、/items、/search、/events、/analysis）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `markdown-viewer.tsx:82,83,87` | 代码块 `rounded-xl … shadow-[0_8px_18px…]`、`bg-[linear-gradient(…#0b1324…)]` | `rounded-md border border-[var(--border)] bg-surface-muted`，去掉阴影和渐变；代码文字 `font-mono text-[13px] text-[var(--foreground)]` |
| `markdown-viewer.tsx:80` | 链接 `text-sky-700 decoration-sky-300 … dark:text-sky-300` | `text-[var(--primary)] underline underline-offset-[3px]` |
| `markdown-viewer.tsx:58,60` | `bg-slate-950/5`，没有对应的 dark 写法 | `bg-surface-muted` |
| `markdown-viewer.tsx`（其余约 60 处 slate） | slate 已重映射为暖色，可以保留 | 只处理上面三处，其余不动 |
| `empty-digest-svg.tsx:14-35,58` | `aura-blur` 光晕、玻璃渐变、`fill="#FFFFFF"`，暗色下是一块白斑 | 重画成线稿：去掉所有 `<defs>` 渐变和滤镜；描边 `stroke="currentColor"`，填充 `fill="none"`，或用 `fill="currentColor" fillOpacity={0.06}`；外层 `className="text-muted-foreground"`。尺寸和 viewBox 不变 |
| `news-image.tsx:18-19,96` | 默认占位是 `from-blue-700 via-indigo-600`、`from-emerald-700 via-teal-600` 渐变 | 改成 `bg-surface-muted` + 居中的来源首字母（`font-serif text-2xl text-muted-foreground`）；若组件已有首字母逻辑就复用，只改底色 |
| `analysis/analysis-toolbar.tsx:241` | `rounded-xl … bg-white/70 p-4 shadow-sm`，暗色下是一块半透明白板 | `content-card p-4` |
| `analysis/analysis-toolbar.tsx:249` | `<Tag color="blue">{surface}</Tag>` | `<span className="kicker">{surface}</span>` |
| `sentiment-badge.tsx:62-63` | `text-[10px]`，`boxShadow: 0 0 8px ${glowColor}` 光晕 | 去掉 boxShadow；字号 `text-xs` |
| `enhanced-search-box.tsx:383-389,606,724,742` | 图标 `text-blue-500`/`text-cyan-500`/`text-purple-500`；`bg-white dark:bg-gray-900` | 图标统一 `text-muted-foreground`；输入面 `bg-surface` |
| `enhanced-search-box.tsx:552,759-771` | `color="geekblue"`、`<Tag color="blue">topic`、`"purple">sentiment` | 不传 color |
| `enhanced-search-box.tsx:780` | `absolute right-3 … <kbd>Enter` 压在后缀按钮上 | 删除这个 kbd 提示（placeholder 里已经有提示的话）；没有的话改进 placeholder 文案 |
| `enhanced-search-box.tsx:751` | 只有图标的 `QuestionCircleOutlined` 按钮 | `aria-label` + `Tooltip` |
| `analysis/create-analysis-task-button.tsx:42-45,189-219` | `"Create analysis task"` 等英文；`<Space>` 里两个 Form.Item，minWidth 160/240 | 文案走 `t()`；布局改 `<Row gutter={12}><Col xs={24} md={10}>…<Col xs={24} md={14}>` |
| `dashboard-chart-card.tsx:106` | 错误态用 ChartEmptyState，空态却是裸 `<Empty` | 空态也用 `ChartEmptyState` |

## F2 settings 面板结构（§3.5-A / B）

**背景**：`/admin/settings/*` 的每个分区外面有一层 `.settings-section-shell`（带边框和 `p-5`，由 9E 负责把圆角改成 10px），而约 17 个面板的根节点或分组仍是 `<Card>`，最深嵌套三层。

**统一做法**（逐个面板执行）：

1. 面板根节点：`<Card …>` → `<div className="flex flex-col gap-6">`。原 Card 的 `title` 不要丢：外壳已经显示了分区标题，**面板标题如果和分区标题相同就删掉，不同就改成第一个 `<SectionHeader title={…} />`**。
2. 面板内一级分组：`<Card size="small" title={X} style={{ marginBottom: 16 }}>…</Card>` → `<section className="flex flex-col gap-3"><SectionHeader title={X} rule />…</section>`。
3. 面板内二级分组或指标块：`<Card size="small">` / `<Card type="inner">` → `<div className="surface-inset">`。
4. 删掉所有 `style={{ marginBottom|marginTop: … }}`，间距交给父级 gap。
5. 区块标题 `Typography.Title level={5} style={{ marginTop: "1.5rem" }}` / `Text strong` → `SectionHeader`。

**优先处理的文件**（嵌套最深的放前面）：

| 文件:行 | 现状 |
|---|---|
| `settings/rss-diagnostics-panel.tsx:417,510,534,562,576` | Card 里 Col 里还是 Card，三层；`:419` 面板内重复的 `Title level={5}` 要删掉 |
| `settings/llm-request-logs-panel.tsx:2231→2357` | Card 里套 `<Card size="small" style={{marginTop:"0.75rem"}}>`；1600–2478 根节点是 Fragment，靠 marginBottom 撑节奏 |
| `settings/akshare-gateway-settings-panel.tsx:781-818` | 4 个 `<Card size="small">` 当指标块 → `surface-inset`，数字加 `font-mono` |
| `settings/llm-gateway/llm-gateway-proxy-governance-panel.tsx:1285→1430` | `<Card size="small" type="inner">` |
| `settings/news-extraction-*`（:75-216 有 5 处）、`settings/llm-gateway/llm-gateway-settings-panel.tsx:100,155` 及其余 settings 面板 | `<Card size="small" … style={{ marginBottom: 16 }}>` |
| `settings/access-settings-content.tsx:1151` | `rounded-[28px] p-5` → `rounded-lg p-5` |

**状态写法**：settings 下 28 处 `<div style={{display:"flex",justifyContent:"center",marginTop:"2rem"}}><Spin/></div>`（例如 `llm-request-logs:1569`、`access:1041`、`news-event-source-policy-settings-panel:1338`）→ 一律 `DataStateBoundary`。如果某处的数据结构不好接 DataStateBoundary，至少改成 `<div className="flex justify-center py-10"><Spin /></div>`，并在报告中列出。

**图表空白**：`settings/rss-diagnostics-panel.tsx:565-583` 的 `{visibilityChartOption ? <DashboardChart…/> : null}`，没数据时卡片空白 → `: <ChartEmptyState …/>`。`rss-translation-metrics:535,549`、`llm-request-logs:2371` 的裸 Empty → `ChartEmptyState`。

## F3 settings 细节与 i18n（§3.5-C / D / E）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `settings/llm-request-logs-panel.tsx:1655-1694` | 一行依次 geekblue/cyan/purple/gold/orange/red | 数值改成 mono 文本；只有超阈值时才 `<Tag color="warning|error">` |
| `settings/llm-gateway/llm-gateway-proxy-governance-panel.tsx:472-486,559-574,852-859,1313-1345` | geekblue/blue/purple 信息 Tag | 不传 color |
| `settings/situation-monitor-settings-panel.tsx:833-859,986-996,1067-1128` | 连续 blue/geekblue/cyan | 来源类不传 color；状态只用 success/error |
| `settings/realtime-signals/realtime-signals-overview.tsx:140-249`（10 处） | `color="geekblue"` | 不传 color |
| `settings/assistant-safety-settings-panel.tsx:965,1124`、`llm-request-logs-panel.tsx:1994,2189` | 同一面板两个 primary；「刷新」也是 primary | 每个区块只留一个 primary，刷新改 default |
| `settings/rss-translation-metrics-panel.tsx:433-468` | Card extra 里放了 150/160/180 宽的 3 个 Select 和 1 个按钮 | 移到 body 顶部 `<FilterBar>` |
| `settings/news-events-settings-panel.tsx:1317` | `<Descriptions column={2}>` | `column={{ xs: 1, md: 2 }}` |
| `settings/access-settings-content.tsx:2177-2236`、`settings/applications-panel.tsx:314-371`、`settings/system-security-settings-panel.tsx:286,302-306,319,336-385` | `title="Create invite"`、`"Join requests"`、`MFA policy: {…}` 等英文 | 走 `t()` |
| `settings/llm-request-logs-panel.tsx:1623,1632,2125-2139`、`settings/rss-diagnostics-panel.tsx:627-630` | `"Clear context"`、`` `scanned=${…}` `` | 走 `t()`；数值 `font-mono` |

---

## 禁止事项

- README §4；只改 `components/**`，但**不动** `data-state-boundary.tsx`、`time-range-controls.tsx`（9A），也不动 `page-header.tsx`、`section-header.tsx`、`filter-bar.tsx` 这些原语的 API。
- 不改表单字段、校验规则和提交逻辑；Form 的 `name` 不变。
- 一个面板改完立刻自查：`grep -n "<Card" <文件>` 应只剩 0 处，或只剩 Modal/Drawer 内部确有必要的卡片，并在报告中解释。

## 测试

settings 面板已有测试必须通过。按 Card 标题文案找元素的测试，如果标题改成了 SectionHeader，文字不变，`getByText` 仍然可以找到；按 role 找 heading 的，按新层级调整。empty-digest-svg 若有测试断言了颜色，改为断言渲染出 svg。

## 验证与提交

- `💄 style(web): FE-UI 批9F 共享组件去玻璃光晕（markdown/空态插图/图片占位/搜索框）`
- `💄 style(web): FE-UI 批9F 设置面板去卡中卡并统一加载与空态`
- `🌐 i18n(web): FE-UI 批9F 设置面板 Tag、主按钮收敛与英文文案国际化`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/admin/settings/ai`、`/monitoring`、`/news` | 亮 + 暗 | ✓ | 分区外壳里只有一层层次，标题统一用 SectionHeader，加载态居中一致 |
| `/admin/settings/access` | 亮 | ✓ | 邀请、审批文案是中文 |
| `/assistant` 回答里含代码块和链接 | 亮 + 暗 | ✓ | 代码块无阴影渐变；链接是墨蓝 |
| `/today` 空摘要 | 暗 | ✓ | 插图没有白斑 |
| `/items` 无图新闻 | 亮 | ✓ | 占位是纸色 + 首字母，不是彩色渐变 |
| `/search` | 亮 | 375 | 搜索框后缀不重叠 |
