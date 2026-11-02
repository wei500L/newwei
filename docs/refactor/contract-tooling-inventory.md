# 契约、运维工具与协议夹具迁出清单 · GO-CONTRACT-TOOLING-001

本清单记录本批从待删除 Node 后端（`apps/api` / `apps/vector` / `apps/ais-relay`）迁出的
契约、可运行运维工具、邮件资源与协议夹具，以及**有意保留到第三步**的依赖。基线
`origin/main = fcf1e5334acb0350ea36535c48c4131df7c9698a`（#151 实际 merge）。

每项按“旧入口 → 新入口 → 真实消费者 → 验证”记录；本机只做静态阅读/diff/必要 gofmt，
未安装、未运行 build/test/lint/typecheck/vet/Docker/服务，未部署、未连真实外部依赖。

## 1. 契约

| 契约 | 旧入口 | 新入口（权威） | 真实消费者 | 验证 |
|---|---|---|---|---|
| GraphQL SDL | `apps/api/schema.gql`（Nest `generate:schema` 生成） | `apps/api-go/internal/graphqlread/schema/schema.gql`（`//go:embed`，`schema.Version` = 内容 SHA-256） | Go 执行器 `schema.Load()`；Web codegen `apps/web/codegen.cjs` → `generated.ts`；根覆盖门禁 `graphqlread/cutover_roots_test.go` | `TestEmbeddedSchemaVersionMatchesSource` / `TestSchemaLoads`；CI “GraphQL codegen drift check”与“Contract copies in sync” `cmp`；见 `schema/PROVENANCE.md` |
| OpenAPI 快照 | `apps/api/tests/contract/openapi.snapshot.json` | `apps/api-go/internal/apidocs/openapi.snapshot.json`（`//go:embed`，`/docs/json` 原样返回） | api-go `apidocs` 处理器 | `assets_test.go` 文档契约/资产一致性；新增 Go 契约门禁；CI “Contract copies in sync” `cmp`；见 `apidocs/PROVENANCE.md` |
| 鉴权矩阵 | `apps/api/tests/contract/auth-matrix.{json,md}` | `apps/api-go/contracts/auth-matrix.{json,md}`（注明基线 SHA 的历史预期） | Go 契约门禁 `legacyproxy/contract_registration_test.go` | `TestAuthMatrixPermissionStructure` + `TestEveryDocumentedHTTPOperationIsOwnedByGo`；CI “Contract copies in sync” `cmp`；见 `contracts/PROVENANCE.md` |
| Web codegen | 默认 schema `../api/schema.gql` | `../api-go/internal/graphqlread/schema/schema.gql` | `@modular/web` `generate`（predev/prebuild） | 两副本本批逐字节相同（SHA-256 `656ebe86…`），`generated.ts` 输出不变；CI codegen drift |

### 独立 Go 契约门禁（不是“快照与自身比较”）

`apps/api-go/internal/legacyproxy/contract_registration_test.go` 用**实际全量 Go 规则表**
`allGoRules()`（与 `cmd/api/main.go` 同一批 `With*` 构建器装配）逐条校验：
OpenAPI 与鉴权矩阵中的每个 `METHOD + 完整路径`（`{param}`/`:param` 归一化后）必须命中
`ModeGo` 规则且不落到 `/api/` 兜底；并校验两件静态制品路由集合一致、鉴权矩阵四态权限结构
自洽（公开/仅认证无 permission，权限门控必带 permission + any/all）。这样，Go 侧新增/遗漏/
错误分类会直接失败，而不是比较两份人工表。orgId 与运行期权限值仍由运行时/权限行为测试覆盖，
本批不声称已验证。

## 2. 运维工具（不再需要 Nest 应用模块）

