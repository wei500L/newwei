# FE-UI 批9G：其余页面版面纪律（助手 / 图谱 / 欢迎 / 安全 / 门户 / 个人 / 实体 / 订阅 / 登录 / 金融关联）

> **一句话目标**：按 README §3.5 清理剩余页面：助手页三层边框加旧按钮皮肤；图谱列表项是旧卡片；欢迎页卡中卡；安全设置卡中卡加 `window.prompt`；门户卡片加药丸按钮；个人页一张卡里堆 5 段、4 个主按钮；登录页 MFA 文案全是英文。
>
> **依赖**：UI-9A 已合入。可与 9B ~ 9F 并行。本批只改：`app/(app)/assistant/`、`knowledge-graph/`、`welcome/`、`settings/security/`、`profile/`、`entities/`、`subscriptions/`、`finance/news-indicator-associations.tsx`、`app/(auth)/`、`app/(portal)/`。
>
> **开工前必读**：README §3（**§3.5**）、§4、§5、§7。行号是审查快照，执行前先用片段定位。分 2 次提交：登录和门面（G1）、其余（G2）。

---

## G1 登录与门户（门面）

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `(auth)/login/page.tsx:615-725,181,402` | `Continue with SSO`、MFA 流程全是英文 | 走 `t()`，key 放 `auth.login.*` / `auth.mfa.*` |
| `(auth)/login/page.tsx:454,615,619,654` | `style={{ marginTop: "1rem" }}`；进入 MFA 后页面上同时有两个 primary | 表单区改 `flex flex-col gap-4`，删除 marginTop；进入 MFA 步骤时**隐藏**原登录表单（条件渲染），只显示 MFA 表单和它的 primary |
| `(portal)/components/portal-shell.tsx:399-403` | 卡片里再套 `rounded-lg border` 框 | 内层改 `hairline-b pb-3` |
| `portal-shell.tsx:52,59,111` | 按钮 `rounded-full` | `rounded`（6px），或直接用 antd Button |
| `portal-shell.tsx:135,257` | 眉题手写 `tracking-[0.24em]` | `kicker` 类 |
| `portal-shell.tsx:100` | 稿件标题 h2 不是衬线 | 加 `font-serif`（文章标题属于 §3.1 允许衬线的场景） |

## G2 其余页面

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `assistant/assistant-content.module.css:1-15,120-140` + `assistant-content.tsx:1104,1177` | pageFrame、panel、bubble 三层都有边框 | pageFrame 去掉边框和底色（`border: 0; background: transparent`），只保留 panel 一层卡片；bubble 用底色区分（用户 `var(--secondary)`，助手 `var(--surface-muted)`），去掉边框 |
| `assistant-content.tsx:1109` | 手写 `<h1 className="m-0 font-serif text-2xl …">` | 改为 `<PageHeader title={title} kicker={…} />`；若这个 h1 在会话空态里作为大标题使用，则保留，并在报告中说明 |
| `assistant-content.tsx:1117-1131,1487,1503,1523,1569` | 按钮自定义 `rounded-xl … sky-600 shadow-[0_12px_24px…]` | 删除自定义 className，用 antd 默认 Button（发送按钮 `type="primary"`，其余 default/text） |
| `assistant-content.tsx:1320,1331,1405` | `style={{ borderRadius: 14 }}` | 删除 |
| `assistant-content.tsx:1152` | 手写 `text-[11px]` 眉题 | `kicker` |
| `knowledge-graph/knowledge-graph-content.tsx:683,688,712` | 列表项是 `rounded-2xl … bg-white/80 shadow-sm`，`text-slate-900`，链接 hover 变蓝 | 列表项改 `hairline-b py-3`；文字 `text-[var(--foreground)]`；hover `hover:text-[var(--primary)]` |
| `knowledge-graph/knowledge-graph-content.tsx`（6 处 `glass-panel`） | 视觉已与 content-card 相同 | 统一改名为 `content-card`，不改其它 class |
| `welcome/page.tsx:87,98-117,137` | content-card 里套 `rounded-lg` 框；手写胶囊按钮；emerald 色 | 内层框 → `surface-inset`；胶囊按钮 → antd `<Button>`；emerald → `text-[var(--bullish)]` |
| `settings/security/page.tsx:71` 与 `:110` | Card 里套 Card | 内层改 `surface-inset` + `SectionHeader` |
| `settings/security/page.tsx:97` | `window.prompt(...)` | 改为 antd `Modal` + `Input`：新增本地 state `promptOpen` 和 `promptValue`，确认后调用原来的回调。**不改调用的 API** |
| `settings/security/page.tsx:58-125` | 英文硬编码 | 走 `t()` |
| `settings/security/page.tsx` 的静态 `message` | `import { message } from "antd"` | 改用 `const { message } = App.useApp()` |
| `profile/profile-content.tsx:360-620` | 一张卡里 5 段用 `Text strong` 当标题；4 个 primary | 拆成多张同级 `content-card`（每段一张），段标题用 `SectionHeader`；每张卡最多一个 primary |
| `profile/profile-content.tsx:368,373` | `bg-blue-500` | `bg-[var(--primary)]` |
| `entities/[id]/entity-intelligence-card.tsx:235` | 根节点 `Space size="large"` | `flex flex-col gap-6` |
| `entities/[id]/entity-intelligence-card.tsx:282-300` | 裸 `<Card>` | `<Card className="content-card">` |
| `entities/[id]/entity-intelligence-card.tsx:261` | 只有图标的按钮 | `aria-label` |
| `subscriptions/page.tsx:824-829,961-965,1099-1103` vs `subscriptions/content-subscriptions-tab.tsx:753` | 卡片标题一处用 `Text strong`，一处是纯字符串 | 统一用 Card 的 `title` 字符串 |
| `finance/news-indicator-associations.tsx:611-657` | 手写筛选栏，固定宽 240/100 | `<FilterBar>`；控件宽度 `w-full sm:w-60` |

---

## 禁止事项

- README §4；只改上面列出的目录和文件。
- 登录、MFA、SSO 的提交逻辑、跳转、错误码处理一律不动，只改布局、文案和条件渲染的显示时机。修改 MFA 显示时机前，先确认它的状态变量，在报告里写清楚判断条件。
- 不动 `assistant` 的消息流、请求和 store。

## 测试

- 登录页已有测试必须通过。按英文文案断言的，改为新的 i18n 文案。
- 为 `settings/security` 新增 1 个用例：点击触发原 `window.prompt` 的按钮后，出现 Modal 输入框；输入并确认后，回调被调用（mock 对应的 API）。

## 验证与提交

- `💄 style(web): FE-UI 批9G 登录页 MFA 国际化与门户版面收敛`
- `💄 style(web): FE-UI 批9G 助手、图谱、欢迎、安全、个人、实体、订阅页版面纪律`

## 人工冒烟清单

| 页面 | 亮/暗 | 375 / 1280 | 看什么 |
|---|---|---|---|
| `/login`（含 MFA） | 亮 + 暗 | 两档 | 全中文；MFA 时只有一个主按钮 |
| `/assistant` | 亮 + 暗 | 两档 | 只有一层卡片，按钮是 antd 默认皮肤 |
| `/knowledge-graph` | 亮 | 1280 | 列表用发丝线分隔 |
| `/welcome`、`/profile`、`/settings/security` | 亮 | 两档 | 无卡中卡；安全页弹出的是 Modal 而不是浏览器 prompt |
| 门户文章页 | 亮 | 两档 | 按钮不是药丸形；标题衬线 |
