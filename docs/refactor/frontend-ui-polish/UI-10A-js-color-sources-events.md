# FE-UI 批10A：JS 色源与事件列表去玻璃（`lib/*-tokens.ts`、`hooks/use-chart-theme.ts`、`app/(app)/events/**`、图谱画布）

> **一句话目标**：前 9 批的扫描只看了 `.tsx` 和 CSS，漏掉了写在 `.ts` 里、以 JS 对象形式传给 `style` / echarts / cytoscape / antd Progress 的颜色和表面样式。其中最严重的是 **`/events` 列表每一行**：圆角 18、`backdrop-filter: blur(18px)`、径向加线性渐变、两层大阴影，是全站最后一块完整的玻璃拟态。另外，图谱节点色、压力状态色、情感色仍是 Tailwind / antd v4 的高饱和默认色（`#2563eb`、`#ff4d4f`、`#1677ff`、`#16a34a`），与纸墨色板冲突。
>
> **依赖**：UI-9 全部合入。可与 UI-10B、UI-10C 并行。本批只改下面「文件范围」列出的文件。
>
> **开工前必读**：README §3.2（色板）、§3.5、§4、§5、§7。所有颜色值本文已给出，**照抄，不要自己调色**。

## 文件范围

- `apps/web/lib/graph-tokens.ts`
- `apps/web/lib/status-tokens.ts`
- `apps/web/hooks/use-chart-theme.ts`
- `apps/web/app/(app)/events/components/event-visuals.ts`
- `apps/web/app/(app)/events/components/event-signal-card.tsx`
- `apps/web/app/(app)/events/events-content.tsx`
- `apps/web/app/(app)/events/[id]/event-detail.tsx`
- `apps/web/app/(app)/events/event-details-drawer.tsx`
- `apps/web/app/(app)/knowledge-graph/knowledge-graph-canvas.tsx`
- `apps/web/app/(app)/alerts/entity-association-evidence.tsx`（只改 `:155` 一行）

---

## A1 事件列表行去玻璃（最高优先）

### `events/components/event-visuals.ts`

**现状**：`resolveEventRowSurface()` 返回圆角 18、`backdropFilter: 'blur(18px)'`、`radial-gradient + linear-gradient` 背景、`LIGHT_ROW_SHADOW` / `DARK_ROW_SHADOW` 两层大阴影、`padding: '18px 20px'`；未来事件是青绿渐变。`resolveEventMetricSurface()` 同样带圆角 14、blur 和阴影，热度是粉红渐变，可信度是「红→黄→绿」三色渐变进度条。

**改法**：整份文件按下面重写，**导出的函数名、参数和返回类型不变**（调用方不用改签名）。

```ts
import type { CSSProperties } from 'react';

export type EventMetricTone = 'heat' | 'credibility';

export interface EventMetricSurface {
  containerStyle: CSSProperties;
  strokeColor: string;
  trailColor: string;
}

export interface EventRowSurfaceOptions {
  heatPercent: number;
  isDark: boolean;
  isFutureEvent: boolean;
}

/**
 * 事件指标小块：surface-inset 同款底色，不要阴影、模糊、渐变。
 * 热度用朱红（--destructive），可信度用墨蓝（--primary），单色进度条。
 * canvas / antd Progress 的 strokeColor 不解析 var()，所以写字面量，值与 globals.css 的 token 一致。
 */
export function resolveEventMetricSurface(
  tone: EventMetricTone,
  isDark: boolean,
): EventMetricSurface {
  const containerStyle: CSSProperties = {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-muted)',
  };
  if (tone === 'heat') {
    return {
      containerStyle,
      strokeColor: isDark ? '#f87171' : '#b91c1c',
      trailColor: isDark ? 'rgba(232, 228, 218, 0.12)' : '#e3dfd6',
    };
  }
  return {
    containerStyle,
    strokeColor: isDark ? '#8fb0ff' : '#1f3b7b',
    trailColor: isDark ? 'rgba(232, 228, 218, 0.12)' : '#e3dfd6',
  };
}

/**
 * 事件行：报纸条目样式——无卡片感，只有底部发丝线；
 * 热度用左侧 3px 色条表达（热度越高越接近朱红），未来事件用琥珀色条。
 */
export function resolveEventRowSurface({
  heatPercent,
  isDark,
  isFutureEvent,
}: EventRowSurfaceOptions): CSSProperties {
  const clampedHeat = Math.max(0, Math.min(heatPercent, 100));
  let barColor: string;
  if (isFutureEvent) {
    barColor = isDark ? '#f59e0b' : '#b45309';
  } else if (clampedHeat >= 70) {
    barColor = isDark ? '#f87171' : '#b91c1c';
  } else if (clampedHeat >= 40) {
    barColor = isDark ? '#9aa3af' : '#5a6270';
  } else {
    barColor = 'var(--border)';
  }
  return {
    borderRadius: 0,
    border: 'none',
    borderBottom: '1px solid var(--border)',
    borderLeft: `3px solid ${barColor}`,
    background: 'transparent',
    padding: '14px 16px',
  };
}

export function resolveFutureEventHintStyle(isDark: boolean): CSSProperties {
  return {
    color: isDark ? '#f59e0b' : '#b45309',
    fontWeight: 600,
  };
}
```

