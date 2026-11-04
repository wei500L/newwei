# 执行提示词 · REFACTOR-RUNTIME-WIRING-001 · `cmd/api` 去开关残骸、Mongo 单客户端、MySQL 连接池

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-RUNTIME-WIRING-001.md`。worktree slug：`refactor-runtime-wiring`。

**前置**：REFACTOR-AUTH-CHAIN-001 已实际合入 main，并且普通 CI 成功。它改过 `cmd/api` 中的鉴权构造，你要在它的结果之上工作。

## 问题（规划基线 18c41879858d 已核实）

### 1. 迁移开关残骸

`cmd/api/main.go`（2180 行）中：

- 有 84 处 `xxxGo := true`（例如 `economicDataGo`、`goTakeover`、`dashboardGo`、`needsCredentialedGo`、`needsRedis`……，约在第 150–330 行），以及 13 处 `if true {`。
- 许多 `if xxxGo || yyyGo {`、`if sharedDB == nil { return ... }` 分支实际上永远为真，或者永远不会进入。第 188 行已经保证了 `sharedDB != nil`，后面很多 `sharedDB == nil` 检查都是死代码。
- 大段注释描述的 shadow/legacy/"回落 NestJS"/"开关为 go 时"都已经不成立。日志里也还在打印 `readMode=%s`、`"go"` 这类无意义信息。
- `cmd/api/legacy_fallback.go` 和 `cmd/api/nest_residual_duties.go` 的文件名也是迁移期遗留。

### 2. Mongo 连接“谁先用谁打开”

- 共享的 Mongo 连接以二级指针 `**dashboardstats.Connection` 在约 34 个装配函数之间传递，每个函数都写着“如果 `*mongoConn == nil`，就由我来 `dashboardstats.Open`”。全仓共有约 49 个 `dashboardstats.Open` 调用点，例如 `cmd/api/situation_telegram_auth.go:51`、`classification_rss_ops.go:41`，`main.go` 里还有 10 处。
- 这导致行为依赖装配顺序，而且有些调用点可能打开了独立的第二个客户端（例如 `realtime_socket.go:195` 直接接收 `mongoURI`，需要核实）。
- 进程级共享资源挂在 `dashboardstats` 这个业务包下，归属错误。

### 3. MySQL 连接池无上限，打开方式不统一

- 全仓库没有任何 `SetMaxOpenConns` / `SetConnMaxLifetime`。每个已认证请求都要做一次 authz MySQL 查询，再加上十几个 worker，高峰时连接数没有上限。
- URL 解析与打开逻辑在 `internal/usersettings/mysql_repository.go:22`（`OpenMySQLFromURL`，被到处借用）。`internal/itemsreading/mysql.go:85` 还有一份 `openMySQLFromURL` / `mySQLConfigFromURL`，疑似无人调用，需要核实。

## 方案

### A. 新增 `internal/platform/mysqldb`

- 把 `usersettings.OpenMySQLFromURL` 和 `parseMySQLURL` 原样搬过来，并给出 `Open(databaseURL string, pool PoolConfig) (*sql.DB, error)`。
- 解析语义不变：
  - 接受 `mysql` 或 `mysql+prisma` scheme；
  - 端口缺省为 3306；
  - 忽略 URL 查询参数；
  - 固定 `charset=utf8mb4`、`ParseTime`、`Loc=UTC`、`utf8mb4_unicode_ci`。
- 所有调用点改为调用新包，删除 `usersettings` 里的版本。如果 `itemsreading` 的副本确认无人调用，也一并删除。
- 连接池参数：在 `internal/config` 增加 `DATABASE_MAX_OPEN_CONNS`（默认 50）、`DATABASE_MAX_IDLE_CONNS`（默认 10）、`DATABASE_CONN_MAX_LIFETIME_SECONDS`（默认 300），非法值启动失败。
- 同步更新以下文件，给出默认值与一句说明：根目录 `.env.example`、`infra/docker/.env.sample`，以及 `infra/docker/docker-compose.yml` 的 api-go 环境变量（如果那里是逐个列出变量的）。
- `cmd/api/llm_gateway_profiles.go:35` 的独立 `lockDB` **不要动**，它属于 REFACTOR-LOCKS-001。

### B. 新增 `internal/platform/mongodb`

- 把 `dashboardstats.Open` 与 `Connection`（包括 `parseMongoDatabase`、`Database()`、`Disconnect`）迁过来，类型改名为 `mongodb.Client`。
- `main` 只打开一次：先核实**是否所有常驻单元都必须使用 Mongo**。如果是（Go-only 运行时下各单元总是开启，预期如此），就在 config 中把 `MONGO_URI` 设为必填，启动时不满足就失败。如果确实存在可以在没有 Mongo 时运行的单元，就保持“可选”，但仍然只在 main 里打开一次。
- 用单个 `*mongodb.Client` 参数替换所有 `**dashboardstats.Connection` 槽和 `dashboardstats.Open` 调用。`dashboardstats` 改为接收这个客户端。
- 关闭时机：在所有使用 Mongo 的 worker/调度器停止之后，只断开一次。

### C. 清理开关残骸并整理装配

- 删除所有恒为 true 的变量，把 `if true {` 和恒真条件内联，删除不可达的 nil 检查。保留真正的门控，即 AGENTS.md 中列出的 `SCHEDULE_ENABLED` / `BULLMQ_WORKERS_ENABLED` / `WS_REDIS_ADAPTER_ENABLED` / `GRAPHQL_SUBSCRIPTION_BUS`，以及确实依赖可选资源的分支。
- 把 `main.go` 中仍然内联的大段装配移到按领域命名的 `wire_<domain>.go`（或并入已有的同领域文件）。最终 `run()` 只负责：加载配置 → 打开共享资源 → 依次调用各领域装配 → 启动 → 等待信号 → 按逆序关闭。
- 关闭逻辑统一为一个 `closers` 栈，元素为 `func(context.Context) error`，按逆序执行。顺序必须与现在一致：先停 HTTP，再停 worker/调度器，最后关 Redis/Mongo/MySQL。改之前先完整读现有的关闭代码，把顺序写进 PR。
- 文件改名：`legacy_fallback.go` → `not_found_recorder.go`，`nest_residual_duties.go` → `maintenance_duties.go`。删除已失效的注释和日志字段。
- 不要改 `internal/legacyproxy` 包名或路由（那属于 REFACTOR-HTTP-ROUTER-001），只改 `cmd/api` 内的调用代码。

## 等价陷阱

1. 删除“恒真变量”之前，先确认它确实恒为 true，并且没有在后面被重新赋值。有些变量是由其他变量派生的，例如 `graphqlCrawlMetadataGo := graphqlReadGo`。
2. 装配顺序有依赖关系：先创建的资源会被后面的单元复用（例如 `graphqlLimiter` 必须由 HTTP 与 WebSocket 共用同一实例，`vectorServiceHealth` 必须进程级唯一）。移动代码时这些“同一实例”的约束不能被拆开。
3. 原来“启动失败”的条件必须仍然导致启动失败，原来“只记日志、继续运行”的情况必须仍然继续运行。逐条对照列出。
4. Mongo 客户端的 `SetServerSelectionTimeout(5s)` 保持不变。`health/probes.go:332` 的探针客户端使用自己的 1.5s 超时、按需连接，这是有意的，不要合并。
5. 连接池上限可能影响长事务和 `GET_LOCK` 会话占用。所以 `lockDB` 留给 LOCKS 任务处理，本任务不要把它合并到主池。

## 测试

- `config` 新增变量的默认值与非法值测试。
- `mysqldb` 的 URL 解析测试（搬迁原有测试）。
- `cmd/api/main_test.go` 中依赖被删变量的断言，相应调整。

## 交付范围

允许修改：`cmd/api/**`、`internal/config/**`、`internal/platform/{mysqldb,mongodb}/**`（新增）、`internal/dashboardstats/**`、`internal/usersettings/mysql_repository.go`、`internal/itemsreading/mysql.go`、以及所有接收 Mongo 连接的包的构造函数签名、`.env.example`、`infra/docker/.env.sample`、`infra/docker/docker-compose.yml`、`AGENTS.md` 中提到环境变量的地方（如需要）。
