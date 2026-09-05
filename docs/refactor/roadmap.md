# 重构路线图（Roadmap）

> 2026-09-03 · 基于 `edf0c8cf` · 上游输入：baseline / system-map / api-contract-inventory / bug-ledger / frontend-IA / go-migration-adr
> 里程碑可并行交错，但**同一里程碑内的后端契约变更与前端重构不同 PR**；每个迁移单元附回滚方式。

---

## M1 建立基线与门禁修复 —— ✅ 已完成（本报告周期）

| 交付物 | 状态 | 证据 |
|---|---|---|
| baseline.md（质量基线 + 勘误） | ✅ | commit c02eaf07 |
| system-map.md / api-contract-inventory.md | ✅ | 本批文档 |
| bug-ledger.md（7 流程全覆盖） | ✅ | 本批文档 |
| frontend-IA / go-ADR / roadmap | ✅ | 本批文档 |
| BL-01~09 全部修复 | ✅ | b25583e9 · 4210e892 · 0aef412c · abed388d |
| API-01（onboarding 死路由） | 🔧 已修复待运行时验证 | edf0c8cf |
| **main CI 首次全绿** | ✅ | GitHub Actions run 33729250187 success |
| codegen drift CI 门禁 | ✅ | ci.yml |

## M2 契约保护网 + Go 骨架 —— 🔶 进行中（验证状态分层：✅ 远端 CI 已验证 / ◻ 仅静态·无真实流量）

| 项 | 状态 |
|---|---|
| 3. `apps/api-go/` 骨架：legacyproxy 全量兜底 + 四态路由表 + trace 中间件 + `/__go/healthz` 自省 | ✅ 远端 CI 已验证（run 33748591315：网关行为测试全绿） |
| 4. vector Go 重写试点 | ✅ 远端 CI 已验证（`vector-integration` job 真实 Qdrant v1.10.1 上 11/11 契约差分全绿，run 33748591315）。部署面（vector-go.Dockerfile + compose `go-pilot` profile）◻ 仅代码落地、未经真实容器构建（本机禁 Docker；CI 只验证二进制直跑）。**无真实部署流量**——切换/回滚开关 = vector 服务 baseUrl 配置 |
| Go 工具链接入 CI（setup-go + build filter + 独立 test 步骤） | ✅ |
| 1. 契约快照落地：OpenAPI 形快照 + schema.gql 冻结 diff 进 CI | ✅ 远端 CI 已验证（`openapi.snapshot.json` 370 端点/294 路径 + `git diff --exit-code` 门禁；schema.gql SDL 门禁已接入）。**能力边界如实登记**：这是 REST 路由/鉴权契约快照（POST=201 默认语义 + @HttpCode 提取 + unresolved schema 标注 + info.completeness），不是完整 OpenAPI 契约 |
| 2. 鉴权矩阵生成（四态语义） | ✅ 远端 CI 已验证（anonymous / authenticatedWithoutPermission / authenticatedWithPermission / wrongOrg=runtime-required 四态 + ordinaryOrgAdmin/platformAdmin 画像 + platformCheckSource=handler-text-scan 启发式标注 + confidence；fail-closed；漂移检查） |
| shadow 差分基础设施 | ✅ 远端 CI 已验证（直通 + 有界旁录：客户端流式语义保留，请求体/响应捕获独立预算，SSE/升级请求跳过，分类丢弃统计，差分正文默认只记 sha256 hash）。**仅基础设施能力**——只对 `/api/healthz/live` 生效，无真实流量差分数据 |
| canary 分流组件 | ◻ 仅静态/组件级验证。**信任边界**：分流依据是未验签的 orgId claim（不是可靠身份），AllowUnverifiedIdentity 默认关闭——受保护路由不可能据此进入 Go。**当前没有任何路由处于 ModeCanary**；CANARY_PERCENT 只是预留。待迁移序 5（Go JWT 验签 + membership 重推导）后激活 |
| 首个迁移单元 `GET /api/healthz/live` | 🔶 shadow 态（NestJS 仍是响应方，Go 实现进入差分管道）。**不是 Go 全量接管**；未做真实流量 0 差异验收 |
| api 单测基座（vitest） | ✅ 远端 CI 已验证（SEC-01 6/6 + API-01 4/4 + 扫描器语义/基线断言全绿） |

余项（按序）：
1. ~~CI 首跑闭环~~ ✅ 已完成（run 33748591315 verify + vector-integration 双绿）
2. shadow 差分在真实流量的零差异验收（M5 迁移序 2 的 shadow 起步；当前无生产流量入口——api-go 尚未接入入口代理）
3. 第二个迁移单元（user-settings 只读 GET → shadow）

## M3 安全修复批次（与 M2 并行，纯 NestJS 侧）

