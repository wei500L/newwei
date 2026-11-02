# FE-UI 批8B：NewsNow 快览模块与 News Hub 入口页回归纸墨风格

> **一句话目标**：`/newsnow/*`（11 个文件，约 4300 行）和 `/news-hub` 在前面几批里基本没被覆盖，仍是旧的玻璃拟态和霓虹渐变，部分组件在亮色下根本看不见。本批把它们按 README §3 改成纸墨风格，并修掉亮色不可见的 bug。
>
> **依赖**：UI-0 ~ UI-7 已合入 main。可与 UI-8A、UI-8C 并行。注意 UI-8A 会把 `slate-*` 色阶整体变暖，本批**不需要**为此去改 slate 类。
>
> **开工前必读**：README §3、§4、§5、§7；`style-preview.html` 里的「列表页」和「数据带」两节是本批的视觉参考。

---

## 背景（审查证据，2026-11-02 于 main@8d230eb6 静态核实）

| 文件 | 问题 |
|---|---|
| `newsnow/components/newsnow-header.tsx:153-200` | sticky 头用 `bg-[linear-gradient(...rgba...)]` + `backdrop-blur-md` + 多层 `shadow-[...]`；内部两块 `glass-panel rounded-[26px] border-white/40`；tab 用 `rounded-2xl`；暗色用 `zinc` 系；16 处 zinc |
| `newsnow/components/newsnow-hottest-candidates.tsx:172-219,308,472` | 卡片是 `border-white/10 bg-white/[0.03]`，**亮色下边框和底色都看不见**（真 bug）；`rounded-2xl` 共 20 处 |
| `newsnow/components/newsnow-search.tsx:90-142` | 搜索弹窗用 `styles.content` 写死深色渐变 `rgba(10,14,22,…)`，标题 `text-zinc-100`，输入框 `bg-black/35`。**亮色主题下也是一块黑色弹窗**；`width={620}` 固定；`title="搜索新闻源"` 硬编码 |
| `newsnow/components/newsnow-recommended-feed.tsx:189,237,277,327` | `glass-panel rounded-[24px|26px] border-white/40` + 大阴影；眉题 `tracking-[0.18em]/[0.24em]` |
| `newsnow/components/news-list-hot.tsx:29-33,160` | 排名徽章是金、银、铜三色渐变 `bg-gradient-to-b from-amber-400 to-orange-500` |
| `newsnow/components/news-list-hot.tsx:182,187`、`news-list-timeline.tsx:164,169` | 标签用 `sky-500`，不在色板内 |
| `newsnow/components/newsnow-card.tsx:1400-1403` | 列表容器 `bg-white/40 backdrop-blur-sm` |
| `newsnow/[column]/page.tsx:213-224` | `frameStyle` 按 isDark 叠两个 `radial-gradient(var(--aura-color-*))` 光斑，即 UI-0 已去掉的 aura 风格的残留 |
| `news-hub/page.tsx:8-63` | 三张入口卡 `pillars` 是 `from-fuchsia-500/25 via-violet-500/15 to-slate-900/0` 霓虹渐变 + `text-zinc-200/90` 浅色字。**亮色纸底上浅字配浅底，几乎读不清**；标题、描述、按钮文案硬编码中文 |
| newsnow 全模块 | 约 150 处硬编码中文（card 34、hottest 31、header 25、column page 19、feed 15…） |

---

## 通用替换规则（本批所有文件）

| 旧写法 | 新写法 |
|---|---|
| `glass-panel` + `rounded-[24px]`/`[26px]`/`rounded-2xl` + `border-white/40` + `shadow-[...]` | `content-card`（UI-0 已改为实色纸面 + 1px 发丝线），圆角交给类本身，删除自定义阴影 |
| `backdrop-blur*`、`bg-[linear-gradient(...)]` 做面板底 | `bg-[var(--surface)]`，sticky 头用 `bg-[var(--background)]` + `border-b border-[var(--border)]` |
| `border-white/10`、`border-white/40`、`border-slate-200/80` | `border-[var(--border)]` |
| `bg-white/[0.03]`、`bg-white/75`、`bg-white/82`、`dark:bg-white/[0.04]` | 卡片 `bg-[var(--surface)]`；内嵌块 `bg-[var(--surface-muted)]` |
| `text-zinc-100`/`text-slate-950`/`text-slate-900` 做标题 | `text-[var(--foreground)]` |
| `text-zinc-400/500`、`text-slate-500` 做次要文字 | `text-[var(--muted-foreground)]` |
| `dark:hover:bg-white/8`、`hover:bg-slate-900/6` | `hover:bg-[var(--secondary)]` |
| 眉题 `text-[11px] uppercase tracking-[0.18em]` 一类 | `kicker` 工具类（README §3.3） |
| `sky-*` 标签 | 「新」「实时」类标签用 `--accent`：`border-[var(--accent)]/…` 不可用（Tailwind 3 对 var 不支持透明度），改为 `border border-[var(--border)] text-[var(--accent)]` |
| `rounded-[4px]`、`rounded-[8px]` | `rounded-sm`（4px）、`rounded`（6px） |

