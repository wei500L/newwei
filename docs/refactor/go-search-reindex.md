# 搜索索引重建迁入 Go（`API_GO_SEARCH_REINDEX_MODE`）

> 本批：搜索索引重建 2 条 HTTP 迁入 Go（`POST /api/admin/search/reindex`、
> `GET /api/admin/search/reindex/:jobId`），并同步修复 Nest 与 Go 两侧的
> Bulk 逐项错误统计、进度写入、任务 TTL 与当前组织清理算法；同批优化两个
> **已迁移**遥测入口的 Redis 往返。
> 生产入口保持 Web → NestJS，canary 保持关闭，前端不改。
> 事实源：`search-admin.controller.ts`（全文，2 个方法）、
> `search-reindex.service.ts`（全文）、`search-reindex-job.store.ts`（全文）、
> `items-elasticsearch.service.ts` 的 `reindexOrg`/`ensureIndex`/`toDocument`、
> `search-telemetry.service.ts` 与 `crawlreadtelemetry/service_telemetry.go`。

## 1. 开关与回滚

- 变量：`API_GO_SEARCH_REINDEX_MODE`。只接受空字符串、`legacy`、`go`；空串与
  `legacy` 等价。**其他值让进程启动失败**，错误文本
  `API_GO_SEARCH_REINDEX_MODE must be one of legacy|go`。
- `go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`
  （条目读取模型在 Mongo；`DATABASE_URL` DSN 无效时启动失败）。
- `go` 只接管这两个 reindex 端点；**检索遥测的开关仍是
  `API_GO_CRAWL_READ_TELEMETRY_MODE`**，本批没有新增第二个遥测开关。
- **Elasticsearch 不是启动条件**：`ELASTICSEARCH_ENABLED=false`（或
  `ELASTICSEARCH_NODE` 为空）时不建客户端、不读 Mongo，任务直接
  `completed`/`indexed=0`（沿用现有禁用分支，不算真实重建验收）。
- 回滚：**只把 `API_GO_SEARCH_REINDEX_MODE` 改回 `legacy`**——纯配置变更；
  legacy 时不注册 handler、不追加路由规则。Redis 里已有的 job/list/orgs/lock
  数据由 Nest 侧同一套逻辑继续维护。
- `infra/docker/.env.sample` 默认 `legacy`；compose 是
  `${API_GO_SEARCH_REINDEX_MODE:-legacy}`。本批不改任何已有 `API_GO_*` 默认值。
- **未启用 shadow / canary，不新增 smoke workflow。**

## 2. 接管的路径（仅 `go` 时）

控制器前缀 `admin/search`，全局前缀 `api`。只接管这 2 条：

| 路径 | 方法 | 权限 | 成功码 | 说明 |
|---|---|---|---|---|
| `/api/admin/search/reindex` | POST | `settings.manage` | 201 | 返回创建时的 queued 快照 `{id, orgId, status:"queued", indexed:0, createdAt, updatedAt}`；不新增请求 DTO 与输入参数 |
| `/api/admin/search/reindex/:jobId` | GET | `settings.manage` | 200 | 只返回本组织任务；不存在/过期/跨组织返回 JSON `null` |

- 时间戳是 `Date.toISOString()` 等价格式（UTC 毫秒 + `Z`）；任务 ID 是
  UUID 字符串（Go 用 crypto/rand 生成 RFC 4122 v4）。
- 同一组织已有锁：409，`code: SEARCH_REINDEX_IN_PROGRESS`、
  `message: Search reindex is already running for this organization.`、
  `error: "Conflict"`、无 `detail`——与
  `ConflictException({code, message})` 经 GlobalExceptionFilter 展开后的形状逐
  字段一致（`authhttp.WriteCodedConflict`）。
- 其他方法（`GET` 启动作业、`POST` 查询任务等）、尾斜杠
  `/api/admin/search/reindex/`、更长路径与父路径全部回落 `/api/` 由 NestJS
  处理（Go 不返回自己的 404）。两条规则都允许 `OPTIONS` 由 Go 回答预检。

