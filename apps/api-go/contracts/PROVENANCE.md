# Go 所有权下的鉴权矩阵契约

本目录保存由 Go 运行时所有权持有的 REST 鉴权矩阵（`auth-matrix.json` 机器可读、
`auth-matrix.md` 人工审查表）。它们是 Nest 装饰器静态扫描产物在迁移基线的**历史预期**，
用于给 Go 当前事实（实际路由注册与权限判定）提供稳定对照输入。

## 来源与基线

- `auth-matrix.json` SHA-256：`9fb9242f9c1bee4a22f1a3d0db454a3f8e93a966ec8f46727fc5b280940b2d77`
- `auth-matrix.md` SHA-256：`3a7a843a8dd5b46ddea9725a15ad869010828ee7f7dcc4151cd13ea0eab16620`
- 迁移基线：`origin/main = fcf1e5334acb0350ea36535c48c4131df7c9698a`（#151 实际 merge）。
- 来源：`apps/api/tests/contract/auth-matrix.{json,md}`，生成命令
  `pnpm --filter @modular/api run contract:auth-matrix:generate`（Nest 装饰器静态扫描，
  fail-closed：非公开端点缺权限元数据即失败）。

## 四态语义与边界（沿用 ADR §6.2，不重新发明）

- anonymous / auth-no-permission / auth-with-permission 为装饰器可判定；
  **wrongOrg 一律 runtime-required**（org 由每请求 DB membership 重推导，静态不编造结论）。
- handler 平台校验为启发式（`platformCheckSource=handler-text-scan`），运行时强制力由
  handler 内 assertPlatformAdmin 提供。
- 本矩阵是 **历史预期（注明基线 SHA）**，不是 Go 当前事实；Go 当前事实由
  `apps/api-go/internal/legacyproxy/contract_registration_test.go` 用实际全量 Go 规则表校验
  每个 `METHOD + 完整路径` 的注册归属，并校验本矩阵的权限结构自洽（公开/仅认证/权限门控
  的 permission 与 permissionMode 边界）。orgId 约束不由“路由存在”替代。
- 请求/响应 DTO 与运行期权限值仍需运行时验证；本批不声称已部署或实网通过。

## 生成边界

- 过渡期 CI “Contract copies in sync” 步骤 `cmp` 本目录两个文件与
  `apps/api/tests/contract/auth-matrix.{json,md}`；`contract-baseline-regen` 会把 Nest
  再生成结果复制回本目录并提交。
- 删除 `apps/api` 后本目录冻结为历史预期；后续如需新增静态预期，必须注明来源 SHA 与
  生成命令，并由上述 Go 门禁与必要权限行为测试发现新增/遗漏/错误分类。
