# vector · 独立 Go 服务与 vector 上游切换

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

vector-go 是独立 HTTP 服务，三条契约已实现与注册，真正直连 Qdrant，不经 Nest 代理。AIS relay、AkShare、crawl4ai、model-service 保持独立服务边界。

关键数据与副作用：Qdrant，x-internal-token；orgId 来自受信上游请求体，API 应先推导租户。向量集合按模型散列，point ID 确定性，幂等 upsert。

真实剩余缺口：实际 VECTOR_SERVICE_BASE_URL/系统设置和部署切流未核实；不另建 api-go 开关替代既有 vector 上游配置。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#vector) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

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

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
