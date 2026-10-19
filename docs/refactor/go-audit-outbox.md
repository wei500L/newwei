# 审计日志失败补偿链迁移（AUDIT-OUTBOX-001）

本批把 NestJS 的 `AuditLogOutboxService.retryPendingAuditLogOutbox` 完整执行链迁到
`apps/api-go`：每分钟扫描、Redis 续租锁、三状态候选合并、条件认领、五元身份查重
写入 `AuditLog`、删除 outbox、失败退避与 `dead` 收口，以及 5 分钟 stale 恢复和
退出收口。

用户可见出口不变：管理员仍通过既有 `GET /api/admin/logs/audit`（`settings.manage`，
orgId 取自鉴权身份）读取补回的记录。本批不新增 HTTP 路由、GraphQL root、手工重放
接口或权限点，也不改 `adminlogs` 的查询、分页、脱敏和返回模型。

## 范围、入口与所有权

- 唯一后台入口：`apps/api/src/modules/audit/audit-log-outbox.service.ts:59`
  `retryPendingAuditLogOutbox`，`@Cron(EVERY_MINUTE)`。
- 用户可见出口：`apps/api/src/modules/observability/admin-logs.controller.ts`
  `listAuditLogs` 与 `apps/api-go/internal/adminlogs/{handler,service}.go`（未改动）。
- 数据事实源：MySQL `AuditLog`、`AuditLogOutbox`（`packages/db/prisma/schema.prisma`
  的 `AuditLog`/`AuditLogOutbox`/`AuditLogOutboxStatus`）。两者都不是 Mongo 集合。
- 生产者协议未改：`internal/{authlogin,identityonboarding,accountsecurity,…}/audit.go`
  等仍写同一 envelope，双失败时各自保持“只记日志”或“返回原错误”的既有行为。

本批明确排除 `RawItemOutbox`、`CrawlCleanupOutbox`、`NewsPipelineOutbox`、
`AuditLogRetentionService`、告警九类 provider、BullMQ 扫描/投递、采集/归档/分析、
Subscription/WS，以及已合入的网关、来源策略、OIDC、知识复核、RSS、导出业务。

## 开关、资源与执行所有权

新增跨进程开关 `API_GO_AUDIT_OUTBOX_MODE`，Nest 与 Go 注入同一值：

- 空串按 `legacy`；只接受 `legacy`/`go`；非法值在 Go `config.Load`
  （`apps/api-go/internal/config/config.go`）和 Nest `env.schema.ts` 都启动失败。
- `legacy`（默认）：保留 NestJS 每分钟 Cron；Go 不创建、不启动调度器。
- `go`：NestJS 在申请 Redis 锁和扫描之前直接退出
  （`audit-log-outbox.service.ts:63`），Go 唯一负责本链；Nest 其他业务和 Cron 不变。
- `SCHEDULE_ENABLED=false`：Nest 的 `audit.module.ts` 不导入 `ScheduleModule`，
  Go 的 `wireAuditOutbox` 也不启动调度器，本链整体停止调度。摘要投递对该变量的
  既有处理不改。

Go 只开本模式即可运行：`DATABASE_URL`、`REDIS_HOST`（及既有 Redis 连接配置）。
不要求 `JWT_SECRET`、`MONGO_URI`、SMTP；不强开 GraphQL、`adminlogs`、设置或任何
HTTP 模式；`needsCredentialedGo` 的鉴权边界保持不变。`wireAuditOutbox` 的错误
直接启动失败，不吞错，也不新增启动 Ping/探针。

## 选中、认领与投递

1. **每分钟一次**：首次 tick 对齐下一个整分，启动不补跑历史分钟；延迟 tick 重新
   对齐到下一个未来整分（`scheduler.go:118` `loop`）。
2. **固定本批 now / staleCutoff**：`now` 与 `now-5min` 只在 tick 开始时计算一次。
   - `pending`/`failed`：`availableAt <= now`
   - `processing`：`lockedAt < staleCutoff`（严格小于；`lockedAt IS NULL` 不匹配）
   - `dead` 不扫描
3. **每状态 200 条**，均按 `createdAt ASC, id ASC`；合并时同一 id 以先出现的
   分组为准（pending → failed → stale processing），全局排序后取 200
   （`selection.go:14` `mergeCandidates`）。
4. **payload 只补入选记录**：三路轻字段扫描后，仅对最终 200 条发一条
   `SELECT id, payload … WHERE id IN (…)`；两次读取之间被删除的 id 直接跳过
   （`scheduler.go:251`）。
