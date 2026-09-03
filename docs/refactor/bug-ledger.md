# 缺陷台账（Bug Ledger）

> 生成时间：2026-09-03 · 基线 commit `95759f59` · 修复提交至 `edf0c8cf`
> 审计方法：5 路并行代码勘察（API 契约 / 鉴权安全 / 队列拓扑 / vector 服务 / 前端 IA）+ 主线逐项复核。**标注「已复核」的条目经主线二次验证（文件:行号 亲验）；其余为单路勘察结论，修复前需按同一标准复核。**
> 规则：先证据后修复；每条修复必须可独立回滚；不制造假测试。

## 0. 字段与级别说明

- **严重级别**：P0 阻断发布/门禁失效/数据泄漏 · P1 核心功能受损 · P2 体验/性能/工程化
- **状态**：✅ 已修复（含回归验证）· 🔧 已修复待运行时验证 · 🔶 部分改善 · ⬜ 开放 · 👁 观察项

## 1. 七条关键用户流程覆盖

| # | 流程 | 本轮涉及条目 |
|---|---|---|
| F1 | 认证与会话（login/MFA/OIDC/refresh/机器令牌） | BL-04/BL-08（构建期）· SEC-01~04 · API-01 |
| F2 | 新闻采集与入库（调度→抓取→处理→聚类→索引→向量） | SEC-01/02（向量链路）· BAPI-01 |
| F3 | 信息浏览与检索（items/search/newsnow/reader/公共门户） | BAPI-01 · FE-01 |
| F4 | 态势与分析（dashboard/war-map/situation-monitor/analysis） | BL-01（war-map 等组件 lint 内）· FE-01 |
| F5 | 告警与通知（规则/事件/投递/WS） | BAPI-01（alerts 列表） |
| F6 | 管理与运维（admin/crawl/system-settings/RBAC/可观测） | BL-02/03/09 · SEC-03 · API-01 |
| F7 | 个性化与个人工作台（user-settings/digest/subscriptions/onboarding） | API-01 · FE-02/03 |

## 2. 总览

| ID | 级别 | 一句话 | 状态 | 修复提交 |
|---|---|---|---|---|
| BL-01 | P0 | web 35 处 lint 错误，CI 门禁失效 | ✅ | 4210e892 |
| BL-02 | P0 | CI 中 packages 未先构建致 import 解析失败 | ✅ | abed388d |
| BL-03 | P0 | db/mongo typecheck 必挂（tsconfig paths 矛盾） | ✅ | abed388d |
| BL-04 | P1 | Edge Runtime 拒绝 tracing.ts 的 eval("require") | ✅ | b25583e9 |
| BL-05 | P2 | 根脚本 pnpm codegen 损坏 | ✅ | abed388d |
| BL-06 | P2 | codegen 无 CI 门禁（漂移不可检测） | ✅ | abed388d |
| BL-07 | P2 | 提交版 generated.ts 与 schema 漂移 | ✅ | abed388d |
| BL-08 | P1 | RSC 引入 react-i18next 致 build 崩（createContext） | ✅ | b25583e9 |
| BL-09 | P0 | api 32 处潜伏 lint 错误（turbo 取消效应掩盖） | ✅ | 0aef412c |
| API-01 | P1 | onboarding 端点缺权限元数据，引导状态永不保存 | 🔧 | edf0c8cf |
| SEC-01 | **P0** | 任意 org 管理员可改**全局** vector 服务配置（token 外泄链） | 🔧 | 本轮（见 §3） |
| SEC-02 | P1 | vector 服务信任请求体 orgId（跨租户读写前提） | 👁 | — |
| SEC-03 | P2 | /api/metrics 全局数据未按 org 过滤 | ⬜ | — |
| SEC-04 | P2 | vector 内部 token 非常量时间比较 | ✅ | 见 §4 |
| BAPI-01 | P2 | GraphQL 列表无分页（全量返回） | ⬜ | — |
| FE-01 | P2 | alert-center 过滤器不入 URL（与全局模式不一致） | ⬜ | — |
| FE-02 | P2 | 死代码：zustand store/sidebar.ts | ⬜ | — |
| FE-03 | P2 | vitest coverage include 仅覆盖 3 个已测文件（覆盖率数字失真） | 🔶 | 部分（见 §3） |

## 3. 已修复条目（详细）

### BL-01 web lint 35 处错误 — ✅ 已修复【已复核】

- **流程/影响**：全流程（构建门禁）。CI 自 2026-08-15 引入从未绿过，主因之一。
- **复现**：基线 commit 上 `pnpm lint` → `@modular/web#lint` exit 1。
- **根因**：19 import/order + 10 array-type（自动修复）；6 unused-vars（analysis-workspace 的 Avatar/allTasks、war-map-symbols 的 mapStrokePath、war-map 的 readSummaryBoolean、access-settings 的 roles、realtime-signals 死变量）。
- **证据**：/tmp/web-lint-full.log（基线存档）；baseline.md §3.4。
- **修复**：`4210e892`（25 文件，含 eslint --fix 回归 TS1361 的 useEconomicData.ts 手工修正）。
- **回归验证**：CI gate `pnpm lint`（现全绿；run 33729250187 success）。

