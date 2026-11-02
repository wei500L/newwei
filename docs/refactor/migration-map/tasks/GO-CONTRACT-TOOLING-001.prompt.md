# 第一步：契约、运维工具与协议夹具脱离待删除 Node 后端

在 `wei500L/newwei` 执行 **GO-CONTRACT-TOOLING-001**。#151 已实际合入，下一阶段目标是删除 Node 后端与迁移过渡结构。本任务先迁出不能随目录一起删除的资产，并给真实 Go 实现保留有效检查。**本批不删 Node app，不删 legacyproxy/shadow/canary，不重写业务功能。**

## 1. 基线与任务恢复

读 AGENTS、迁移地图 README/PLANNING/GAPS、任务索引、本任务和 #151 最终 PR 描述；规划记录在 **PR #149**，如未合入，从该 PR 只读取得，不为读规划合并整个规划分支。

`git fetch origin main`，核对精确 main、开放 PR、认领、worktree 和普通 CI。规划基线 `fcf1e5334acb0350ea36535c48c4131df7c9698a` 为 #151 实际 merge，源 head `e48a25725603e2d7a02088b696599dbf28b0131b` 已验证为 main 祖先；源 head 普通 CI 41199618477 三主要 job success、两个 regen skipped。merge CI 41200907795 在规划时尚未完成，先查真实结果，不称基线全绿。

#151 已补齐根示例 4020、新 Socket.IO 路径、137 个 go/reject mode、本地 dev 启动器/环境加载与完整旧链回退，不再重派这项。复用/创建本任务独立 worktree，分支 `codex/go-contract-tooling`。有实际重叠认领时先核对范围；不碰其他会话改动。

## 2. 先做精确依赖清单，随后实际迁出

检查所有**可执行依赖**：Web codegen、Go `go:embed`/ReadFile/测试、Node fixture 的模块解析与 cwd、根命令、Docker builder、compose migrate/index 工具、CI/再生成器。区分源码注释/历史文档中的 Nest 参考与实际路径依赖，不能为清零 grep 大改历史注释。

已核实入口（行号开工重新确认）：

- `apps/web/codegen.cjs` 默认 schema 为 `../api/schema.gql`。
- `apps/api-go/internal/graphqlread/schema/schema.go` 已 embed 自身 `schema.gql`，但 `schema_test.go` 仍读 `apps/api/schema.gql`；`internal/apidocs/assets_test.go` 仍读 `../../../api/tests/contract/openapi.snapshot.json`。
- `apps/api/tests/contract/{openapi.snapshot.json,auth-matrix.json,auth-matrix.md}`、`apps/api/tools/{scan-routes,generate-auth-matrix,check-auth-matrix}` 与 `apps/api/scripts/generate-{graphql-schema,openapi-snapshot}.ts` 依赖 Nest 控制器/装饰器。OpenAPI 是既有**路由/权限/状态码快照**，请求/响应 DTO 模型并不完整，迁移后仍如实保留能力边界。
- `internal/legacyproxy/testdata/nest-routes.txt`、`internal/graphqlread/testdata/nest-graphql-roots.txt` 与相应覆盖测试是重要覆盖基线，不能随旧源码一起消失。
- 根 `mongo:indexes` / `mongo:indexes:prune` / 两个 `mongo:backfill:*` 命令仍指 `@modular/api`；compose `mongo-indexes` 服务也是如此。`apps/api/scripts/ensure-mongo-indexes.ts` 等可通过现有共享 Mongo 包工作，不应为索引操作启动 Nest。
- `infra/docker/runtime.Dockerfile` 仍生成 Nest schema、构建三个 Node 后端；普通 CI 仍执行 API 单测、Nest 快照生成与向量双端对照；Go 集成 job 通过 `pnpm install --filter @modular/api...` 获取锁定 BullMQ 夹具依赖。

清单必须涵盖其它被调用的 backfill/reconcile/索引工具、邮件模板/资源、Node 协议片段、vendor Lua 来源与许可证。不能只搬三份 JSON 就称已可删目录。

## 3. 契约与 Go 检查

让 Web 与实际 Go 运行时使用明确的 Go 所有契约。优先沿用 Go 已 embed 的 SDL/OpenAPI 文件作为权威入口，或用一个清晰的 Go contracts 目录加受检查的 embed 副本；避免新增多份无同步保证的副本。初次搬迁保留字节/字段、原来源 SHA 与生成边界，不顺手改 schema、权限或响应；Web codegen、Swagger、缓存 schema version/哈希、契约 regenerate/check 命令与 CI 路径一并接通。

