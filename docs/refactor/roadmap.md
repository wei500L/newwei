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
| 1. 契约快照落地：OpenAPI 形快照 + schema.gql 冻结 diff 进 CI | ✅ 远端 CI 已验证（`openapi.snapshot.json` 370 端点/294 路径 + `git diff --exit-code` 门禁；schema.gql SDL 门禁已接入）。**能力边界如实登记**：这是 REST 路由/鉴权契约快照（POST=201 默认语义 + @HttpCode 提取 + unresolved schema 标注 + info.completeness），不是完整 OpenAPI 契约。**确定性已修复加固（CI-01，PR #12）**：快照曾因扫描器误读 `@CurrentUser` 等自定义参数装饰器的随机 uid 元数据键而随机漂移（main 曾被阻断，run 34031744982）；现 OpenAPI 步骤为双冷进程生成 + SHA-256 一致 + 与已提交快照逐字节比对，无 retry |
| 2. 鉴权矩阵生成（四态语义） | ✅ 远端 CI 已验证（anonymous / authenticatedWithoutPermission / authenticatedWithPermission / wrongOrg=runtime-required 四态 + ordinaryOrgAdmin/platformAdmin 画像 + platformCheckSource=handler-text-scan 启发式标注 + confidence；fail-closed；漂移检查） |
| shadow 差分基础设施 | ✅ 远端 CI 已验证（直通 + 有界旁录：客户端流式语义保留，请求体/响应捕获独立预算，SSE/升级请求跳过，分类丢弃统计，差分正文默认只记 sha256 hash）。**仅基础设施能力**——只对 `/api/healthz/live` 生效，无真实流量差分数据 |
| canary 分流组件 | ◻ 仅静态/组件级验证。**信任边界**：分流依据是未验签的 orgId claim（不是可靠身份），AllowUnverifiedIdentity 默认关闭——受保护路由不可能据此进入 Go。**当前没有任何路由处于 ModeCanary**；CANARY_PERCENT 只是预留。Go-批3A 已落地 onboarding 单元的最小闭环 Go Auth（见下），但 canary router 本身仍消费未验签 claim（未改造为已验证身份分流），canary 仍不激活 |
| 首个迁移单元 `GET /api/healthz/live` | 🔶 shadow 态（NestJS 仍是响应方，Go 实现进入差分管道）。**不是 Go 全量接管**；未做真实流量 0 差异验收 |
| 第二个迁移单元 `GET /api/user-settings/ui/onboarding`（Go-批2A） | 🔶 shadow 态（NestJS 仍是响应方）。Go 已实现**真实 MySQL 只读查询**（`UserSetting` 三条件参数化查询 + normalization 契约对齐），远端 CI 真实 MySQL service 集成验证（`api-go-user-settings-integration` job）；单元/集成测试由远端 CI 完成。身份来自 **legacy-approved shadow identity**（legacy 200 后的临时信任委托——Go 尚未独立完成 JWT 验签/membership/RBAC，不得进入 canary/go）。未做真实生产流量差分验收（api-go 尚未接入入口代理）；PUT 与其他 user-settings GET 仍全部 legacy。（Go-批3A 起该单元在 pilot 中可切 go 全响应，见下。） |
| user-settings 只读 GET 第二批：`rss-reader`、`spacetime-timeline`（Go-批2B） | 🔶 shadow 态（NestJS 仍是响应方）。复用批2A 的 repository（`SettingKey` 编译期固定常量，三个语义方法共享同一条参数化查询）、legacy-approved shadow identity 与失败非阻断语义；normalization 逐字段对齐（RSS：trim/128 截断/稳定去重/严格布尔/provider/targetLanguage；spacetime：枚举回退/浮点 clamp 不取整）；远端 CI MySQL integration 扩展验证三 key 读取与 orgId/userId/key 隔离。未做真实生产流量差分验收；**其余三个 GET（situation-monitor/war-map/newsnow）与全部 PUT 仍 legacy**——user-settings 未迁移完成。Go-批3A 后仍是 shadow（本批不扩大迁移范围） |
| api-go 真实入口接线 + 容器化（Go-批2C） | 🔶 **已完成远端真实栈运行验证**（非生产流量）。`infra/docker/api-go.Dockerfile`（多阶段、distroless nonroot、`-mod=readonly -trimpath`、内置 `healthcheck` 子命令——exec 形式 HEALTHCHECK）+ compose 独立 `api-go-pilot` profile 服务（:4020，`LEGACY_API_URL=http://api:4000`，同一 MySQL，`CANARY_PERCENT=0`）+ Web/API 入口可切换（`API_BASE_URL` 运行期可指 `http://api-go:4020`；web 启动等待不再硬编码 `api:4000`）。手动 `api-go-entry-smoke` workflow 在远端真实栈（真实 MySQL+migrate+真实 NestJS+api-go 容器+真实登录 JWT）闭环：3 个 PUT 经 api-go 由 NestJS 单写持久化、PUT 零 Shadow 执行、4 个 Shadow GET `executed` 精确 +4、`diffs`/`dropped` 零增量、`inflight` 归零、trace header 传播、三 key 无串读。**默认 legacy 部署不变；生产/预发布真实流量验证未完成；canary/go 仍禁止** |
| Go Access Token 鉴权/RBAC 最小闭环 + onboarding GET 首次真实接管（Go-批3A） | 🔶 **已完成远端真实栈下的 onboarding Go 接管验证**（非生产流量）。`GET /api/user-settings/ui/onboarding` 成为 pilot 范围内首个由 Go 全响应的业务端点（`API_GO_ONBOARDING_MODE=go`，默认仍 shadow）：Go 独立验签 NestJS 签发的 HS256 access token（`internal/authn`，拒绝 alg=none/算法混淆/mtk_，issuer/audience/exp/nbf 按 jsonwebtoken 语义，jti 缺失按 NestJS 当前语义放行）→ 独立查询真实 Redis blacklist（`access-token:blacklist:<jti>`，与 NestJS 同一实例同一 key，查询失败 fail-closed）→ 从真实 MySQL 重推导 User/Org/Membership 有效性与 MembershipRole/RolePermission/Permission 权限（`internal/authz`，与 getUserProfile 同序同文案 401；多角色优先/primary 回退）→ `items.read` 独立判定（**JWT permissions claim 一律不参与**）→ 既有 repository 查 UserSetting 并全响应（`internal/onboarding` + `internal/authhttp` 契约等价错误）。路由层迁移单元改为 exact path + method 白名单（PUT 与 onboarding-x/子路径回落 legacy）。远端真实栈 smoke 验证：契约对比（NestJS 直连 vs Go handler 全等）、数据库无 items.read 而 JWT claim 有 → 双端 403 一致、membership inactive → 双端 401 同文案、真实 logout blacklist → Go 401 revoked、篡改签名/alg=none → 401、**NestJS 停止后 onboarding GET 仍 200（Go 独立接管证明）且 rss-reader 502（非伪装成功）**、onboarding 零 shadow 执行（executed +3=live+rss+spacetime）。**边界如实登记**：登录/refresh/logout/MFA/OIDC/机器令牌仍全部 NestJS（mtk_ 在 Go 端点被拒绝）；全部 PUT 仍 NestJS 单写；RSS/Spacetime 仍 shadow；默认部署仍直连 NestJS；这不代表完整 Auth/RBAC 模块迁移完成（迁移序 5 的 MFA/OIDC/refresh/机器令牌未动）；canary router 未改造仍不激活；生产流量未切换 |
| user-settings 只读域统一 Go 接管（Go-批3B） | 🔶 **已完成远端真实栈下的六端点 Go 接管验证**（非生产流量）。六个只读 GET（onboarding/rss-reader/spacetime-timeline/war-map/newsnow/situation-monitor）由统一 handler `internal/usersettingsread` 全响应（`API_GO_USER_SETTINGS_READ_MODE=go`，优先级高于批3A 变量；未设置=兼容旧行为）：复用批3A 的 authn/authz/authhttp 鉴权链与同一 MySQL/Redis 连接池；repository 扩展到 8 个编译期固定 key（五个单 key 查询共用一条 SQL + situation-monitor 三 key 聚合查询）；三个新 normalization（War Map 完整移植 war-map-contract.ts 含 45 layer/legacy key/clamp/归零；Situation Monitor 三段聚合+updatedAt；NewsNow 有序对象 Object.entries 顺序+200/32/300 上限+Boolean 真值+clamp/round）。远端真实栈 smoke 四阶段：Phase A 六 PUT（NestJS 单写，8 key 落库）→ Phase B shadow（executed +6、diffs 零增量）→ Phase C go 契约对比（六端点与 NestJS 直连逐字段全等）→ Phase D 停止 NestJS 后六端点仍 200、代表性 PUT 与未迁移 GET 502。**边界**：六个 PUT 仍全部 NestJS 单写；登录/refresh/logout/MFA/OIDC/机器令牌仍 NestJS；LegacyApprovedIdentity 保留（shadow 回滚路径）；canary 未激活；生产流量未切换 |
| api 单测基座（vitest） | ✅ 远端 CI 已验证（SEC-01 6/6 + API-01 4/4 + 扫描器语义/基线断言全绿） |

