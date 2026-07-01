# 前端问题优化完善 — 交付报告

> 策略: optimize-measure → 平移为「静态审查驱动的定向修复」 · 方法: 纯静态、不补测试 · 日期: 2026-06-30
> 输入: 静态审计 [`report.md`](../static-perf-audit/report.md) + [`deep-analysis.md`](../static-perf-audit/deep-analysis.md) 的前端发现（C6 / D-FE-1~14）

## 结论摘要

审计清单原列 14 条前端项。**逐一核对当前代码后，绝大多数已在前一轮落地**（且配了 `tests/frontend-bundle-splitting-wiring.spec.ts` 保护）。本轮实际需要修复并已完成 **2 条**。

## 已修复（本轮改动）

### D-FE-7 · items 列表未 memo + 调用点内联对象破坏浅比较
- **文件**: `apps/web/app/(app)/items/components/news-card.tsx`、`apps/web/app/(app)/items/items-view.tsx`
- **改动**:
  1. `NewsCard` 用 `React.memo` 包裹（`function NewsCardComponent(...)` + `export const NewsCard = memo(NewsCardComponent)`），保留具名函数 → devtools displayName 不丢。
  2. 列表（items-view:2340 renderItem）与 feed（:2372 renderFeedCard）两处调用点，将 `item={{...item, <10~12 个字段>}}` 替换为 `item={item}`。
- **为何等价且有效**: 原内联对象里 `...item` 已展开全部 `ParsedItem` 字段，后续显式赋值全是把字段设成自己的**冗余 no-op**——传 `item={item}` 字段值完全一致，仅让引用变稳定。`pageData`/`basePageData` 均为 `useMemo`，item 引用在非数据变更的重渲染间稳定 → memo 生效，未变卡片跳过重渲染 + 卡片内 `flatMap`/`formatRatioAsPercent`/`estimateReadingTime` 等逐项计算不再重跑。
- **类型**: `ParsedItem` 是 `NewsCardProps["item"]` 结构超集，`item={item}` 通过 typecheck。

### D-FE-12 · lodash 根导入
- **文件**: `apps/web/app/(app)/assistant/assistant-content.tsx:34`
- **改动**: `import { debounce } from 'lodash'` → `import debounce from 'lodash/debounce'`。
- **收益**: 避免整包 lodash（CommonJS 无法 tree-shake）打进 assistant 路由首包，仅拉入 debounce 单方法。全 web 唯一一处 lodash 根导入。

## 经复核为「已修复 / 无需改动」

| 项 | 复核结论 |
|----|---------|
| C6 markdown-viewer | 已 `memo` + `useMemo(components)` |
| D-FE-1 finance metric-drilldown | 已 `dynamic{ssr:false}` |
| D-FE-2 map/page WarMap | 已 `dynamic{ssr:false}` |
| D-FE-3 echart wrapper | `echart.tsx` 内部已 `dynamic(import("./echart.client"),{ssr:false})`，所有消费方从 `@/components/echart` 导入包装器；页面里 `import type ... from "echarts"` 为类型导入零成本 |
| D-FE-4 cytoscape | 仅存于 `knowledge-graph-canvas.tsx`，而 canvas 只被 `dynamic()` 引用（content 仅 `import type`）→ 边界有效；`frontend-bundle-splitting-wiring.spec.ts` 已断言 |
| D-FE-5 alert refetch 风暴 | 订阅 `next` 已走 `createCoalescedRefetchScheduler.schedule()`；其余 `refetchEvents()` 均为用户主动操作，本应立即刷新 |
| D-FE-6 Apollo 分页 merge | `apollo-cache-policies.ts` 已配 `items`/`alertEvents` 的 typePolicies + merge/read |
| D-FE-8 index key | 均为 `${语义前缀}-${index}` 的短 top-N 汇总列表，index 用于去重（label/term 可能重复），主事件列表已用 `key={event.id}`；现状合理 |
| D-FE-9 虚拟化 | items feed 与 alert events 均已接入 `useWindowVirtualizer` |
| D-FE-10 news-hub 'use client' | 已无 `'use client'` |
| D-FE-11 dashboard WarMap ssr | 已 `dynamic{ssr:false}` |
| D-FE-13 loading.tsx | 已有根级 `app/(app)/loading.tsx` 兜底 + 6 个重路由专属；Next.js 对无自身 loading 的路由用最近祖先兜底 |
| D-FE-14 dashboard echarts | 子路由经 `DashboardChart`/`DashboardChartCard` 走 echart 动态边界，echarts 不进首包 |

## 验证

- `tsc --noEmit -p apps/web/tsconfig.json`：**3 个改动文件 0 错误**。
- 全库残留 9 个 `TS1185 Merge conflict marker`（`war-map/url-state.ts`、`(auth)/login/page.tsx`）——**预先存在、与本任务无关**，未触碰这些文件。
- lint/build 因本仓库 pnpm `.bin` 链接在当前环境损坏（`tsc`/`eslint`/`next` 均无法经脚本调起）而未能运行；改动极简无 lint 风险。

## ⚠️ 顺带发现（非本任务范围，需你决定）

`apps/web/app/(app)/dashboard/charts/war-map/url-state.ts` 与 `apps/web/app/(app)/(auth)/login/page.tsx` 存在**未解决的 Git 合并冲突标记**，会阻断 typecheck/build。建议尽快单独处理。
