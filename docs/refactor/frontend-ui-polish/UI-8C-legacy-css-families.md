# FE-UI 批8C：遗留样式族与零散漏项收尾

> **一句话目标**：清掉 `globals.css` 和两个 CSS Module 中仍写死旧「冷灰蓝 + 毛玻璃」色值的组件样式族；补上前几批漏掉的 TSX：events-archive、hero-section、健康度条、24 个缺横向滚动的表格、1 个固定宽抽屉，以及权限设置页的旧页头。
>
> **依赖**：UI-0 ~ UI-7 已合入 main。可与 UI-8A、UI-8B 并行。本批独占 `app/globals.css`。
>
> **开工前必读**：README §3、§4、§5、§7；`style-preview.html`。

本批分 **两部分**，各自提交。如果一个窗口做不完，先做 Part 1 并提交，在报告中说明 Part 2 未开始。

---

## 背景（审查证据，2026-11-02 于 main@8d230eb6 静态核实）

- `app/globals.css` 共 2137 行，其中约 400 处原始 `rgba(...)` / `#hex`，几乎都属于下面这些组件样式族，并且大量写在 `.dark .xxx` 里。用的是旧 Tailwind slate 色值：`#0f172a`、`#e2e8f0`、`#cbd5e1`、`#475569`、`#64748b`、`rgba(15,23,42,…)`、`rgba(148,163,184,…)`、`rgba(71,85,105,…)`。在暖纸底上发冷蓝；暗色下是「海军蓝」而不是新的深墨 `#0d1117`。
- 5 处仍有 `backdrop-filter: blur(...)`：`globals.css:428`（`.sm-layout-panel-metrics`）、`:949`（`.settings-section-shell`，blur 28px）、`:1434`（`.search-feedback-pill`）、`:1672`（`.entity-graph-panel`）、`:1750`（`.entity-graph-chip`）。
- UI-5 要求删除或 token 化的 auth 暗色覆写**仍在**：`globals.css` 约 1978-2106 的 `.dark .auth-card .ant-input-affix-wrapper { background: rgba(15,23,42,0.78); color:#e2e8f0 }` 等。
- `assistant/assistant-content.module.css`（597 行）有 28px 圆角、`backdrop-filter: blur(18px)`、三段白色渐变；`admin/admin-content.module.css`（540 行）在 `:54,137,267,385` 有 4 处渐变，`:135` 是 16px 圆角。两文件合计约 300 处原始色值。

---

## 原始色值 → token 映射表（Part 1 全程照此替换）

| 原始值（含近似值） | 语义 | 替换为 |
|---|---|---|
| `#ffffff`、`rgba(255,255,255,0.75~0.98)` 做面板底 | 纸面 | `var(--surface)` |
| `#f8fafc`、`#f1f5f9`、`rgba(248,250,252,…)` | 浅底、内嵌 | `var(--surface-muted)` |
| `#e2e8f0`、`#cbd5e1`、`rgba(148,163,184,0.18~0.46)`、`rgba(100,116,139,…)` 做**边框** | 发丝线 | `var(--border)` |
| `#0f172a`、`#111827`、`#1e293b`，做**文字** | 墨色正文 | `var(--foreground)` |
| `#475569`、`#64748b`、`#334155`，做**文字** | 次要文字 | `var(--muted-foreground)` |
| `#0f172a`、`rgba(15,23,42,0.78~0.96)`、`rgba(30,41,59,…)`，在 `.dark` 中做**背景** | 深墨面 | `var(--surface)`；内嵌用 `var(--surface-muted)` |
| `#e2e8f0`、`#cbd5e1`，在 `.dark` 中做**文字** | 暖白 | `var(--foreground)` |
| `#93c5fd`、`#60a5fa`、`#3b82f6`、`rgba(59,130,246,…)`、`rgba(31,59,123,…)` | 强调、选中、hover | `var(--primary)`；需要淡底时用 `var(--secondary)` |
| `box-shadow: 0 10px 24px rgba(15,23,42,…)` 一类 | 漂浮阴影 | `var(--shadow-surface)`；嵌在卡片内部的元素直接 `none` |
| `backdrop-filter` / `-webkit-backdrop-filter` | 毛玻璃 | **删除** |
| `linear-gradient(...)` 做面板背景 | 装饰渐变 | 改为对应的纯色 token |
| `border-radius` ≥ 14px | 大圆角 | 卡片 `var(--radius-lg)`（10px）；控件 `var(--radius)`（6px）；药丸状 `999px` 保留 |