**写 dark: 的原则**：上面都是 CSS 变量，暗色会自动切换，**替换后删掉对应的 `dark:` 类**，不要保留旧的 `dark:bg-white/[0.04]`。

---

## 任务 1：修 `newsnow-search.tsx` 的强制深色弹窗（亮色 bug）

- 删除 `<Modal>` 的 `className="[&_.ant-modal-close]:text-zinc-400 …"` 和 `styles.content` 里的深色渐变背景。弹窗外观完全交给 antd 主题（UI-0 已对齐 token）。
- `:111` 输入区 wrapper 的一长串 `[&_.ant-input…]` 任意选择器全部删除，使用 antd 默认 Input。
- `:112` `border-white/10` → `border-[var(--border)]`；`:142` `hover:bg-white/10` → `hover:bg-[var(--secondary)]`。
- `width={620}` → `width="min(620px, calc(100vw - 32px))"`。
- `title="搜索新闻源"` → `t("newsnow.search.title")`（key 不存在就在 zh/en 新增：「搜索新闻源」 / "Search sources"）。

**验收**：亮色主题下弹窗是纸面白底、墨色文字；暗色下是深墨底；375px 宽度下不溢出。

## 任务 2：修 `newsnow-hottest-candidates.tsx` 亮色不可见

- 所有 `rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2`（`:172,201,207,213,219,308`）→ `rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2`。
- `:472` 的 `rounded-full border border-white/10 bg-white/5` → `rounded-full border border-[var(--border)] bg-[var(--surface)]`。
- 其余 `rounded-2xl` 一律降为 `rounded`（6px）或 `rounded-lg`（10px，仅限最外层容器）。
- 数字（热度、排名、计数）加 `font-mono tabular-nums`。

**验收**：亮色下每个候选块都有清晰的发丝线边框和浅纸底；暗色下效果与原先接近，但不发灰蓝。

## 任务 3：`newsnow-header.tsx` 去玻璃

- `:153` sticky header：整串类替换为 `sticky top-0 z-50 w-full border-b border-[var(--border)] bg-[var(--background)]`（去渐变、去 blur、去阴影）。
- `:156,200` 两个 `glass-panel rounded-[26px] …` → `content-card px-3 py-2.5 md:px-4`（第二个保留原 py 值）。
- `:164` tab：`rounded-2xl` → `rounded`；选中态参照 `style-preview.html` 的顶部导航——**选中 = 墨色字 + 下方 2px 墨线**（`border-b-2 border-[var(--foreground)]`），未选中 = muted 字。不要用填充色块表示选中。把这段三元表达式的两侧都写成完整字面量（README §4 Tailwind JIT 铁律）。
- `:179,192` 次级按钮去掉 `bg-white/82 shadow-[…] rounded-2xl` 和 zinc 系，交给 antd Button 默认样式（`size="small"`）。
- `import { message } from "antd"` 先保留（UI-8A 用 holderRender 统一处理）。

## 任务 4：`newsnow-recommended-feed.tsx`、`news-list-hot.tsx`、`news-list-timeline.tsx`、`newsnow-card.tsx`

- feed `:189,277,327` 按通用规则换成 `content-card`；`:193,302` 眉题改 `kicker`；`:305` 标题 `text-2xl font-semibold` 改 `font-serif text-xl font-semibold`。这是版面级标题，按 README §3.1 允许用衬线。
- feed `:237` 内嵌块 → `rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]`。
- news-list-hot `:29-33` 排名徽章：去掉金、银、铜渐变，改为报纸式「编号」。
  - 前三名：`bg-[var(--foreground)] text-[var(--background)]`（反白墨块）。
  - 其余：`text-[var(--muted-foreground)]`，无底色。
  - 统一 `font-mono tabular-nums`；`:160` 的 `rounded-[8px]` → `rounded-sm`。
  - 参照 `style-preview.html` 中 Today「热点话题」的编号样式。
- news-list-hot `:182,187`、timeline `:164,169` 的 sky/amber 小标签按通用规则改。
- newsnow-card `:1400-1403` 的 `bg-white/25|40 dark:bg-black/20 backdrop-blur-*` 三元 → 两侧都改成 `bg-transparent`（外层已是纸面卡片），删除 blur。
- newsnow-card `:90` 的 `gray: "bg-zinc-400"` → `"bg-slate-400"`（随 UI-8A 色阶变暖）。

## 任务 5：`newsnow/[column]/page.tsx` 去光斑

