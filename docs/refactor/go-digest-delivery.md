# 每日摘要定时投递迁移（DIGEST-DELIVERY-001）

本批把每天一次的 `UserDigestDeliverySchedule` 执行链从 NestJS Cron 迁到
`apps/api-go`：Go 每分钟扫描、按活动组织认领到期日程、调用既有 Go 摘要生成、
真实 SMTP 投递、回写 sent/empty_notified/failed，并补一条摘要专用实时通知桥。
五条既有 HTTP（`GET /api/user-digest`、`GET/PUT /api/user-digest/preference`、
`GET/PUT /api/user-digest/delivery`）契约、开关和响应字段不变，后台复用同一个
Go `userdigest.Service`。

## 开关、资源与所有权

新增跨进程开关 `API_GO_USER_DIGEST_DELIVERY_MODE`，Nest 与 Go 注入同一值：

- 空串按 `legacy`；只接受 `legacy`/`go`；非法值在 Go `config.Load` 和 Nest
  `env.schema.ts` 都启动失败。
- `legacy`（默认）：保留 NestJS `@Cron(EVERY_MINUTE)`，不启动 Go 调度器，不建
  NestJS 摘要通知 subscriber。
- `go`：Go 执行整条投递链；NestJS `runScheduledDeliveries` 在尝试 tick gate 前
  直接返回；NestJS 摘要通知 subscriber 用 `REDIS_CLIENT` 的 duplicate 连接订阅
  `user-digest:notifications:v1`；NestJS Socket.IO 服务保留。

delivery-only 可在 `API_GO_USER_DIGEST_MODE`、`CONTENT_SUBSCRIPTIONS`、
`USER_NEWS_BEHAVIOR`、`RUNTIME_SETTINGS`、`AUTH_LOGIN`、`IDENTITY_ONBOARDING`
以及全部 GraphQL 模式均为 `legacy` 时独立运行。Go 后台不验 JWT，不要求
`JWT_SECRET`，也不强开任何 HTTP 模式；`go` 要求 `DATABASE_URL`、`REDIS_HOST`、
`MONGO_URI` 和既有 `SMTP_*`。ES 关键词读取沿用既有可选配置与 Mongo 回退。

## Go 执行链

1. **每分钟 tick gate**：`cron:user-digest-delivery:tick-gate`，值 `{claimedAt}`，
   `SET NX EX 55`；持有期间不删除。抢不到跳过；Redis 错误使本 tick 失败，不失锁
   继续投递。启动不补跑历史分钟。
2. **活动组织**：`Org.isActive=true`，`id ASC`，读具名数组缓存
   `org:active:list:v1`（TTL 15 秒），缓存读取失败回退数据库；填充沿用 NestJS
   `wrap` 的物理锁 `lock:org:active:list:v1`（2 秒）。
3. **运行并发**：`SystemSetting.key=multi_tenant_scheduler_runtime_settings`，
   复用 `runtimesettings` 全记录规范化器；`userDigestDeliveryOrgConcurrency`
   缺省 4、范围 1–16，其他并发字段非法同样让读取失败，不自修复。进程内 30 秒
   缓存与 NestJS `getRuntimeSettings` 一致。同组织日程顺序处理。
4. **组织锁**：`lock:cron:user-digest-delivery:org:<orgId>`，`SET NX PX 55000`
   随机 token，约 TTL/3 续租，完成时按 token 释放。抢不到该组织跳过。
5. **到期扫描**：`enabled=1`、`nextRunAt IS NOT NULL AND nextRunAt <= 固定 now`、
   `User.isActive`、同组织活动 `Membership` 与活动 `Org`，排序
   `nextRunAt ASC, updatedAt ASC, id ASC`。使用读取时原 `nextRunAt/updatedAt/id`
   做游标分批扫描到耗尽；批次大小不是当天投递上限。
6. **分支**：
   - 邮箱失去验证：条件认领旧 slot，`enabled=false`、`nextRunAt=NULL`、
     `lastStatus=failed`、`lastError=Email is no longer verified for this user`，
     发失败通知，不发信。
   - 无事件：认领旧 slot、推进 `nextRunAt`、`empty_notified`、清 `lastError`，
     发 empty 通知，不发邮件。
   - 有事件：先条件认领并推进 `nextRunAt/lastStatusAt`，再构造并发送 HTML+text
     邮件；成功后写 `lastSentAt/lastStatus=sent/lastStatusAt`、清错误，再发 ready
     通知。
   - 生成失败或 SMTP 失败：写 `failed/error` 并通知；SMTP 失败不自动重发，不撤回
     已领取 slot。
