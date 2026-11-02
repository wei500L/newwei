# FE-UI 批13B：KPI 条统一、剩余冷色相收敛、助手页与市场脉搏细节

> **一句话目标**：精读告警、实体、dashboard、助手页后发现三类问题：
> 1. **KPI 有三种写法**：告警中心是 5 张独立小卡片（`alerts/alert-center-summary.tsx:78-120`），实体页是 4 张卡片（`entities/[id]/entity-intelligence-card.tsx:287-312`），crawl-frontier 是 `Row` 里一排裸 `Statistic`（`crawl-frontier-console.tsx:1673-1677`），search-telemetry 用的是 9E 定下的「一张卡 + 竖线分隔」。没有共享组件，所以每次都会再写出一种新的。
> 2. **还有约 180 处 Tailwind 原生冷色相**没有进纸墨色板：`amber` 79、`emerald` 43、`sky` 40、`rose` 34、`cyan` 12、`red` / `indigo` / `blue` 各 9、`violet` 6。主要集中在助手页（47 处）、系统健康指示（24）、战争地图图例（约 70）、事件归档（19）、指标下钻（12）。`slate` / `gray` 在批8A 已整体重映射为暖色，但这几个色相没有。
> 3. **零散细节**：
>    - 助手页选中的会话项还是 `shadow-[0_10px_30px…]` 大阴影 + `bg-white/55` 半透明底。
>    - 模型信息区是三个手写的彩色圆角胶囊。
>    - 市场脉搏的涨跌是 `font-black rounded-full` 药丸。
>    - 「数据不足」是粗斜体全大写字距加宽的写法。
>    - 外层已经有 `gap-6`，组件自己还写了 `mb-6`，间距叠成双倍。
>    - `text-secondary-foreground/30`、`/50` 两处不生效（已用本机 Tailwind 编译确认：var() 定义的具名颜色加透明度不会生成 CSS）。
>
> **依赖**：UI-12 全部合入。可与 UI-13A 并行（文件不相交）。分 4 次提交（B1 → B4）。
>
> **开工前必读**：README §3.2、§3.5、§4、§5、§7。所有色值本文已给出，**照抄**。

## 文件范围

- 新建 `apps/web/components/kpi-strip.tsx`、`apps/web/components/kpi-strip.test.tsx`
- `apps/web/app/(app)/alerts/alert-center-summary.tsx`
- `apps/web/app/(app)/entities/[id]/entity-intelligence-card.tsx`
- `apps/web/app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx`（只改 `:1673-1677` 一带的运行统计行）
- `apps/web/app/(app)/admin/search-telemetry/search-telemetry-content.tsx`（只改 KPI 区）
- `apps/web/tailwind.config.ts`
- `apps/web/app/(app)/assistant/assistant-content.tsx`
- `apps/web/app/(app)/dashboard/components/market-pulse.tsx`
- `apps/web/vitest.config.ts`（只追加 coverage.include）

---

## B1 新建 `components/kpi-strip.tsx`

```tsx
import type { ReactNode } from "react";

export type KpiTone = "default" | "bullish" | "bearish" | "warning" | "danger";

export interface KpiItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  suffix?: ReactNode;
  /** 数值下方的一行小字说明（可选） */
  hint?: ReactNode;
  tone?: KpiTone;
}

export interface KpiStripProps {
  items: KpiItem[];
  /** 为 true 时不带外层 content-card（放进已有卡片内部时使用） */
  bare?: boolean;
  className?: string;
}

const TONE_CLASS: Record<KpiTone, string> = {
  default: "text-[var(--foreground)]",
  bullish: "text-[var(--bullish)]",
  bearish: "text-[var(--bearish)]",
  warning: "text-[var(--accent)]",
  danger: "text-[var(--destructive)]",
};

/**
 * 指标条：一张卡、等宽数字、格子之间用发丝竖线分隔（README §3.5 / UI-9E 定下的 KPI 写法）。
 * 不用于带迷你图的指标（dashboard 的 MarketPulse 保持自己的实现）。
 */
export function KpiStrip({ items, bare = false, className }: KpiStripProps) {
  const outer = bare ? "" : "content-card p-4";
  return (
    <dl
      className={`m-0 grid grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-[repeat(auto-fit,minmax(140px,1fr))] ${outer} ${className ?? ""}`.trim()}
    >
      {items.map((item, index) => (
        <div
          key={item.key}
          className={`flex min-w-0 flex-col gap-1 ${index > 0 ? "md:border-l md:border-[var(--border)] md:pl-4" : ""}`}
        >
          <dt className="kicker m-0 truncate">{item.label}</dt>
          <dd className={`m-0 font-mono text-2xl font-semibold tabular-nums leading-tight ${TONE_CLASS[item.tone ?? "default"]}`}>
            {item.value}
            {item.suffix ? (
              <span className="ml-1 text-sm font-normal text-muted-foreground">{item.suffix}</span>
            ) : null}
          </dd>
          {item.hint ? <span className="text-xs text-muted-foreground">{item.hint}</span> : null}
        </div>
      ))}
    </dl>
  );
}
```

