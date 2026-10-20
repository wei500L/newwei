# 分析执行链迁移（ANALYSIS-RUNS-001）

任务 ID：`ANALYSIS-RUNS-001`。基线 `origin/main 91e759b449c4511dc96d86539ea0eb258754d07e`；分支 `refactor/go-analysis-runs`；独立 worktree `/Users/oo/project/newwei-go-analysis-runs`。本批把三个分析请求 Mutation 的完整执行链从 NestJS 迁到 Go：持久 pending → BullMQ 原生入队 → 真实 Go 消费者 → 三类真实计算/模型流 → Mongo 结果 → `gqlsub:analysisEvents` → MySQL 通知与分析专用本地实时接缝。

## 1. 入口与契约

| Mutation | 根权限 | Go 位置 |
|---|---|---|
| `requestCorrelationAnalysis(input: CorrelationAnalysisInput!)` | `analysis.run` | `internal/graphqlread/analysisruns` |
| `requestAnomalyExplanation(input: AnomalyAnalysisInput!)` | `analysis.run` | 同上 |
| `requestGeoTransportAnalysis(input: GeoTransportAnalysisInput!)` | `analysis.run` | 同上 |

- 均返回 `AnalysisResultModel!`。成功提交返回 `id/type/pending/createdAt/已保存 input`；`summary/error/output` 按原 Resolver 缺省/null 投影；不等待模型完成。
- `orgId`/`triggeredById` 只从验证身份重推导，input 不接受组织或用户。没有额外 `analysis.read`/`settings.manage`/platform-admin 门槛。
- GraphQL 认证、变量、别名/fragment、选择集与错误投影沿既有 executor；`AnalysisResultModel` 通过 `history` 的窄端口 `RegisterAnalysisModel` 单独注册，与 history 读/工作台写同时启用时按 `HasType` 去重，不装配 Assistant/通知根。
- DTO 只复现可达的 class-validator 约束：必填字符串/有限 Float/字符串数组；Geo `transportKinds` 1..2、bbox 恰 4 个有限 Float；`series` 保留缺省与显式 null 差异；Geo 空 `objectKeys`/缺省不成为过滤。入口不新增日期合法性、日期顺序或坐标范围校验；Geo 日期在 worker 执行阶段解析，无效时成为真实运行失败。

## 2. 请求侧持久化与入队

- `analysisruns.Submitter` 先向 Mongo `analysisresults` 插入 `pending`（ObjectId、orgId、type、具名 input、triggeredById、createdAt/updatedAt），再调用 `analysisqueue.Producer` 入队。两者没有跨库事务：Mongo 成功、Redis 入队失败时请求失败并保留 pending 行，与原 NestJS 边界一致。
- queue=`analysis`，默认 prefix=`bull`；job name 与 payload.type 为 `correlation`/`anomaly`/`geo_transport`；payload 为 `{type,analysisId,orgId,traceId}`；traceId 取 `httpx.TraceIDFromContext`/`EnsureTraceID`。
- jobId 分别为 `corr-<id>`、`anomaly-<id>`、`geo-transport-<id>`；`removeOnComplete=true`、`attempts=ANALYSIS_MAX_RETRIES`（默认 3）、无 backoff、`removeOnFail={age:604800,count:10000}`。
- 旧 NestJS payload 的 `orgId`/`traceId` 允许缺省；有 orgId 时必须与持久记录一致，payload type 也必须与记录一致。

## 3. 真正的 Go BullMQ 消费者

新增 `internal/analysisqueue/`：

