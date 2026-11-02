# OpenAPI 快照权威来源与能力边界

本目录的 `openapi.snapshot.json` 是 **api-go `/docs/json` 服务的权威 OpenAPI 文档**，
由 `assets.go` 通过 `//go:embed openapi.snapshot.json` 嵌入并原样提供（字节不变，保留
`info.completeness` 等全部成员）。

## 来源与基线

- 内容 SHA-256：`2805e882d1ef21b5825380fc45951fdf21bcc290d5eaaf93db395708b21f91ba`
- 迁移基线：`origin/main = fcf1e5334acb0350ea36535c48c4131df7c9698a`（#151 实际 merge）。
- 曾与 `apps/api/tests/contract/openapi.snapshot.json`（NestJS 生成物）逐字节相同；
  生成命令为 `pnpm --filter @modular/api run contract:openapi:snapshot`。

## 能力边界（迁移后仍如实保留）

- 本 OpenAPI 是既有的 **路由 / 权限 / 状态码快照**；请求与响应 DTO 模型并不完整，
  不要把它当作“完整模型”或据此虚构 schema 字段。
- 静态文档继续人工/再生成维护，但真正的 Go 契约门禁在
  `apps/api-go/internal/legacyproxy/contract_registration_test.go`：它用实际 Go 全量规则
  表校验本快照中的每个 `METHOD + path` 是否都由 Go 注册（而非 `/api/` 兜底），从而发现
  新增、遗漏、错误分类——不是“快照与自身比较”。

## 生成边界

- 过渡期 CI 的 “Contract copies in sync” 步骤 `cmp` 本文件与
  `apps/api/tests/contract/openapi.snapshot.json`；`contract-baseline-regen` 会把 Nest
  再生成结果复制回本文件并提交。
- 删除 `apps/api` 后本文件冻结；届时 `info.completeness` 中的 route 统计随 Go 规则表演进，
  由上述 Go 门禁暴露漂移。