### BL-02 CI 构建顺序 — ✅ 已修复【已复核】

- **根因**：`packages/utils` 的 main/types 指向 dist/；CI 全新安装 lint 先于 build 执行 → import/no-unresolved ×16。
- **修复**：`abed388d` turbo.json：`lint.dependsOn:["^build"]`、`typecheck.dependsOn:["^typecheck","^build"]`。
- **回归验证**：CI run 33729250187（Node 20 干净环境）success。

### BL-03 db/mongo typecheck — ✅ 已修复【已复核】

- **根因**：`tsconfig.build.json` 显式 `"paths":{}` 覆盖了 tsconfig.json 的 `@modular/config`/`@modular/utils` 源码映射，而这两个包无 dist → TS2307。
- **修复**：`abed388d` 新增 `packages/{db,mongo}/tsconfig.typecheck.json`（paths 指向 src，参照 api/vector 先例），typecheck 脚本改用之。
- **回归验证**：`pnpm typecheck` 14/14 tasks ✅。

### BL-04 Edge Runtime eval — ✅ 已修复【已复核】

- **流程/影响**：F1（middleware 鉴权链）。web 生产构建失败 → 无法出包。
- **复现**：基线 `pnpm build` → `Dynamic Code Evaluation not allowed in Edge Runtime`（链路 middleware.ts → lib/auth.ts → lib/env.server.ts → @modular/utils → tracing.js）。
- **根因**：`packages/utils/src/tracing.ts:30` 用 `eval("require")` 动态加载 node:async_hooks；运行时有守卫但 webpack **静态检测**即拒绝。
- **修复**：`b25583e9` 改用 `process.getBuiltinModule("node:async_hooks")`（Node ≥20.16，打包器不可静态解析；CI Node 20.16+ 需确认——见 §6 风险）。
- **回归验证**：`pnpm build`（middleware 141 kB 产出）+ CI success。

### BL-05/06/07 codegen 三联 — ✅ 已修复【已复核】

- **BL-05**：根 `pnpm codegen` 指向不存在于根依赖的二进制 + 失效 codegen.yml（指向 localhost:4000 活体）→ 改指 `@modular/web run generate`、删除 codegen.yml、README 同步。
- **BL-06**：CI 无 drift 检查 → ci.yml 新增 `generate && git diff --exit-code apps/web/graphql/generated.ts`。
- **BL-07**：提交版 generated.ts 的 QueueStatsDocument 缺 `countsAvailable`（与同文件 TS 类型不一致，手改嫌疑）；消费方 system-health-context.tsx:205 → 重新生成提交。
- **回归验证**：CI 内建 drift gate + 本地 generate 后无 diff。

### BL-08 RSC 引入 react-i18next — ✅ 已修复【已复核】

- **流程/影响**：全流程（root layout 渲染）。build "Collecting page data" 阶段 `TypeError: createContext is not a function`。
- **根因**：`app/layout.tsx`（Server Component）→ `lib/i18n.ts` 顶层 import react-i18next → 其模块作用域调用 `React.createContext`（react-server 条件无此 API）。
- **修复**：`b25583e9` 拆分 `lib/i18n.ts`（服务端安全）与 `lib/i18n-client.ts`（"use client"），更新 4 个引用点。
- **回归验证**：`pnpm build` 全路由出包 + CI success。
- **教训**：与 BL-04 同为「门禁从未跑到」的潜伏失败——**修复一层后会暴露下一层**，分层修复后必须整链复跑。

### BL-09 api 32 处潜伏 lint — ✅ 已修复【已复核】

- **根因**：turbo 失败即取消：web lint 先挂 → api lint 被取消从未上报（基线报告初版误记为「通过」，已勘误）。
- **修复**：`0aef412c`（28 import/order + 1 array-type 自动；settings.resolver 两个退化映射改穷尽 switch；socket-error-payloads 删未用导入）。
- **回归验证**：`pnpm lint` 全绿（仓库首次）+ CI success。

### API-01 onboarding 死路由 — 🔧 已修复（静态闭环复核完成，运行时验证待远端）【已复核】