| 项 | 动作 | 回归验证 | 状态 |
|---|---|---|---|
| SEC-01（P0） | vector-service 设置 PUT/DELETE 注入 platformAccess.assertPlatformAdmin（复用 audit-log 模式） | 控制器单测：非平台管理员的 settings.manage 持有者 → 403；平台管理员 → 通过；GET 不受影响 | ✅ 单元级远端 CI 已验证（vitest 6/6）。**真实数据库登录态（登录→改配置→403）未验证**——CI 无 DB 栈。网络白名单只登记设计建议（见 bug-ledger §SEC-01） |
| SEC-03 | /api/metrics 定位决策（平台级收紧 or org 过滤）+ 实施 | 鉴权矩阵对应行 | ⬜ |
| API-01 运行时验证 | Docker 栈就绪后：登录→完成引导→刷新不重现 | 手工冒烟清单 | 🔶 静态闭环 + 契约测试远端 CI 已验证（4/4）；**真实用户完成引导并刷新不重现——未验证**（需数据库栈） |
| BAPI-01 | **决策冻结**：Go 迁移前不动 schema；列入 GraphQL 迁移序（M5）的版本化演进 | — | — |

## M4 前端第一批（App Shell + 代表页）—— 🔶 已落地第一小批（不是 App Shell 重构完成）

| 项 | 状态 |
|---|---|
| FE-批1（子集）：PageContainer 宽度原语 + 单一真源 lib/content-widths（shell 与 PageContainer 共用；padding 唯一所有者是 shell；服务端安全无 "use client"）+ 行为测试 | ✅ 远端 CI 已验证（组件测试 + lint/typecheck/build） |
| FE-批2（子集）：newsnow 1760px 特例收敛（12 处硬编码 → NewsnowBoardContainer）+ news-hub 1200px 双重约束修复 + ActionRail 4 组图标语义唯一化 | ✅ 远端 CI 已验证（同上） |
| FE-批2（主体）：ActionRail 五组化（navigation-model 单一真源 + 权限过滤唯一事实源 + rail/drawer 共用）+ TopNav 589 行九职责拆分（编排层 ~124 行 + 组件/hooks）+ 顶部栏响应式优先级（resolveTopNavLayout 纯函数 + 窄屏搜索兜底入口）+ Shell 视口测量单一来源 + App Shell 导航 token 收敛 | ✅ 远端 CI 已验证（PR #3 已合并）|
| FE-02 死 store 删除（store/sidebar.ts） | ✅ 静态验证零引用后删除；残留引用由 typecheck 拦截 |
| FE-批1（其余）：DataStateBoundary、useUrlState | ✅ 已落地（PR #4：use-url-state.ts / url-state-codec.ts / data-state-boundary.tsx，远端 CI 已验证）；design/tokens.ts 收敛仍为后续批次 |
| FE-批3（FE-批3A）：alert-center 重构（顺修 FE-01 URL 状态）——代表页试点 1 | ✅ 远端 CI 已验证（PR #4 已合并，合并后基线 2851 行）：characterization tests + useUrlState/DataStateBoundary 原语 + URL 十参数契约 + DataStateBoundary 首个消费方 + 证据域/图表构建器拆分；最终 CI run 33857305521，main 合并后 CI run 33858778995（b9669b2b）|
| FE-批3B：Alert Center 领域拆分收口（列表/详情/数据 hooks） | ✅ 远端 CI 已验证（PR #5）：feed/selection/status-actions/batch/detail/virtualization/charts 七个领域 hooks + filters/summary/list/row/toolbar 组件 + 五个详情页签 + detail-model/actions/data-state 纯模块；alert-center.tsx 2851→~490 行，全部模块 < 500 行；web 测试 205→211（+6 保护网）。**第四轮静态收口（合并前）**：List/Toolbar/Detail 的 33/19/39 平铺 props 收敛为 6/2/11 领域契约（model/controller 具名切片，alert-event-controllers.ts），删除未消费的 selectedEventId 死接口——修正此前“无 20+ props 机械搬运/无死代码”的不准确表述 。**第五轮最终收口**：契约层不再依赖展示组件（AlertExportScope 归属领域层）、导出/状态修改拆为独立 controller（Toolbar 消费 selection/export/status 三切片）、Detail 收敛为 model+7 切片（8 项，isFilteredOut 编排层计算）、删除 replayUnit 死字段与恒等 builder；最终 Props：List 7 / Toolbar 3 / Detail 8 |
| FE-03：vitest coverage include 改全仓 glob，阈值按真实基线重设 | 🔶 部分（include 3→约 40：App Shell 导航原语 + FE-批3/3B 原语与 Alert Center 全部领域模块；全仓阈值待巨型组件拆分批次） |
| 试点页人工冒烟 | ⬜ 未做（本机不启动前端；需部署环境） |

**范围声明**：FE-批2 主体 = Shell 导航信息架构重组 + TopNav 拆分。**不是** App Shell 重构全部完成——design/tokens.ts 全站收敛、DataStateBoundary、useUrlState、代表页试点（alert-center/war-map）均未开始；页面级视觉未经人工验收。

## M5 Go 迁移推进（只读 → CRUD → GraphQL）

