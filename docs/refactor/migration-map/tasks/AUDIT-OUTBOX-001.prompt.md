# 目标

为 wei500L/newwei 完整迁移审计失败补偿链，任务 ID `AUDIT-OUTBOX-001`：现有 Nest 与 Go 业务写入 `AuditLogOutbox` 后，由 Go 按时重放为 `AuditLog`，管理员可在既有审计日志页面看到恢复的记录。完整交付扫描、认领、租户校验、去重落库、成功删除、失败退避、dead 状态、调度所有权和退出收口。不新增 HTTP/GraphQL 入口凑数，不重迁既有审计生产者与日志查询。

本批入口少，但包含跨进程所有权、数据库状态机和耐久补偿。只实施这一条链，不扩成全部 Outbox/worker 迁移。

## 基线与工作目录

- 仓库 `/Users/oo/project/newwei` 当前 checkout 可能很旧；规划基线是 fetch 后的 `origin/main c70b0373990ab931758f7a000511c2d34572fc33`。
- 先读取最新 main 的 `AGENTS.md`、`docs/refactor/migration-map/{README,PLANNING}.md`、`tasks/README.md` 和本任务记录。再执行 `git fetch origin main`、`git rev-parse origin/main`、`gh pr list --state open`、`gh run list --branch main --limit 5`、`git worktree list`。只检查本链增量与新占用。
- 独立业务分支 `refactor/go-audit-outbox`；worktree `/Users/oo/project/newwei-go-audit-outbox`，从执行时最新 `origin/main` 创建。规划窗口没有创建业务目录或启动实施。若目录已存在，先核对身份和改动，不能重置别人的目录。
- 规划记录在 `docs/plan-audit-outbox` 文档分支、`/Users/oo/project/newwei-plan-audit-outbox`。若尚未合 main，可只读此分支的任务与提示词，不将整份旧地图覆盖到业务分支。
- 规划时无开放 PR；#69/#70 已合并，#81–#87 的实现经 #89（实际 main merge `f1167769f8c1d90017a6105cc65f135741ea47a1`）进入 main，#88 经 #90（`c70b0373990ab931758f7a000511c2d34572fc33`）进入 main。旧目录保留不表示仍占用。已有这些范围不得再做一遍。
- 该基线普通 CI：`https://github.com/wei500L/newwei/actions/runs/39163544617`，verify、vector-integration、api-go-user-settings-integration 成功；两个 regen job skipped。此证据不代表本任务已实现、真实数据库已验证或生产已切流。

## 源码事实与复用

以下均按上述 SHA 核对；实现时阅读完整方法，不凭旧报告补行为：

1. `apps/api/src/modules/audit/audit-log-outbox.service.ts`：`retryPendingAuditLogOutbox`（57）、`parseOutboxPayload`（117）、`deliverOutboxPayload`（170）、`claimOutboxEntry`（219）、`fetchRetryEntries`（257）、`mergeRetryEntries`（300）、`markOutboxFailure`（325）、`markOutboxDead`（362）、`computeBackoffDelay`（387），是状态机事实源。
2. `apps/api/src/modules/audit/{audit-log.writer.ts,audit.module.ts}`、`apps/api/src/app.module.ts`：生产者协议、模块装配、`SCHEDULE_ENABLED !== "false"` 的现有调度边界。
3. `packages/db/prisma/schema.prisma`：`AuditLog`（239）、`AuditLogOutbox`（253）、`AuditLogOutboxStatus`；已有索引见 `packages/db/prisma/migrations/20260323150000_reduce_disk_read_hot_paths/migration.sql`。两表都是 MySQL，不是 Mongo 审计集合。
4. `apps/api/src/modules/cache/cache.service.ts`：`withLock`、`tryAcquireLock`、`lockKey`、`createLockLease`、`acquireLock/releaseLock/extendLock`（270–410）。物理锁名、token、续租与释放照此协议。
5. Go 已有普通 SQL 连接池和 Redis：`apps/api-go/internal/usersettings/mysql_repository.go:OpenMySQLFromURL` 处理 UTC/毫秒；`cmd/api/main.go` 的 `sharedDB`、`needsRedis`。直接复用，不建第二套连接池。
6. `apps/api-go/internal/userdigest/delivery_redis.go` 的 `NewRedisDeliveryStore` 和返回的公开 `DeliveryStore` 已有 SetIfAbsent/ReleaseLock/RenewLock；可通过本任务的窄接口适配复用。Lua helper 是私有的，不能假装可跨包调用；不要为复用扩建通用调度框架。`delivery_scheduler.go` 的分钟对齐与 Start/Close 是已有生命周期参考，不复制摘要业务或活动组织筛选。
7. Go 审计生产者已存在：`internal/{authlogin,identityonboarding,accountsecurity,rbacapi,classificationrssops,modelaccesssettings,infrastructuresettings,dataruntimesettings}/audit.go`，`{runtimesettings,platformgovernance,llmgatewayprofiles,llmgatewayops,llmlogs}/store.go`，`graphqlread/{orgaccesswrite,knowledgereview}/audit.go`、`graphqlread/settingswrite/{store,sourcepolicy_store}.go`。核对其 payload 共用字段即可，不重构这些包。部分生产者双失败只记录日志，部分返回原错误；保持各自既有语义。