- **流程**：F7 个性化。**用户影响**：新用户引导完成状态永不保存——每次进入应用重新触发引导（welcome/onboarding-boundary 消费）。
- **复现**：登录态 `GET/PUT /api/user-settings/ui/onboarding` → 403 `PERMISSION_METADATA_MISSING`（全局 PermissionsGuard fail-closed）。
- **预期/实际**：预期返回/更新 per-user 引导状态；实际恒 403。
- **根因**：两个 handler 缺 `@Permissions` 装饰器（同 controller 其余 10 个端点均有）。
- **证据**：`user-ui-settings.controller.ts:110,116`（修复前）；前端 `onboarding-boundary.tsx:67,98`。
- **修复**：`edf0c8cf` 补 `@Permissions("items.read")`（与 5 组兄弟端点一致）。
- **本轮静态闭环复核（全链路）**：
  1. 权限元数据 ✅：GET/PUT 均带 `@Permissions("items.read")`（鉴权矩阵生成器 fail-closed 断言全库 0 死路由）。
  2. 上下文来源 ✅：orgId/userId 均取自 `@CurrentUser()`（JWT orgId claim → membership 重推导），无请求体信任。
  3. 前后端一致性 ✅：前端 `ONBOARDING_SETTINGS_PATH = "user-settings/ui/onboarding"` + axios baseURL（`/api` 前缀）→ 后端 `@Controller("user-settings/ui")` + 全局前缀；PUT 体 `{ settings: ... }` 与 DTO 唯一字段一致；GET 响应 envelope（version/updatedAt/settings）与前端类型镜像一致。
  4. 无保存后查询不到的字段差异 ✅：存储键 `ui:onboarding:settings:v1`（per org+user+key 唯一），normalize 白名单四步键（today/events/map/finance）两侧一致。
  5. 错误吞掉风险 ⚠️（登记，未改）：前端 `persistSettings`/GET 的 catch 只上报 telemetry（captureClientError），无用户可见提示——这正是原 403 长期不可见的原因。属前端 IA 重构（onboarding-boundary 拆分批次）处理项，不在本轮范围强行加 UI。
- **回归验证**：`user-ui-settings.controller.test.ts` 锚定 controller→service 契约；鉴权矩阵 CI 断言权限元数据存在。**真实数据库登录态冒烟（登录→完成引导→刷新）仍待运行时验证**。

## 4. 开放条目（待修复，按优先级排序）

### SEC-01 全局 vector 配置可被任意 org 管理员改写 — 🔧 已修复待 CI 验证【已复核】

- **流程**：F1/F2/F6。**用户影响**：跨租户向量数据读写 + 内部 token 外泄（多租户隔离破坏）。
- **攻击链**：① org-A 管理员（有 settings.manage）`PUT /api/system-settings/vector-service` 改 `baseUrl` 为攻击者服务器（该设置是**全局单例**，非 per-org）→ ② api 的 vector-client 向攻击者服务器发请求，**携带真实 `x-internal-token`**（token 外泄）→ ③ 攻击者用窃取的 token 调真实 vector 服务，配合 SEC-02（body orgId 任意填）读写任意 org 的向量。
- **证据**：`system-settings/vector-service-settings.controller.ts:33-40`（PUT 仅 `@Permissions("settings.manage")`——per-org 权限写全局设置）；`packages/vector-client/src/client.ts:127-131`（发送 x-internal-token）。
- **修复（本轮）**：PUT 与 DELETE handler 首行注入 `platformAccess.assertPlatformAdmin(user.id)`——复用 audit-log/email/task-log 设置控制器的既有模式（不新建第二套平台管理员判断）。GET 与 GET /diagnostics 保持 `settings.manage` 读取语义（合法内部调用与运维可观测不受影响）。
- **网络白名单（设计建议，未实施）**：baseUrl 修改后的网络边界加固（SSRF 白名单/私网段拦截）依赖部署拓扑（内网 DNS、服务网格策略各异），凭空硬编码可能破坏内网部署——建议方向：① 部署侧用 NetworkPolicy/egress 白名单限制 api 出口到 vector 服务网段；② 应用侧可选 `VECTOR_SERVICE_ALLOWED_BASE_URLS` 显式允许清单（平台管理员维护）。本轮只登记，不实施。
- **回归验证**：`vector-service-settings.controller.test.ts`（vitest，CI 执行）覆盖：非平台管理员的 settings.manage 持有者 PUT/DELETE → 403 且 service 未被调用；平台管理员 PUT/DELETE 正常；GET 不做平台校验（读取兼容）。**运行时（真实 DB/登录态）验证仍待远端集成环境**。
- **状态**：🔧 代码+测试已落地，CI 待跑；攻击链①（权限入口）已关闭，②的出口（baseUrl 指向）网络层建议见上。

### SEC-02 vector 服务信任请求体 orgId — 👁 观察项【勘察报告】