## 3. Redis 结构与锁协议（与 Nest 共用）

| 键 | 类型 | TTL |
|---|---|---|
| `search:reindex:job:<jobId>` | JSON 字符串 | 活跃 12h / 终态 1h |
| `search:reindex:org:<orgId>` | RPUSH 列表（最旧在前） | 始终活跃窗口 12h |
| `search:reindex:orgs` | SADD 集合 | 无。列表清空时 `SREM` |
| `lock:search:reindex:org:<orgId>` | 锁（`SET NX PX`） | 5 分钟 |

- `SearchReindexService` 传给 `CacheService` 的逻辑锁名没有 `lock:` 前缀，
  CacheService 才补上前缀。Go 直接用**物理键** `lock:search:reindex:org:<orgId>`，
  绝不与组织任务列表 `search:reindex:org:<orgId>` 混用。
- 锁 value 是随机 owner token；续租与释放都用 Lua 比较 token；续租间隔
  TTL/3 ≈ 100 秒。不新增第二套 MySQL 锁或任务锁。
- job JSON 的键序与 Nest 对象展开一致：创建时为
  `id, orgId, status, indexed, createdAt, updatedAt`，失败后 `error` 追加在末尾，
  completed 时 `error` 不出现。因此两侧互读/互写都保持兼容。

## 4. 后台执行顺序与生命周期

1. 取组织锁（失败 → 409，不创建任务）。
2. 创建并保存 `queued` 任务。
3. 返回 queued 快照。
4. 后台改 `running`。
5. 分批扫描 + bulk 写入，**每批更新 `indexed`、`updatedAt` 与活跃 TTL**。
6. 最后一次显式 refresh 成功后改 `completed`。
7. 出错改 `failed`，保留此前批次与当前批次已成功写入的数量。
8. 停止续租 → 释放自身锁 → 只清理本组织历史。

Go 侧后台协程用的是**服务生命周期 context**（`Service.Close()` 在进程关闭时
取消并等待），不绑定 HTTP 请求 context，所以客户端停止轮询不会中断重建。
本批**不实现进程重启后的自动续跑或重新调度**：状态留在 Redis，没有恢复器。

## 5. Mongo 分批与 Elasticsearch 写入

- 集合：`itemreadmodels`（Mongoose 默认名）。
- 始终带 `orgId`；按 `itemMetaId` 升序；下一批条件
  `itemMetaId > 上批最后一个值`；每批最多 500；不使用递增 `skip`；不把整个
  组织文档读进内存。
- 投影只取索引需要的 16 个字段（含 `_id: 0`）：`orgId`、`itemMetaId`、`title`、
  `externalId`、`sourceName`、`summary`、`topics`、`entities`、`region`、
  `location`、`sentiment`、`contentType`、`searchText`、`sortAt`、`createdAt`。
  不再读 `raw.payload`、`processed.result` 等大字段。
- 文档形状保持既有语义：null 数组 → `[]`，null 文本 → `null`，
  `searchText` 为 null → `""`；`sortAt`/`createdAt` 输出有效 UTC ISO 时间
  （缺失日期会让该批失败，而不是写入零值时间）。
- ES 文档 ID：`<orgId>:<itemMetaId>`。配置沿用
  `ELASTICSEARCH_ENABLED`（默认 false）、`ELASTICSEARCH_NODE`、
  `ELASTICSEARCH_USERNAME`、`ELASTICSEARCH_PASSWORD`、
  `ELASTICSEARCH_API_KEY`、`ELASTICSEARCH_ITEMS_INDEX`（默认 `items-v1`）、
  `ELASTICSEARCH_ITEMS_ALIAS`（默认 `items-current`）、
  `ELASTICSEARCH_REQUEST_TIMEOUT_MS`（默认 3000）。认证优先 API key，否则
  username+password（与 Nest 客户端同一优先级）。这些变量已透传到 compose 的
  `api-go` 服务。