- 以 `pnpm-lock` 锁定的 BullMQ **5.63.2** 为事实源，内嵌官方 Lua（`scripts/NOTICE.md` 记录版本、来源、MIT 许可、上游/展开 SHA-256）。运行时不下载脚本。
- 实现本队列实际需要的 standard add、`moveToActive`、`extendLock` 续租、`moveToFinished`（completed/failed）、`retryJob`（无延迟即时重试）、`moveStalledJobsToWait`、paused、delayed/marker 唤醒、events、attempt 计数、retention 与关闭。没有 BLPOP/HSET 状态机、asynq、内存任务或重复队列。
- 作业数据与 opts 使用固定版本 `github.com/vmihailenco/msgpack/v5`（msgpackr `useRecords=false` 兼容），不手写编码器；新增参数/结果/job options 均为具名类型。
- 默认锁 30000ms、约 15000ms 续租、stalled 间隔 30000ms、`maxStalledCount=1`；并发读 `ANALYSIS_QUEUE_CONCURRENCY`（默认 2）。阻塞读取使用独立 Redis 连接，沿现有地址/用户名/密码/DB/prefix。
- 续租失败或锁 token 不匹配时取消本尝试的 handler context：停止模型读取、不写终态、不 ack；由 BullMQ stalled 回收接续。旧 token 的 `moveToFinished`/`retryJob` 会被官方脚本以 `-6/-2` 拒绝，不手工减重试次数。
- `BULLMQ_WORKERS_ENABLED=false` 时 NestJS 与 Go 都不启动 analysis 消费。

## 4. 运行状态、GAP-ANALYSIS-001 与 fencing

- 认领把 `pending/failed/running` 条件更新为 `running`，清 `error`，写入本次 BullMQ 锁 token 到可选 `runToken` 字段，并发布 running。
- GAP-ANALYSIS-001：原 `analysis.service.ts:134-148` 只认领 pending/failed；worker 标 running 后崩溃/丢锁，stalled 重排后记录仍 running，process 直接 return。Go 现在允许**持有当前 job 租约**的执行者恢复 running；NestJS 回滚侧同步使用同一条件认领。
- 所有终态写回都以 `{_id, runToken, status:"running"}` 为条件。失去租约的旧尝试匹配 0 行：不发布 completed/failed、不发通知、不覆盖新尝试；完成记录不再重复计算。
- `deferredFailure`（stalled 超过允许次数）由新租约尝试直接推进 failed/事件/最终通知，不把 Mongo 留在 running。Nest 回滚侧在 Processor failed handler 中以 `finalizeStalledFailure` 同样接管遗留 running：条件 `status=running`、写入当前/新 token 形成 fence，再发布 failed 与单一最终通知；已 failed 的记录只刷新 fence 与发通知，completed 不触碰。
- 成功写 `output/summary/completed/updatedAt` 并清 error；失败写 `failed/error`，有非空 partialSummary 时保存；中间失败不发用户失败通知，最后一次才发。`createdAt` 始终取原记录时间。
- Mongo 完成与 BullMQ ack 是两个独立动作；不承诺跨库 exactly-once，可能出现“Mongo 已完成但 job 未 ack”并导致下一次尝试看到 completed 后直接 ack。

## 5. 三类真实计算

### Correlation

按 `packages/config/src/prompts/analysis.ts` 的模板传指标名/值/环比/日期/新闻；新闻按输入顺序编号，空列表使用“无相关新闻”。不做本地 Pearson；output=`{summary,raw}`。

### Anomaly

完整迁移四个检测器，输入不排序/去重：

1. z-score：全序列总体方差、阈值 3、std=0 无结果；
2. rolling spike：此前 20 点总体 std、2.5 倍；
3. trend：3 个采样点、首值非 0、除以 `abs(start)`、绝对变化 ≥10%；
4. volume：此前 20 点均值、均值 >0、当前 ≥3 倍均值。

保留包含边界比较、`reason` 字符串、JS `toFixed` 语义、findings 的 z→spike→trend→volume 拼接顺序；同一点可多项命中。统计摘要、`统计检测：\n...\n\n` 前缀、新闻/政策空文案与原模板替换均在 Go 完成，不是只调用模型。output=`{summary,raw,statisticalFindings}`。

### Geo

真实读取 `maptransportobjectstates` / `maptransporttrackpoints`，不调用 OpenSky/AIS、不启动采集：

- 状态：当前组织、`entityKind`、`observedAt` 闭区间、可选 bbox（仅状态）、`objectKeys` 只取输入前 20 项；`observedAt DESC` 最多 20 个状态。
- 对象：名称回退（aircraft: callsign→registration→icao24→objectKey；vessel: name→mmsi→objectKey）、分类/角色/国家、nullable 位置字段。
- 轨迹：同组织、同窗口、每对象最近 30 点；不把 bbox 加给轨迹。输出 trackPointId、UTC ISO observedAt、lat/lng、heading/course/speed/altitudeFt/geoCell。
- 完整具名 context：`filters`、`objectKeys`、`trackPointIds`、hotspots（count DESC、前 10、同分稳定保留原顺序）、`objects`；promptVersion=`geo-transport-v1`；output=`{summary,raw,promptVersion,context}`。
- 空观测仍把真实空 context 交给模型，不伪造轨迹。

