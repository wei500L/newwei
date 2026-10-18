# vector · 独立 Go 服务与 vector 上游切换

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

vector-go 是独立 HTTP 服务，三条契约已实现与注册，真正直连 Qdrant，不经 Nest 代理。AIS relay、AkShare、crawl4ai、model-service 保持独立服务边界。

关键数据与副作用：Qdrant，x-internal-token；orgId 来自受信上游请求体，API 应先推导租户。向量集合按模型散列，point ID 确定性，幂等 upsert。

真实剩余缺口：实际 VECTOR_SERVICE_BASE_URL/系统设置和部署切流未核实；不另建 api-go 开关替代既有 vector 上游配置。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：首次基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；14:22 MSK 最新 main [CI 39122519950](https://github.com/wei500L/newwei/actions/runs/39122519950) 已复核为 success，head 与本页3cedce9a基线一致。#68 的 PR head a1c96172 普通 CI 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## 独立 HTTP 契约（不计入主 API 分母）

| 入口 | 权限 | 实现与注册 |
|---|---|---|
| `GET /healthz` | 公开 | `httpapi.New → handleHealthz` |
| `POST /v1/upsert` | x-internal-token | `httpapi.New → handleUpsert → qdrant.Client.UpsertPoints` |
| `POST /v1/search` | x-internal-token | `httpapi.New → handleSearch → qdrant.Client.Search` |

事实源：[apps/vector/src/modules/vector/vector.controller.ts](../../../../apps/vector/src/modules/vector/vector.controller.ts)、[apps/vector/src/modules/health/health.controller.ts](../../../../apps/vector/src/modules/health/health.controller.ts)；Go [apps/vector-go/main.go](../../../../apps/vector-go/main.go) → [httpapi.New](../../../../apps/vector-go/internal/httpapi/server.go) → [apps/vector-go/internal/qdrant/client.go](../../../../apps/vector-go/internal/qdrant/client.go)。

基线 CI 的 vector-integration 成功，证据是同 SHA 的真实 Qdrant 契约差分，不是生产调用验证。compose vector-go 为独立 pilot；上游选择使用 VECTOR_SERVICE_BASE_URL/数据库系统设置，回滚指回 Nest vector。见 [vector-service-settings.service.ts](../../../../apps/api/src/modules/system-settings/vector-service-settings.service.ts)（若变更配置优先级需读当前源码）。

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#2](https://github.com/wei500L/newwei/pull/2) | [e605e28fa43f](https://github.com/wei500L/newwei/commit/e605e28fa43f21d27bc498d798deefc5cf53d26f) | feat: SEC-01 修复 + 契约保护网（OpenAPI 快照/鉴权矩阵）+ api-go 四态 + vector-go 远端集成 + 前端 App Shell 第一批 |
| [#27](https://github.com/wei500L/newwei/pull/27) | [8219a7c485c2](https://github.com/wei500L/newwei/commit/8219a7c485c2ca384f67031eb63f4752cc83d00b) | 🐛 fix(vector): 有界重试 Qdrant 并发建集合后的未就绪读 |

- [docs/refactor/vector-go-pilot-deployment.md](../../vector-go-pilot-deployment.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
