# FE-UI 批7（可选）：antd SSR 样式注册，消除首屏无样式闪烁

> ⚠️ **执行前必须有用户的明确确认。** 本批要**新增一个依赖**并更新 `pnpm-lock.yaml`，违反 README §4.2「不新增依赖」的默认约束。没有用户确认就不要开工。
> 依赖：无，可以在任意时间点执行。

## 问题

`apps/web/package.json` 里没有 `@ant-design/nextjs-registry`，`app/layout.tsx` 也没有用 `AntdRegistry` 或 cssinjs 的 `StyleProvider`。这导致服务端渲染出来的 HTML 里，antd 组件没有样式。首屏加载时，按钮、输入框、表格会先以无样式状态闪现一下，客户端 hydrate 之后才恢复正常。项目用的是 Next 15 App Router，这是 antd 官方给出的标准解法。

## 任务

1. 在仓库根目录执行 `pnpm --filter @modular/web add @ant-design/nextjs-registry`。选择与 antd 5.28 兼容的最新 1.x 版本，并确认 `pnpm-lock.yaml` 已随之更新。
2. 修改 `apps/web/app/layout.tsx`：
   ```tsx
   import { AntdRegistry } from "@ant-design/nextjs-registry";
   …
         <body className="font-sans bg-background text-foreground antialiased">
           <AntdRegistry>
             <ThemeProvider>
               …原内容不变…
             </ThemeProvider>
           </AntdRegistry>
         </body>
   ```
3. 检查 `app/providers.tsx` 里 `unstableSetRender` 等 React 19 兼容代码。如果其中有自定义的 cssinjs `StyleProvider`，就和 `AntdRegistry` 二选一，保留一个，并在报告里说明原因。
4. 根级 layout 的 `<body>` 上已经有 `bg-background`。`globals.css` 中 body 的背景色在 UI-0 已经去重，这里无需处理。

## 验证

- 按 README §5 执行 lint、typecheck、test，最终以 CI 为准，因为 CI 的 install 步骤会校验 lockfile。
- 人工冒烟：Chrome DevTools 里选「Disable cache」并把网络限速为「Slow 3G」，刷新 `/admin/quality`。首屏应当直接出现带样式的表格和按钮，不再先闪一下无样式的版本。

## 提交

`⚡️ perf(web): FE-UI 批7 引入 AntdRegistry 消除 antd 首屏无样式闪烁`。这次提交需要同时 stage `apps/web/package.json` 和 `pnpm-lock.yaml`。