### 查询优化

用 Mongo 7.0 `$topN` 在 `$group` 内每组只保留 30 点，替换 `$group:$push` 全量后 `$slice`，并删除“同参数空结果再查一次”的 fallback。组织、窗口、对象选择、排序字段与输出字段不变；同 `observedAt` 的次序源实现本来未定义，未引入额外业务排序。集成测试用 100+ 历史点/窗口外/双组织/空对象验证每组最多 30。

## 6. 真流式模型与日志

新增 `internal/publicportal/analysis_stream*.go`（实际文件 `analysis_stream.go`），复用既有 profile 读取、API base 规范化、密钥解密与治理 helper：

- 支持 `chat_completions` 与 `responses` 两个 apiSurface、`/v1` 与短路径 404/405 fallback；请求带 profile/治理凭据、`temperature`/`top_p`/`max_tokens`/`max_output_tokens`。本链无 metadata、无显式 guardrails、无 `response_format`，未额外套 RSS/网页策略。
- 主模型/fallback 顺序去重；只有尚未 yield 任何 chunk 才能换模型；已经 yield（含仅 finishReason 的 chunk）后失败不拼接另一模型；guardrail 拒绝与兼容性错误直接失败。
- SSE 处理跨网络 chunk、UTF-8 边界、CRLF、空行、多行 data、`[DONE]`、chat delta/finish、Responses delta/done/error、usage/cost；请求取消/worker 关闭/锁丢失可中断读取；非 SSE 响应不当作成功流。
- `streamMessages` 适配器按 JS 字符串长度（UTF-16 单元，不是 UTF-8 字节）比较 `flushChars`，并在处理新 chunk 时检查 `flushMs`；不是 250ms 心跳。统计前缀先 flush，结束 flush，失败也尽量 flush 并保留 partial summary。
- `raw={stream:true,model:lastModel}`；无 model 时按源省略。timeout 使用 `ANALYSIS_LLM_TIMEOUT_MS`（配置默认 300000ms，不沿 brief 硬编码）。
- 每次真实流式尝试写 `llmrequestlogs`：`requestType=stream`、apiSurface、实际 model、orgId、profile/治理、success/error、latency、已上报 usage/cost；缺值 null，metadata null，不发明 feature。新增 `internal/llmlogs/analysis_stream.go`；日志失败 best effort，不使已完成分析失败。

## 7. GraphQL 事件与通知

- 发布到现有 `gqlsub:analysisEvents`，envelope 精确为 `{orgId,result:{id,type,status,summary?,error?,createdAt}}`；createdAt 是 ISO 字符串，不套 `$gqlDate`；undefined 字段省略；不混入 input/output，不发到 queueEvents。
- 复用 Nest bus best-effort 失败语义；本批不改订阅 executor、Redis codec 或 Socket.IO transport。#95 的 Go 订阅与现有 Nest 订阅消费同一 schema。
- 有 `triggeredById` 才写 MySQL Notification：完成 `analysis_completed`；最终重试耗尽/ stalled 终止 `analysis_failed`。保留 notifyResult / notifyFinalFailure 各自 title/body/data/presentation 差异，中间失败不通知。
- 新增分析专用 `analysis:notification:v1`，只携 `{version:1,notificationId,orgId,userId}`。Nest 新增 `AnalysisNotificationSubscriber`，在 worker owner=go 时订阅，按 id+org+user 重读真实 Notification，检查 analysis 类型/presentation，再调用既有 `NotificationsGateway.emitLocalNotification`；每实例只发本地匹配组织和用户的 socket，绕过跨节点 adapter 避免重复。不改 digest 频道/格式/subscriber。SQL 是持久结果，实时接缝仍 best effort，不承诺断线重放。

## 8. 两个独立开关、资源、关闭与回滚