| 能力 | 旧入口 | 新入口 | 真实消费者 | 验证 |
|---|---|---|---|---|
| Mongo 运行时索引补齐 | `pnpm --filter @modular/api run mongo:indexes`（`apps/api/scripts/ensure-mongo-indexes.ts`） | `@modular/mongo` `mongo:indexes`（`packages/mongo/cli/ensure-mongo-indexes.ts`） | 根 `pnpm mongo:indexes`；compose `api` 服务启动前 | 行为保留（RawItem sync，其余 createIndexes）；`tsx` 直接运行 |
| Mongo 旧索引清理 | `…@modular/api run mongo:indexes:prune` | `@modular/mongo` `mongo:indexes:prune`（`prune-mongo-indexes.ts`） | 根 `pnpm mongo:indexes:prune` | 行为保留（精确 name+key、key 不匹配保留、Namespace/IndexNotFound 幂等） |
| processed-item hasLocation 回填 | `…@modular/api run processed-item-location:backfill` | `@modular/mongo` `processed-item-location:backfill`（`backfill-processed-item-has-location.ts`） | 根 `pnpm mongo:backfill:processed-item-location` | 参数/默认值/dry-run/org 范围/批量写/失败退出保留；去 zod 后等价校验 |
| raw-item 可比 URL 回填 | `…@modular/api run raw-item-urls:backfill` | `@modular/mongo` `raw-item-urls:backfill`（`backfill-raw-item-comparable-urls.ts`） | 根 `pnpm mongo:backfill:raw-item-urls` | 参数/dry-run/resume 游标/批量写/失败退出保留 |

- 工具源码放在 `packages/mongo/cli/*.ts`（**不在 `src` 内**），用 `tsx` 直接运行：与旧
  `apps/api/scripts` 一样不纳入 tsc 类型检查与 eslint（旧脚本目录本就被 `tsconfig.build`
  的 `exclude: scripts` 排除），避免把大量未类型检查的脚本迁入严格包后引入无关类型改动；
  同时 `@modular/mongo` 的 `lint`/`typecheck` 仍只覆盖 `src`。`tsx` 为仓库根 devDependency，
  Docker 运行时镜像的 `pnpm install`（非 `--prod`）已包含；`runtime.Dockerfile` 无需额外构建步骤。
- 根 `package.json` 四条命令、`infra/docker/docker-compose.yml` 的 `api` 服务内联索引步骤与独立
  `mongo-indexes` 服务均已改指 `@modular/mongo`。
- Prisma migrate/seed 与共享 Mongo 包继续为 Node，本批不改 DDL、不执行真实索引/回填/seed。
- 未纳入根命令、仍与 Nest 内部实现耦合的工具（`economic:fetch`→Nest `AkshareService`、
  `knowledge-graph:reviews:reconcile`→Nest `AppModule`、`fingerprint:backfill`→
  `apps/api/src/modules/crawl/url-fingerprint`、`vector:backfill`→`@modular/vector-client`）
  本批**不搬迁**：它们要么已被 Go 经济数据/知识图谱实现取代，要么依赖 Nest 业务源码，
  删除 `apps/api` 时随目录一并退役；若仍需保留的能力，须单独核对 Go 等价物后再决定
  （见 §6）。

## 3. 协议夹具（独立解析锁定依赖）

| 夹具 | 旧解析 cwd | 新解析 cwd | 依赖（锁定） | 验证 |
|---|---|---|---|---|
| `analysis_queue_fixture.mjs` | `apps/api`（`bullmq` 由 `@modular/api` 提供） | `infra/scripts`（`@modular/infra-scripts`） | `bullmq@5.63.2`（精确锁定，复用既有快照） | Go 集成 job 改 `pnpm install --frozen-lockfile --filter @modular/infra-scripts...`；`analysisruns` 集成测试 Node↔Go 双向 |
| `situation_scheduler_fixture.mjs` | 同上 | 同上 | 同上 | `situationsettings`/`telegramsched` 集成测试 |

- 三个 Go 集成测试的 `command.Dir` 已从 `apps/api` 改为 `infra/scripts`；`infra/scripts/package.json`
  新增 `bullmq: 5.63.2`，`pnpm-lock.yaml` 的 `infra/scripts` importer 精确补齐（不升级、不新增
  其它依赖）。不需要因此保留 Node HTTP 后端。

## 4. 邮件模板与其它运行资源