- `:213-224` 删除 `frameStyle` 和两个 radial-gradient；`frameClass` 保留，所有 `style={frameStyle}` 删掉。删除后如果 `isDark`/`useTheme` 不再被使用，一并删除对应的 import 和变量。
- `:244` `subTitle` 中硬编码的「无法获取新闻源数据，请稍后重试」→ `t()`。
- 删掉光斑后，若 `--aura-color-1/2` 在全仓（`grep -rn "aura-color" apps/web --include=*.ts* --include=*.css`）只剩 `lib/aura-theme-tokens.ts` 和 `globals.css` 定义，保持不动，在报告中记录。

## 任务 6：`news-hub/page.tsx` 入口卡重做（亮色可读性 bug）

**现状**：`pillars` 数组每项带 `tone`（霓虹渐变 + 浅字），标题、描述、cta 是中文字面量。

**改法**：

- `pillars` 删除 `tone` 字段；title/description/cta 改为 i18n key（`newsHub.pillars.newsnow.title` 等，zh 照抄原文；en 自行翻译：NewsNow live board / Items deep reads / Events timeline）。组件内用 `t()` 渲染。
- 卡片改为报纸「三栏导读」：

```tsx
<section className="grid grid-cols-1 gap-0 border-t-2 border-[var(--foreground)] md:grid-cols-3">
  {pillars.map((pillar, index) => (
    <article
      key={pillar.href}
      className={
        index === 0
          ? "flex flex-col gap-2 py-5 md:pr-6"
          : "flex flex-col gap-2 border-t border-[var(--border)] py-5 md:border-l md:border-t-0 md:px-6"
      }
    >
      <span className="kicker">{String(index + 1).padStart(2, "0")}</span>
      <h2 className="font-serif text-lg font-semibold text-[var(--foreground)]">{t(pillar.titleKey)}</h2>
      <p className="text-sm leading-6 text-[var(--muted-foreground)]">{t(pillar.descriptionKey)}</p>
      <Link href={pillar.href} className="mt-auto text-sm font-medium text-[var(--primary)] hover:underline">
        {t(pillar.ctaKey)} →
      </Link>
    </article>
  ))}
</section>
```

- 如果 `page.tsx` 是 server component 不能用 `useTranslation`，就把这个 section 抽成同目录的 `news-hub-pillars.tsx`（`"use client"`），参照已有 `NewsHubPageHeader` 的做法。

**验收**：亮色、暗色下三栏文字都清晰；顶部是一条 2px 墨线；手机上三栏纵向堆叠，以发丝线分隔。

## 任务 7（有余力再做，最多 150 行改动，超出就停下列清单）：newsnow 硬编码中文 i18n

- 范围仅限 `newsnow/` 目录，key 统一放在 `newsnow.*` 下（zh.json 已有 `"newsnow": {` 对象，在里面追加）。
- 优先级：用户可见的按钮、提示、空态 > tooltip > 日志、注释（注释不改）。
- 做不完的在报告中按文件列出剩余条数。

---

## 禁止事项

- README §4 全部通用约束。
- 不改 newsnow 的数据请求、store、拖拽排序逻辑（`newsnow-dnd-grid.tsx` 只允许改 className）。
- 不改 `globals.css`（UI-8C 负责，包括 `.search-feedback-pill` 系列）。
- 不改 `lib/chart-theme-tokens.ts`、`tailwind.config.ts`、`providers.tsx`（UI-8A 负责）。

## 自主优化授权

`newsnow/` 和 `news-hub/` 目录内同类的玻璃、渐变、zinc 写法可以按通用规则继续清理，在报告中列出。不得改其它目录。

## 测试

- 已有 `newsnow` 测试必须仍然通过。若测试按旧中文文案查询元素，改成按新的 i18n 文案（测试环境的 i18n 实际用 zh 还是 key，以现有测试写法为准），不要删测试。
- 为 news-hub 三栏新增一个行为测试 `news-hub-pillars.test.tsx`（若已抽组件）：断言渲染 3 个 heading level 2，3 个链接的 href 分别为原来的三个路由。加入 `vitest.config.ts` 的 coverage.include。

## 验证与提交

按 README §5 执行。建议提交：

- `🐛 fix(web): FE-UI 批8B 修复 NewsNow 搜索弹窗与候选卡亮色不可见`
- `💄 style(web): FE-UI 批8B NewsNow 去玻璃与霓虹，News Hub 改三栏导读`
- （若做了任务 7）`🌐 i18n(web): FE-UI 批8B NewsNow 硬编码文案国际化`

## 人工冒烟清单

| 页面 | 亮色 | 暗色 | 375 / 1280 | 看什么 |
|---|---|---|---|---|
| `/newsnow/hottest` | ✓ | ✓ | ✓ | 头部无毛玻璃；候选块有边框；排名编号是墨块 |
| `/newsnow/hottest` 打开搜索 | ✓ | ✓ | ✓ | 亮色下弹窗为纸面白底，窄屏不溢出 |
| `/newsnow/<任一栏目>` | ✓ | ✓ |  | 页面顶部无彩色光斑 |
| `/news-hub` | ✓ | ✓ | ✓ | 三栏文字可读，2px 墨线，窄屏堆叠 |
