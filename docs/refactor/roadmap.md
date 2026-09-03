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

## M2 契约保护网 + Go 骨架（下一里程碑，本轮后续任务）

1. **契约快照落地**：OpenAPI 导出 + `apps/api/schema.gql` 冻结 diff 进 CI（`tests/contract/`）
2. **鉴权矩阵生成**：由 api-contract-inventory §1 生成 369 端点 × 4 态断言表；先以 NestJS 自身为被测对象跑通（自证矩阵正确），Go 上线后复用
3. **`apps/api-go/` 骨架**：cmd/api + platform（httpx/authn/authz/config）+ legacyproxy 全量兜底 + 四态路由表（legacy 默认）；`migrations/README.md` 声明禁改 schema
4. **vector Go 重写试点**（迁移序 1）：3 端点 + x-internal-token（常量时间比较，顺修 SEC-04）+ orgId 推导（顺修 SEC-02 语义）+ 差分测试 + 回滚开关（env 切换 vector 上游）
5. 验收：Go 骨架 shadow 模式下 health/public-portal 请求差分 0 失败；vector Go 版通过全部契约用例

## M3 安全修复批次（与 M2 并行，纯 NestJS 侧）

| 项 | 动作 | 回归验证 |
|---|---|---|
| SEC-01（P0） | vector-service 设置改平台管理员专用（platformAccess），或全局/per-org 分离 | 非 platform admin 的 settings.manage 持有者 PUT → 403 |
| SEC-03 | /api/metrics 定位决策（平台级收紧 or org 过滤）+ 实施 | 鉴权矩阵对应行 |
| API-01 运行时验证 | Docker 栈就绪后：登录→完成引导→刷新不重现 | 手工冒烟清单 |
| BAPI-01 | **决策冻结**：Go 迁移前不动 schema；列入 GraphQL 迁移序（M5）的版本化演进 | — |

## M4 前端第一批（App Shell + 代表页）

1. FE-批1：设计 token 收敛 + AppShell/PageContainer/DataStateBoundary/useUrlState 原语
2. FE-批2：ActionRail 5 组化 + TopNav 拆分 + 图标去重 + newsnow 宽度特例收敛
3. FE-批3：alert-center 重构（顺修 FE-01 URL 状态）——代表页试点 1
4. FE-03：vitest coverage include 改全仓 glob，阈值按真实基线重设
5. 验收：真实覆盖率报告 + 试点页人工冒烟 + lint/typecheck/test 绿

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

## 立即可做的下一轮最小任务（M2 起步）

1. OpenAPI 快照导出脚本 + CI diff 步骤
2. 鉴权矩阵生成脚本（读 controller 装饰器元数据 → JSON 断言表）
3. apps/api-go 骨架（legacyproxy 兜底 + healthz 端点 + Dockerfile）
4. vector Go 实现契约用例（先写测试）