**测试 `components/kpi-strip.test.tsx`**（用 `test/render.tsx` 的 `renderWithProviders`）：

1. 传入 3 个 item，`getByText` 能找到每个 label 和 value；
2. `suffix="%"` 渲染在 value 旁边；
3. `bare` 为 true 时根节点没有 `content-card` 类（`container.querySelector(".content-card")` 为 null）。

把 `components/kpi-strip.tsx` 加进 `vitest.config.ts` 的 `coverage.include`（只追加一行）。

在 `docs/design-system.md` §9 页面原语一节末尾追加一小段：KpiStrip 的用途和一个最小示例（3 行代码以内）。

## B2 KPI 调用方迁移

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `alerts/alert-center-summary.tsx:78-120` | `Row` 里 5 个 `Col` + `Card size="small"` + `Statistic` | 整块换成 `<KpiStrip items={[…]} />`。5 项依次是 total、pending、confirmed、ignored、falsePositiveRate；falsePositiveRate 的 `value` 是 `falsePositivePercent ?? "--"`，`suffix` 在非 null 时为 `"%"`；pending > 0 时 `tone: "warning"`。删掉不再使用的 `Row` / `Col` / `Statistic` import |
| `entities/[id]/entity-intelligence-card.tsx:287-312` | `grid … xl:grid-cols-4` 里 4 张 `Card` + `Statistic` | `<KpiStrip items={[relationships, mentions, events, negativeRatio]} />`；negativeRatio 的 value 用原来的 `formatPercent(...)` |
| `admin/ops/crawl-frontier/crawl-frontier-console.tsx:~1673-1677` | `Row` 里 5 个 `<Col …><Statistic …/></Col>` | `<KpiStrip bare items={[…]} />`（它本来就在一张卡里面，所以用 `bare`）；failed > 0 时 `tone: "danger"` |
| `admin/search-telemetry/search-telemetry-content.tsx:~255-290` | 已是「一张卡 + `md:border-l` 分隔」的手写版 | 换成 `<KpiStrip>`，视觉不变，只是改用共享组件。原 `Statistic` 的 `loading` 属性：loading 时 value 传 `"—"` |

> `Statistic` 的 `loading` 骨架效果不再保留：数据加载中由外层 DataStateBoundary 负责，KPI 区不单独转圈。

## B3 剩余冷色相整体收敛（`tailwind.config.ts`）

和批8A 重映射 `slate` / `gray` 一样，在 `theme.extend.colors`（与 `slate` 同一层）**追加**下面几组色阶。这样约 180 处 `bg-emerald-50`、`text-sky-700`、`border-rose-200/80` 等写法会一次性变成纸墨色板里的对应色相，**不用逐文件改**。色阶都写 hex，所以 `/80` 这类透明度修饰仍然有效。

