# FE-UI 批2A：布局 bug 修复——外壳 · 内容页 · 登录

> 先读 [README](README.md) 的 §3 和 §4。
> 依赖：UI-0 已合入。可以和 UI-1、UI-2B 并行，改动的文件互不相交。
> 本批只修**具体的布局 bug**，不迁移页头（页头属于 UI-3A）。每项都写了「现状片段 → 改法 → 验收」，请照着执行。

## 必读文件

- `apps/web/app/(app)/components/shell.tsx`（全文）
- `apps/web/app/(app)/components/ticker-tape.tsx`、`notification-center.tsx`、`top-nav.tsx`、`command-bar.tsx`
- `apps/web/app/(app)/today/today-content.tsx`（全文 78 行）
- `apps/web/app/(app)/items/items-view.tsx`：864–880 行（props）、924 行起（组件签名）、2465–2480 行（根容器）
- `apps/web/app/(app)/alerts/alert-event-row.tsx`：150–200 行
- `apps/web/app/(app)/events/events-content.tsx`：515–560 行
- `apps/web/app/(auth)/login/page.tsx`：405–460 行；`invite/[token]/page.tsx`：40–65 行；`auth/sso/callback/page.tsx`：190–205 行
- `apps/web/app/(reader)/read/items/[id]/page.tsx`：355–365、445–470 行
- `apps/web/app/(app)/news-hub/page.tsx`、`app/(app)/welcome/page.tsx`：55–80 行

## 任务清单

### T1 · Today 栅格类未定义（P0）

**现状**（`today/today-content.tsx:44-58`）：
```tsx
      <div className="aura-bento-grid">
        <div className="lg:col-span-4">
          <BreakingAlerts />
        </div>
        <div className="col-span-2 space-y-4">
        ...
        <div className="col-span-2 space-y-4 h-full flex flex-col">
```
`aura-bento-grid` 在全仓任何 CSS 里都没有定义，所以 `col-span-*` 不生效，所有区块都纵向堆在一起。

**改法**：
```tsx
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-12">
          <BreakingAlerts />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-7">
          <Headlines />
          <UserDigestPanel />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-5">
          <HotTopics />
          <AuraBentoCard squish={false} className="flex min-h-viz-3xl flex-1 flex-col p-4">
            ...（内部不变，只把 ItemsView 加上 surface="none"，见 T2）
          </AuraBentoCard>
        </div>
      </div>
```
最外层 `space-y-6 pb-10` 改为 `flex flex-col gap-6 pb-10`。（Today 的整体头版设计在 UI-6，本批只让栅格生效。）

**验收**：≥1024px 宽时左右两栏（7/5）并排；窄屏时单栏。

### T2 · ItemsView 自带卡片外壳导致卡中卡（P0）

**现状**（`items/items-view.tsx:2470-2475`）：
```tsx
  const containerClassName = layoutState.isReaderPreset
    ? "content-card items-reader-shell"
    : "content-card";

  return (
    <div className={containerClassName} style={{ padding: "24px" }}>
```
ItemsView 有 4 个宿主：`/items`、Today（`today-content.tsx:62`，本身已在 AuraBentoCard 里）、RSS（`rss-content.tsx:740`）、Search（`search-content.tsx:948`）。只有 Today 是真正的「卡片套卡片 + 三层内边距」；其余宿主的 ItemsView 外面没有卡片，保持 card 即可。

**改法**：
1. 在 `ItemsViewProps`（`:864`）末尾加一个可选 prop：
   ```ts
     /** 外层表面：card=自带纸面卡片（独立页面默认）；none=无外壳，由宿主提供容器 */
     surface?: "card" | "none";
   ```
2. 组件签名的解构里加上 `surface = "card"`。
3. 根容器改为：
   ```tsx
   const surfaceClassName =
     surface === "none"
       ? ""
       : "content-card p-4 md:p-6";
   const containerClassName = layoutState.isReaderPreset
     ? `${surfaceClassName} items-reader-shell`.trim()
     : surfaceClassName;

   return (
     <div className={containerClassName || undefined}>
   ```
   也就是删掉 `style={{ padding: "24px" }}`。
4. 宿主处理（只有 Today 加 `surface="none"`）：
   - `today/today-content.tsx:62`：加 `surface="none"`
   - `search/search-content.tsx:948`：**不加**。Search 的 ItemsView 外面没有卡片，结果区必须保留自己的纸面卡片
   - `rss/rss-content.tsx:740` **不要传**。已核实：RSS 页里 ItemsView 直接挂在页面根 `Space` 下，与上方的配置卡片是兄弟节点，外面没有包卡片，所以保留 `card` 是正确的。