**原则**：

1. 替换成 CSS 变量后，`.dark .xxx { … }` 里**只为颜色而存在**的规则就和亮色规则重复了，应整条删除，因为变量自己会切换。只在暗色确实需要不同**结构**时保留。
2. 语义色（成功绿、警告琥珀、错误红）如果表示状态，保留色相，但改用 `var(--bullish)` / `var(--accent)` / `var(--destructive)`。
3. 拿不准的值（比如图谱节点的分类色）**保留原值**，写进报告「未完成与原因」。

---

## Part 1：样式表清理

### 1-1 `app/globals.css` 各样式族（按行号从上到下处理，每处理完一族自查一次）

| 族 | 大致行号 | 重点 |
|---|---|---|
| `.sm-panel*`、`.sm-layout*`、`.sm-realtime*`、`.react-grid*` | 285-577 | 态势监控面板。`:428` 删 blur；`.sm-realtime-snapshot-card` 的 webkit 滚动条颜色用 `var(--border)` |
| `.archive-toolbar*`、`.archive-region*` | 586-1125（含 `.dark` 段 1005-1044） | 事件归档工具栏。删除对 antd 的 `!important` 覆写中**只改颜色**的部分（交给 antd 主题）；结构性的（间距、布局）保留 |
| `.settings-nav*`、`.settings-section-shell` | 900-1178 | `:942-955` 改为 `border:1px solid var(--border); background:var(--surface); box-shadow:none;`，删 blur 和渐变 |
| `.items-reader*`、`.items-filter*`、`.items-feed*` | 965-1612 散落 | `:983` 的 `100vh - …` 改为 `100dvh - …`，并在前一行保留 `100vh` 版本作为回退：先写一条 `max-height: calc(100vh - …)`，再写一条 `max-height: calc(100dvh - …)` |
| `.search-feedback-pill*` | 1340-1605 | `:1434` 删 blur；各状态色（idle/loading/success/error）用 `var(--muted-foreground)` / `var(--primary)` / `var(--bullish)` / `var(--destructive)`，底色统一 `var(--surface-muted)` |
| `.entity-graph-*` | 1650-1935 | `:1672,1750` 删 blur；面板和 chip 按映射表处理 |
| `.auth-layout`、`.auth-card` | 1940-2106 | **删除** `.dark .auth-card .ant-*` 这一整组只改颜色的覆写（约 1978 行起），让 antd darkAlgorithm 和 token 接管。`.auth-card` 本体和 `@media (max-width:480px)` 的 padding 保留 |

**自查命令**（处理完 globals.css 后执行，并把输出贴进报告）：

```bash
grep -cE "rgba\(|#[0-9a-fA-F]{3,6}\b" apps/web/app/globals.css     # 目标：从约 400 降到 ≤ 80（:root/.dark token 定义本身的色值不算违规）
grep -nE "backdrop-filter" apps/web/app/globals.css                 # 目标：0 行
grep -nE "#0f172a|rgba\(15, ?23, ?42" apps/web/app/globals.css      # 目标：0 行
```

### 1-2 `app/(app)/assistant/assistant-content.module.css`

- `:9` 页面三段渐变 → `background: var(--background);`。
- `:41-47` 主面板：`background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-surface);`，删除 `backdrop-filter`。
- 其余色值按映射表处理。`.dark` 选择器下的颜色规则按原则 1 删除。
- 自查：`grep -cE "rgba\(|#[0-9a-fA-F]{6}" <file>` 目标降到 ≤ 15，剩下的要能说明是语义色。

### 1-3 `app/(app)/admin/admin-content.module.css`

- `:54,137,267,385` 四处 `linear-gradient` → 对应纯色 token（头部区块用 `var(--surface)`，统计条用 `var(--surface-muted)`）。
- `:51` 12px 圆角 → `var(--radius-lg)`；`:135` 16px 圆角 → `var(--radius-lg)`。
- 其余色值按映射表处理。

**Part 1 验收**：

