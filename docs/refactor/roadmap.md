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

## M2 契约保护网 + Go 骨架 —— 🔶 进行中（2026-09-03 起步；本轮推进四态与契约快照）

| 项 | 状态 |
|---|---|
| 3. `apps/api-go/` 骨架：legacyproxy 全量兜底 + 四态路由表 + trace 中间件 + `/__go/healthz` 自省 | ✅ 首版落地（纯标准库；7 组网关行为测试 + 真进程冒烟：路径/查询/头原样代理、go 路由不触达上游、502 fail-safe、trace 透传） |
| 4. vector Go 重写试点 | ✅ 首版落地（`apps/vector-go/`：3 端点契约等价、30 个行为测试镜像 NestJS 11 用例、常量时间 token 比较；真进程冒烟通过）。**部署切换与 Docker 接线** ✅ 代码落地（vector-go.Dockerfile + compose `go-pilot` profile + CI 真实 Qdrant 集成 job），远端验证待 CI（回滚开关 = vector 服务 baseUrl 配置，见 main.go 头注） |
| Go 工具链接入 CI（setup-go + build filter + 独立 test 步骤） | ✅ |
| 1. 契约快照落地：OpenAPI 导出 + schema.gql 冻结 diff 进 CI | ✅ 本轮（静态装饰器扫描生成，`apps/api/tests/contract/openapi.snapshot.json`，370 端点/294 路径；CI `git diff --exit-code` 漂移门禁；确定性双跑验证同 hash） |
| 2. 鉴权矩阵生成（370 端点 × 4 态） | ✅ 本轮（`tools/scan-routes.ts` 静态扫描 71 controller/370 端点 → `tests/contract/auth-matrix.{json,md}`；生成时 fail-closed：缺权限元数据即失败；CI 漂移检查） |
| shadow/canary 四态实现 | ✅ 本轮（shadow：NestJS 响应 + Go 异步差分，超时/体积/并发/速率四预算，只读方法白名单；canary：orgId 稳定哈希分桶，无 token 回 legacy，CANARY_PERCENT 配置；首个迁移单元 `GET /api/healthz/live` 进 shadow 态） |
| api 首个 Go 单测基座 | ✅ 本轮（apps/api 接入 vitest：SEC-01/API-01 控制器回归测试 + 路由扫描器行为测试，CI 步骤 `pnpm --filter @modular/api test`） |
| vector-go 远端 Qdrant 集成 | 🔧 代码落地（CI `vector-integration` job：真实 Qdrant v1.10.1 service + NestJS/vector-go 双服务 + `vector-go-diff.test.ts` 契约差分 11 组用例：状态码/错误体/json.Number 精度/collection 命名/UUID 稳定性/orgId filter/空数组/错误输入/trace header）——**远端执行待 CI 首跑** |

余项（按序）：
1. CI 首跑闭环：OpenAPI 快照 diff、鉴权矩阵 fail-closed、api/vitest、vector-integration 四个门禁全绿
2. shadow 差分在真实流量的零差异验收（M5 迁移序 2 的 shadow 起步）
3. 第二个迁移单元（user-settings 只读 GET → shadow）

## M3 安全修复批次（与 M2 并行，纯 NestJS 侧）

| 项 | 动作 | 回归验证 | 状态 |
|---|---|---|---|
| SEC-01（P0） | vector-service 设置 PUT/DELETE 注入 platformAccess.assertPlatformAdmin（复用 audit-log 模式） | `vector-service-settings.controller.test.ts`：非平台管理员的 settings.manage 持有者 → 403；平台管理员 → 通过；GET 不受影响 | 🔧 代码+测试落地，CI 待跑；网络白名单只登记设计建议（见 bug-ledger §SEC-01） |
| SEC-03 | /api/metrics 定位决策（平台级收紧 or org 过滤）+ 实施 | 鉴权矩阵对应行 | ⬜ |
| API-01 运行时验证 | Docker 栈就绪后：登录→完成引导→刷新不重现 | 手工冒烟清单 | 🔧 静态闭环复核完成（本轮），运行时待数据库栈 |
| BAPI-01 | **决策冻结**：Go 迁移前不动 schema；列入 GraphQL 迁移序（M5）的版本化演进 | — | — |

## M4 前端第一批（App Shell + 代表页）—— 🔶 本轮起步（FE-批1 子集落地）

| 项 | 状态 |
|---|---|
| FE-批1（原语）：PageContainer 宽度档位原语（default/wide/wide-board=1760/article/full + 边距策略）+ 行为测试 | ✅ 本轮 |
| FE-批2（子集）：newsnow 1760px 特例收敛（12 处硬编码 → NewsnowBoardContainer/PageContainer）+ news-hub 1200px 双重约束修复 + ActionRail 4 组图标语义唯一化 | ✅ 本轮 |
| FE-批1（其余）：design/tokens.ts 收敛、DataStateBoundary、useUrlState | ⬜ 下轮 |
| FE-批2（其余）：ActionRail 5 组化 + TopNav 9 职责拆分 | ⬜ 下轮（TopNav 589 行拆分单独一批） |
| FE-批3：alert-center 重构（顺修 FE-01 URL 状态）——代表页试点 1 | ⬜ |
| FE-03：vitest coverage include 改全仓 glob，阈值按真实基线重设 | 🔶 部分（include 3→6；全仓阈值待巨型组件拆分批次） |
| 验收：真实覆盖率报告 + 试点页人工冒烟 + lint/typecheck/test 绿 | lint/typecheck 静态绿（本轮）；test/coverage CI 验证 |

## M5 Go 迁移推进（只读 → CRUD → GraphQL）

- 迁移序 2（health/public-portal/dashboard 只读）→ 序 3（用户偏好 CRUD）→ 序 4（GraphQL 层，含 BAPI-01 版本化分页决策）
- 每单元：shadow 差分 0 失败 → canary（按 org 哈希）→ go；NestJS 对应路由保留 2 个发布周期
- WS 六 namespace 的事件契约快照进保护网

## M6 前端第二批（巨型组件拆解）

- FE-批4：war-map 重构（试点 2，验证原语够用）→ FE-批5+：task-detail/CreateCrawlTaskDrawer/realtime-signals/crawl-monitor/quality 分批
- 直接 fetch → 类型化客户端迁移（10 文件）；FE-02 死 store 删除

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

## 立即可做的下一轮最小任务（M2 余项）

1. CI 首跑闭环：OpenAPI 快照 diff / 鉴权矩阵 fail-closed / api vitest / vector-integration 四门禁全绿后合并节奏回归
2. shadow 差分真实流量验收（首个单元 /api/healthz/live 0 差异 → canary 起步）
3. 第二个迁移单元：user-settings 只读 GET（shadow 模式）
4. FE-批1 剩余原语（design/tokens.ts、DataStateBoundary、useUrlState）与 TopNav 拆分