5. **条件认领**（`repository.go:141` `Claim`）：短事务内
   `UPDATE … SET status='processing', lockedAt=now, attempts=attempts+1,
   lastError=NULL, updatedAt=now WHERE id=? AND orgId=? AND status=?
   AND (availableAt<=now | lockedAt<now-5min)`；影响 0 行表示已被其他执行者处理，
   直接跳过；随后在同一事务读取认领行的 `attempts`。认领瞬时 `now` 按源方法重新
   计算，不复用批次 now。
6. **五元查重**（`repository.go:189`）：`(orgId, actorId, resource, action,
   createdAt)`；`actorId=null` 用 `IS NULL`。命中则不插入，仍删除 outbox。
7. **写入**（`repository.go:223`）：保留 payload 的业务 `createdAt`、metadata 与
   `ipAddress`；id 由客户端生成 cuid 形态字符串；不使用 outboxId 作为 `AuditLog.id`。
8. **删除**（`repository.go:243`）：`DELETE … WHERE id=? AND orgId=?`，绑定已核对
   的租户。
9. **失败**（`scheduler.go:339`）：使用认领后的 `attempts`；`attempts>=10` 转
   `dead`，否则 `failed`，`lockedAt=NULL`，`lastError=错误消息`，
   `availableAt=失败时刻+退避`。退避为
   `round(30000 * 2^max(min(attempt,5)-1,0) * (0.5+random()))` 毫秒。
10. **状态写失败**只记 warning，保留可恢复数据；单条失败不终止其他记录，也不
    反向改变已提交的业务请求。

这是至少一次投递：先写 `AuditLog` 再删 outbox，两步之间失败会重投；查重保证重投
不重复插入（当前没有数据库唯一约束，不宣称 exactly-once，不新增 schema/幂等表/
审计唯一索引）。

## 查询优化与等价性

原 `fetchRetryEntries` 在三状态各读 200 条时一起读取 `payload`，最多搬运 600 份
大 JSON，最终只处理 200 条。本批改为：

| 阶段 | 原实现 | 本实现 |
|---|---|---|
| 候选读取 | 3 × 200 行，含 payload | 3 × 200 行，仅 `id/orgId/status/attempts/createdAt` |
| 合并 | 同 id 先到先得 → 排序 → 取 200 | 相同规则（`mergeCandidates`） |
| payload | 已随候选读取 | 仅入选 ≤200 条批量补读一次 |

等价性依据：选择键只有 `(createdAt, id)` 和分组顺序，payload 不参与；补读按主键
`IN` 一次完成，不引入全表读取或逐候选 N+1；认领后源本就需要的读取不计入预取。
排序 tie-breaker 在 Nest 用 `String.prototype.localeCompare`；本链持久化的 id 是
`[0-9a-z]` 的 cuid，ICU root collation 与字节比较一致，因此 Go 用 `ID <`。若线上
存在非该字符集的旧 id，这一点需要重新核对——本轮未做该数据核查，见“未验证项”。

## Payload、时间与 null 语义

- 根必须是 JSON object；`orgId`/`resource`/`action`/`createdAt` 必须是非空白
  string（`payload.go:55`）。trim 只用于判断有效性，不重写原值。
- `createdAt` 按源端日期输入语义解析：`RFC3339Nano` 覆盖正常生产者的
  `toISOString()` 毫秒 UTC；无时区时间与纯日期按 UTC 解释（假定 Nest 进程
  `TZ=UTC`，容器默认）；解析结果截断到毫秒，与 `DATETIME(3)` 和查重比较一致。
- 不用 `outbox.createdAt` 或重放时间替代业务 `createdAt`。
- `actorId`/`ipAddress` 缺省、`null` 或非 string 归一为 `null`；string 原样保留，
  不额外 trim、不要求非空、不预查用户是否存在；外键错误按投递失败重试。
- `metadata` 保留输入存在性：成员缺省 → SQL NULL；显式 JSON `null` → JSON null
  值（写入字面量 `null`）。这一点与 Go 生产者直接 `INSERT []byte` 的 SQL 语义
  一致。Nest 侧 `Prisma Json?` 对 `undefined`/`null` 的最终落库映射未在本机实跑，
  不作为运行证据。
- `metadata` 不按 `resource` 重新投影；未知 envelope 附加字段忽略。
- `lastError` 列为 `VARCHAR(191)`，与 Nest 一样不做截断：超长错误使状态更新失败，
  只记 warning，记录保持可恢复（`processing` 由 5 分钟 stale 规则回收）。

无效 payload 或 `payload.orgId !== AuditLogOutbox.orgId`：不写 `AuditLog`；
`status=dead`、`lastError="Invalid outbox payload"`、`attempts=原值+1（至少 1）`、
`lockedAt=NULL`、`availableAt=当前时间`（`scheduler.go:251`）。

## Redis 租约与退出收口

- 物理 key：`lock:cron:audit-log-outbox`（Nest `CacheService.withLock` 的 `lock:`
  前缀；不是逻辑 key）。
