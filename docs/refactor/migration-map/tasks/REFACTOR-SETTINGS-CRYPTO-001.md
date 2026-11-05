# REFACTOR-SETTINGS-CRYPTO-001 · 设置密文信封与密钥解析单一实现

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-SETTINGS-CRYPTO-001.prompt.md)

## 任务记录

- 状态：**merged**（PR #163，整合 #165 → `742ebdba`；2026-11-05 规划窗口核实合入 main，最新 main `6ab26a54` 普通 CI success）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：无。
- 分支：`codex/refactor-settings-crypto`；worktree：`/Users/oo/project/newwei-refactor-settings-crypto`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-settings-crypto` / [#163](https://github.com/wei500L/newwei/pull/163) / Ready（非 draft）。
- 最终 head SHA：`47830c8a34c9900e2ed60f8e05670459a99b2369`（代码提交；其后仅追加本条交付记录，docs-only，不改代码）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41817332835](https://github.com/wei500L/newwei/actions/runs/41817332835) `conclusion=success` `headSha=47830c8a34c9900e2ed60f8e05670459a99b2369`；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，`contract-baseline-regen`、`go-modules-regen` 按设计 skipped（skipped 不计为通过，但非本任务检查项）。
- 实际范围 / 排除项：新增 `apps/api-go/internal/settingscrypto`；替换 16 个域的本地 AES-256-GCM 加解密、密钥解析与信封判定实现，改为调用共享包（含同包测试改动）。未改 `cmd/api`、`internal/config`，未改 `apps/web`。本机未构建/测试，未连接真实服务，运行证据仅为上述普通 CI。
- 有意行为变更：所有域统一按 Node `Buffer.from(value,"base64")` 语义解析密钥（原最宽集合并集），原本被部分域拒绝的无 padding/URL-safe 密钥现在全域可用；畸形信封（缺 iv/tag/data）由可能的 panic/报错改为按“非信封”处理，与 NestJS `isEncryptedStringValueV1` 判定一致；补充 IV=12/tag=16 长度校验。详见 PR 描述。
- 剩余问题：无阻塞项。`settingscrypto` 的等价性由静态审查 + 迁移后的单测覆盖，未做真实环境密文互解验证（本机不运行服务）。
