# Node 后端退役清单 · GO-NODE-RETIRE-001

本清单记录删除三个 Node 后端（`apps/api` / `apps/vector` / `apps/ais-relay`）、把默认开发、
镜像、编排与 CI 收口到 Go 后端，以及旧 CI 检查的替换去向。基线为开工时最新
`origin/main = e72440e186acbdf671be904cc98d1dd2f9858cbf`（#153 实际 merge）。

前置已核实实际合入并有普通 CI 通过：

- GO-CONTRACT-TOOLING-001 → #152 merge `f22e36ae`，`verify` / `vector-integration` /
  `api-go-user-settings-integration` success。
- GO-ONLY-RUNTIME-001 → #153 merge `e72440e1`，同上三主 job success。

本机只做静态阅读、diff、必要 `gofmt`；未安装依赖、未运行 build/test/lint/typecheck/vet/
Docker/服务，未执行真实迁移/seed/index/回填，未部署、未连外部服务。最终由普通 CI 验证精确
head。

## 1. 删除范围

| 类别 | 删除项 |
|---|---|
| 运行时应用 | `apps/api`（NestJS）、`apps/vector`（Node/Nest）、`apps/ais-relay`（Node relay） |
| 旧镜像 | `infra/docker/api.Dockerfile`、`infra/docker/ais-relay.Dockerfile`、`infra/docker/web.Dockerfile`（后两者无引用/仅 legacy） |
| Legacy/pilot 编排 | `infra/docker/legacy-rollback.env.sample`、`legacy-rollback.override.yml`、`api-go-cutover.env.sample`、`docker-compose.api-go-cutover.sample.yml`、`vector-go-pilot.override.yml`、`docker-compose.ais-startup-smoke.yml` |
| 手工 smoke/脚本 | 全部 38 个 `.github/workflows/*smoke*.yml`（35 个 `api-go-*-smoke`、`graphql-subscriptions-smoke`、`vector-go-pilot-smoke`）；`infra/scripts/src/ais-relay-startup-smoke.js`、`mock-ais-upstream.js`；`apps/vector-go/scripts/pilot-upstream-switch.cjs` |
| 根配置 | 根 `package.json` 的 `dev:legacy`、`docker:smoke:ais-relay-startup`；`test` 去 `@modular/vector` filter；`infra/scripts/package.json` 的 smoke 脚本；`pnpm-lock.yaml` 的 `apps/api` / `apps/vector` / `apps/ais-relay` 三个 importer |

根 `apps/*` glob 只保留 `api-go` / `vector-go` / `web`；`packages/*` 与 `infra/scripts`
workspace 不变。锁文件只移除三个 importer（-564 行），未删除整个锁文件、未升级全树、
未关闭 frozen-lockfile、未移除 Go module 漂移检查。

## 2. 能力保留去向（删除前逐项核对）

| 能力 | 旧入口 | 现在归属 | 消费者 / 验证 |
|---|---|---|---|
| GraphQL SDL | `apps/api/schema.gql`（Nest 生成） | `apps/api-go/internal/graphqlread/schema/schema.gql`（`//go:embed`，唯一权威） | Go 执行器 + Web codegen `apps/web/codegen.cjs`；`TestEmbeddedSchemaVersionMatchesSource`、`cutover_roots` 门禁、CI Web codegen 确定性/漂移 |
| OpenAPI 快照 | `apps/api/tests/contract/openapi.snapshot.json` | `apps/api-go/internal/apidocs/openapi.snapshot.json`（embedded，`/docs/json`） | Go 契约门禁 `TestEveryDocumentedHTTPOperationIsOwnedByGo` / `TestHTTPContractArtifactsAgree`；`apidocs` 资产测试 |
| 鉴权矩阵 | `apps/api/tests/contract/auth-matrix.{json,md}` | `apps/api-go/contracts/auth-matrix.{json,md}`（冻结的历史预期） | Go 契约门禁 `TestAuthMatrixPermissionStructure` + 真实 Go 路由表对照 |
| 邮件模板 | `apps/api/src/modules/email/templates/*.hbs` | Go 内联渲染（`authlogin/mailer.go`、`userdigest/delivery_email.go`、`alertworker/email.go`） | Go 运行不读旧 `.hbs`；随 `apps/api` 删除 |
| Mongo 索引/裁剪/回填 | `apps/api/scripts/*`（`@modular/api run mongo:*`） | `packages/mongo/src/cli/*`（`@modular/mongo`，`tsx` 直跑） | 根 `pnpm mongo:*`、compose `mongo-indexes`；行为由 `@modular/mongo` CLI 承担 |
| BullMQ/Telegram/Socket.IO 协议夹具 | 夹具在 apps/api 解析 `bullmq` | `@modular/infra-scripts`（锁定 `bullmq@5.63.2`） | 三个 Go 集成测试的 `command.Dir` 指 `infra/scripts`；Go 集成 job `pnpm install --filter @modular/infra-scripts...` |
| 精选 Telegram 频道目录 | `apps/api/.../telegram-channels.json` | `apps/api-go/internal/situationsignalsworker/telegram-channels.json`（embedded） | Go 运行时嵌入并校验；跨源同步已随删除移除 |
| Vendor Lua 来源/许可 | 各 `apps/api-go/internal/*/scripts/*.lua`（内嵌，含 NOTICE） | 不变 | 字节 SHA-256 断言继续有效 |
| 共享 Node 工具 | `packages/db`（Prisma schema/migrations/seed）、`packages/mongo`、`packages/utils`、`packages/config`、`packages/vector-client` | 全部保留 | 仍为 Node 工具，不要求 Go 化，不称其为 Node 后端 |