- `SET NX PX 55000`，随机 16 字节 hex owner token；约 TTL/3（18.3s）续租；续租与
  释放都用 Lua 比较 token（`lock.go`）。不增加摘要 tick gate、组织锁或通用协调框架。
- `Start` 只执行一次。`Close`：关闭 stop 信号 → 不再开始新 tick、不再认领新条目 →
  等待在途条目与整批 drain → `runTick` 的 defer 先停续租再按 token 释放锁 →
  返回后由 `main` 关闭共享 Redis/MySQL。正常退出、初始化失败和 listen 失败都走同一
  defer 收口；退出不删除未完成记录，中断留下的 `processing` 按 5 分钟规则恢复。

## 启用与回滚（本批不实际部署）

启用：
1. 停止所有旧 Nest 实例的本链调度并 drain（旧版本不识别 gate 时先升级或停止）。
2. 把 `API_GO_AUDIT_OUTBOX_MODE` 切到 `go`（`infra/docker/.env`）。
3. 启动 Go 消费；确认日志出现 `audit log outbox scheduler enabled`。

回滚：
1. 停止 Go 消费并等待在途批次 drain（`SIGTERM` → `Close`）。
2. 把 Nest 恢复 `legacy`，确认 Cron 重新持有 `lock:cron:audit-log-outbox`。

共享锁只用于混合版本期间的保护，不能替代明确的执行所有权切换；不要用全局
`SCHEDULE_ENABLED` 去关闭其他任务来完成本链切换。Web→NestJS 入口与 canary 默认值
保持现状。

## 验证与未验证项

本机未安装依赖、未运行 build/test、未启动 Docker 或服务。已做：

- 静态复核（逐条读源码，非运行证据）：SQL 与事务边界、UTC 毫秒时间、可空 JSON
  落库映射、`orgId` 绑定、认领条件、Redis key/续租/释放与退出顺序。
- 新增 Go 测试（交普通 CI 执行，本机未跑）：
  - `selection.go` 合并/去重/200 上限与排序（`scheduler_test.go`）
  - payload 缺省/null/非 string/无效内容（`payload_test.go`）
  - 租户不匹配 dead、认领竞争跳过、查重后只删不插、失败退避、10 次 dead、
    `Close` 后不再认领（`scheduler_test.go`）
  - 独立模式、非法模式、只要求 MySQL/Redis 的启动校验
    （`config_auditoutbox_test.go`）

交付 head `876dc6a4c65095627347810772857f41bc3758cb` 的普通
[CI 39241876877](https://github.com/wei500L/newwei/actions/runs/39241876877)
success：`verify`（含 `go vet ./...` 与 `go test ./...`）、
`api-go-user-settings-integration`、`vector-integration` 成功，
`contract-baseline-regen`、`go-modules-regen` skipped（不计通过）。

未验证（不写成已通过）：

- 真实 MySQL/Redis 上的故障恢复、并发认领、租约续期与多实例切换未实跑。
- Nest 与 Go 混合版本切换未实跑；`SCHEDULE_ENABLED=false` 的部署行为未实跑。
- `Prisma Json?` 对 `undefined`/`null` 的实际落库未实跑。
- 线上是否存在非 `[0-9a-z]` 的旧 outbox id（影响 localeCompare 等价性）未核查。
- 基线 CI 只证明基线本身；本任务以业务 PR 的精确 head 普通 CI 为准。

## 源码定位（本分支实现）

Nest：
- `apps/api/src/modules/audit/audit-log-outbox.service.ts:59` cron、
  `:63` 所有权 gate、`:129` payload、`:182` 投递、`:231` 认领、`:269` 扫描、
  `:312` 合并、`:337` 失败、`:374` dead、`:399` 模式读取
- `apps/api/src/modules/config/env.schema.ts` `API_GO_AUDIT_OUTBOX_MODE`

Go：
- `apps/api-go/internal/auditoutbox/scheduler.go:70` Start、`:89` Close、
  `:146` runTick、`:190` collectCandidates、`:217` processCandidates、
  `:248` processCandidate、`:270` deliver、`:292` failDelivery、
  `:305` writeAuditLog、`:336` markFailure、`:362` markDead、`:378` backoffDelay、
  `:393` startLockRenew
- `apps/api-go/internal/auditoutbox/repository.go:43/50/59` 三状态扫描、
  `:95` 批量 payload、`:141` 认领、`:189` 查重、`:223` 插入、`:243` 删除、
  `:261/283` 状态回写
- `apps/api-go/internal/auditoutbox/{payload.go:55,selection.go:14,lock.go}`
- `apps/api-go/internal/config/config.go` 模式与资源校验
- `apps/api-go/cmd/api/audit_outbox.go` wire、`cmd/api/main.go` 初始化与关闭顺序