- `/situation-monitor`、`/events-archive`、`/admin/settings/*`、`/search`（搜索反馈胶囊）、`/knowledge-graph`、`/assistant`、`/admin`、`/login` 亮色和暗色都过一遍。
- 没有毛玻璃，没有发蓝的面板。暗色下面板是深墨色而不是海军蓝。
- 登录页暗色输入框与其它页面的输入框一致。

**Part 1 提交**：`🎨 style(web): FE-UI 批8C 遗留样式族去毛玻璃并改用纸墨 token（globals/assistant/admin）`

---

## Part 2：TSX 漏项

### 2-1 `events-archive/events-archive-content.tsx`（slate 169 处，`rounded-2xl` 8 处）

- `:1298,1332,1515,1528,1700,1724` 的 `rounded-2xl border border-slate-200/80 bg-white/75|78 … shadow-[…] dark:border-slate-800/80 dark:bg-slate-900/82|950/60`：
  - 区块（`<section>`）→ `content-card p-4`。
  - 区块内的可点击条目（`:1332`）→ `rounded border border-[var(--border)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--border-strong)]`。
  - 空态（`:1298`）→ `rounded border border-dashed border-[var(--border)] bg-[var(--surface-muted)] px-4 py-6 text-center`。
  - 删除对应的 `dark:` 类和 `shadow-[…]`。
- `:1332` 的 `focus-visible:ring-sky-500/60` → `focus-visible:ring-[var(--ring)]`。
- `:1252,1256` 渐隐分隔线（`bg-gradient-to-r from-transparent via-slate-300/75 …`）→ 改为 `h-px flex-1 bg-[var(--border)]`。
- `:1276,1645` `tone.accentGlowClassName` 渐变条：找到 `tone` 的定义处，把 `accentGlowClassName` 的值从 `from-X to-Y` 渐变改为单色。为了让 `bg-gradient-to-r` 失效，同时把调用处的 `bg-gradient-to-r` 去掉，例如改成 `className={\`h-1.5 w-full ${tone.accentBarClassName}\`}`，并把字段重命名为 `accentBarClassName`。每个 tone 取一个 token 色：
  - 高危：`bg-[var(--destructive)]`
  - 中：`bg-[var(--accent)]`
  - 低：`bg-[var(--primary)]`
  - 中性：`bg-[var(--border-strong)]`

  所有类名必须是完整字面量。

### 2-2 `dashboard/hero-section.tsx:182,189`

`mb-10 glass-panel border border-[var(--border)] rounded-3xl p-8 shadow-sm` → `content-card p-6 md:p-8`（去 `mb-10`，间距交给父级 `gap-6`；如果父级没有 gap，就保留 `mb-6`）。

### 2-3 `components/system-health-meter.tsx`

- `:57,67,77,87` 四个 `fillClassName` 的渐变 → 单色：健康 `bg-[var(--bullish)]`、警告 `bg-[var(--accent)]`、危险 `bg-[var(--destructive)]`、未知 `bg-slate-400`。
- `:144` 轨道 `border border-white/60 bg-slate-200/80` → `bg-[var(--surface-muted)]`（去边框）。
- `:146` 三色背景渐变层 `<div className="absolute inset-0 bg-[linear-gradient(...)] opacity-25" />` 整行删除。
- 如果有测试断言了这些类名，同步更新。

### 2-4 补 24 个表格的横向滚动

给以下 `<Table` 加 `scroll={{ x: "max-content" }}`。已有 `scroll={{ y: … }}` 的合并为 `{{ x: "max-content", y: … }}`。

```
app/(app)/admin/quality/quality-content.tsx:2134
app/(app)/admin/search-telemetry/search-telemetry-content.tsx:320,335,350,376
app/(app)/admin/logs/admin-logs-content.tsx:1441
app/(app)/admin/ops/queue-ops/queue-ops-dlq-panel.tsx:249
app/(app)/admin/ops/queue-ops/queue-ops-jobs-panel.tsx:266
app/(app)/admin/ops/queue-ops/queue-ops-queues-panel.tsx:245
app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx:2302
app/(app)/crawl/components/MetadataExtractionCard.tsx:379
components/settings/llm-request-logs-panel.tsx:2412,2440,2460
components/settings/rss-translation-metrics-panel.tsx:563
components/settings/llm-gateway/llm-gateway-profiles-panel.tsx:273
components/settings/llm-gateway/llm-gateway-models-modals.tsx:47,217
components/settings/news-source-runtime-secrets-panel.tsx:1111
components/settings/applications-panel.tsx:315,349
components/settings/assistant-safety-settings-panel.tsx:754
components/settings/news-events-settings-panel.tsx:1397
components/settings/rss-diagnostics-panel.tsx:663
```

