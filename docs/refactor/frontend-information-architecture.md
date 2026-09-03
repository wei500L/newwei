# 前端信息架构重构方案（Frontend IA）

> 生成时间：2026-09-03 · 基线 commit `edf0c8cf`
> 原则：**只重组架构与边界，不动业务能力**；App Shell 先行 + 代表页试点，每步可回滚；前后端不同 PR 推倒。

---

## 1. 现状盘点（证据）

### 1.1 路由与页面（共 72 路由）

| 分组 | 数量 | 明细 |
|---|---|---|
| `(app)` 业务台 | 56 | admin 20（orgs/logs/errors/audit-logs/dashboards/quality/search-telemetry/storage/system/settings/[section] + ops 下 crawl-tasks(+[taskId])/crawl-monitor/crawl-templates/crawl-frontier/news-sources + alerts）· dashboard 8（总览+economic-short/medium/long+economic-alert+key-monitor+livelihood-prices+military-alert）· finance 4 · 业务 24（today/news-hub/newsnow(+[column])/topics/events(+[id])/events-archive/rss/items(+[id])/search/map/situation-monitor/knowledge-graph/analysis/assistant/alerts/subscriptions/profile/settings(+security/system)/welcome/crawl(+[taskId])/entities/[id]） |
| `(auth)` | 6 | login/register/forgot/reset/invite/[token]/auth/sso/callback |
| `(portal)` 公共门户 | 5 | /（首页）· channel/[topic] · [topic] · article/[id] · article/[slug]（无鉴权） |
| `(reader)` | 1 | read/items/[id] |
| API routes | 9 | — |

### 1.2 Shell 结构问题

- **ActionRail**（`app/(app)/components/action-rail.tsx`）：17 个主项 + dashboard + 2 管理项**平铺无分组**；3 个导航项图标重复
- **TopNav 589 行**（`top-nav.tsx`）：ticker 跑马灯、品牌、命令面板、DEFCON 徽标、抓取按钮、通知中心、组织切换、主题、用户——9 种职责挤在一个组件
- **宽度白名单**（`shell.tsx:33-44`）：wide=1920 / fluid / edge-to-edge，默认 1440；newsnow 页**自加 1760px 特例**——页面私自介入布局策略
- 死代码：`store/sidebar.ts`（zustand，无消费方）

### 1.3 数据层（四套并存）

| 方式 | 文件数 | 用途 |
|---|---|---|
| Apollo（GraphQL） | 39 | 列表/详情/订阅 |
| TanStack Query | 16 | REST 轮询/变更 |
| 统一 axios `apiClient` | ~40 | REST |
| 直接 `fetch` | 10 | 绕过统一客户端（错误处理/trace 头不一致） |
| Socket.IO 客户端 | 9 | 6 个 namespace 的实时事件 |
| zustand | 8 store | 本地 UI 状态（1 个死） |

### 1.4 交互反馈不一致

- **URL 状态**：items/search/events 页过滤器全量 URL 同步（可分享/可恢复）；**alert-center 自成内存态**（FE-01）
- **巨型组件**（行数）：war-map 4420 · alert-center 4074 · task-detail 3822 · CreateCrawlTaskDrawer 3147 · realtime-signals 面板 3014 · crawl-monitor 2993 · quality 2875——超出单组件可维护边界一个量级
- globals.css 2120 行（分区见勘察：主题变量/滚动条/地图覆写/图表动画…混杂）
- 测试：vitest coverage.include 仅 3 个已测文件——覆盖率数字失真（FE-03）

## 2. 目标信息架构（17 项 → 5 组）

按任务规范将现有平铺导航归入五个语义组（**所有现有路由保留**，仅重组导航层级与入口）：