```ts
// FE-UI 批13B：剩余冷色相收敛到纸墨色板（README §3.2）。
// 同一色相族保持彼此可区分（战争地图图例依赖 sky / indigo / cyan / emerald / rose / violet 的区分度）。
sky: {      // 钢蓝：比墨蓝浅、偏青，与 indigo 区分
  50: '#f1f6f9', 100: '#dfeaf2', 200: '#bfd4e5', 300: '#93b6d2', 400: '#6593ba',
  500: '#42769f', 600: '#2f6189', 700: '#274f70', 800: '#22425c', 900: '#1d374c', 950: '#11222f',
},
blue: {     // 墨蓝（= --primary #1f3b7b 为 700）
  50: '#f2f5fa', 100: '#e3e9f4', 200: '#c5d1e8', 300: '#9fb3d9', 400: '#6f8cc4',
  500: '#4a6aa8', 600: '#2f5597', 700: '#1f3b7b', 800: '#1a3164', 900: '#15284f', 950: '#0e1a33',
},
indigo: {   // 与 blue 同族
  50: '#f2f5fa', 100: '#e3e9f4', 200: '#c5d1e8', 300: '#9fb3d9', 400: '#6f8cc4',
  500: '#4a6aa8', 600: '#2f5597', 700: '#1f3b7b', 800: '#1a3164', 900: '#15284f', 950: '#0e1a33',
},
emerald: {  // 松绿（600 = #2f7d5b，与 antd seed green 一致）
  50: '#f1f7f3', 100: '#ddeee3', 200: '#bcdcc8', 300: '#8fc3a3', 400: '#5ea67c',
  500: '#3d8a60', 600: '#2f7d5b', 700: '#256649', 800: '#1f523c', 900: '#1a4332', 950: '#0d251b',
},
green: {    // 与 emerald 同族
  50: '#f1f7f3', 100: '#ddeee3', 200: '#bcdcc8', 300: '#8fc3a3', 400: '#5ea67c',
  500: '#3d8a60', 600: '#2f7d5b', 700: '#256649', 800: '#1f523c', 900: '#1a4332', 950: '#0d251b',
},
rose: {     // 朱红（600 = --destructive #b91c1c）
  50: '#fbf3f1', 100: '#f6e2dd', 200: '#ecc3ba', 300: '#df988a', 400: '#cf6a57',
  500: '#c24433', 600: '#b91c1c', 700: '#9a1b17', 800: '#7f1d17', 900: '#6a1c17', 950: '#3b0c09',
},
red: {      // 与 rose 同族
  50: '#fbf3f1', 100: '#f6e2dd', 200: '#ecc3ba', 300: '#df988a', 400: '#cf6a57',
  500: '#c24433', 600: '#b91c1c', 700: '#9a1b17', 800: '#7f1d17', 900: '#6a1c17', 950: '#3b0c09',
},
cyan: {     // 青绿（600 = #0f766e，与 antd seed cyan 一致）
  50: '#f0f7f6', 100: '#d9ecea', 200: '#b3d8d4', 300: '#82beb8', 400: '#4f9f97',
  500: '#2f857c', 600: '#0f766e', 700: '#0f5f59', 800: '#114c48', 900: '#123f3c', 950: '#062321',
},
violet: {   // 靛紫（600 = #5b4b8a，与 antd seed purple 一致）
  50: '#f5f3f9', 100: '#e9e5f2', 200: '#d3cbe5', 300: '#b4a8d2', 400: '#8f7fb8',
  500: '#73639f', 600: '#5b4b8a', 700: '#4b3e72', 800: '#3e345d', 900: '#342c4d', 950: '#1f1a2f',
},
```

**`amber` / `orange` 不重映射**：Tailwind 的 `amber-700` 恰好就是 `--accent`（#b45309），本身已经在色板里。

**注意**：
- 先确认 `tailwind.config.ts` 的 `colors` 写在 `theme.extend.colors` 还是 `theme.colors`，**和 slate 放在同一个对象里**。
- 改完 grep 一下 `.ts` 文件里有没有用这些类名拼字符串（`grep -rn "emerald-\|sky-\|rose-" apps/web/lib`），它们同样会生效，属于预期内。
- 改完后在报告里列出受影响最多的 5 个文件，提醒冒烟时重点看。

## B4 助手页与市场脉搏细节

### `assistant/assistant-content.tsx`