## 精确入口、权限与返回契约

- 新迁移入口是后台 `AuditLogOutboxService.retryPendingAuditLogOutbox` 的每分钟执行，不新增公共路由、GraphQL root、手工重放 API 或权限点。
- 用户可见出口是既有 `GET /api/admin/logs/audit`，`settings.manage`；Nest `modules/observability/admin-logs.controller.ts:listAuditLogs`，Go `internal/adminlogs/{handler,service}.go`。身份和 orgId 仍由既有鉴权推导，查询/分页/脱敏/返回结构保持，后台完成后自然可读，不改查询开关或页面。
- 调度器有跨组织扫描权限，但每条必须核对 `payload.orgId === AuditLogOutbox.orgId`。不使用请求 orgId，不把全部记录绑定某个默认组织；也不按活动组织过滤历史待补记录。
- 无新增 HTTP DTO/状态码。后台结果通过现有结构化日志和数据库状态体现；单条失败不能终止其余记录，也不能反向改变已提交业务请求结果。

## Payload、缺省/null 与错误语义

- 具名 envelope：`orgId/resource/action/createdAt`、可空 `actorId/ipAddress`、扩展叶子 `metadata`。业务结构不用 any/interface{}/map[string]any/[]any；SQL/驱动参数边界可用既有通用签名，metadata 用 `json.RawMessage` 保留各生产者的 JSON。
- 根必须是 JSON object。四个必填字段必须是非空白 string；只用 trim 判断有效，不擅自改写原值。createdAt 按源端支持的日期输入解析，正常生产者为 JS ISO UTC 毫秒；不得用 outbox.createdAt 或重放时间替代。
- actorId/ipAddress 缺省、null 或非 string 时源端归一为 null；string 原样保留，不能自加 trim/非空/用户存在校验。外键失败进入原有失败重试。
- metadata 缺省与显式 JSON null 必须分别保留其输入存在性；缺省不填成空对象。按 Prisma Json? 与现有 Go SQL 写法核对 SQL NULL/JSON null 的落库映射，记录实际选择，不把不确定的 Prisma null 行为写成已实跑证据。未知 envelope 附加字段可忽略，metadata 不做按 resource 的重新投影。
- 无效 payload 或 orgId 不匹配：`lastError="Invalid outbox payload"`，dead，attempts 为原值+1且至少1，lockedAt=null，availableAt=当前时间；不写 AuditLog。
- DB/解析/单条处理错误按源码分层记录。mark failed/dead 自身写失败只 warning，保留可恢复数据，不把整批删除或当成功；日志不打印 payload/metadata 内容。

## 扫描、事务与必要副作用

