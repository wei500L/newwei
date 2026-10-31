# GraphQL SDL 权威来源与生成边界

本目录的 `schema.gql` 是 **Go 运行时与 Web codegen 的权威 GraphQL SDL**：

- Go 运行时：`schema.go` 用 `//go:embed schema.gql` 嵌入，`schema.Load()` 供执行器与
  `internal/graphqlread/cutover_roots_test.go` 的根覆盖门禁使用；`Version` 为内容 SHA-256，
  进入响应缓存键。
- Web codegen：`apps/web/codegen.cjs` 的默认 `schema` 指向本文件，生成
  `apps/web/graphql/generated.ts`（CI 的 “GraphQL codegen drift check” 校验）。

## 来源与基线

- 内容 SHA-256：`656ebe863768def657d58cade2589d8e7f8a467759cfc90324e496454884f96c`
- 迁移基线：`origin/main = fcf1e5334acb0350ea36535c48c4131df7c9698a`（#151 实际 merge）。
- 曾与 `apps/api/schema.gql`（NestJS 生成物）逐字节相同；生成命令为
  `pnpm --filter @modular/api run generate:schema`。

## 生成边界

- 本批不修改 SDL 字节、字段、权限或响应；只把“权威入口”从 Nest 生成物切到本文件。
- 过渡期由 CI 的 “Contract copies in sync” 步骤 `cmp` 本文件与 `apps/api/schema.gql`，
  保证两者仍逐字节一致；若有人改动 Nest 侧而未同步本文件，普通 CI 直接失败。
- `contract-baseline-regen` 远端再生成 job 会把 Nest 生成结果复制回本文件并提交。
- 删除 `apps/api` 后（GO-NODE-RETIRE-001），本文件即冻结为唯一事实源，届时移除 CI 的过
  渡同步步骤；新增/修改字段必须显式修改本文件并更新 `apps/web/graphql/generated.ts`。