鉴权矩阵/路由清单与 Query/Mutation/Subscription 必须有可持续的 Go 对照：从实际注册/具名元数据与现有权限判定获得检查输入，必要时只暴露少量只读注册信息，不改变 handler 行为。覆盖 METHOD+完整路径、公开/认证/平台门、权限 any/all、GraphQL 根/字段、订阅与机器令牌的现行边界；orgId 约束不能由路由存在替代。

**不能把旧生成器改成读静态基线再原样输出并自比，也不能只比较两份人工表。** 静态 OpenAPI 可以继续人工维护，但应通过实际 Go 路由/注册与必要权限行为测试发现新增、遗漏、错误分类；不把 unresolved schema 改成虚构完整模型。不为迁移引入新的通用鉴权框架。Nest 扫描产物可作为注明 SHA 的历史预期，Go 当前事实另行校验。

保留已有普通 CI 的 Nest 生成/对照步骤，同时增加/接通独立 Go 契约检查；本批不提前裁掉旧基线。给后两批留下确定的生成/check 命令、路径与可维护元数据，而不是只有报告。既有 contract-regen job 的迁移方案要具体，避免未来仍 checkout 已删路径；本批能安全迁出的入口立即迁出。

## 4. 运维工具、资源与夹具

将仍需保留的索引/回填/reconcile 工具迁到现有工具或共享包职责下，修根命令、compose 与镜像调用；明确所有脚本是搬迁、改为调用现有 Go 工具，还是确无调用方且仅属旧实现的退役资源。被使用的能力不可丢失；不能把 Nest AppModule/Controller/service 树复制到工具包以绕开目录删除。

保留 Prisma migrate/seed 与共享 Mongo 工具为 Node 是允许的，本批不重写数据库迁移、不改 DDL、不执行真实索引/回填/seed、不增加数据重置逻辑。工具的租户范围、确认/只读模式、失败退出、连接关闭与原有数据处理边界继续保留。

Go 的 BullMQ/Telegram/Socket.IO 等互操作夹具需要 Node 库时，把依赖/fixture 的解析 cwd 与模块入口放到明确工具职责，复用**已锁定版本**，包括 BullMQ 5.63.2；不需要因此保留 Node HTTP 后端。Go vendored Lua 的源码、许可证、展开方式与字节哈希检查继续有效，不能格式化上游脚本或删 NOTICE 来让测试通过。必要依赖只做已有锁定依赖的精确搬迁，不升级、不本机安装；CI 的 frozen-lockfile/tidy 门禁保留。

邮件模板/其它运行资源逐项查实际 Go 使用方式，已 embed/移植的保留实际内容，仍引用旧目录的迁出；不得仅因放在 Nest 目录就认定可删。记录最后剩下的**有意保留到第三步**的依赖（例如旧服务的对照 job），与遗漏分开。

## 5. 验证与交付

主要文件：Web codegen；Go schema/apidocs/契约与相关测试；工具/fixture 与现有 workspace/package/lock 引用；根命令；runtime Dockerfile/compose 工具调用；现有 ci.yml 最小增量。共享 main/config/router 仅限契约所需小型只读接缝，不抢后续路由重构。不修改 API/UI 业务或旧目录中的无关代码，不删 Node 后端、不弱化权限。

增加必要行为/契约测试：真实注册对照、Web 生成链、工具参数/失败/租户边界、独立 fixture 模块解析；不做源码字符串/snapshot-of-implementation 测试，不新建 API Jest/e2e 体系。Go 业务类型具名，源码注释英文，文档/提交/PR 中文。

本机只静态阅读、diff、必要 gofmt；不安装，不运行 build/test/lint/typecheck/vet/Docker/服务，不接真实外部依赖。普通 CI 保留 lint/typecheck/Web coverage/vector 与 Go/真实 CI 服务集成；只改现有流程必要步骤，不新增每批 smoke、不改 runner。读精确 head/job 处理失败，不用 skipped 或反复重跑冒充通过。

做只读静态反证复核，核类型/GraphQL、错误/关闭流程、orgId/权限和生成链，成立问题附当前 file:line。正常中文 emoji + type(scope) commit/push，创建 **Ready PR**，不合并/auto-merge/amend/rebase/force-push。只 stage 自己改动；更新本 task/PR 与直接运行说明，共享地图由规划窗口维护。

交付契约/工具/夹具“旧入口→新入口→真实消费者→验证”清单、精确 head/run/逐 job、剩余旧目录依赖与第二步接口。不得称已部署或实网通过。后继 GO-ONLY-RUNTIME-001 等本批实际合入并通过普通 CI 后再执行。
