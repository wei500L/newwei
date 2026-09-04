# PR 描述（草稿——随批次推进更新）

## refactor(web): 拆分 Alert Center 并落地 URL 状态与数据边界

FE-批3：Alert Center 领域拆分 + useUrlState + DataStateBoundary（修复 FE-01）。

纯前端 PR，可整体 revert 回滚；无数据库/后端数据迁移。

## 1. 问题与静态证据

- `apps/web/app/(app)/alerts/alert-center.tsx` 4,074 行（约 138 KB）——超出单组件可维护边界一个量级（frontend-IA §1.4）。
- FE-01（bug-ledger §4）：items/search/events 页过滤器全量 URL 同步；alert-center 只把 `eventId` 写入 URL（`alert-center.tsx:1363` 读、`:1550-1556` 写），筛选/日期/关键字/分页均为组件内存态——告警视图不可分享、不可刷新恢复、前进/后退丢失。
- 数据状态缺口：`alert-center.tsx:3182-3221` 手工拼装 blocking error 分支；refetch 挂起时旧数据保留依赖 `eventsError && sortedEvents.length === 0` 的隐式判断，无可复用原语。
- 测试缺口：Alert Center 目录测试为零（FE-03）。

## 2. 变更范围（随批次更新）

- [x] 批次 A：迁移前 characterization tests（生产代码零改动）
- [x] 批次 B：`useUrlState` 原语 + Alert Center URL codec/组合 hook
- [x] 批次 C：`DataStateBoundary` 展示原语
- [ ] 批次 D：Alert Center 领域拆分
- [ ] FE-03 coverage include 扩充
- [ ] 文档收口

## 3. 非变更范围

- 不改 GraphQL schema / generated 文件 / OpenAPI 快照 / 鉴权矩阵
- 不改后端（api / vector / api-go / vector-go / db / prisma）
- 不动 TopNav / ActionRail / TickerTape / war-map / task-detail
- 不迁移 items/events/search 到 useUrlState（后续批次）
- 无视觉重设计；布局与交互保持

## 4. URL 参数契约

| 参数 | 语义 | 默认（不写入 URL） |
|---|---|---|
| severity | 已选 severity（重复 key 形式，去重 + 排序） | 空 |
| status | 已选 status（同上） | 空 |
| provider | 已选 metric provider（同上） | 空 |
| q | rule keyword（220ms debounce 后写入） | 空 |
| range | today / 7d / 30d / custom | 30d |
| from / to | custom 起止日期 YYYY-MM-DD；from <= to 才生效 | 空 |
| page | 当前页码（>= 1） | 1 |
| pageSize | 20 / 30 / 50 / 100 | 30 |
| eventId | 现有选中事件参数，继续保留 | 空 |

规则：默认值不写入 URL；非法值读取时安全回退（不立即改写 URL）；未知参数原样保留；写回用 `router.replace`；筛选变化 page 重置 1；URL eventId 自动定位页码优先。

## 5. DataStateBoundary 状态表

| 状态 | 有可用数据 | 展示 |
|---|---|---|
| initialLoading | 否 | 居中 Spin（role=status, aria-live=polite） |
| permissionDenied | 否 | 权限空态（ChartEmptyState permission） |
| blockingError | 否 | 错误空态 + retry（复用 buildRequestErrorEmptyState） |
| empty | 否（请求完成） | 空态 |
| ready | 是 | children |
| refreshing | 是 | children + aria-busy |
| nonBlockingError | 是 | children + 非阻断横幅（RequestErrorBanner + cached hint） |

## 6. 权限与 GraphQL 契约

- `alerts.read` 决定查询与订阅（fail-closed：无权限时 query/subscription 均不发起）
- `alerts.manage` 决定状态修改 / 批量操作 / tuning suggestion
- 消费 operation：AlertEvents query / AlertEventsStream subscription / UpdateAlertEventStatus mutation / AlertEventReplay lazy query / AlertRuleTuningSuggestion query（全部现有，无 schema 变更）

## 7. Coverage include 前后对比（草稿）

修改前（8 个文件）：

- app/(auth)/login/page.tsx
- app/(app)/admin/ops/news-sources/news-sources-content.tsx
- components/settings/email-settings-panel.tsx
- app/(app)/components/{page-container,nav-mode,action-rail-routing,navigation-model,top-nav-density}

修改后（+5）：

- lib/url-state-codec.ts
- hooks/use-url-state.ts
- components/data-state-boundary.tsx
- app/(app)/alerts/alert-center-url-state.ts
- app/(app)/alerts/hooks/use-alert-center-url-state.ts

（批次 D 后追加 Alert Center 拆分产物；阈值不变：lines 35 / functions 3 / statements 35 / branches 30）

仍未纳入：全仓 apps/web 生产代码（FE-03 保持「部分改善」）。

## 8. 远端 CI 与 HEAD SHA

（收口时填写）

## 9. 未验证项

- 本机未启动页面（任务约束）
- 真实浏览器 back/forward 未人工操作
- 真实键盘/读屏未人工验证
- 320/390px 真机未验证
- 亮/暗色、中英文真实视觉未验证
- 大数据量滚动/虚拟化手感未人工验证
- 导出文件未人工打开检查

## 10. 回滚方案

整体 revert 本 PR。本轮无数据库和后端数据迁移。