## 3. 构建 / 编排 / 本地启动

- `infra/docker/runtime.Dockerfile`：不再运行 Nest SDL 生成、不再构建三个旧 app；保留
  `pnpm install`、`@modular/db prisma:generate`，只 `turbo run build --filter=@modular/web`
  （web codegen 读已提交 Go SDL）。`NEXTAUTH_SECRET` 仍运行期注入，不是 build ARG。
- `infra/docker/docker-compose.yml`：删除 `api` / `vector` / `ais-relay` 服务与 `legacy-node`
  profile；默认链 `mysql → migrate → mongo-indexes → api-go → web`（外加 litellm 健康门）。
  `migrate` / `mongo-indexes` / `web` 继续用 `runtime.Dockerfile`。`api-go` 服务清空全部
  137 个 `API_GO_*_MODE` + `LEGACY_API_URL` + `CANARY_PERCENT` + `SHADOW_DEBUG_BODY_LOG`
  死键；保留真实资源/调用地址/第二道门。
- `infra/scripts/src/dev-config.ts` / `dev.mts`：`DevMode` 收为 `go | ais-relay`；删除
  `legacy` 分支与从迁移样例读取 137 开关的 `readModeOverlay`/`buildSwitchOverlay`；保留
  #151 已补齐的根 `.env` 加载、cwd 独立、每进程端口、共享资源/密钥、`DATABASE_URL`
  派生、信号/进程组关闭与错误码。`pnpm dev` 不会因样例删除而失败。
- `infra/scripts/src/docker-up.js`：移除 `api`/`vector` 服务名与 `api` 回退；Prisma 预检
  基于 `migrate` / `mongo-indexes` 工具镜像。
- `.env.example` 与 `infra/docker/.env.sample`：删除全部 `API_GO_*_MODE` / `CANARY_PERCENT`
  / `SHADOW_*` / `LEGACY_API_URL` / `dev:legacy` 示例；保留真实功能开关（`SCHEDULE_ENABLED`、
  `BULLMQ_WORKERS_ENABLED`、`WS_REDIS_ADAPTER_ENABLED`、`GRAPHQL_SUBSCRIPTION_BUS`、
  `REALTIME_SIGNALS_AIS_BASE_URL`、`VECTOR_SERVICE_*`、`AIS_RELAY_*` 等）。

## 4. 旧 CI → 新验证矩阵

| 旧默认 CI 步骤 | 处理 | 新位置 / 说明 |
|---|---|---|
| `@modular/vector test`（Nest Vitest） | 退役 | 由真实 **Go 单端 + CI Qdrant** 契约测试替代（见下） |
| `@modular/api test`（Nest SEC-01/API-01/路由扫描） | 退役实现单测 | 业务约束改由 Go 单端验证：路由/权限结构→`Go contract gate`；SEC-01（vector-service 全局单例 + platform admin）与 API-01（onboarding `items.read`）→`Go tests` 中的 `internal/infrastructuresettings` / `internal/usersettings` 单元测试；authn/authz 与限流→集成 job `TestAuthZMySQLIntegration` 及分域集成；GraphQL root→`internal/graphqlread` cutover_roots。未删除任何安全回归。 |
| OpenAPI 快照双冷进程确定性 + 与 Nest 基线比对 | 改写 | Nest 不再生成；OpenAPI 为 Go-owned 冻结历史预期，由 `Go contract gate` 对照真实 Go 路由表。确定性检查转移到唯一剩余生成物 Web 客户端：`Web GraphQL codegen determinism (Go SDL source)` 两冷进程生成 + `cmp` + `git diff`。 |
| Auth matrix drift（Nest 装饰器扫描） | 改写 | `Go contract gate` 的 `TestAuthMatrixPermissionStructure` 校验四态权限结构与真实注册。 |
| GraphQL SDL drift（Nest `generate:schema` + `git diff apps/api/schema.gql`） | 改写 | Go SDL 是唯一源；`cutover_roots` 校验 root 与注册，Web codegen 确定性/漂移校验 `generated.ts`。 |
| `Contract copies in sync (transition)`（Go 副本 vs Nest 副本 `cmp`） | 删除 | 过渡守护随 `apps/api` 删除；跨源比较无对象。 |
| `Go contract gate`（OpenAPI/auth-matrix vs Go 注册） | 保留 | 不变。 |
| `Go tests`（api-go + vector-go） | 保留 | 不变（含 config/路由/契约/业务约束单测）。 |
| `Build`（turbo filter 含 ais-relay/api/vector） | 改写 | 仅 `@modular/web` / `@modular/api-go` / `@modular/vector-go`。 |
| `vector-integration`（Nest vector vs vector-go 差分） | 改写 | 真实 Qdrant 上的 **Go 单端** `TestVectorContractIntegration`：`/healthz`、`/v1/upsert`、`/v1/search`、`x-internal-token`、orgId 过滤、400/401 错误；预期为独立断言，不由同一次响应生成。 |
| `contract-baseline-regen`（Nest 三生成器 + 复制到 Go 副本） | 改写 | 从已提交 Go SDL 重新生成 `apps/web/graphql/generated.ts` 并提交；OpenAPI/auth-matrix 冻结，不再由 Nest 扫描。 |
| `go-modules-regen` / Go 模块漂移门禁 / frozen-lockfile | 保留 | 不变。 |
| Qdrant/MySQL/Redis/Mongo/BullMQ 集成 job 的 `pnpm install --filter` | 保留 | 已是 `@modular/infra-scripts...`（bullmq 5.63.2），不因删 API 目录跳过。 |

