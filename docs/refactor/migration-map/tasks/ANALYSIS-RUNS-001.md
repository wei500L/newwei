# ANALYSIS-RUNS-001 · 三类分析真实后台执行与流式交付

- 状态 **pr_open**；2026-10-19 Europe/Moscow。独立业务分支 `refactor/go-analysis-runs`、worktree `/Users/oo/project/newwei-go-analysis-runs`；[Ready PR #98](https://github.com/wei500L/newwei/pull/98)。交付说明见 [go-analysis-runs.md](../../go-analysis-runs.md)。
- 代码基线origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`，普通CI39247556593精确head成功。本批从该 SHA 创建 worktree；规划认领与稳定提示词在 [Ready规划PR #93](https://github.com/wei500L/newwei/pull/93) / 分支 `docs/plan-newsnow-feed`。
- 实现 head `a933d982e548ebc19fb811d96724cd62d7808d3a`；普通CI [run 39314539054](https://github.com/wei500L/newwei/actions/runs/39314539054) **success**，verify job 118272476424、integration job 118272476548、vector job 118272475937。`go-modules-regen` 已生成 go.sum 提交 `c3bfeec7`。本文档提交后的文档-only head 以 PR 页面/最终交接为准。未合 main 不标 merged，不增加共享地图覆盖，不关闭 GAP-ASYNC-001。

## 精确范围、实现与复用

三个 Mutation `requestCorrelationAnalysis`/`requestAnomalyExplanation`/`requestGeoTransportAnalysis`，均 `analysis.run`、`AnalysisResultModel!`，orgId/triggeredById 从验证身份重推导。成功提交只返回 id/type/pending/createdAt/已保存 input；summary/error/output 缺省/null；不等模型。

已实现：

- Go 请求侧 `analysisruns.Submitter` + `graphqlread/analysisruns`：DTO/默认/null 语义、pending Mongo 插入、BullMQ 入队；入队失败返回错误并保留 pending，不新增 Outbox。
- `internal/analysisqueue`：BullMQ 5.63.2 官方 Lua（固定/内嵌/许可/摘要）、MessagePack、standard add、moveToActive、续租、completed/failed、即时 retry、stalled、paused、delayed/marker、retention、关闭。独立阻塞 Redis 连接；默认锁 30000ms/续租 15000ms/stalled 30000ms/maxStalledCount=1；并发读 `ANALYSIS_QUEUE_CONCURRENCY`。
- `internal/analysisruns`：三类真实计算、六模板/覆盖/nullish、四统计检测器（总体方差/阈值/顺序/toFixed）、Geo 真实状态+轨迹读取与完整 context、Mongo 终态、事件、通知、模型日志 observer、UTF-16 flush/partial summary。
- Geo 优化：Mongo 7.0 `$topN` 每组最多 30 点，删除重复空 fallback；状态 20/组织/窗口/bbox 仅状态/objectKeys 前 20 不变。
- `internal/publicportal/analysis_stream.go`：真 SSE 两 surface、`/v1` 短路径 404/405、profile/治理、fallback 只在未 yield 前、非 SSE/guardrail/兼容错误识别、usage/cost、取消。
- `internal/llmlogs/analysis_stream.go`：`requestType=stream` 专用 writer，best effort。
- 事件：`gqlsub:analysisEvents` 精确 envelope；通知：MySQL + `analysis:notification:v1`，Nest 新增 `AnalysisNotificationSubscriber`（id+org+user 重读、analysis 类型/presentation 校验、`emitLocalNotification`）。
- 两个独立开关：`API_GO_ANALYSIS_RUNS_MODE`（JWT/MySQL/Redis/Mongo）、`API_GO_ANALYSIS_WORKER_MODE`（MySQL/Redis/Mongo/redis bus，无 JWT）；空/legacy 默认，非法启动失败；`BULLMQ_WORKERS_ENABLED=false` 两端停消费。
- GAP-ANALYSIS-001：条件认领 running、`runToken` fencing、旧 token 不写终态；Nest `AnalysisService.process(job, token)` 同步窄修，processor 在 owner=go 时不建 Worker；stalled deferred failure 也推进最终失败通知。
- 关闭/切换/回滚：worker 先停 claim、drain 续租、截止取消；不 flush、不删记录；两端默认 legacy。

## 并行占用与交接

审计 Ready #92/head28c8f761、NewsNow Ready #94/headcf25026f、四订阅 Ready #95 保持不碰；条目入库/归档独立目录不碰。共享 Go `main.go`/`config.go`/`go.mod`、Nest env/schema、Compose、`ci.yml` 仅本批最小并集。

## 验证与未验证

普通 CI head `a933d982`：run 39314539054 success；verify job 118272476424（Go module 漂移门禁、lint、typecheck、web/vector/API 单测、契约、Go 单测、Compose、SBOM、build 全部 success）；integration job 118272476548 success；vector job 118272475937 success。`TestAnalysisRunsIntegration` 及全部子项 PASS：NodeBullMQToGoWorkerCompletes、GoProducerToNodeBullMQWorker、ImmediateRetrySucceedsAfterOneFailure、FinalFailureNotifiesOnce、PausedQueueIsNotClaimed、CompletedRecordIsNotRecomputed、OrganizationMismatchCannotTouchTheRecord、GeoKeepsThirtyPointsPerObject、StalledRecoveryResumesRunningRecord、StalledExhaustionFinalizesFailed；包耗时 18.88s，`ok github.com/wei500L/newwei/apps/api-go/internal/analysisruns`。集成 job 使用真实 MySQL/Redis/Mongo 7.0、锁定 Node BullMQ 5.63.2 双向 fixture 与本地 HTTP SSE。

SSE fixture 只证明协议与本地闭环；真实外部模型、生产数据/流量、部署、Nest/Go 多实例切换与 Socket.IO 多节点投递未验证；skipped 不算通过。