注意 `strokeColor` 的类型从 `Record<string, string>` 改成了 `string`。antd `Progress` 的 `strokeColor` 两种都接受，`event-signal-card.tsx` 不用改类型以外的代码；如果 TS 报错，就在 `event-signal-card.tsx` 里跟着改。

### `events/events-content.tsx:~603`

```ts
const rowStyle: CSSProperties = {
  ...resolveEventRowSurface({ heatPercent, isDark, isFutureEvent }),
  alignItems: "flex-start",
  marginBottom: 14
};
```

删掉 `marginBottom: 14`：行之间改用发丝线分隔，不再留空隙。List 外层如果有 `split={false}`，保持不变（分隔线由 rowStyle 的 `borderBottom` 提供）。

### `events/components/event-signal-card.tsx`

- `style={{ fontSize: 12, color: token.colorText }}` 的两个 Text：标签改 `className="text-xs text-muted-foreground"`，数值改 `className="font-mono text-xs"`，删掉 style。
- `minWidth = 160` 默认值保留。

**验收**：`grep -nE "blur|gradient|boxShadow|borderRadius: 1[0-9]" app/(app)/events/components/event-visuals.ts` 输出为空。

## A2 events 状态写法（§3.5-B）

`event-detail.tsx` 有 11 处 `<Empty`，`event-details-drawer.tsx` 有 8 处：

| 场景 | 改法 |
|---|---|
| 整页 / 整个抽屉「找不到事件」（如 `event-detail.tsx:~663` 的 `if (!event) return <Empty …/>`） | `<ChartEmptyState title={t("pages.events.detail.notFound")} description={…} />`；原来没有 description 的，就把原 description 文案作为 `description`，不传 `title` |
| 区块内「暂无 X」（列表、时间线、来源等） | `<ChartEmptyState presentation="banner" description={原文案} />` |
| `Table` 的 `locale={{ emptyText: <Empty …/> }}` | **保留不改**（表格内部空态由 antd 负责） |

`ChartEmptyState` 从 `@/components/chart-empty-state` 导入。改完后两个文件里的 `Empty` import 如果不再使用就删除。

## A3 图谱与状态色板对齐纸墨（只改值，不改导出名）

### `lib/graph-tokens.ts`

```ts
export const KNOWLEDGE_GRAPH_NODE_COLORS = {
  company: "#2f5597",      // 墨蓝
  industry: "#2f7d5b",     // 松绿
  person: "#c2410c",       // 赭橙
  policy: "#b91c1c",       // 朱红
  commodity: "#5b4b8a",    // 靛紫
  instrument: "#0f766e",   // 青绿
  organization: "#5a6270", // 石墨
} as const;

export const DEFAULT_NODE_COLOR = "#9b978e";

export const ENTITY_IMPACT_GRAPH_COLORS = {
  person: "#2f5597",
  organization: "#2f7d5b",
  stock: "#b45309",
  commodity: "#5b4b8a",
} as const;

export const ENTITY_IMPACT_GRAPH_DEFAULT_COLOR = "#5a6270";
```

把文件头注释中的「值与迁移前完全一致，收敛本身零视觉变化。」改成「FE-UI 批10A：对齐情报编辑台纸墨色板（README §3.2）。」。`KNOWLEDGE_GRAPH_LABEL_COLORS`、`WORKFLOW_CANVAS_GRID_COLOR` 不动。

### `lib/status-tokens.ts`

只替换下列值，键名和其它常量不动：