## 5. 手工 smoke workflow 退役与验证去向

38 个 `*smoke*.yml` 均为 **label / workflow_dispatch 手动触发、从不进入普通 CI**，且都以
启动真实 NestJS（`@modular/api` / `apps/vector` / `apps/ais-relay`）作为 legacy 基线做
双端差分。Nest 删除后这些差分对象不存在，故整体退役。**这不是等价迁移**：被退役的是
“Nest↔Go 差分”本身；Go 侧单端行为（REST / GraphQL / 订阅 / WS / worker / 租户）由普通
CI 的真实服务 Go 集成测试与契约门禁覆盖：

| smoke 文件域 | 覆盖去向（普通 CI） |
|---|---|
| `api-go-account-security` / `auth-factors` / `api-go-entry` / `oidc` 等身份相关 | `verify` Go 单测（`internal/usersettings`、`internal/infrastructure…`）+ 集成 job `TestAuthZMySQLIntegration`/`TestUserSettingsMySQLIntegration` |
| `api-go-rbac` | `internal/authz` 集成 + `Go contract gate`（权限结构） |
| `api-go-items-reading` / `item-pipeline` / `news-*` / `classification-*` | 集成 job 的 `itemsingest`/`itempipeline`/`newseventsingest`/`newsbackfilljobs`/`qualityqueue` 等真实 MySQL/Redis/Mongo 步骤 |
| `api-go-crawl-*` / `frontier-*` | 集成 job `crawlworker`/`crawlexecution`/`crawlfrontierruns`/`crawlfrontiernode`/`crawlmaintenance` |
| `api-go-situation-*` / `stream-healthz` / `spacetime` / `war-map` | 集成 job `situationsignals`/`situationssignalsworker`/`dashboardspacetime`/`realtimesignals` |
| `api-go-llm-*` / `model-access` / `infrastructure-settings` / `data-runtime-settings` | 集成 job `emailsettings`/`geocoding`/`runtimediagnostics`/`llm…`、`internal/infrastructuresettings` |
| `graphql-subscriptions-smoke` | 集成 job `realtimeintegration`（`TestRealtime`，多 namespace/租户/广播） |
| `vector-go-pilot-smoke` | 新的 `vector-integration` Go 单端 Qdrant 契约测试 |

**剩余边界（如实记录）**：这些手动栈的“多进程同时起真实 Nest + 真实 Go + 真实外部依赖”
组合没有逐条复刻；Go 单端集成与契约门禁不声称等价于原差分；任何原 smoke 中依赖真实外部
服务（SMTP/LiteLLM/Telegram/OREF/OpenSky 等）的断言未在本批新增，仍属未运行验证。

## 6. 静态复核结论

- 默认 / 开发 / compose / CI / 工具链对旧 app 的可执行引用为零：仓库内仅剩历史注释
  （如 `packages/mongo/...` 注释与 `docs/refactor/**` 历史快照），无 `apps/api/dist`、
  `node apps/vector/dist/main.js`、`@modular/api` 等可执行调用。
- `pnpm-lock.yaml` 只移除三个 importer；其余 importer 依赖未变，`pnpm install
  --frozen-lockfile` 由普通 CI 验证。
- `docker-compose.yml` 与 `ci.yml` 通过 YAML 解析；所有 `package.json` 通过 JSON 解析；
  `.env.example` / `infra/docker/.env.sample` 无重复键、无残留 mode 赋值。
- 新 Go 契约测试通过 `gofmt`；未能本机编译，交由普通 CI `vector-integration` 验证。

## 7. 已知残留与边界（未统一关闭 GAP）

- GAP-EXCEPTION-WIRING-001：#150 自写 500/unknown/stack 异常记录仍有残留，未因大删源码
  统一关闭。
- GAP-ASYNC-001：运行证据（真实多实例 / 外部服务）仍缺失；默认启用值与真实执行权未在
  本批运行验证。
- 本阶段只证明“仓库已移除 Node 后端与迁移过渡结构，源码/CI 完成”，不声称已部署、真实流量
  或外部调用已验证。