1. 每分钟一次；用分钟边界定时，启动不额外立即补跑。每批只处理最多200条，不擅改为一次清空全表。并发8，单条 settle 后继续其他条目。
2. 固定本批 now 与 staleCutoff=now-5分钟：pending/failed 的 availableAt<=now；processing 的 lockedAt<staleCutoff（严格小于）。dead 不扫描，processing.lockedAt=null 不擅自纳入。
3. 原算法分别对三状态按 createdAt ASC、id ASC 取200，再去重合并、全局排序取200。保留最终选择与顺序，不按状态轮转，不按 orgId 分桶，不新增 attempts 预过滤。使用现有 status+availableAt/lockedAt 索引。
4. 原有认领是短事务：用 id、观察到的 status 和到期/陈旧条件更新为 processing，lockedAt=认领时间、attempts+1、lastError=null，再读取认领行；0行表示已被别人处理，直接跳过。保持此业务条件和事务；SQL 显式维护 updatedAt，不能依赖 Prisma 自动更新。
5. payload 校验和认领的次序以源方法为准，不能顺手改成一套新的状态机。成功投递：按 `(orgId, actorId, resource, action, createdAt)` 查已有 AuditLog，actorId null 用正确 SQL null 比较；不存在才插入，保留原 createdAt/metadata/ipAddress；然后删除对应 outbox。metadata/ipAddress 不属于当前去重身份，不能扩大或缩小身份，也不能换成 outboxId 作 AuditLog.id。
6. 原实现是至少一次投递，查重不具有数据库唯一约束。保留兼容查重与恢复逻辑，不宣称 exactly-once，不新增 schema/幂等表/审计唯一索引；不迁改所有生产者。SQL 操作限定已核对行的 id/orgId，避免跨租户关联。
7. 投递失败使用认领后 attempts：>=10 标 dead；否则 failed，lockedAt=null，lastError=错误消息，availableAt=失败时刻+退避。退避为 `round(30000 * 2^max(min(attempt,5)-1,0) * (0.5+random()))` 毫秒，不再另加重试层。失败状态更新不能伪装成投递成功。
8. 无 Redis 缓存填充/失效、无入队、BullMQ、Mongo、SMTP、模型或其他外部 HTTP；本批不是审计保留期删除任务，不发送通知或 Socket.IO 事件。

## 有价值的查询优化

原 fetchRetryEntries 在三状态各读200条时连 payload 一起搬运，最多读取600份大 JSON，最终只处理200条。改为三路先读具名轻候选（id/orgId/status/attempts/createdAt），按原规则选出最多200条，再仅为入选记录批量补 payload、按候选顺序处理。记录被其他实例删除时跳过；保留最终认领时的到期/状态复核，不用补 payload 代替认领。

验证候选集合/顺序和原算法等价，单批 payload 读取上限降到200，不增加全表查询或逐候选N+1预取；认领后源本就需要的读不计作新预取。若实际 SQL 方案无法保持排序契约，优先保持原选择，说明具体取舍，不借机改批量/重试策略。

## 文件所有权、共享接线与排除

- 拥有新增 `apps/api-go/internal/auditoutbox/`、`apps/api-go/cmd/api/audit_outbox.go`，以及本批必要测试和 `docs/refactor/go-audit-outbox.md`。
- Nest 只允许 `modules/audit/audit-log-outbox.service.ts` 增加所有权 gate/EnvService 注入及必要模块依赖；`modules/config/env.schema.ts` 增加同名模式校验。不得改写 audit-log.writer.ts 的生产契约或原有 Cron 装饰器/签名。
- 共享 `cmd/api/main.go`、`internal/config/config.go`、`apps/api-go/README.md`、`infra/docker/{docker-compose.yml,.env.sample}` 只做本开关、DB/Redis 初始化、scheduler Start/Close/默认值的最小增量。其他环境样例若确需新增，也仅追加本键。
- 复用摘要 Redis 窄端口时不修改摘要投递行为、通知桥、公共 Socket.IO 或其他任务调度；不碰既有 LLM、来源策略、OIDC、知识复核、RSS、导出业务实现。
- 排除 alertRules/告警 worker、RawItemOutbox、CrawlCleanupOutbox、NewsPipelineOutbox、AuditLogRetentionService、采集/归档/经济/分析/Assistant、Subscription/WS 迁移；不重建地图，不重新派发已合批次。
- 开工及共享文件提交前重查开放 PR/本地任务；若有新的业务文件占用，按现有认领顺序处理。main/config/env/compose 只保留并集；旧分支需同步时正常 merge 最新 main，不 rebase、不覆盖整段初始化。

## 独立开关、执行所有权与回滚