- `apps/api/src/modules/email/templates/{verification-code,verification-code.text,alert,alert.text,user-digest,user-digest.text}.hbs`
  均已在 Go 侧**移植为内联渲染**，Go 不读取这些 `.hbs`：
  - verification-code：`apps/api-go/internal/authlogin/mailer.go:65,92`（HTML/Text）。
  - user-digest：`apps/api-go/internal/userdigest/delivery_email.go:178,209`。
  - alert：`apps/api-go/internal/alertworker/email.go`（`RenderAlertHTML/RenderAlertText`）。
  - 结论：这些 `.hbs` 属 Nest 专属资源，随 `apps/api` 删除；Go 运行不依赖旧目录。本批不改其内容。
- 精选 Telegram 频道目录 `apps/api/src/modules/situation-monitor/signals/telegram-channels.json`
  已由 Go **嵌入为运行时权威副本** `apps/api-go/internal/situationsignalsworker/telegram-channels.json`
  （`//go:embed`，`telegram.go` 内解析并算哈希）。Go 不再读取旧目录；本批把旧测试
  `TestTelegramChannelsMatchesNest` 改为校验嵌入目录可解析（`TestTelegramChannelsEmbeddedCatalogValid`），
  跨源字节一致性改由 CI “Contract copies in sync” `cmp` 过渡保证（基线两副本逐字节相同）。

## 5. Vendor Lua（来源与许可证）

- BullMQ 5.63.2 展开脚本已内嵌在各 `apps/api-go/internal/*/scripts/*.lua`，各有 `NOTICE`/`NOTICE.md`
  记录来源、MIT 许可证与展开方式；`queueorgstats/tracker_test.go`、`archivepreparationworker/retry_test.go`
  等用 SHA-256 固定脚本字节。**本批不改、不重新格式化上游脚本、不删 NOTICE**；字节哈希检查继续有效。

## 6. 有意保留到第三步（GO-NODE-RETIRE-001）的旧目录依赖

- 普通 CI 的 Nest 生成/对照步骤：`pnpm --filter @modular/api test|run generate:schema|run
  contract:openapi:snapshot|run contract:auth-matrix:check`；`Build` 构建 `@modular/api`。
- 大量 `api-go-*.smoke.yml` 以 `@modular/api` 启动 Nest 做双端对照（旧服务对照 job）。
- `infra/docker/runtime.Dockerfile` 仍构建 `ais-relay/api/vector/web` 三个 Node 后端并
  `pnpm --filter @modular/api run generate:schema`（Nest 运行时需要；Go 镜像 `api-go.Dockerfile`
  独立，只构建 Go 二进制）。
- `apps/api/scripts/` 中被搬迁脚本的原件（本批保留，随目录删除），以及与 Nest 业务源码耦合的
  `economic:fetch` / `reconcile` / `fingerprint` / `vector:backfill` 工具。
- 这些均为**有意保留**，不是遗漏；第三步删除 `apps/api` 时须同步移除 CI 的“Contract copies in sync”
  过渡步骤与上述生成/对照步骤。

## 7. 给第二步（GO-ONLY-RUNTIME-001）的接口

- 契约权威已在 Go 侧：SDL `internal/graphqlread/schema/schema.gql`、OpenAPI
  `internal/apidocs/openapi.snapshot.json`、鉴权矩阵 `contracts/auth-matrix.{json,md}`；第二步不再改
  这些路径，可直接以“Go 单端”验证替换 Nest 对照。
- 独立 Go 契约门禁命令：`cd apps/api-go && go test ./internal/legacyproxy/ -run
  'TestEveryDocumentedHTTPOperationIsOwnedByGo|TestHTTPContractArtifactsAgree|TestAuthMatrixPermissionStructure'`。
- 过渡同步步骤（`Contract copies in sync`）与 `contract-baseline-regen` 的 Go 复制步骤，应在删除
  `apps/api` 时移除/改写；生成边界见三份 `PROVENANCE.md`。
- 协议夹具解析入口：`@modular/infra-scripts`（bullmq 5.63.2），无需 `@modular/api`。