- 迁移序 2（health/public-portal/dashboard 只读）→ 序 3（用户偏好 CRUD）→ 序 4（GraphQL 层，含 BAPI-01 版本化分页决策）
- 每单元：shadow 差分 0 失败 → canary（按 org 哈希）→ go；NestJS 对应路由保留 2 个发布周期
- WS 六 namespace 的事件契约快照进保护网

## M6 前端第二批（巨型组件拆解）

- FE-批4：war-map 重构（试点 2，验证原语够用）→ FE-批5+：task-detail/CreateCrawlTaskDrawer/realtime-signals/crawl-monitor/quality 分批
  - FE-批4A（PR #6，已完成）：行为保护网 + war-map.tsx 4412 → 497 行；拆出容器观测/URL/查询/运行时/交互/点位/图层/状态展示/overlay 组合等 20+ 领域模块（全部 ≤500 行）；三个消费入口与全部行为红线保持；coverage include 48 → 82 项
  - FE-批4A 合并前静态收口（PR #6 第二轮）：修复 WM-RT-01 运行时缺陷（retry 重建后新 Deck overlay 丢失 layers/getTooltip/getCursor——setOverlayProps 在 overlay 缺位时丢弃 props 且重建不回放；改为 runtime 持有最新 props 并在创建 effect 内立即回放；红→绿远端验证 run 33945984922 → 33946342887）；interaction 返回值 24 平铺字段 → 4 领域切片（layerInteraction 7 / legend 6 / inspector 6 / overlayPanel 4，删除 setSelectedInspectorKey/updateHoveredInteractionKey 两个零消费者死字段）；删除 16 输入 → 39 字段平铺输出的 buildWarMapTransportPanelProps（flights 4 / ais 8 / analysis 3 / legend 1 领域对象传递，presentation 整体下传，controls-panel 仅做 transport 类型与字段读取适配）；overlay panels 返回 10 → 4（删除 6 个零消费者死字段）；runtime 同步 guard 零延迟 timeout 与 legend dock RAF 句柄闭环（保存句柄/新调度前取消/卸载取消并复位）；顺带修复 standalone Drawer 误关缺陷（「面板外 mousedown 关闭」效应未豁免 standalone 底部 Drawer——Drawer 内容在 rail 之外，非 minimal 密度下点击 Drawer 内任何控件即被误关；新增行为测试暴露）。war-map.tsx 496 行；War Map 用例 77 → 82（修正此前「96 个用例」的误记——远端 CI 实测 6 个测试文件 77 用例）。**未做**真实浏览器地图操作/WebGL 性能/视觉验收/真机/大数据量压力（仍属 FE-批4B 验证项）
  - FE-批4B（待做）：controls-panel（1741）、symbols（1530）、inspector-panel（668）、overlay-model（534）、overlay-rail（329）内部拆分；真实浏览器地图操作/WebGL 性能/视觉验收/320-390px 真机/大数据量压力
- 直接 fetch → 类型化客户端迁移（10 文件）；~~FE-02 死 store 删除~~（✅ 已随 FE-批2 完成）

## M7 深水区：Auth/Org/RBAC（Go）

- JWT 验签/MFA/OIDC/refresh 轮换/机器令牌逐项语义对齐；鉴权矩阵全量驱动
- canary 期任一会话语义差分失败自动回切 legacy

## M8 终局：编排、队列、调度、realtime

- crawl 编排/news-pipeline/scheduler 迁移；BullMQ 行为对齐清单（job name/重试/DLQ 时机/repeat）逐项验收
- 队列内积压排空后切 worker；Subscription PubSub 统一 Redis（行为变更公告）
- NestJS 摘除计划：按路由分批下线，最终归档 `apps/api`

## 持续原则（每个里程碑适用）

1. 每修复先证据（文件:行号）后动手；台账状态同步更新
2. Go 侧 code review checklist 固定项：orgId 服务端推导、常量时间 token 比较、错误结构逐字段对齐
3. 契约变更一律版本化并更新 api-contract-inventory
4. 未运行验证的项显式标「未运行」，禁止「应该没问题」
5. 回滚方式先于实施写进每个 PR 描述

## 立即可做的下一轮最小任务（PR #2 合并后，新分支/新 PR）

1. shadow 差分真实流量验收（首个单元 /api/healthz/live 0 差异——需要 api-go 接入入口代理；当前网关本身未上线路径）
2. 第二个迁移单元：user-settings 只读 GET（shadow 模式）
3. FE-批1 剩余原语（design/tokens.ts、DataStateBoundary、useUrlState）（TopNav 拆分已随 FE-批2 完成）
4. canary 激活的前置件（迁移序 5 的 Go JWT 验签 + membership 重推导——在它完成前 canary 保持不激活）

**canary 契约提醒**：路由表没有任何 ModeCanary 条目；CANARY_PERCENT 是预留配置。把业务路由切到 ModeCanary 之前必须先落地可信身份来源——`cmd/api/main_test.go` 的 TestDefaultRulesHaveNoCanaryRoutes 会在有人提前切换时失败。
