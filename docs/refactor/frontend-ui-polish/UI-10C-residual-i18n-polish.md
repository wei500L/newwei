# FE-UI 批10C：零散残留收尾（分析看板 / 邀请与 SSO / NewsNow 头部与热点候选 / 助手 / 战争地图 / 无标签图标按钮）

> **一句话目标**：清掉 UI-9 后全仓扫描剩下的零散问题：
> - `/analysis` 看板从未进过任何一批，约 58 处英文硬编码。
> - 邀请注册页、SSO 回调页的表单标签是英文。
> - `newsnow-header.tsx`（约 26 处）、`newsnow-hottest-candidates.tsx`（约 21 处）硬编码中文，没有接 i18n，英文界面下会混排。
> - 助手页残留 2 处 `rounded-2xl`；战争地图容器还是 `rounded-[24px]`。
> - 12 个只有图标的按钮没有 `aria-label`。
> - 若干 `text-[10px]` 以下的小字。
>
> **依赖**：UI-9 全部合入。可与 UI-10A、UI-10B 并行。本批**不碰** `events/**`、`knowledge-graph/knowledge-graph-canvas.tsx`、`alerts/entity-association-evidence.tsx`、`lib/*-tokens.ts`、`hooks/use-chart-theme.ts`（10A），也不碰 `admin/ops/crawl-frontier/**`、`admin/quality/**`（10B）。`zh.json` / `en.json` 只追加。
>
> **开工前必读**：README §3.5、§4、§5、§7。行号是审查快照，执行前先用片段定位。分 2 次提交（C1 文案，C2 样式与可访问性）。

---

## C1 文案国际化

### `app/(app)/analysis/analysis-workspace.tsx`（约 58 处）

文件已经 `"use client"` 并导入了 `useTranslation`（有 6 处 `t(`）。把剩下的英文全部走 `t()`，key 放 `analysis.workspace.*`（先 `grep -n '"analysis"' lib/locales/zh.json` 看现有结构，沿用已有子树）。典型位置：

| 行（快照） | 原文 | 建议 key / 中文 |
|---|---|---|
| `:238` | `<Tooltip title="Add task">` | `analysis.workspace.addTask` / 添加任务 |
| `:263` | `description="No tasks"` | `analysis.workspace.emptyColumn` / 暂无任务 |
| `:764` | `title="Archive this board?"` | `analysis.workspace.archiveConfirm` / 确定归档这个看板？ |
| `:789` | `description="No board columns yet."` | `analysis.workspace.emptyBoard` / 看板还没有列 |
| `:806` | `title="Create analysis board"` | `analysis.workspace.createBoard` / 新建分析看板 |
| `:812` | `label="Title"`、`message: "Enter a title."` | `…fields.title` / 标题；`…validation.titleRequired` / 请输入标题 |
| `:815` | `label="Description"` | `…fields.description` / 描述 |
| `:823` | `title="Create task"` | `…createTask` / 新建任务 |
| `:833` | `title="Manage columns"` | `…manageColumns` / 管理列 |
| `:864` | `title="Delete this column?"` | `…deleteColumnConfirm` / 确定删除这一列？ |

其余 `message.success("…")`、按钮文字、`okText`、Form label 同样处理。同时：

- `:263`、`:789` 的 `<Empty>` 改为 `<ChartEmptyState presentation="banner" description={t(…)} />`（§3.5-B）。
- `:772` 的 `<Spin spinning={loadingBoard}>` 包裹层保留（它是覆盖式加载，不是居中占位）。
- `:185` 的 `style={{ marginBottom: 8, marginTop: 6, fontSize: 12 }}` → `className="mb-2 mt-1.5 text-xs"`。

自查：`grep -cE '"[A-Z][a-z]+( [a-z]+)+[.?]?"|>\s*[A-Z][a-z]+( [a-z]+)*\s*<' app/(app)/analysis/analysis-workspace.tsx`，期望 0（排除协议枚举值）。

### `app/(auth)/invite/[token]/page.tsx`、`app/(auth)/auth/sso/callback/page.tsx`

| 文件:行 | 原文 | 改法 |
|---|---|---|
| `invite:129,132,135` | `label="First name"` / `"Last name"` / `"Password"` | `t("auth.invite.firstName")` / 名、`lastName` / 姓、`password` / 密码；`rules` 里补 `message: t("auth.invite.required")` |
| `sso/callback:228` | `label="Authenticator code or recovery code"` | 先查 UI-9G 在 `auth.mfa.*` 下建的 key，能复用就复用，否则新建 `auth.mfa.codeOrRecovery` / 验证器动态码或恢复码 |
| `sso/callback:283` | `label="Authenticator code"` | 复用 `auth.mfa.*` 中对应 key |
| 两个文件中其余 `>English text<` | — | 一并走 `t()` |

**不改**提交逻辑、跳转和错误码处理。

### `app/(app)/newsnow/components/newsnow-header.tsx`、`newsnow-hottest-candidates.tsx`

两个文件都是 `"use client"`，但没有导入 `useTranslation`。加上：

```tsx
import { useTranslation } from "react-i18next";
// 组件内
const { t } = useTranslation();
```

然后把所有硬编码中文改成 `t("newsnow.header.*")` / `t("newsnow.hottest.*")`，en.json 给出对应英文。典型位置：