5. `items-reader-shell` 这个类可能依赖 `.content-card` 的样式。grep `globals.css` 中的 `.items-reader-shell`：如果它的规则里有 `padding` 或背景，并且在 `surface="none"` 下会出问题，就在报告里描述，不要改 CSS。

**验收**：`/items`、`/search`、`/rss` 外观不变（padding 改用 Tailwind 类）；Today 的信息流不再有第二层卡片边框。

### T3 · Shell 高度与无效滚动条类

**现状**（`components/shell.tsx:89-91`，函数 `useMainScrollbarClass`）：
```ts
  return "scrollbar-thin scrollbar-thumb-slate-200/80 hover:scrollbar-thumb-slate-300/90 scrollbar-track-transparent";
```
这些类依赖 `tailwind-scrollbar` 插件，而项目没装（`tailwind.config.ts` 里 `plugins: []`），所以完全不生效。

**改法**：
1. 改为 `return "rail-scrollbar";`。`.rail-scrollbar` 已在 `globals.css` 中定义，先 grep 确认它存在。
2. `shell.tsx:173`（`className="flex flex-col h-screen overflow-hidden"`）改为 `className="flex h-screen flex-col overflow-hidden supports-[height:100dvh]:h-[100dvh]"`。这样 iOS Safari 用动态视口高度，旧浏览器回退到 `h-screen`。
3. `globals.css:987-995` 的 `.items-filter-rail`：
   ```css
   max-height: calc(100vh - var(--top-nav-height, 4rem) - var(--ticker-height, 0px) - 32px);
   ```
   改为两行，后一行覆盖前一行，以支持 dvh：
   ```css
   max-height: calc(100vh - var(--top-nav-height, 4rem) - var(--ticker-height, 0px) - 48px);
   max-height: calc(100dvh - var(--top-nav-height, 4rem) - var(--ticker-height, 0px) - 48px);
   ```
   改成 48px 是因为 shell 在 md 及以上的上下 padding 合计是 48px（`p-6`）。

### T4 · 跑马灯改为「电讯条」（同时修暗色）

**现状**（`components/ticker-tape.tsx:109-143`）：容器是 `bg-white/85`，两侧渐隐用 `from-white`，文字是 `text-slate-500/700/400`。没有任何 `dark:` 变体，暗色下是一条白带。

**改法**（两个 return 分支都改）：
- 容器：`className="relative flex h-[var(--ticker-height)] w-full select-none items-center overflow-hidden border-b border-[var(--border)] bg-[var(--ticker-bg)] text-[var(--ticker-fg)]"`
- 左右渐隐：`from-white` 改为 `from-[var(--ticker-bg)]`（两处，左右各一）。
- 标签 `text-slate-500 font-semibold` 改为 `font-semibold uppercase tracking-wider text-[var(--ticker-muted)] text-[11px]`。
- 数值 `text-slate-700` 改为 `font-mono tabular-nums text-[var(--ticker-fg)]`。
- 单位和中性趋势 `text-slate-400` 改为 `text-[var(--ticker-muted)]`。
- 加载图标和消息里的 `text-slate-400` / `text-slate-500` 改为 `text-[var(--ticker-muted)]`；`text-red-600` 改为 `text-[var(--destructive)]`。在暗底上这个红可能偏暗；如果肉眼判断对比不足，改用 `text-red-300`，并在报告里注明。
- 涨跌色 `text-[var(--bullish)]` / `text-[var(--bearish)]` 保留。
- `<ArrowUpOutlined style={{fontSize: 10}}/>` 改为 `<ArrowUpOutlined className="text-[10px]" />`，Down 同理。

**验收**：亮色和暗色下都是一条深色窄条配浅色字，不再有白带。

### T5 · 通知中心弹层

**现状**（`components/notification-center.tsx:231`）：`<div style={{ width: 380 }}>`，在手机上会溢出。另外 `:291-298` 未读背景用的是 `"rgba(24,144,255,0.06)"`（antd v4 的蓝），`borderRadius: 4`。

**改法**：
- `:231` 改为 `<div className="w-[min(380px,calc(100vw-24px))]">`。
- `List.Item` 的 style 改用 className：
  ```tsx
  <List.Item
    key={item.id}
    className={`cursor-pointer rounded px-3 ${isUnread ? "bg-[var(--surface-muted)]" : ""}`}
    onClick={...}
  ```
  然后删掉 `style={{...}}`。如果 antd List.Item 自带的 padding 覆盖了 `px-3`，就保留 `style={{ paddingInline: 12 }}` 这一项。
- 文件里其他 `style={{ width: "100%", justifyContent: ... }}` 一类的 Space 布局可以改成 `className="flex w-full justify-between"`，这一项可选。

### T6 · 顶栏高度和命令栏宽度