- 新增同名 `API_GO_AUDIT_OUTBOX_MODE`，Nest 和 Go 都只接受空串/legacy/go，默认 legacy，非法值启动失败。Compose 同时注入 api 与 api-go，`${API_GO_AUDIT_OUTBOX_MODE:-legacy}`；不固定单边 go。
- legacy：仅现有 Nest Cron 执行，本批 Go scheduler 不创建/不启动。go：Nest 在申请锁和扫描前退出，Go 负责该链；Nest 其他 Cron/业务照常。`SCHEDULE_ENABLED=false` 保留本链总停调度语义，Go 本链也停止调度；不要顺带改变已合摘要任务的该变量行为。
- Go 仅开本模式即可运行，所需只有 DATABASE_URL、REDIS_HOST 及现有 Redis 配置，不要求 JWT、Mongo、SMTP、GraphQL总读、adminlogs或任何设置HTTP为go。补 Load、无效DSN失败分支、needsRedis、wire、Start/Close，保持 needsCredentialedGo 的既有鉴权边界；wire 错误启动失败，不吞错。
- 复用实际 Redis key `lock:cron:audit-log-outbox`：NX PX55000，随机 owner token，约TTL/3续租、比较token续租和释放。不要误用少一层 lock: 的逻辑key；不加摘要tick-gate、组织锁或通用分布式任务平台。
- Start 仅一次，Close 停止新tick/新条目认领并等待在途任务，再停续租/释放锁，最后才关闭共享Redis/MySQL。正常退出、初始化失败、listen失败都要收口；中断留下的processing按原5分钟规则恢复，不能退出时把未完成行删除。
- Web→NestJS、canary默认值及其他模式不变。模式控制后台执行，不新增 legacyproxy规则或GraphQL注册；后台失败不转发Nest补执行。
- 文档给出启用与回滚步骤，不在本任务实际部署：先停旧Nest审计Cron并drain所有实例，再同名模式切go并启动Go；回滚先停Go并drain，再恢复Nest legacy。旧版本不识别gate时先升级/停旧实例。共享锁兼容不能代替明确的所有权切换，不通过全局SCHEDULE_ENABLED关闭其他调度器。

## 精简验证、记录与交付

- 本机不安装依赖，不运行 build/test、Docker 或服务。允许源码静态审查、git diff --check、已有格式化工具；无须新增第三方依赖、专用 smoke、测试框架或 CI workflow。
- 添加少量有意义的现有Go测试，交普通CI运行：三状态选择/200上限/轻投影等价；payload缺省/null/租户不匹配；认领竞争与查重成功/失败退避10次/陈旧processing恢复；独立模式与非法值、资源和关闭顺序。覆盖关键业务边界即可，不为每个helper堆测试。
- 静态复核SQL和事务、毫秒日期、nullable JSON、租户绑定、claim条件、Redis key/续租/退出顺序；在交付文档保留精确SHA+file:line。真实 MySQL/Redis 故障恢复和多实例切换未实跑就明确记未验证，不从已有 main CI 推断。
- 记录义务采用PLANNING轻量分工：编码窗口更新自己的 `tasks/AUDIT-OUTBOX-001.md`（若尚在规划PR则从该分支取此单文件），并在专属实施文档/PR列实际范围、优化、独立组合、排除、Nest剩余所有权和未验证项；共享README/BACKLOG/GAPS/AUDIT/DEPENDENCIES/域页由规划窗口集中回填，不在编码窗口重复改全图。仅缩小 GAP-ASYNC-001 的审计子链，不能关闭整个GAP或提前记merged。
- 专注迁移与功能，保留既有校验、鉴权和必要事务，不增加无依据的锁/重试/兼容框架。新增/修改源码注释英文；文档、提交和PR描述中文。
- 静态审查后只提交自己的文件，中文 emoji + type(scope)，正常 push；创建指向main的 Ready PR。使用现有普通CI，记录精确PR head、run链接与实际job结果；失败修复正常追加提交，skipped不算通过。不 merge、不 auto-merge、不 amend/rebase/force-push。
- 最终交付：Ready PR链接、分支/worktree、head SHA、普通CI结果、已迁后台步骤、轻字段优化证据、开关和启停/回滚说明、任务记录位置、剩余Nest链路和未做真实验证。不要创建Codex新对话、跨对话发消息或创建定时任务。