- `ensureIndex` 保持当前行为：索引不存在时按当前 mappings 创建；alias 不存在时
  挂到当前索引。不重建共享索引、不删其他组织文档、不切整库 alias。
- Bulk：每批 `refresh=false`，NDJSON 动作行与文档行交替、末尾保留换行；Go 每批
  只保留本批文档与写入数据。重建含义不变：重写本组织已有读取模型，**本批不增加
  删除陈旧索引文档的功能**。

## 6. Bulk 逐项错误与进度（Nest 与 Go 同步修复）

修复前的缺陷：`reindexOrg` 在 `await bulk` 之后直接 `indexed += docs.length`，
不看 Bulk 响应里的逐项错误；因此 HTTP 请求成功就等于整批成功。

修复后两侧一致：

- 逐项读取 `items`：只有无逐项错误（且状态为 2xx）的项目才计入 `indexed`。
- 一批存在逐项失败时：先保存该批成功数量（同时刷新 `updatedAt` 与活跃 TTL），
  再把任务改成 `failed`；**不继续把后续批次当作成功任务执行**，**不新增自动重试**。
- 错误信息含 `itemMetaId`、ES 错误类型与截短到 200 字符的原因（空白折叠为单行），
  不含认证信息或完整文档。
- `indexed` 表示本次任务实际成功写入的文档数；失败后保留此前批次与当前批次已成功
  写入的数量；completed 时 `error` 省略。
- 每个批次结束更新 `indexed`/`updatedAt`/活跃 TTL，所以轮询 GET 能看到真实进度，
  不是一直 0、结束后突然出现总数。
- Nest 侧只给 `reindexOrg` 增加了内部进度回调参数
  （`reindexOrg(orgId, { onProgress })`），controller 的公开签名、装饰器与权限不变，
  也没有引入事件总线或通用任务抽象。

## 7. 任务 TTL 与清理算法（Nest 与 Go 同步）

修复前的缺陷：所有 job（含 queued/running）都用终态的 1 小时 TTL，与已有活动任务
12 小时保留常量不一致；`prune` 每次创建任务都会 `SMEMBERS` 全局组织集合，再对每个
组织逐条 `GET`/`DEL`/`LREM`；超额裁剪基于包含 staleId 的原列表直接截取。

修复后：

- queued/running 用活动 TTL 12 小时；进入 completed/failed 切换为终态 TTL 1 小时。
  组织任务列表 TTL 始终是活动窗口，不会先于活动任务过期。
- 清理改为**当前组织范围**：创建任务与结束任务时只清理该 `orgId`；不再为一次操作
  遍历全局组织集合。
- 实现：一次 `LRANGE` 取当前组织 jobId 列表 → 一次 `MGET` 批量读 job JSON → 单遍
  分类过期/缺失/超额/有效 → 批量 `DEL` + `LREM`。
- 超额判断基于**过滤后的有效任务列表**；裁剪只从终态任务里按最旧优先进行，
  **当前 queued/running 任务不会被历史清理删掉**。
- 不使用整段覆盖列表的写法，因此并行追加的新记录不会被丢掉；列表变空时再
  `SREM` 组织集合，保持既有组织集合语义。
- 不新增全局清理 scheduler、恢复系统或 Redis 新版本协议。

## 8. 检索遥测的批处理优化（两个入口已迁移，本批只优化）

开关不变（`API_GO_CRAWL_READ_TELEMETRY_MODE`），存储键、字段名与计数口径不变。

**写入** `POST /api/search-telemetry`：

- 仍是 `search-telemetry:<orgId>:<YYYY-MM-DD>`（UTC 日桶）、TTL 30 天，字段仍是
  `events.total`、`events.<eventType>`、`surface.<surface>`、
  `load_more.vertical.<vertical>`、`query_length.<bucket>`；只有
  `archive_load_more_click` 记 vertical；`queryLength` 分桶不变。