1. `components/top-nav.tsx:100`：`className={\`relative flex h-16 shrink-0 ...` 中的 `h-16` 改为 `h-[var(--top-nav-height)]`。
2. 命令栏的最大宽度有两处在互相打架：
   - `top-nav.tsx:113`：`max-w-[640px]`（full 档）/ `max-w-[380px]`（其它档）。**以这里为准**。
   - `command-bar.tsx:145-146`：`max-w-[440px] ... lg:max-w-[560px] 2xl:max-w-[640px]`，聚焦时 `2xl:max-w-[700px]`。
   
   改法：在 `command-bar.tsx` 中删掉 `max-w-[440px]`、`lg:max-w-[560px]`、`2xl:max-w-[640px]` 和聚焦时的 `2xl:max-w-[700px]`，保留 `relative z-50 w-full min-w-0`。动画 `transition-[max-width,filter]` 只剩 filter 还有作用，改为 `transition-[filter]`。
   
   **验收**：命令栏宽度只受 top-nav 外层容器控制。

### T7 · news-hub 双重边距、welcome 嵌套 main

1. `news-hub/page.tsx:36`：`<PageContainer contentWidth="article" className="py-6 md:py-8">` 改为 `<PageContainer contentWidth="article" className="flex flex-col gap-6">`；同时删掉 header 上的 `mb-6`，统一由 gap 控制间距。（这个页面的暗色渐变头在 UI-3A 中会换成 PageHeader，本批不动。）
2. `welcome/page.tsx:60-64`：
   ```tsx
   <main id="welcome-main" className="mx-auto flex w-full max-w-5xl flex-col gap-8" aria-labelledby="welcome-title">
   ```
   shell 里已经有一个 `<main>`，这里又嵌套了一个，这是 a11y 错误。把它改为 `<section ... >`，保留 `id` 和 `aria-labelledby`；`max-w-5xl` 保留，因为欢迎页刻意做窄。闭合标签 `</main>` 也要同步改成 `</section>`。

### T8 · 告警行暗色白块（P0）

**现状**（`alerts/alert-event-row.tsx:174-179`）：
```tsx
            <div
              className="rounded-lg border p-3 transition-colors"
              style={{
                borderColor: isSelected ? "#93c5fd" : "#e2e8f0",
                background: isSelected ? "rgba(239,246,255,0.8)" : "#fff",
              }}
            >
```

**改法**：
```tsx
            <div
              className={`rounded border p-3 transition-colors ${
                isSelected
                  ? "border-[var(--primary)] bg-[var(--surface-muted)]"
                  : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]"
              }`}
            >
```
**测试**：`alerts` 目录下已有测试，并在 coverage.include 中。检查是否有测试断言了这个行内 style（比如 `toHaveStyle({ background: ... })`）：如果有，改成断言 `aria-selected` 或其它用户可见行为；如果没有对应语义，就删掉这条样式断言，并在报告里说明。

### T9 · 事件页错误态与空态同时出现

**现状**（`events/events-content.tsx:527-554`）：`{error ? <Typography.Text type="danger">...</Typography.Text> : null}` 之后，紧跟一个独立的三元：`loading ? Skeleton : sortedEvents.length === 0 ? <Empty>…去配置…</Empty> : <List>`。请求出错时 `sortedEvents` 为空，于是错误文字和「暂无事件，去配置」会同时显示。

**改法**：把错误分支并入同一个三元，并改用统一的错误横幅：
```tsx
          {error && !resolvedData ? (
            <RequestErrorBanner error={error} onRetry={() => void refetch()} actionLoading={loading} />
            {/* props 已核实：error / onRetry / actionLoading / showCachedDataHint / presentation */}
          ) : loading && !resolvedData ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : sortedEvents.length === 0 ? (
            <Empty ...>...</Empty>
          ) : (
            <List ... />
          )}
```
- 「有缓存数据但刷新失败」（`error && resolvedData`）这种情况：在三元表达式**之前**单独渲染 `{error && resolvedData ? <RequestErrorBanner error={error} onRetry={() => void refetch()} showCachedDataHint /> : null}`，列表照常显示。
- 要 import `RequestErrorBanner`（`@/components/request-error-banner`）。原来那段 `Typography.Text type="danger"` 删掉；如果 `Typography` 变成未使用的 import，也一并删掉。

**验收**：断网时只看到错误和重试，不出现「去配置」按钮。

### T10 · 登录、邀请、SSO

1. `login/page.tsx:419-433` 的两个硬编码英文按钮 `Register`、`Forgot password?`：
   - 新增 i18n key：`auth.login.registerLink`（「注册账号」/ "Create account"）、`auth.login.forgotLink`（「忘记密码？」/ "Forgot password?"）。先 grep 一下 zh.json 的 `auth.register` / `auth.forgot` 下是否已有可复用的 key，有就复用。
   - 外层 `<div style={{ marginTop: "0.5rem" }}>` 改为 `<div className="mt-2 flex flex-wrap gap-3">`；按钮上的 `style={{ paddingInline: 0, marginLeft: 12 }}` 改为 `className="!px-0"`。
