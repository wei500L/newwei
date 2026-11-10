# 后端重构修复计划（REFACTOR 系列）

规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`（2026-11-04）。来源：2026-11-04 对 `apps/api-go` 的纯静态横向审查（约 48 万行非测试 Go、136 个包）。返回[入口](README.md) · [规划规则](PLANNING.md) · [任务索引](tasks/README.md)。

## 背景与目标

Go 迁移以“与 NestJS 契约等价”为目标，并由多批窗口并行完成，于是：

1. Node 时期的粗糙逻辑被原样复刻（如无 `jti` 的 token 不可吊销）；
2. 每个包各写一份基础设施——BullMQ 客户端 10+ 份、机器令牌鉴权约 22 份、设置加密 16 份、Redis 租约十余份、`writeJSON` 39 份；
3. 迁移期开关、shadow/legacy 注释与装配残骸仍在（`cmd/api/main.go` 84 处 `xxxGo := true`、13 处 `if true {`）。

本系列只做**重构与已知缺陷修复**：对外 HTTP/GraphQL/Socket 契约、Redis key、Mongo/MySQL 存储格式保持不变，除非任务里明确列为“有意变更”。不部署、不连真实外部服务，验证为静态审查 + 普通 CI。

## 任务与波次

| 波次 | 任务 | 主题 | 前置 | 可并行 |
|---|---|---|---|---|
| 1 | [REFACTOR-SAFE-GOROUTINE-001](tasks/REFACTOR-SAFE-GOROUTINE-001.md) | 后台 goroutine panic 隔离 | 无 | 与 AUTH、CRYPTO 并行 |
| 1 | [REFACTOR-AUTH-CHAIN-001](tasks/REFACTOR-AUTH-CHAIN-001.md) | 鉴权链单一实现、机器令牌统一、强制 jti | 无 | 是 |
| 1 | [REFACTOR-SETTINGS-CRYPTO-001](tasks/REFACTOR-SETTINGS-CRYPTO-001.md) | 设置密文信封与密钥解析单一实现 | 无 | 是 |
| 2 | [REFACTOR-RUNTIME-WIRING-001](tasks/REFACTOR-RUNTIME-WIRING-001.md) | `cmd/api` 去开关残骸、Mongo 单客户端、MySQL 连接池 | AUTH 合入 | 与 LEASE 并行 |
| 2 | [REFACTOR-LOCKS-001](tasks/REFACTOR-LOCKS-001.md) | Redis 租约与 MySQL GET_LOCK 各收敛为一份 | SAFE-GOROUTINE 合入 | 与 RUNTIME 并行 |
| 3 | [REFACTOR-BULLMQ-PRODUCER-001](tasks/REFACTOR-BULLMQ-PRODUCER-001.md) | BullMQ Lua 脚本单份 + 统一 Producer | RUNTIME 合入 | 与 ROUTER 并行 |
| 3 | [REFACTOR-HTTP-ROUTER-001](tasks/REFACTOR-HTTP-ROUTER-001.md) | 路由预编译、包改名、过时注释清理 | RUNTIME 合入 | 与 BULLMQ-PRODUCER 并行 |
| 4 | [REFACTOR-BULLMQ-WORKER-001](tasks/REFACTOR-BULLMQ-WORKER-001.md) | 统一 BullMQ Worker 循环 | BULLMQ-PRODUCER、SAFE-GOROUTINE 合入 | 与 HTTP-KIT 并行 |
| 4 | [REFACTOR-HTTP-KIT-001](tasks/REFACTOR-HTTP-KIT-001.md) | JSON 读写/时间格式等 HTTP 样板收敛 | ROUTER 合入 | 是 |
| 5 | [REFACTOR-OUTBOUND-CLIENTS-001](tasks/REFACTOR-OUTBOUND-CLIENTS-001.md) | 出站 HTTP Client 与 LLM chat 客户端收敛 | HTTP-KIT、CRYPTO 合入 | — |

“合入”指 GitHub 实际 merge 进 main 且该 head 的普通 CI 三主 job success；Ready PR 不算。

## 第一轮结果与第二轮候选

2026-11-05 规划窗口核实：10 个任务全部有 PR 合入 main（#162–#174，含整合 PR #165、#168），最新 main `6ab26a54` 普通 CI success（#169、#171 合并时的 push run 被后续 push 取消，二者 PR head 的 CI 均为 success）。8 个任务完整完成，2 个部分完成。各执行窗口交付记录中的“剩余问题”汇总如下，作为第二轮候选（已于 2026-11-06 拆成下节 4 个任务）：

| 候选 | 来源 | 内容 |
|---|---|---|
| BULLMQ-WORKER 收尾 | [BULLMQ-WORKER-001](tasks/REFACTOR-BULLMQ-WORKER-001.md) -b | `crawlworker` 未迁移：处理器内自行迁移状态、C2 动态并发、跨队列内存压力限速、stalled 业务副作用；需先给 `bullmq.Worker` 增加可调并发与 stalled 回调 |
| OUTBOUND 收尾 | [OUTBOUND-CLIENTS-001](tasks/REFACTOR-OUTBOUND-CLIENTS-001.md) -a | 只做了 `litellmcompat.PostOnce` 传输收敛；publicportal 各 completion 的 profile/请求体/响应解析/guardrail/fallback 上收到 `Completion`，`analysis_stream`/`assistant_stream` 上收到新增 `CompletionStream`，crawlfrontierllm/llmembed 的 complete/embed/rerank 上收，探针改调 `PostOnce`；-b（43 处 `&http.Client{` 与共享 Transport）未开始 |
| HTTP-KIT 收尾 | [HTTP-KIT-001](tasks/REFACTOR-HTTP-KIT-001.md) | `readJSON` 8 份、`writeError` 5 份、`authorize` 约 45 份（AUTH-CHAIN 后仅约 6 份是纯转发）、其余时间格式与 `toInt64`/`asFloat`/`asBool` 未收敛 |
| LOCKS 收尾 | [LOCKS-001](tasks/REFACTOR-LOCKS-001.md) | `contentsubscriptions`/`situationmonitors`/`newsindicator` 三份 `fn(ctx,*sql.Conn)` 式 GET_LOCK，`newsnowhottest`/`crawlreadtelemetry`/`qualityoverview`/`classificationrssops` 的缓存重建锁 |
| 迁移期注释 | [HTTP-ROUTER-001](tasks/REFACTOR-HTTP-ROUTER-001.md)、[RUNTIME-WIRING-001](tasks/REFACTOR-RUNTIME-WIRING-001.md) | `*_routes.go` 少量 “legacy /api/” 措辞、`cmd/api` wire 文件 “legacy default” 等注释；纯注释批次 |
| SAFE-GOROUTINE 取舍 | [SAFE-GOROUTINE-001](tasks/REFACTOR-SAFE-GOROUTINE-001.md) | 少数 channel 会合式扇出在发送前 panic 时单接收者可能阻塞（进程不崩），未改扇出结构 |

全部验证仍只有静态审查 + 普通 CI，没有连接真实 Redis/MySQL/Mongo/LiteLLM，也没有部署。

## 第二轮任务（2026-11-06 规划，基线 main `67f31754`）

| 波次 | 任务 | 内容 | 前置 | 可并行 |
|---|---|---|---|---|
| A | [REFACTOR-LLM-CLIENT-001](tasks/REFACTOR-LLM-CLIENT-001.md) | publicportal/crawlfrontierllm/llmembed/history/探针的 profile、密钥、补全、流式、嵌入上收到 litellmcompat | 无 | 是 |
| A | [REFACTOR-CRAWLWORKER-001](tasks/REFACTOR-CRAWLWORKER-001.md) | 给 `bullmq.Worker` 补可调并发、stalled 回调、slot 钩子，迁移 crawlworker | 无 | 是 |
| A | [REFACTOR-CLEANUP-001](tasks/REFACTOR-CLEANUP-001.md) | readJSON/writeError/authorize 收尾、3 份 `fn(*sql.Conn)` GET_LOCK（修复释放失败泄漏）与 4 处缓存锁、路由与 `cmd/api` 迁移期注释 | 无 | 是（避开 LLM-CLIENT/CRAWLWORKER 的包） |
| B | [REFACTOR-HTTP-CLIENT-001](tasks/REFACTOR-HTTP-CLIENT-001.md) | 43 处 `&http.Client{` 收敛到 `internal/platform/outbound` 共享 Transport（SSRF 拨号器例外保留） | LLM-CLIENT 合入 | — |

**结果（2026-11-10）**：4 个任务全部合入（#175–#183），main `695d73eb` 普通 CI success。不再派发的零碎：CLEANUP 记录的 5 份独特 `readJSON`、`toInt64` 变体、`cmd/api` 约 132 处事实性 Nest 参照；SAFE-GOROUTINE 扇出取舍。下一步候选仍是下节 BACKLOG（GraphQL 执行器、Nest 怪癖契约收敛、逐域业务规则复审）。

文件所有权：`internal/bullmq/**` 只归 CRAWLWORKER；LLM 相关包只归 LLM-CLIENT（CLEANUP 显式排除）；`cmd/api` 中 CLEANUP 只改注释，其余两者只改构造参数，冲突用 merge 保留并集。SAFE-GOROUTINE 的扇出取舍不派发，保持现状。

## 不进入本轮的候选（只记 BACKLOG，不派发）

- 自研 GraphQL 执行器（`internal/graphqlread/exec`，反射投影）换代码生成方案：风险最高，等上面全部落地后再评估。
- 刻意复刻的 Nest 怪癖契约（如 `rbacapi` 的 `includeSystem` 只认字面量 `"true"`）：需要连 `apps/web` 一起改，单独做“契约收敛”批次。
- 逐业务域的算法/规则正确性复审（去重、聚类、告警评估等）：本次审查未覆盖，需另起审查任务。

## 文件所有权冲突提示

- `cmd/api/**`：RUNTIME-WIRING 独占重写；其余任务只做构造参数级最小改动，并在 main 前进后 `git merge origin/main` 保留并集。AUTH-CHAIN 会改 `cmd/api` 中 verifier/blacklist 的重复构造，所以 RUNTIME-WIRING 必须在它之后。
- `internal/*/worker.go` 等队列文件：SAFE-GOROUTINE 先加 panic 隔离，BULLMQ-WORKER 再整体替换；后者必须保留前者语义（处理器 panic → 任务 failed）。
- `internal/legacyproxy/**`：只有 HTTP-ROUTER 改名/重写；其他任务若需加路由，等其合入后按新包名添加。