- 本次所有 `HINCRBY` 与 `EXPIRE` 合并为**一次 Lua 调用**（Nest：
  `CacheService.hincrbyMany`；Go：`searchTelemetryWriteScript`），减少 Redis 往返。
- 仍是 best-effort 上报响应（`{"recorded":true}`，Redis 失败被吞掉），不新增重试队列。

**汇总** `GET /api/admin/search-telemetry/summary`：

- 校验不变：`YYYY-MM-DD`、`from <= to`、含首尾最多 31 天、
  `surface filtering is not supported by the stored telemetry counters`。
- 逐日串行 `HGETALL` 改为**一次 Pipeline**（Go）与一次批处理读取（Nest：
  `CacheService.hgetallMany`）；按日期顺序对应，再一次遍历归并 `totals`/`daily`；
  没有记录的日期继续输出零值。
- 输出结构与计数不变；不按边际计数推算分 surface 分布，不改历史遥测格式。

## 9. 身份与鉴权

- 没有 `Authorization` 或不是 Bearer：401。
- `mtk_` 机器令牌：复用 `adminlogs.Service.AuthenticateMachine`（SHA-256 查
  `MachineAccessToken.tokenHash`，连 `Org.isActive`，更新 `lastUsedAt`，权限只取
  令牌行）——与 NestJS 全局 `JwtAuthGuard` 经 `MachineTokenService` 的行为一致。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + MySQL membership
  与权限重推导）。
- 缺少 `settings.manage`：403（`INSUFFICIENT_PERMISSIONS`）。
- `orgId` 一律来自鉴权身份；body/query 里的 `orgId` 不参与。

## 10. 本批实际修改的结构性变化（不含性能数字）

- Go 新增 `internal/searchreindex` 包（handler / service / jobstore / lock /
  source / elasticsearch / 具名强类型 struct 与枚举），新增
  `cmd/api/search_reindex.go` 装配与 `legacyproxy/search_reindex_routes.go`
  路由规则。
- Nest `SearchReindexJobStore` 增加 `updateProgress`，`markFailed` 增加 `indexed`
  参数，`prune` 改为组织范围并改批量读写；`ItemsElasticsearchService.reindexOrg`
  增加投影、逐项 Bulk 错误统计与进度回调；`SearchTelemetryService` 改为单次 Lua
  写入与批处理读取；`CacheService` 新增 `hgetallMany`/`hincrbyMany` 两个方法
  （不修改既有方法）。
- 新增开关 1 个（`API_GO_SEARCH_REINDEX_MODE`），compose 透传 8 个
  `ELASTICSEARCH_*`，`.env.sample` 同步。

没有真实 Elasticsearch 环境时，本批**未做真实 ES 重建验收**；禁用分支
（`indexed=0`）与编译通过都**不能**描述成 ES 功能验证。

## 11. 未验证项

- 真实 Elasticsearch 上的 `ensureIndex` + bulk + 逐项错误 + 进度轮询（本机未运行；
  需要真实 ES 的验收环境）。
- 真实 Redis 上的锁续租/释放、清理算法与遥测 Lua/Pipeline（本机只做静态检查；
  CI 的既有 job 覆盖编译与单元测试，不含本批新增的真实 Redis 集成用例）。
- 跨 Nest/Go 的混合部署互操作（两侧结构按代码逐字段对齐，未做运行时联调）。

## 12. 回滚

`API_GO_SEARCH_REINDEX_MODE=legacy` 一条配置即可把两个 reindex 端点交回 NestJS；
Nest 侧本批的缺陷修复（逐项 Bulk 错误、进度、TTL、组织范围清理、遥测 Lua/Pipeline）
是行为修复，保留不回滚。遥测开关与回滚方式不变
（`API_GO_CRAWL_READ_TELEMETRY_MODE=legacy`）。