7. **竞争修正**：未领取 slot 的生成失败分支与旧 slot 条件比较
   `id + orgId + enabled + 旧 nextRunAt`，不会覆盖生成期间用户的禁用或改期；
   认领失败返回 `idle`，不发通知、不发邮件。已领取后的错误保持
   `slotAlreadyClaimed` 语义，不再推进日程。

## 邮件与通知

- 复用 `authlogin.NewMailSender` / `MailMessage` / `Send` 与真实 SMTP 实现，不另建
  协议栈，不改登录/OIDC 核心。
- subject 为 `每日摘要｜<用户时区日期>`；保留中文日期、姓名、窗口天数、事件数、
  条数、最近时间和链接。模板等价转义 Handlebars 默认字符集。标题回退
  `title → primaryEntity → primaryTopic → eventId`；summary 空回退 `暂无摘要。`；
  代表 URL 仅接受绝对 http/https，否则回退 `NEXTAUTH_URL`（去尾斜线，空值
  `http://localhost:3000`）的 `/today`。
- 通知先写 MySQL `Notification`（`type=system`、orgId/userId 必填、`readAt=NULL`），
  data 为具名强类型结构，含 `link=/today` 与 `presentation`。三种 kind：
  `user_digest_ready`、`user_digest_empty`、`user_digest_delivery_failed`。写入
  成功后发布 `user-digest:notifications:v1` 消息
  `{version:1, notificationId, orgId, userId}`，不携带邮件正文。
- NestJS subscriber 使用 `REDIS_CLIENT` 的 duplicate 连接，按 id+orgId+userId
  重读 `Notification`，只接受上述三种 kind，再通过
  `NotificationsGateway.emitLocalNotification` 只向本实例已认证且 orgId/userId
  均匹配的本地 socket 发一次。不复用会经 Socket.IO Redis adapter 跨实例广播的
  普通 dispatcher。关闭时只 unsubscribe/quit duplicate 连接，不关闭共享 Redis。
- Redis Pub/Sub 实时投递为 best-effort；无监听或断线不伪造推送成功。Notification
  持久化与现有列表读取提供补读，不新增重放队列。

## 原子性、执行保证与明确差异

- SQL 认领与结果回写是原子条件更新；SMTP 与摘要查询不放在长事务里。
- 保留当前“先推进 slot 再发信”的语义：SMTP 成功与 DB 回写之间存在崩溃窗口，
  因此本链不是 exactly-once。
- 不引入邮件 outbox/重试平台；SMTP 失败不自动重发。
- 本链无 BullMQ producer/worker，不认领其他 Cron/Outbox。
- 相较 NestJS，本批修正了两处：未领取 slot 的失败写改为旧 slot 条件更新；
  到期扫描改为固定 cutoff + 稳定游标分页。

## 切换与回滚

启用：

1. 先部署默认 `legacy` 的新代码。
2. 所有 Nest 实例切 `go`：停旧 Cron、开摘要 relay。
3. 等旧 in-flight 退出。
4. 再启 Go 后台 `go`。

回滚：

1. 停 Go 后台新任务。
2. 等 in-flight 收口、组织锁释放。
3. 再将所有 Nest 实例切回 `legacy`，恢复 Cron。

不能只改 `apps/api-go` 变量就宣称回滚完成。共用 tick/组织锁和 SQL CAS 是混合
版本期间的保护，不能代替明确单一执行权。

## 验证与未核实范围

- 已提交 Go 单元测试覆盖：有内容 sent、空摘要 empty、未验证邮箱停用、
  生成失败、SMTP 失败、旧 slot 竞争失败（idle 无副作用）、生成失败 CAS 失败、
  稳定分页跨批、邮件回退与转义。
- 本机未安装依赖、未运行 `go build`/`go test`、Docker 或服务启动；SMTP、Redis、
  Mongo、ES、Socket.IO 多实例 relay 的真实验证未执行。普通 GitHub Actions CI 的
  精确 head 与 job 结果以 PR 描述为准。部署、真实流量和 SMTP 实网投递均未验证；
  外键、`Notification` 持久化和 Socket.IO 本地投递需在真实多实例环境复核。