行号可能已漂移，以 `<Table` 出现位置为准。改完用 UI-4 提示词里那段 python 校验脚本复查，结果应为 0 条。

### 2-5 固定宽抽屉

`dashboard/charts/knowledge-graph.tsx:591` `width={380}` → `width="min(380px, 100vw)"`。

### 2-6 权限设置页旧页头（`components/settings/access-settings-content.tsx:1112-1121`）

**现状**：根节点是 `<div className="space-y-6"><Card className="content-card" title={t('adminConsole.links.settings.title')}>`，接着是 `<Typography.Paragraph>` 描述。这是 UI-3C 漏掉的 Card-title 页头写法（同目录 `/admin/settings/[section]` 的其它分区都已经用 PageHeader）。

**改法**：参照 `app/(app)/admin/settings/settings-section-content.tsx:100-108`：

```tsx
<div className="flex flex-col gap-6">
  <PageHeader
    kicker={t('nav.groups.admin')}
    title={t('adminConsole.links.settings.title')}
    description={t('adminConsole.links.settings.description')}
  />
  <Card className="content-card">
    {messageContext}
    {/* 原 Paragraph 删除，其余内容原样保留 */}
```

- 页头标题若应为「成员与权限」一类分区名，就用分区自己的 title key：在 `settings-navigation` 里找到 `access` 对应的 `titleKey`。在报告中说明选了哪个。
- 同文件 `:1126` 的 `style={{ marginBottom: '1rem' }}` → `className="mb-4"`。

**Part 2 验收**：`/events-archive` 无圆胖卡片和渐变条；`/dashboard` hero 区块与其它卡片同风格；顶栏健康度条是单色；上面这些表格在 375px 宽度下能横向滚动而不是挤成竖排；`/admin/settings/access` 有衬线 h1 页头。

**Part 2 提交**：`💄 style(web): FE-UI 批8C 收尾 events-archive/hero/健康度条与漏掉的表格滚动、权限页页头`

---

## 禁止事项

- README §4 全部通用约束。
- 不改 `tailwind.config.ts`、`providers.tsx`、`lib/chart-theme-tokens.ts`（UI-8A）和 `newsnow/`、`news-hub/`（UI-8B）。
- `globals.css` 中 `:root` / `.dark` 的 token 定义块（约 1-150 行）**不要改值**。
- 删 CSS 规则前先 `grep -rn "<类名>" apps/web/app apps/web/components` 确认类名仍在使用；没人用的规则整段删除，并在报告中列出。

## 自主优化授权

在 `globals.css`、两个 CSS Module、Part 2 列出的文件内，可以按映射表继续清理同类问题，在报告中列出。不得扩散到其它文件。

## 测试

纯样式改动不新增测试；已有测试断言了旧类名的要同步更新，不能删除。

## 人工冒烟清单

| 页面 | 亮色 | 暗色 | 375 / 1280 | 看什么 |
|---|---|---|---|---|
| `/situation-monitor` | ✓ | ✓ |  | 面板无毛玻璃，暗色不发海军蓝 |
| `/events-archive` | ✓ | ✓ | ✓ | 工具栏、区块、条目卡片、色条 |
| `/search` | ✓ | ✓ |  | 搜索反馈胶囊 |
| `/knowledge-graph` | ✓ | ✓ |  | 图谱侧面板与 chip |
| `/assistant` | ✓ | ✓ | ✓ | 主面板纸面化，无 28px 大圆角 |
| `/admin`、`/admin/settings/access` | ✓ | ✓ |  | 头部无渐变，权限页有 h1 |
| `/login` | ✓ | ✓ | ✓ | 暗色输入框与全站一致 |
| `/admin/search-telemetry`、`/admin/ops/queue-ops` | ✓ |  | ✓ | 表格可横向滚动 |