2. `login/page.tsx:435`：`<div style={{ marginTop: "1.5rem" }}>` 包裹了 sessionExpired / logoutFailed 等 Alert，即使没有任何 Alert 也会留出 24px 空白。改为：
   ```tsx
   {sessionExpired || logoutFailed /* 以及该 div 内其它条件，逐个读出来写全 */ ? (
     <div className="mt-6 flex flex-col gap-3">...</div>
   ) : null}
   ```
   内部 Alert 上的 `style={{ marginTop: "0.75rem" }}` 删掉，由 gap 控制。**一定要先把这个 div 内所有条件渲染的 Alert 都读出来**，组合条件一个都不能漏。
3. `login/page.tsx:415`：`<Title level={3} style={{ marginBottom: "0.5rem" }}>` 改为 `<Title level={3} className="!mb-2 font-serif">`。register、forgot、reset 三个页面的 Title 也统一加 `className="!mb-2 font-serif"`。
4. `invite/[token]/page.tsx:49-51`，加载态改为 `<div className="auth-card flex min-h-[200px] items-center justify-center"><Spin /></div>`；`:58` 的 `Accept invitation` 改为 i18n key `auth.invite.title`（「接受邀请」/ "Accept invitation"）。
5. `auth/sso/callback/page.tsx:198` 的 `Single sign-on` 改为 `auth.sso.title`（「单点登录」/ "Single sign-on"）。这几个文件如果还没有 `useTranslation`，就补上（它们都是客户端组件，先确认文件顶部有 `"use client"`）。
6. `globals.css` 的 `.auth-layout`（`:1994`）：`min-height: 100vh;` 后面追加一行 `min-height: 100dvh;`；再加一条媒体查询：
   ```css
   @media (max-width: 480px) {
     .auth-layout { padding: 16px; }
     .auth-card { padding: 20px; }
   }
   ```

### T11 · Reader 阅读页

1. `read/items/[id]/page.tsx:360`：`<div className="min-h-screen bg-[#fafafa]">` 改为 `<div className="min-h-screen bg-[var(--background)]">`，避免暗色模式下加载时闪白。
2. `:451`：`<div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-6">` 改为 `... flex flex-wrap items-center gap-x-6 gap-y-3`，防止 375px 宽时溢出。

## 禁止事项

- 不要改任何页面的页头（UI-3A 负责）。
- 不要动 ItemsView 的数据、筛选和 URL 状态逻辑，T2 只动根容器。
- 不要改 `shell.tsx` 中宽度白名单相关的函数（`useContainerClass` / `useContentPaddingClass`）。

## 自主优化授权

在本批列出的文件里，可以把 `style={{ margin...}}`、`style={{ display: "flex", gap: N }}` 这类纯布局的行内样式改成对应的 Tailwind 类，前提是语义完全等价，并在报告里列出。`items-view.tsx` 体量很大（2758 行），**只允许改 T2 涉及的根容器附近**。

## 测试

- T8：按要求调整已有测试。
- 新增 `apps/web/app/(app)/events/events-content.test.tsx` 不是必须的：mock 成本高，可以跳过，但要在报告里写明「T9 由人工冒烟覆盖」。
- 现有 `shell.test.tsx`、`top-nav.test.tsx`、`notification-center.test.tsx` 必须通过。如果它们断言了被改掉的类名或 style（例如 `h-16`、`width: 380`），就改成断言用户可见行为，或者同步更新断言，并在报告里说明。

## 验证与提交

按 README §5 执行。commit 示例：
`🐛 fix(web): FE-UI 批2A 修复 Today 栅格失效、ItemsView 卡中卡、告警行暗色白块与外壳 dvh/电讯条`

## 人工冒烟清单

| 页面 | 宽度 / 主题 | 看什么 |
|---|---|---|
| `/today` | 1280 亮 | 左右两栏并排；信息流只有一层卡片 |
| `/search`（items 模式） | 768 亮 | 结果区仍是一张纸面卡片，内边距正常 |
| `/alerts` | 1280 暗 | 告警行是深色纸面；选中行是墨蓝边框 |
| 顶栏 | 1920 亮/暗 | 电讯条是深色窄条，文字清晰 |
| 通知铃铛 | 375 | 弹层不超出屏幕 |
| `/events` | 断网 | 只出现错误加重试，不出现「去配置」 |
| `/login` | 375 | 注册和忘记密码是中文；没有多余空白 |
| `/read/items/<id>` | 375 暗 | 加载时不闪白；工具栏会换行 |