| 组 | 现有路由 | 组内定位 |
|---|---|---|
| **今日与信息流** | /today · /news-hub · /newsnow · /rss · /search* | 每日简报与持续信息摄入。*search 同时升格为全局能力（命令面板已有入口），组内保留作兜底 |
| **事件与态势** | /dashboard · /events · /events-archive · /topics · /situation-monitor · /map · /finance | 态势总览（dashboard 总览+8 个子面板、finance 4 页）与事件工作流（事件列表/详情/档案/专题） |
| **分析与研究** | /analysis · /assistant · /knowledge-graph · /entities/[id] | 深度分析工作台、AI 助手、知识图谱与实体页 |
| **个人工作台** | /alerts · /subscriptions · /profile · /settings* | 个人告警中心、订阅管理、个人资料与偏好。*settings/system 属管理面（下组） |
| **管理** | /admin/*（20 页）· /settings/system · /crawl* | 运维与平台管理（含抓取任务管理；crawl/[taskId] 详情从任务列表进入，不占主导航） |

调整说明：
1. ActionRail 由 20 个平铺项变为 **5 组 + 组内项**（rail 高度下降，图标去重后语义唯一）
2. `/welcome`（onboarding）与 `/read`（沉浸阅读）保持组外特殊页
3. `(portal)` 与 `(auth)` 不动
4. 宽度策略收敛进 shell（newsnow 1760px 特例移入白名单或改 fluid）

## 3. 设计系统统一

1. **语义 token 单一真源**：现有 `lib/antd-theme-tokens.ts`（antd theme.token）+ `lib/aura-theme-tokens.ts` + `lib/chart-theme-tokens.ts` + Tailwind config + globals.css 变量——收敛为 `design/tokens.ts` 分层（primitive → semantic → component），antd/Tailwind/图表三处消费方从同一源派生
2. **AppShell 原语**：`AppShell`（布局槽位：rail/nav/content/ticker）· `PageContainer`（标题/宽度档位/滚动边界）· `PageHeader`（标题+操作区）——宽度白名单只在此层生效
3. **反馈原语**：`DataStateBoundary`（loading/error/empty/delayed——后端已有 chartState 语义，推广到全列表页）· `useUrlState`（URL 过滤器同步，统一 items/events/alerts 三种现行为为一种）

## 4. 组件拆解（400–500 行上限，分批）

| 优先 | 文件（行数） | 拆法 |
|---|---|---|
| P1 | war-map.tsx 4420 | 图层渲染 / 交互面板 / inspector / 数据装配 四层；图表逻辑下沉 hooks |
| P1 | alert-center.tsx 4074 | 过滤器 / 事件列表 / 详情抽屉 / 规则管理 分域；顺带落地 FE-01（URL 状态） |
| P1 | task-detail.tsx 3822 + CreateCrawlTaskDrawer 3147 | 抓取域共抽 crawl-task 原语（表单分步/结果表格/元数据卡） |
| P2 | realtime-signals 3014 · crawl-monitor 2993 · quality 2875 | 设置面板按 signal 域拆分；监控页用 PageContainer+DataStateBoundary 重排 |

规则：每批拆解**先建测试再动文件**（现有 3 文件 5 用例基础太薄，FE-03 先修 coverage include）；纯移动不改逻辑；一批一 PR 可回滚。

## 5. 数据层统一（目标拓扑）

```
GraphQL  → Apollo（保留，唯一 GQL 客户端）+ generated.ts（codegen 已有 CI 门禁）
REST     → 单一类型化客户端（现 apiClient）+ TanStack Query（缓存/轮询/变更）
实时     → 统一 useRealtime(namespace) hooks 封装 6 个 Socket.IO 连接
本地状态 → zustand 仅限跨组件 UI 状态；删除死 store（FE-02）
迁移     → 10 处直接 fetch 逐一切换到类型化客户端（trace 头/错误分类自动一致）
```

不引入新状态库；Apollo 与 TanStack 并存是**有意分工**（GQL vs REST），不是待统一项。

## 6. 实施顺序（每步可回滚，与后端解耦）

| 批次 | 内容 | 回滚方式 |
|---|---|---|
| FE-批1 | 设计 token 收敛 + AppShell/PageContainer/DataStateBoundary/useUrlState 原语落地（不动页面） | revert 单 PR |
| FE-批2 | ActionRail 分组 + TopNav 拆分（9 职责 → 组合式组件）+ 图标去重 + newsnow 宽度特例收敛 | feature flag（新旧 rail 切换）或 revert |
| FE-批3 | alert-center 重构（拆解 + URL 状态，修 FE-01）——**代表页试点 1** | revert |
| FE-批4 | war-map 重构——**代表页试点 2**（最大最复杂，验证原语够用） | revert |
| FE-批5+ | 其余巨型组件按 §4 顺序分批；直接 fetch 迁移；FE-02/03 清理 | 逐 PR |

验收：每批 `pnpm lint/typecheck + web test --coverage`（真实全仓覆盖率）+ 目标页人工冒烟清单；批 2 起每批补 1–2 个行为测试（用户可见断言，非源码文本断言）。
