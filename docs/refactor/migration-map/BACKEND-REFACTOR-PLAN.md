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

## 不进入本轮的候选（只记 BACKLOG，不派发）

- 自研 GraphQL 执行器（`internal/graphqlread/exec`，反射投影）换代码生成方案：风险最高，等上面全部落地后再评估。
- 刻意复刻的 Nest 怪癖契约（如 `rbacapi` 的 `includeSystem` 只认字面量 `"true"`）：需要连 `apps/web` 一起改，单独做“契约收敛”批次。
- 逐业务域的算法/规则正确性复审（去重、聚类、告警评估等）：本次审查未覆盖，需另起审查任务。

## 文件所有权冲突提示

- `cmd/api/**`：RUNTIME-WIRING 独占重写；其余任务只做构造参数级最小改动，并在 main 前进后 `git merge origin/main` 保留并集。AUTH-CHAIN 会改 `cmd/api` 中 verifier/blacklist 的重复构造，所以 RUNTIME-WIRING 必须在它之后。
- `internal/*/worker.go` 等队列文件：SAFE-GOROUTINE 先加 panic 隔离，BULLMQ-WORKER 再整体替换；后者必须保留前者语义（处理器 panic → 任务 failed）。
- `internal/legacyproxy/**`：只有 HTTP-ROUTER 改名/重写；其他任务若需加路由，等其合入后按新包名添加。