- **流程**：F2。**用户影响**：持内部 token 的调用方可指定任意 orgId 读写该 org 向量（多租户边界依赖上游自觉）。
- **证据**：`apps/vector/src/modules/vector/vector.controller.ts`（orgId 取自 body，Qdrant filter.must[0]）；audit-report BoundaryContract 项开放中。
- **决策记录（2026-09-03）**：Go 试点（apps/vector-go）保持同构——orgId 仍来自请求体，因为该服务的定位是**内部信任边界后的纯执行器**（调用方仅 apps/api，orgId 由其服务端推导）。真正的修复点在 SEC-01（防止外部因素劫持调用链）。若未来出现第二调用方，需引入按调用方身份推导 orgId 的接口约定。
- **注**：现实风险 = SEC-01 的后置条件；SEC-01 关闭后此项降级为架构约束记录。

### SEC-03 /api/metrics 未按 org 过滤 — ⬜ P2【勘察报告】

- **流程**：F6。**用户影响**：持 metrics.read 的用户可看到全局（跨 org）队列/运行指标。
- **证据**：`modules/observability/` metrics 端点（metrics.read）返回全局聚合。
- **修复方向**：明确该端点定位（平台级 → 收紧权限；org 级 → 按 orgId 过滤）；迁移保护网中列入鉴权矩阵。

### SEC-04 vector 内部 token 非常量时间比较 — ✅ 已修复【已复核】

- **证据**：`apps/vector/src/modules/internal-auth/internal-auth.guard.ts:22-29`（`===` 比较）；对照：litellm guard 用 `crypto.timingSafeEqual`（`common/internal-token.ts`）。
- **修复**：NestJS 版（`internal-auth.guard.ts`）与 Go 试点（`apps/vector-go/internal/httpapi/server.go` 的 `requireInternalToken`，`crypto/subtle.ConstantTimeCompare`）均已改为常量时间比较。**回归验证**：vector 11/11 测试 + vector-go 行为测试全过；lint/typecheck/build 绿。
- **注**：长度不同的短路（先比 byteLength）是可接受泄漏——token 长度由部署方控制。

### BAPI-01 GraphQL 列表无分页 — ⬜ P2【已复核】

- **流程**：F3/F5。**用户影响**：数据量增长后 alerts/newsEvents 查询内存与时延线性恶化；审计报告遗留项，确认仍开放。
- **证据**：`alerts.resolver.ts:29,49`（alertChannels/alertRules 全量返回）；`news-events.resolver.ts:80-105`（仅 limit 1..100 clamp，无 cursor/offset）。
- **修复方向**：契约演进（加可选分页参数、默认值保持现状）——属 schema 变更，走版本化并更新契约清单；**Go 迁移前不动**，避免双实现期契约漂移。

### FE-01 alert-center 过滤器不入 URL — ⬜ P2【勘察报告】

- **证据**：items/search/events 页过滤器全量 URL 同步；alert-center 自成一套内存态。**用户影响**：告警视图不可分享/不可刷新恢复。
- **修复方向**：前端 IA 重构第一批（统一 use-url-state 模式）。

### FE-02 死代码 store/sidebar.ts — ⬜ P2【勘察报告】

- **修复方向**：IA 重构时随 ActionRail 统一导航状态后删除。

### FE-03 vitest coverage include 失真 — 🔶 部分改善 P2【勘察报告】

- **证据**：vitest.config.ts coverage.include 仅列 3 个已测文件 → 47% 语句覆盖率是「已测文件内部」的数字，非全仓覆盖率。
- **本轮**：include 增至 6 个（+page-container.tsx / nav-mode.ts / action-rail-routing.ts——App Shell 第一批的可测原语）。**全仓 glob + 阈值重设仍待 FE-批3+（alert-center 试点时一并做，避免在巨型组件未拆分时用全仓阈值制造红 CI）**。

## 5. 观察项（非缺陷，迁移决策输入）

1. GraphQL Subscription 进程内 PubSub vs WS Redis adapter（水平扩容语义不一致）
2. crawl4ai legacy 与 hot/normal 双轨队列并存
3. itemPipeline DLQ 在 worker failed 事件中入队（非 BullMQ 原生语义）
4. 隐藏写入方：news-pipeline-crawl-bridge.service.ts:185-188（结果缺失时同步触发抓取）、CrawlTaskJanitor 直改状态
5. TopNav 589 行 / ActionRail 3 个重复图标 / newsnow 自加 1760px 宽度特例（IA 重构输入）

## 6. 风险与未验证登记

- **BL-04 的 Node 版本前提**：`process.getBuiltinModule` 需 Node ≥20.16。CI 当前 Node 20（latest tag，实际 ≥20.16）已验证通过；若未来 CI 固定到 <20.16 需回退方案。
- **API-01 / SEC 系列运行时验证**：需 Docker 数据库栈（本机未装 Docker），列入 Docker 可用后的第一优先验证项。
- 基线环境缺口（AISSTREAM_API_KEY 空、infra/docker/.env 缺失）不属代码缺陷，不入本台账。