| 常量.键 | 原值 | 新值 |
|---|---|---|
| `CHART_STATE_TITLE.empty` / `.backfilling` | `#0f172a` | `#161b26` |
| `CHART_STATE_TITLE.delayed` | `#d97706` | `#b45309` |
| `CHART_STATE_TITLE.offline` | `#475569` | `#5a6270` |
| `CHART_STATE_TITLE.error` | `#dc2626` | `#b91c1c` |
| `CHART_BORDER_FALLBACK` | `rgba(148, 163, 184, 0.4)` | `rgba(155, 151, 142, 0.4)` |
| `CHART_FILL_FALLBACK` | `rgba(148, 163, 184, 0.08)` | `rgba(155, 151, 142, 0.08)` |
| `CHART_TEXT_FALLBACK` | `#94a3b8` | `#9b978e` |
| `PRESSURE_STATUS_COLORS.critical` / `.warning` / `.normal` | `#ff4d4f` / `#faad14` / `#1677ff` | `#b91c1c` / `#b45309` / `#1f3b7b` |
| `SENTIMENT_COLORS.neutral` / `.positive` / `.negative` / `.gray` | `#94a3b8` / `#16a34a` / `#dc2626` / `#64748b` | `#9b978e` / `#1b9e77` / `#d95f02` / `#5a6270` |
| `RANGE_INDICATOR_COLORS.track` / `.range` / `.expected` / `.observed` | `#e2e8f0` / `#93c5fd` / `#0f172a` / `#dc2626` | `#e3dfd6` / `#9fb3d9` / `#161b26` / `#b91c1c` |
| `ALERT_LINE_COLORS.low` / `.medium` / `.high` | `#16a34a` / `#ea580c` / `#dc2626` | `#2f7d5b` / `#c2410c` / `#b91c1c` |

情感色用 `--bullish` / `--bearish` 的值（#1b9e77 / #d95f02），与全站涨跌色一致。

### `hooks/use-chart-theme.ts`

只改**不读 CSS 变量**的那几项（`getVar(...)` 的兜底值不用改）：

- 静态默认对象（约 `:30-41`）：`destructive: "#b91c1c"`、`accent: "#b45309"`、`foreground: "#5a6270"`、`border: "#e3dfd6"`、`grid: "rgba(22, 27, 38, 0.08)"`、`tooltipBg: "#161b26"`、`tooltipText: "#faf8f3"`、`secondary: "#f0ede6"`。
- 动态对象（约 `:70-72`）：`grid: isDark ? "rgba(232, 228, 218, 0.14)" : "rgba(22, 27, 38, 0.08)"`；`tooltipBg: isDark ? "rgba(13, 17, 23, 0.94)" : "#161b26"`；`tooltipText: isDark ? "#e8e4da" : "#faf8f3"`。

### `knowledge-graph/knowledge-graph-canvas.tsx`（cytoscape 样式，`:~100-160`）

- 节点 `"border-color": "#e2e8f0"` → `isDark ? "#3a414d" : "#faf8f3"`（节点描边与底色同色，形成「纸面切口」）。
- 边按置信度上色的三档：`#16a34a` → `#2f7d5b`，`#f59e0b` → `#b45309`，`#ef4444` → `#b91c1c`。
- 选中态 `"border-color": "#0f172a"` → `isDark ? "#e8e4da" : "#161b26"`；`"overlay-color": "#1d4ed8"` → `"#1f3b7b"`；另一处 `"overlay-color": "#0f172a"` → `"#161b26"`。
- 如果 `useMemo` / `useEffect` 的依赖数组里还没有 `isDark`，补上（`:184` 已经有就不用动）。

### `alerts/entity-association-evidence.tsx:155`

`strokeColor="#f97316"` → `strokeColor="#b45309"`。

---

## 禁止事项

- README §4。
- 不改导出名、函数签名（`strokeColor` 类型收窄是唯一例外）、调用方的数据逻辑。
- 不改 `CHART_SERIES_*`（批8A 已处理）和 `war-map-symbol-*.ts`（地图符号需要高区分度，保留）。

## 测试

- 已有测试必须通过。测试 mock 里的 `destructive: "#dc2626"` 是 mock 值，**不要改**。
- `events-content` 已有测试如果断言了行 style 的某个属性（例如 `borderRadius`），按新值更新断言。

## 验证与提交

- `💄 style(web): FE-UI 批10A 事件列表行与指标块去玻璃，改为发丝线加热度色条`
- `🎨 style(web): FE-UI 批10A 图谱、状态、情感与图表兜底色对齐纸墨色板`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/events` | 亮 + 暗 | ✓ | 行是发丝线分隔的报纸条目，左侧细色条，没有圆角、渐变、模糊；热度和可信度条是单色 |
| `/events/<id>`、事件抽屉 | 亮 | ✓ | 空区块是统一的空态提示 |
| `/knowledge-graph`、`/dashboard/knowledge-graph` | 亮 + 暗 | ✓ | 节点颜色是低饱和的墨蓝、松绿、赭橙，而不是亮蓝、亮橙 |
| `/alerts` 选中告警看范围条 | 亮 | ✓ | 范围条是纸色底轨 |
| 任意 echarts 图表悬停 | 亮 | ✓ | tooltip 是墨色底、纸色字 |