余项（按序）：
1. ~~CI 首跑闭环~~ ✅ 已完成（run 33748591315 verify + vector-integration 双绿）
2. shadow 差分在真实流量的零差异验收（M5 迁移序 2 的 shadow 起步）。🔶 Go-批2C 已完成**远端真实栈运行验证**（api-go 容器入口链 + 真实 NestJS/MySQL + 真实 JWT：`api-go-entry-smoke` workflow 断言 executed 精确增量、diffs/dropped 零增量）；**生产流量差分验收仍未完成**（api-go 未接入生产入口，默认部署仍 Web → NestJS 直连）
3. ~~第二个迁移单元（user-settings 只读 GET → shadow）~~ ✅ 已完成（Go-批2A/2B + 批2C 入口接线）

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

- FE-批4：war-map 重构（试点 2，验证原语够用）→ FE-批5A：crawl task-detail 重构（试点 3，3822 → 281 行编排层，PR #9）→ FE-批5B+：CreateCrawlTaskDrawer/realtime-signals/crawl-monitor/quality 分批
  - FE-批4A（PR #6，已完成）：行为保护网 + war-map.tsx 4412 → 497 行；拆出容器观测/URL/查询/运行时/交互/点位/图层/状态展示/overlay 组合等 20+ 领域模块（全部 ≤500 行）；三个消费入口与全部行为红线保持；coverage include 48 → 82 项
  - FE-批4A 合并前静态收口（PR #6 第二轮）：修复 WM-RT-01 运行时缺陷（retry 重建后新 Deck overlay 丢失 layers/getTooltip/getCursor——setOverlayProps 在 overlay 缺位时丢弃 props 且重建不回放；改为 runtime 持有最新 props 并在创建 effect 内立即回放；红→绿远端验证 run 33945984922 → 33946342887）；interaction 返回值 24 平铺字段 → 4 领域切片（layerInteraction 7 / legend 6 / inspector 6 / overlayPanel 4，删除 setSelectedInspectorKey/updateHoveredInteractionKey 两个零消费者死字段）；删除 16 输入 → 39 字段平铺输出的 buildWarMapTransportPanelProps（flights 4 / ais 8 / analysis 3 / legend 1 领域对象传递，presentation 整体下传，controls-panel 仅做 transport 类型与字段读取适配）；overlay panels 返回 10 → 4（删除 6 个零消费者死字段）；runtime 同步 guard 零延迟 timeout 与 legend dock RAF 句柄闭环（保存句柄/新调度前取消/卸载取消并复位）；顺带修复 standalone Drawer 误关缺陷（「面板外 mousedown 关闭」效应未豁免 standalone 底部 Drawer——Drawer 内容在 rail 之外，非 minimal 密度下点击 Drawer 内任何控件即被误关；新增行为测试暴露）。war-map.tsx 496 行；War Map 用例 77 → 82（修正此前「96 个用例」的误记——远端 CI 实测 6 个测试文件 77 用例）。**未做**真实浏览器地图操作/WebGL 性能/视觉验收/真机/大数据量压力（仍属 FE-批4B 验证项）
  - FE-批4B（PR #7，已完成）：五个巨型展示模块拆分（保护网先行）。Batch 1 在旧实现上建立直接 characterization tests（symbols/swatch/controls/inspector/overlay model/rail 六个测试文件，远端跑绿 run 33952441286，web 用例 287 → 391）；Batch 2 symbols 1530 → 六模块（symbol-types/color/svg/icons/legend-model/legend-swatch，函数体与旧实现逐字 diff 验证一致；原文件成 48 行纯 re-export 出口）；Batch 3 overlay-model 534 → theme/types/layout/view-model 四纯模块（移除 use client；原文件成 55 行出口）+ overlay-rail 329 → rail-types/summary/quick-legend + 154 行薄组合层（props 22 → 6 切片）；Batch 4 controls-panel 1746 → types/primitives/header/view-section/transport-controls/ais-reference/feed-controls/legend-sections/legend-panel/legend-dock + 287 行编排层（props 24 → 8 切片）；a11y/i18n 修复：legend section 折叠按钮补 aria-expanded+aria-controls（useId 稳定 id）、聚焦徽标硬编码 "Focus" 改 i18n focusBadge（en Focused/zh 已聚焦）；Batch 5 inspector-panel 667 → types/shell + event/news/transport cluster/detail 内容组件 + 105 行编排层（props 14 → 6 切片，轨迹 20 点上限保持）；Batch 6 删除死常量 OVERLAY_BUTTON_GROUP_CLASS_NAME、依赖方向静态审计（无循环；纯模块仅类型级 React 依赖）、props/行数统计收口。war-map.tsx 保持 495 行；War Map 用例 82 → 181（新增 99：直接测试 + en/zh 键配对锁定）；coverage include 82 → 113 项（war-map 35 → 63）；thresholds 不变。**未做**真实浏览器地图操作/WebGL 性能/视觉验收/320-390px 真机/大数据量压力（部署环境人工验收项）
  - FE-批4B 合并后收口（本报告周期，follow-up PR）：**勘误 PR #7 两处失实**——①「全部新增生产模块 ≤500 行」不成立：合并时 `war-map-symbol-svg.ts` 591 行、`war-map-legend-model.ts` 576 行（主要入口文件确已收敛，但这两个批4B 新拆纯模块超限，验收结论遗漏）；② coverage include 实际 79 → 107（PR #7 记为 82 → 113，逐条清点 db21bf1f 核实；war-map 35 → 63 一致）。本轮修正：symbol-svg 按职责续拆为 svg-primitives/glyphs/公共装配（214/374/43 行，逐字移动、SVG 内容与 cache key 语义不变、公共 API 面不变）；legend-model 拆为 legend-item/quick/full 三纯模块（78/248/276 行，直接消费方仅 2 处改指向、facade 公共 API 不变）；全部 War Map 生产模块 ≤500 行（逐文件清单见 PR）；FE-DD-01 两个零消费导出删除（静态引用审查，见 bug-ledger §3）；include 107 → 111（war-map 63 → 67）。真实浏览器/WebGL/视觉/中英文布局/真机/读屏/压力验证仍未完成；FE-批5 未开始
  - FE-批5B（PR #10）：CreateCrawlTaskDrawer 领域拆分。前置 FE-TEST-01（Crawl Task Detail 专用 mock 状态自全局 component-mock-state 拆出为零依赖领域模块，全局文件 479→184 行，211 个用例不变，run 34018784959）；在未拆分的 3147 行旧实现上建立 4 文件 68 例直接 characterization 保护网（含对 jsdom 可访问名语义与两个既有死路径的实测纠正，run 34022491640 全绿）后拆分：根文件 3147→134 行编排层 + 24 个领域模块（全部 ≤500 行，最大 markdown-fields 402）；两个消费入口/公共 Props/Form 契约保持（153 Form.Item、5 Form.List、rules/条件渲染/字段顺序逐项对照）；8 处 as any 清零（字面量元组 NamePath）；修复 FE-TPL-01（defaultTemplateKey 持续回写）、FE-A11Y-03（模板选择器键盘语义）、FE-SUBMIT-01（loading 期间 submit 门禁）、FE-I18N-02（3 个 i18n 键）；登记 FE-TPL-02（proxy 告警分支不可达，开放）。测试 68→72 例；coverage include 145→148 项。真实浏览器/键盘/读屏/真机未验证。
  - FE-批6A（PR #13）：realtime-signals 设置与诊断面板。本轮以功能实现为核心、不先建旧实现 characterization：静态审查确认并修复三个真实缺陷——FE-RT-01（初始 GET 失败后 EMPTY_SETTINGS 填充表单并可保存覆盖未知配置，P1）、FE-RT-02（Save/Reset 无 handler 层互斥，可重复 PUT / PUT+DELETE 并发）、FE-RT-03（diagnostics 失败污染 settings 域）；根组件 3009→240 行编排层 + 17 个领域模块（types/constants/runtime-model/两个领域 hooks/overview/runtime 展示域/表单六 section，全部 ≤500 行，最大 source-card 379）；四请求 URL/method、settings.manage 权限、secret touched/omit/null 语义（复用 realtime-signals-settings-payload.ts）、保存/重置/诊断展示契约全部保持；最小关键测试 2 例（初始失败阻断 + Retry 恢复；secret 语义 + 挂起 PUT 期间重复 submit 单次 PUT + diagnostics 失败不清空表单）；web 测试 41 文件 480 例 → 42 文件 482 例（+1 文件 +2 例，耗时 93.95s → 84.80s）；coverage include 155→159 项（实测逐条清点 base `24fbae9a` 155 条 → 本轮 159 条：编排层 + 2 hooks + payload helper；批5B 登记「148」与实测 155 不符，系其计数口径问题，勘误于此）；i18n 新增 loadFailedTitle/Description 双语键。最终 CI run 34042481108（HEAD 750a7ec4）verify 13 关键 step 全绿（前两轮失败：run 34041760020/34041906177 Lint 3 处 import/order、run 34042050067 Typecheck 5 处，均分析根因后新提交修复，无 rerun）。真实浏览器/视觉/读屏未验证；crawl-monitor/quality 仍为 FE-批6B+。
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
2. ~~第二个迁移单元：user-settings 只读 GET（shadow 模式）~~ ✅ 已完成（Go-批2A：`GET /api/user-settings/ui/onboarding` 进入 shadow，NestJS 仍是响应方；Go 真实读取 MySQL `UserSetting`，legacy-approved shadow identity 信任边界，远端 CI `api-go-user-settings-integration` 真实 MySQL service 验证。Go-批2B 扩展：`rss-reader`、`spacetime-timeline` 两个确定性 GET 以同一模式进入 shadow；其余三个 GET 与全部 PUT 仍 legacy）
3. FE-批1 剩余原语（design/tokens.ts、DataStateBoundary、useUrlState）（TopNav 拆分已随 FE-批2 完成）
4. canary 激活的前置件（迁移序 5 的 Go JWT 验签 + membership 重推导——在它完成前 canary 保持不激活）

**canary 契约提醒**：路由表没有任何 ModeCanary 条目；CANARY_PERCENT 是预留配置。把业务路由切到 ModeCanary 之前必须先落地可信身份来源——`cmd/api/main_test.go` 的 TestDefaultRulesHaveNoCanaryRoutes 会在有人提前切换时失败。