- header：`messageApi.success("行为画像已清空")`、`messageApi.error("清空行为画像失败")`、`排序`、`手动` / `个性化`、`去重`、两个 Tooltip 说明文字。
- hottest-candidates：`title="热点候选"`、`国内舆情指数`、`热榜底座 + 新闻管道补强`、`aria-label="国内舆情指数趋势"`、`新闻管道负面压力`、登录提示（`:369-370`）、权限提示（`:379`）。

先 `grep -n '"newsnow"' lib/locales/zh.json`，UI-8B / 9D 已经建了 `newsnow.*` 子树，**能复用的 key 直接复用**。

同文件的样式顺手处理：

- hottest-candidates 有 9 处 `text-[9px]` / `text-[10px]` → `text-[11px]`（全站最小字号 11px）。
- `:133` 手写的 `<h2 className="mt-1 text-lg font-semibold …">` 如果上方已有 kicker，整体换成 `<SectionHeader kicker={…} title={…} />`（9D 已在本文件 `:79-80` 用过 SectionHeader，保持一致）。

## C2 样式与可访问性

### 大圆角残留

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `assistant/assistant-content.tsx:1020` | 会话列表项 `rounded-2xl border px-4 py-3` | `rounded-md border px-3 py-2.5` |
| `assistant/assistant-content.tsx:1439` | 输入区按钮 `rounded-2xl px-5 text-[15px]` | 删掉 `rounded-2xl` 和 `text-[15px]`（用 antd Button 默认圆角与字号） |
| `dashboard/charts/war-map/war-map.tsx:442` | 地图容器 `rounded-[24px]` | `rounded-lg` |

### 只有图标的按钮补 `aria-label`（§3.5-E）

以下按钮只有 `icon={<XxxOutlined />}`，没有文字，也没有 `aria-label`。逐个补上，文案用 `t()`，优先复用 `common.*`（`common.close`、`common.refresh`、`common.delete`、`common.more`…，先 grep zh.json 确认存在）：

| 文件:行（快照） |
|---|
| `newsnow/components/newsnow-card.tsx:1403` |
| `newsnow/components/news-list-hot.tsx:234` |
| `newsnow/components/news-list-timeline.tsx:140` |
| `today/user-digest-panel.tsx:367` |
| `dashboard/charts/war-map/war-map-inspector-shell.tsx:164`、`:246` |
| `components/top-nav-actions.tsx:69`、`components/notification-center.tsx:389`（均在 `app/(app)/components/`） |
| `situation-monitor/components/situation-monitor-headlines.tsx:146` |
| `items/items-view.tsx:2552` |
| `items/components/news-card.tsx:546`、`:614` |

**做法**：看图标判断语义（`CloseOutlined` → 关闭，`ReloadOutlined` → 刷新，`MoreOutlined` → 更多操作，`StarOutlined` → 收藏……）。如果按钮外面已经包了 `<Tooltip title={X}>`，就把同一个 `X` 作为 `aria-label`。

### 其它

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `crawl/components/create-crawl-task-drawer/template-step.tsx:32` | `<Col span={12}>` | `<Col xs={24} sm={12}>` |
| `entities/[id]/entity-intelligence-card.tsx:327` | `"border-slate-200 bg-white text-slate-700"`（没有暗色写法） | `"border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"` |
| `(portal)/components/portal-shell.tsx:35` | `bg-[var(--surface)] backdrop-blur` | 删掉 `backdrop-blur` |
| `dashboard/components/market-pulse.tsx`、`dashboard/charts/sector-heatmap.tsx`、`components/command-bar.tsx`（`app/(app)/`）、`components/enhanced-search-box.tsx`、`items/items-view.tsx`、`items/components/news-card.tsx`、`newsnow/components/*`、`admin/admin-content.tsx` | 共约 25 处 `text-[9px]` / `text-[10px]` | 一律 `text-[11px]`。热力图格子里的数字如果放不下，保留 `text-[10px]` 并在报告中说明 |

---

## 禁止事项

- README §4；本批不碰 10A、10B 的文件（见开头依赖说明）。
- 门户（`app/(portal)/**`）是服务端渲染的公开站点，文案目前统一为英文。**本批不做门户 i18n**，只删 `backdrop-blur`。
- 不改 newsnow 的 store、请求和排序 / 去重逻辑；不改助手的消息流。

## 测试

- 已有测试必须通过。按旧中文 / 英文文案断言的测试同步更新（测试环境语言以 `test/render.tsx` 为准）。
- 不需要新增测试。

## 验证与提交

- `🌐 i18n(web): FE-UI 批10C 分析看板、邀请与 SSO、NewsNow 头部与热点候选文案国际化`
- `💄 style(web): FE-UI 批10C 大圆角、小字号与图标按钮无障碍标签收尾`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/analysis` | 亮 | ✓ | 新建看板、新建任务、管理列的弹窗全是中文；空列有统一的空态提示 |
| `/invite/<token>`、SSO 回调的 MFA 步骤 | 亮 | ✓ | 表单标签是中文 |
| `/newsnow/hottest` 切换到英文 | 亮 | ✓ | 头部控件和热点候选区没有中文残留 |
| `/assistant` | 亮 + 暗 | ✓ | 会话列表项和发送按钮不再是大圆角 |
| `/map`（或 dashboard 概览里的地图） | 亮 | ✓ | 地图容器圆角与其它卡片一致 |