| 行（快照） | 现状 | 改法 |
|---|---|---|
| `:1020-1023` 会话项 | 选中态 `border-sky-200/80 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.12)] dark:… dark:shadow-[…]`；未选中态 `bg-white/55 hover:bg-white/80 dark:bg-slate-900/45 …` | 选中态：`border-[var(--border-strong)] bg-[var(--surface)]`（无阴影）；未选中态：`border-transparent bg-transparent hover:bg-slate-100/70 dark:hover:bg-slate-800/60` |
| `:1059`、`:1204` 状态胶囊 + `:252-265` `getStatusChipClass` | 手写 `rounded-full ring-1` 彩色胶囊 | 改用 antd `<Tag>`：`getStatusChipClass` 改为返回 Tag color：pending → `undefined`、running → `"processing"`、completed → `"success"`、failed → `"error"`（函数改名 `getStatusTagColor`，返回类型 `TagProps["color"]`）；两处 `<span className={…}>{getStatusLabel(…)}</span>` 换成 `<Tag color={getStatusTagColor(…)} className="m-0">{getStatusLabel(…)}</Tag>` |
| `:1063` 类型胶囊、`:1067` blocked 胶囊（`:1210` 同） | 手写 slate / amber 胶囊 | 类型：`<Tag className="m-0">`；blocked：`<Tag color="warning" className="m-0">` |
| `:267-279` `getStatusRailClass` | 左侧 1px 状态条 sky / emerald / rose | 保留函数，返回值改成 token：running `bg-[var(--primary)]`、completed `bg-[var(--bullish)]`、failed `bg-[var(--destructive)]`、pending / default `bg-slate-300 dark:bg-slate-600` |
| `:1271` | `<Spin size="small" className="text-sky-600" />` | 删掉 `className` |
| `:1265` 机器人头像 | `bg-slate-900 text-white dark:bg-slate-700` | 保留（墨色头像符合风格） |
| `:1266` | `text-[15px] font-bold` | `text-sm font-semibold` |
| `:1286-1310` 模型信息区 | kicker 是手写 `text-[11px] font-bold uppercase tracking-[0.2em]`；下面三个 `rounded-lg bg-white … ring-1` 彩色胶囊 | kicker 改 `<p className="kicker m-0">`；三个胶囊改成一行元信息：`<p className="m-0 mt-2 font-mono text-xs text-muted-foreground">{[模型 · x, 预测模型 · y, 模型服务 · 已用/未用].filter(Boolean).join("  ·  ")}</p>`（用原来的 i18n label 拼接） |
| 其余 `text-sky-*` / `text-emerald-*` / `text-amber-*`（`:825-826`、`:1358`、`:1529` 等） | 文字强调色 | B3 的色阶重映射之后会自动变成纸墨色相，**不用逐个改** |

### `dashboard/components/market-pulse.tsx`

| 行（快照） | 现状 | 改法 |
|---|---|---|
| `:88-91` 数值闪烁底色 | `bg-emerald-500/10` / `bg-orange-500/10` | 保留（B3 之后 emerald 自动收敛）；`orange` 改 `bg-[#d95f02]/10`（= --bearish） |
| `:95` | 无数据时 `text-secondary-foreground/30`（不生效） | `text-muted-foreground` |
| `:96` | 单位 `text-secondary-foreground/50`（不生效） | `text-muted-foreground` |
| `:~452` 涨跌药丸 | `text-[11px] font-black px-2 py-0.5 rounded-full … border` | `inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-xs font-medium`（去掉 `border`，保留 `trendClass` 的颜色） |
| `:~465` 「数据不足」 | `text-[11px] font-bold uppercase tracking-widest text-muted-foreground italic` | `text-xs text-muted-foreground` |
| `:324`、`:338`、`:364` | 组件根节点带 `mb-6`，外层父级已有 `gap-6` | 删掉三处 `mb-6` |

---

## 禁止事项

- README §4。
- 不改告警、实体、助手的请求和状态逻辑；`getStatusLabel` 等文案函数不改。
- B3 只追加色阶，**不要**动 `slate` / `gray` 和其它已有配置。

## 测试

- 已有测试必须通过。断言了 `Statistic` 结构（如 `.ant-statistic-content-value`）的告警 / 实体测试，改为按 label 和 value 文本断言。
- 助手页测试如果按旧胶囊 className 断言，改为按 Tag 文本断言。
- 新增：B1 的 `kpi-strip.test.tsx`（3 个用例）。

## 验证与提交

- `✨ feat(web): FE-UI 批13B 新增 KpiStrip 指标条原语`
- `💄 style(web): FE-UI 批13B 告警、实体、抓取前沿、搜索遥测 KPI 统一为 KpiStrip`
- `🎨 style(web): FE-UI 批13B sky/blue/indigo/emerald/green/rose/red/cyan/violet 色阶收敛到纸墨色板`
- `💄 style(web): FE-UI 批13B 助手页会话与模型信息、市场脉搏涨跌与间距细节`

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/alerts` | 亮 + 暗 | ✓ | 顶部是一张卡里的 5 格指标，竖线分隔，等宽数字 |
| `/entities/<id>` | 亮 | ✓ | 4 格指标条，与告警页样式一致 |
| `/assistant` | 亮 + 暗 | ✓ | 选中会话没有浮起阴影；状态是 antd Tag；模型信息是一行小字 |
| `/dashboard` | 亮 + 暗 | ✓ | KPI 涨跌是小方角标；KPI 与下方区块的间距和其它区块一致（没有双倍空白） |
| `/map`、dashboard 战争地图图例 | 亮 + 暗 | ✓ | 图例各类颜色仍然**能互相区分**，只是整体变沉稳 |
| `/events-archive`、导航栏系统健康指示 | 亮 | ✓ | 原来的亮青、亮绿、亮红变成墨蓝、松绿、朱红 |
