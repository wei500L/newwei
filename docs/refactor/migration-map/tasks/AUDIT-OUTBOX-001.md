# AUDIT-OUTBOX-001 · 审计失败补偿完整消费链

- 状态：in_progress；2026-10-19 编码窗口在独立分支 `refactor/go-audit-outbox` 完成实现，待推送并创建业务 PR。规划 PR [#91](https://github.com/wei500L/newwei/pull/91) 仍开放。
- 基线：`origin/main c70b0373990ab931758f7a000511c2d34572fc33`。只深入 BL-20 的 AuditLogOutbox，不认领其余 Outbox/worker；关联 GAP-ASYNC-001。
- 独立业务分支：`refactor/go-audit-outbox`；worktree：`/Users/oo/project/newwei-go-audit-outbox`，从执行时最新 `origin/main` 创建，创建前目录不存在、无其他窗口占用。
- 规划发布分支：`docs/plan-audit-outbox`，worktree：`/Users/oo/project/newwei-plan-audit-outbox`；任务与提示词来自该分支的单文件，不改写整份地图。
- 基线普通 CI [39163544617](https://github.com/wei500L/newwei/actions/runs/39163544617) 在精确SHA c70b0373990ab931758f7a000511c2d34572fc33 success；verify/vector-integration/api-go-user-settings-integration success，两个regen skipped。非本任务实现/部署/故障恢复证据。

## 范围、契约与复用

唯一后台入口为Nest `modules/audit/audit-log-outbox.service.ts:retryPendingAuditLogOutbox`。用户可见出口是既有 `GET /api/admin/logs/audit`（settings.manage，orgId取身份），不重迁查询或任何生产者，不增加HTTP/GraphQL root。

完整迁每分钟扫描→Redis续租锁→三状态候选合并/200条→并发8→payload与org校验→条件事务认领→五元身份查重/写AuditLog→删除outbox，或失败退避/10次dead；5分钟stale恢复、缺省/null/日期/updatedAt与退出收口。payload存MySQL JSON，metadata可用RawMessage叶子；两张MySQL表，无Mongo/BullMQ/外部服务。

已有复用：sharedDB/OpenMySQLFromURL、sharedRedis；userdigest 的公开 Redis 端口与 Start/Close 生命周期作为参考（Lua helper 私有，本包自带两份 token 校验脚本）；adminlogs 既有 org-scoped 读取未改。

## 实现（2026-10-19）

- 新增 `apps/api-go/internal/auditoutbox/`：`doc.go`、`model.go`、`payload.go`、
  `selection.go`、`repository.go`、`lock.go`、`scheduler.go` 及两个测试文件。
- 新增 `apps/api-go/cmd/api/audit_outbox.go`；`cmd/api/main.go` 仅追加
  `needsRedis`、无效 DATABASE_URL 启动失败清单、调度器变量、defer 关闭与 wire/Start。
- `internal/config/config.go`：`AuditOutboxMode`（空/legacy/go，默认 legacy，非法值失败）、
  `ScheduleEnabled`（严格按 Nest `!== "false"`）、go 只要求 `DATABASE_URL`/`REDIS_HOST`。
- Nest：`audit-log-outbox.service.ts` 注入 `EnvService`，在 `cache.withLock` 前按
  `API_GO_AUDIT_OUTBOX_MODE=go` 退出；`env.schema.ts` 同名枚举校验。模块装配不变。
- 共享接线：`infra/docker/docker-compose.yml` 的 api 与 api-go 各注入
  `${API_GO_AUDIT_OUTBOX_MODE:-legacy}`；`infra/docker/.env.sample` 追加同键；
  `apps/api-go/README.md` 追加上线段落。未改其他开关、资源或退出逻辑。
- 交付说明：`docs/refactor/go-audit-outbox.md`。

## 查询优化与契约差异

三路先读 `id/orgId/status/attempts/createdAt`（各 LIMIT 200，`createdAt ASC, id ASC`），
合并/去重/全局排序取 200 后，仅对入选 id 发一条 `IN` 批量补 payload；被删除的候选
跳过。最终集合与顺序不变，payload 预取上限 200，无 N+1、无全表读取。

记录的实际取舍：Nest 的 id tie-breaker 是 `localeCompare`，Go 用字节比较；对
`[0-9a-z]` cuid 等价，线上是否存在其他字符集的旧 id 未核查。`metadata` 缺省写 SQL
NULL、显式 `null` 写 JSON null；Nest/Prisma 的最终映射未实跑。`lastError` 为
VARCHAR(191)，与 Nest 一样不截断。

## 占用、开关与边界

新增 `API_GO_AUDIT_OUTBOX_MODE` 空/legacy/go，双进程校验并注入；go 由 Go 唯一消费，
Nest 锁前退出；`SCHEDULE_ENABLED=false` 时两边都停调度。实际 key
`lock:cron:audit-log-outbox`，NX PX55000，随机 token，约 TTL/3 续租，按 token 释放。

启用先停旧 Nest 本链并 drain，再开 Go；回滚反向。实际部署未执行。排除
RawItem/CrawlCleanup/NewsPipeline Outbox、审计 retention、告警及其九 provider/BullMQ、
其他后台链/WS；不重迁 #70 八写、摘要通知桥、知识复核等。

## 核对与剩余验证

实现窗口静态复核了 SQL 与事务、UTC 毫秒、nullable JSON、租户绑定、claim 条件、
Redis key/续租/释放、main 退出顺序。新增 Go 测试覆盖合并/200、payload 缺省/null/
无效、租户不匹配、认领竞争、查重、退避/10 次 dead、Close 后不再认领、模式与资源
校验；本机按约束未运行 build/test。

未验证：真实 MySQL/Redis 故障恢复、多实例租约切换、混合版本启用/回滚、
`Prisma Json?` 实际落库、旧 id 字符集。下一检查点是业务 PR 的精确 head 与普通 CI；
届时只回填本审计子链，不关闭整个 GAP-ASYNC-001。
