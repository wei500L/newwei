# GO-CONTRACT-TOOLING-001 · 契约与运维工具迁出待删 Node 后端

- 状态：`merged`；2026-11-01 核实 [#152](https://github.com/wei500L/newwei/pull/152) 实际 merge `f22e36ae6fabf72c501ae2ad573eb3323fa0db35`，最终源 head `eff23a09f59b67220496be6cb1f50a0537e6ea82` 已是 main 祖先；[普通 CI 41205126554](https://github.com/wei500L/newwei/actions/runs/41205126554) 三主 job success，两个 regen skipped。原交付快照保留，未部署。
- 后继 #153/#154 亦已合入，去向与最终 main 验证见 [收口记录](../GO-MIGRATION-CLOSEOUT.md)；原“有意保留到第三步”的旧目录已在 #154 删除，不再按历史清单重复迁出。
- 基线：`origin/main fcf1e5334acb0350ea36535c48c4131df7c9698a`（#151 实际 merge）。
- 分支：`codex/go-contract-tooling`；worktree `/Users/oo/project/newwei-go-contract-tooling`。
- 提示词：[GO-CONTRACT-TOOLING-001.prompt.md](GO-CONTRACT-TOOLING-001.prompt.md)；规划发布 PR #149。
- 目标：删除 `apps/api` / `apps/vector` / `apps/ais-relay` 前，迁出不能随目录删除的契约、可运行
  运维工具、邮件资源与协议夹具，并给真实 Go 实现保留有效检查。
- 后继：[GO-ONLY-RUNTIME-001](GO-ONLY-RUNTIME-001.md) 必须等本任务实际合入并通过普通 CI 后执行。

## 本批实际交付

1. **契约权威切到 Go 侧**
   - Web codegen 默认 schema 指向 `apps/api-go/internal/graphqlread/schema/schema.gql`（与
     `apps/api/schema.gql` 本批逐字节相同，`generated.ts` 不变）。
   - `graphqlread/schema/schema_test.go` 与 `apidocs/assets_test.go` 不再读取 `apps/api/` 路径；
     跨源一致性改由 CI 过渡步骤 `Contract copies in sync`（`cmp`）保证。
   - 新增 Go 所有权契约目录 `apps/api-go/contracts/auth-matrix.{json,md}`（注明基线 SHA 的历史
     预期）+ 三份 `PROVENANCE.md`（SDL/OpenAPI/鉴权矩阵的来源 SHA 与生成边界）。
   - 新增独立 Go 契约门禁 `internal/legacyproxy/contract_registration_test.go`：用实际全量 Go 规则
     表校验 OpenAPI + 鉴权矩阵的 `METHOD+path` 注册归属，并校验鉴权矩阵四态权限结构。
2. **运维工具不再经 Nest 应用模块**：`ensure-mongo-indexes` / `prune-mongo-indexes` /
   `backfill-processed-item-has-location` / `backfill-raw-item-comparable-urls` 迁到
   `@modular/mongo` 的 `cli/`（tsx 直接运行，与旧 apps/api/scripts 一样不纳入 tsc/eslint 类型检查），根命令与 compose `mongo-indexes` 改指
   `@modular/mongo`。
3. **协议夹具独立解析锁定依赖**：BullMQ 集成夹具的 Node 解析 cwd 从 `apps/api` 改到
   `@modular/infra-scripts`，精确复用 `bullmq@5.63.2`（lockfile importer 补齐），CI 集成 job 安装
   filter 改为 `@modular/infra-scripts...`。
4. **CI 最小增量**：保留既有 Nest 生成/对照步骤，新增 Go 契约门禁步骤与契约副本过渡同步步骤；
   `contract-baseline-regen` 增补把 Nest 再生成结果复制回 Go 契约副本并一起提交。
5. 详细“旧入口→新入口→真实消费者→验证”、邮件模板与 vendor Lua 审计、剩余旧目录依赖见
   [contract-tooling-inventory.md](../../contract-tooling-inventory.md)。

## 验证

- 本机只静态：diff、必要 `gofmt`、只读静态反证复核；未装/未跑 build/test/lint/typecheck/vet/Docker/服务，未部署、未连真实外部依赖。
- 实现 head `edfb341fde79e7ff31277bc6a3d89b7ceb6c9e1d` 普通 CI [run 41203871729](https://github.com/wei500L/newwei/actions/runs/41203871729)：
  `verify` success、`api-go-user-settings-integration` success（含 BullMQ Node↔Go 夹具、Go 契约门禁、`pnpm install --frozen-lockfile --filter @modular/infra-scripts...`）、
  `vector-integration` success；`go-modules-regen`、`contract-baseline-regen` skipped（skipped 不算通过）。
- 实现过程中 `verify` 首跑在 Lint 步骤因 `packages/mongo` eslint `array-type` 失败（已修并重跑通过）；另据只读反证修复了独立 compose `mongo-indexes` 服务仍指 `@modular/api` 的遗漏。

## 排除项

- 不删除 Node 后端/`legacyproxy`/`shadow`/`canary`，不重写业务功能，不提前裁掉旧基线；
  不把 Nest AppModule/Controller/service 树复制进工具包；不改 DDL、不执行真实索引/回填/seed。
