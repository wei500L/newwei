# REFACTOR-RUNTIME-WIRING-001 · cmd/api 去开关残骸、Mongo 单客户端、MySQL 连接池

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-RUNTIME-WIRING-001.prompt.md)

## 任务记录

- 状态：**merged**（PR #167，整合 #168 → `51525856`；2026-11-05 规划窗口核实合入 main，最新 main `6ab26a54` 普通 CI success）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-AUTH-CHAIN-001 合入且 CI 成功。
- 分支：`codex/refactor-runtime-wiring`；worktree：`/Users/oo/project/newwei-refactor-runtime-wiring`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-runtime-wiring` / [#167](https://github.com/wei500L/newwei/pull/167) / Ready（非 draft）。
- 最终 head SHA（代码）：`77b2596f7a5bb0c72bf86079272e358cabb807b9`（本交付记录为后续文档回填提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41840336799](https://github.com/wei500L/newwei/actions/runs/41840336799)，headSha `77b2596f`，**conclusion=success**；`verify` / `vector-integration` / `api-go-user-settings-integration` / `globe-vendor` 均 success，两个 regen job skipped（skipped 不算通过）。前一次 head `1fb2dfe7` 的 run 41835033672 因 crawlfrontiernode 集成测试漏 `mysqldb` 导入失败，已修复。
- 实际范围 / 排除项：新增 `internal/platform/mongodb`、`internal/platform/mysqldb`；迁移 `dashboardstats.Open/Connection` 与 `usersettings.OpenMySQLFromURL`/`itemsreading` 副本；全部 `**dashboardstats.Connection` 槽改为单个 `*mongodb.Client`；`internal/config` 新增 3 个连接池变量并同步 `.env.example` / `infra/docker/.env.sample` / `docker-compose.yml`；`cmd/api` 去开关残骸、拆出 `wire_dashboard.go` / `wire_graphql.go`、closers 逆序关闭、文件改名 `legacy_fallback.go→not_found_recorder.go`、`nest_residual_duties.go→maintenance_duties.go`。排除：`health/probes.go` 的 1.5s 按需探针客户端、`llm_gateway_profiles.go` 的独立 `lockDB`（留给 REFACTOR-LOCKS-001）、`internal/legacyproxy` 包名/路由（HTTP-ROUTER-001）。
- 有意行为变更：① `MONGO_URI` 变为启动必填（所有常驻单元都需要 Mongo）；② 共享 MySQL 池默认上限 50 open / 10 idle / 300s；③ 30+ 个 `internal/**` 的 `integration` 测试调用点由 `usersettings.OpenMySQLFromURL` 改为 `mysqldb.Open(url, PoolConfig{})`（删除重复实现的必要连带，断言不变）；④ `wireDataRuntimeSettings` 由静默吞错改为记一条跳过日志后继续。
- 剩余问题：未在本机构建/测试（遵守纪律，不运行 go build/test/vet）、未部署、未连接真实 MySQL/Redis/Mongo；部分 wire 文件的迁移期措辞注释（如 “legacy default”/“opened on demand”）仍在，未大面积改写无关注释；运行证据仅为普通 CI 精确 head。