| 变量 | 所有权 | 依赖 |
|---|---|---|
| `API_GO_ANALYSIS_RUNS_MODE` | 三个 Mutation | JWT + MySQL + Redis + Mongo；不依赖 READ/历史/导出开关 |
| `API_GO_ANALYSIS_WORKER_MODE` | analysis 消费者 | MySQL + Redis + Mongo + `GRAPHQL_SUBSCRIPTION_BUS=redis`；不要求 JWT/GraphQL 开关 |

- 两者都接受空串/legacy/go，空串=legacy，非法值在 Nest 与 Go 都启动失败。
- `BULLMQ_WORKERS_ENABLED=false` 两端都不消费；它不是 `SCHEDULE_ENABLED`，不能拿关闭全部 Nest worker 代替本队列 owner。无新增 cron/自动触发/全队列开关。
- request 模式在 `/graphql` 路由 OR、handler OR、`needsCredentialedGo` 与 Mongo 装配中补齐；worker 模式只加入 `needsRedis`，不进入 `requiresJWT` 集合。init 与 Start 分开；构造/Start 失败会关闭本次打开的 Mongo/blocking Redis。
- 关闭顺序：先停新 claim，drain 在途并续租；截止时间到取消模型、保留 partial/可接续状态；停止 stalled/renew/阻塞连接；最后才关共享 Redis/Mongo/SQL。已接受任务不使用 HTTP 请求 context。
- 切换：两端代码先部署且默认 legacy → 停/排空所有 Nest analysis 消费者 → 启动 Go owner → 请求生产者可独立切 Go。回滚：停 Go 领取并 drain/按恢复协议交还 → 启 Nest owner → 按需退三入口。不 flush 队列、不删分析记录；硬崩溃后的 running/stalled 也可由 GAP 修复接续。

## 9. 文件与并行边界

新增：`internal/analysisqueue/`、`internal/analysisruns/`、`internal/graphqlread/analysisruns/`、`cmd/api/analysis_runs.go`、`internal/llmlogs/analysis_stream.go`、`internal/publicportal/analysis_stream.go`、history `analysis_port.go`、Nest `analysis-notification.subscriber.ts`、`apps/api-go/testdata/analysis_queue_fixture.mjs`。

共享文件仅最小并集：Go `main.go`/`config.go`/`go.mod`、Nest `analysis.processor.ts`/`analysis.service.ts`/`analysis-result.ts`/`notifications.module.ts`/`env.schema.ts`/`config.service.ts`、`ci.yml`、Compose/env、本文与 task。

未改：`analysisResults` 读入口、四 Subscription transport/WS 包、分析协作 CRUD/CSV、Assistant/告警/经济/crawl/归档 worker、地图采集、ARCHIVE-READING-001 的 `llmembed`/`llmgatewayprofiles`/`llmlogs/archive_search.go` 端口。

## 10. 验证与未验证项

已执行（远端）：

- 实现 head `a933d982e548ebc19fb811d96724cd62d7808d3a`；普通 CI [run 39314539054](https://github.com/wei500L/newwei/actions/runs/39314539054) **success**。verify job 118272476424：Go module 漂移门禁、lint、typecheck、web/vector/API 单测、OpenAPI/auth matrix/SDL 契约、Go 单测、Compose、SBOM、build 全部 success。integration job 118272476548 success；vector job 118272475937 success。
- 集成 job 内：真实 MySQL/Redis/Mongo 7.0 + 真 Go worker + 锁定 Node BullMQ 5.63.2 双向 + 本地 HTTP SSE fixture。`TestAnalysisRunsIntegration` 18.88s PASS，10 个子项全部 PASS：Node 入队→Go 完成、Go 入队→Node ack、一次失败后成功、最终失败通知一次、paused 不领取、completed 不重复模型调用、双组织/类型隔离、Geo 大量轨迹每组 30、锁丢失/stalled 恢复、stalled 耗尽最终失败。
- Go 单元测试覆盖 JS number/toFixed/UTF-16 长度、四检测器边界与顺序、prompt 覆盖空串、DTO/组织/独立开关、SSE 两 surface/半包/fallback/guardrail、BullMQ job/opts 解码。

未验证（明确不推断）：

- 真实外部模型、生产 gateway 凭据/治理密钥、真实生产数据与流量。
- 生产部署、Nest/Go 多实例切换、Socket.IO 多节点实际投递。
- SSE fixture 只证明协议与本地闭环，不等于外部模型验证；CI skipped 不算通过。
