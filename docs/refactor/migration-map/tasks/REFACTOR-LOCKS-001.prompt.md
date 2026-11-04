# 执行提示词 · REFACTOR-LOCKS-001 · Redis 租约与 MySQL GET_LOCK 各收敛为一份

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-LOCKS-001.md`。worktree slug：`refactor-locks`。

**前置**：REFACTOR-SAFE-GOROUTINE-001 已实际合入 main 并且 CI 成功。租约续期 goroutine 已经被它包上了 panic 隔离，你要保留这个效果。REFACTOR-RUNTIME-WIRING-001 可以同时进行；你们唯一可能冲突的文件是 `cmd/api/llm_gateway_profiles.go`，main 前进时用 merge 保留双方的改动。

## 问题（规划基线 18c41879858d 已核实）

### 1. Redis 互斥租约

`internal/cronlock/lock.go` 已经提供了 `WithLock` 和 `WithRenewableLock`：SET NX PX、按 `max(500ms, ttl/3)` 续期、校验 token 后释放、续期失败时取消 runner 的 ctx。它的包注释自己也承认还有私有副本。目前仍各自手写 SET NX + pexpire 续期 + 校验释放的有：

- `internal/searchreindex/lock.go`（物理 key 为 `lock:search:reindex:org:<id>`）
- `internal/newsbackfilljobs/lock.go`
- `internal/auditoutbox/lock.go`
- `internal/crawlmaintenance/lock.go`（第 38 行是 `"lock:"+key`）
- `internal/newsnowsources/lock.go`
- `internal/telegramclient/lease.go`（232 行，带接口抽象）
- `internal/gdeltsnapshot/cache.go` 中的 lease

另外，下面这些文件里也有 `SetNX`，需要逐个**分类**后再决定是否迁移：`economicdata/scheduler.go`、`newseventsingest/scheduler.go`、`newsnowhottest/scheduler.go`、`kgingestion/redis.go`、`userdigest/delivery_redis.go`、`rediscache/cache.go`、`crawlmaintenance/active_orgs.go`、`newssourcescheduler/cache.go`、`dashboardwarmap/opensky.go`、`classificationrssops/cache.go`、`itemsreading/cache.go`、`contentcatalog/cache.go`、`qualityoverview/snapshot.go`、`crawlreadtelemetry/snapshot.go`、`situationsignals/insights_cache.go`、`alertworker/providers/cache.go`、`newsbehavior/*`、`accountsecurity/store.go`、`authlogin/store.go`、`realtimeevents/sources.go`。

### 2. MySQL `GET_LOCK`

共有 6 份实现，质量不一致：

- 正确写法：`dataruntimesettings/lock.go`、`infrastructuresettings/lock.go`、`authfactors/lock.go`。它们在专用的 `*sql.Conn` 上执行 GET_LOCK；如果 RELEASE_LOCK 失败，就通过 `conn.Raw` 返回 `driver.ErrBadConn`，把这条物理连接从池中逐出，避免锁随着连接被归还到池里。
- `platformgovernance/lock.go`：同样用 `db.Conn`，但**没有**逐出逻辑。RELEASE 失败时，持有锁的会话会被归还到池里，之后被其他请求复用，导致锁泄漏。
- `modelaccesssettings/lock.go:68`：**每次加锁都新建一个完整连接池**，用完再 Close。
- `llmgatewayprofiles/lock.go` + `cmd/api/llm_gateway_profiles.go:35`：单独开了一个 `MaxIdleConns(0)` 的 lockDB 池。

## 方案

### A. Redis：统一到 `cronlock`

1. 先给每个候选文件分类，并写进 PR 表格：
   - **互斥租约**：持有期间独占、结束时释放 → 迁移到 cronlock。
   - **tick gate / 节流闸门**：SET NX 加 TTL，**不释放**，靠 TTL 自然过期来限制频率。例如 `crawlmaintenance/lock.go:93` 注释写的 "tick-gate key with no lock: prefix"，以及 `newsbackfilljobs/lock.go:130`。→ **不迁移**，可以在 cronlock 里增加一个 `TryGate(ctx, key, value, ttl) (bool, error)` 供它们共用，但语义必须是“不释放”。
   - **缓存/去重/限流**：不属于本任务，保持原样。
2. 给 cronlock 增加一个接收**完整物理 key** 的入口，例如 `WithLease(ctx, physicalKey, ttl, renewMode, runner)`。原来的 `WithLock(key)` 只是在前面加上 `"lock:"` 前缀。这样所有迁移后的物理 key 都**逐字节不变**，滚动发布期间新旧版本进程仍然互斥。
3. 续期语义按原副本选择：
   - 原副本续期失败时取消工作 → 用 `WithRenewableLock` 的语义；
   - 原副本只是尽力续期 → 用 `WithLock` 的语义；
   - 原副本完全不续期 → 增加 `renewMode=none`，只设 TTL，结束时校验 token 后释放。
4. 如果 `telegramclient/lease.go` 是需要持续持有、并对外暴露 Lost 信号的长租约（接口抽象主要是为了测试），评估之后可以只把它内部的 Lua 和 token 释放换成 cronlock 的实现；如果它的生命周期模型与 cronlock 差异太大，就保留它，并在 PR 中说明理由。不要为了迁移而扭曲 cronlock 的 API。

### B. MySQL：新增 `internal/platform/mysqllock`

- 以 `infrastructuresettings/lock.go` 为基准：`WithLock(ctx, db *sql.DB, name string, waitSeconds int, fn func(context.Context) error) error`。
  - 在专用 `*sql.Conn` 上执行 `SELECT GET_LOCK(?, ?)`，返回值必须是 1 才算获得锁。
  - fn 执行结束后，用独立的短超时 ctx 执行 RELEASE_LOCK。
  - RELEASE 失败或返回值不为 1 时，用 `conn.Raw(func(any) error { return driver.ErrBadConn })` 逐出该连接。
  - 获取锁失败、返回 0 或 NULL 时，返回哨兵错误 `ErrNotAcquired`，由各域映射成自己原来的错误。
- 6 个域全部改为调用这个包。`modelaccesssettings` 不再新建连接池，直接用主池。`llmgatewayprofiles` 的独立 lockDB 删除，改用主池，并删除 `cmd/api/llm_gateway_profiles.go` 中创建 lockDB 的代码。因为有逐出机制，就不再需要 `MaxIdleConns(0)`。
- `platformgovernance` 因此获得逐出行为。这是一个**缺陷修复**，在 PR 中写明。
- 各域的等待秒数（例如 10 秒、配置项 `defaultLockTimeoutSeconds`）和错误文案保持不变。

## 等价陷阱

1. **物理 key 不能变**。有的副本自带 `"lock:"` 前缀常量，有的在调用处拼接，迁移时最容易出现双重前缀或者丢失前缀。在 PR 中逐个列出“迁移前物理 key → 迁移后物理 key”，两者必须完全相同。
2. 锁的 value：有的写随机 token，有的写 `{"claimedAt": ISO}` 这样的 JSON payload（tick gate）。外部（队列运维页面或其他读取方）可能会读取这个 value，用 `grep` 核实后再决定是否可以改动；不确定就保持原样。
3. 释放必须校验 token，绝不能直接 DEL，否则会删掉其他持有者的锁。
4. 续期间隔、TTL 与 runner 的 ctx 取消语义按原副本保留，在差异表里逐个说明。
5. `GET_LOCK` 的名字长度上限是 64 个字符，原来的名字不要改。
6. `mysqllock` 用的是主池里的连接。如果某个域在 fn 里又开启了事务，确认它使用的是 fn 收到的 ctx 和主池，而不是锁连接；原来的行为是什么，就保持什么。

## 测试

- 把各副本已有的租约测试迁到 cronlock 或 mysqllock。
- 加用例：完整物理 key 透传不加前缀；`renewMode=none`；RELEASE 失败时触发逐出（用 fake driver 或现有测试替身，不要新建大型框架）。

## 交付范围

允许修改：`internal/cronlock/**`、`internal/platform/mysqllock/**`（新增）、上面列出的租约文件及其调用方、6 个 GET_LOCK 文件及其调用方、`cmd/api/llm_gateway_profiles.go`。
