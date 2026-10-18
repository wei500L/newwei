# 目标

在 wei500L/newwei 完成 `DIGEST-DELIVERY-001`：把每日摘要从“能保存投递设置、预览摘要”推进到 Go 每分钟扫描、按组织认领到期日程、生成个性化摘要、真实 SMTP 投递、回写结果并发送站内实时通知的完整链。已有五条 HTTP 不重迁，不新增凑数入口。这批工作量在调度、竞争状态、邮件和跨进程通知，不以新增接口数量验收。

本任务仅后端。专注迁移和必要功能，不堆防御性代码、锁平台、重试框架或测试基础设施；保留已有鉴权、租户隔离、业务校验、必要原子性。源码新增/修改注释英文，文档、提交和 PR 描述中文。

Go新增/修改的业务DTO、返回模型、数据库JSON、缓存、通知和审计数据使用具名强类型，禁止any/interface{}/map[string]any/[]any承载业务数据；通用驱动/GraphQL协议边界沿用，扩展JSON叶子可用json.RawMessage。不借迁移清理本域无关旧代码。

## 1. 基线、恢复与独立工作目录

- 规划基线：fetch 后 `origin/main 90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`。该 SHA 普通 CI：https://github.com/wei500L/newwei/actions/runs/39149114456 ，success；不是 SMTP、部署或实时链运行证明。
- 仓库 `/Users/oo/project/newwei` 当前 checkout 可能旧，禁止以其工作文件推断 main。先 `git fetch origin main`，查询 SHA、开放 PR、main 最近五次 CI、worktree；读取适用 AGENTS.md、迁移地图 README/PLANNING/tasks/README、本任务及 personal 域。核对本范围相对规划 SHA 的差异即可，不全仓审计。
- 业务分支 `refactor/go-digest-delivery`；worktree `/Users/oo/project/newwei-go-digest-delivery`，从当时最新 origin/main 创建。已有同任务目录先核 HEAD/差异/归属后复用，不切换或清理其他窗口目录。后续同步 main 用正常 merge，不 rebase。
- 规划记录随独立文档分支 `docs/plan-digest-delivery` 发布；main 未含记录时从其规划 PR 读取。业务源码始终取最新 main，不以规划分支代替业务基线。若目标已被其他任务覆盖，按实际剩余步骤缩小本任务，不重做整批。

## 2. 已核事实与可复用能力

以下路径均相对仓库，事实源 SHA 为上列规划基线；开始编码时复查候选域增量：

1. Nest `apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts`：`runScheduledDeliveries` 每分钟触发，tick gate、活动组织、运行时组织并发、`runOrgWithLock`。`user-digest-delivery.service.ts`：`runDueDeliveriesForOrg/processDueSchedule/claimDueScheduleSlot/failDueSchedule/buildEmailPayload/safeNotify*` 是实际执行与错误分支依据，不能只读 Controller。
2. Go `apps/api-go/internal/userdigest/{digest,events,items,preference,delivery,handler}.go`：已有具名 `Digest/Event/Preference/DeliverySettings`，`Service.GenerateDigest/GetDelivery/UpdateDelivery` 和完整订阅/情绪/指标/关键词/地理筛选；`NewElasticsearchFromEnv` 保留 ES 查询失败回退 Mongo。现阶段 `Service` 仅在 `NewHandler` 内构造，**没有可直接使用的公开 NewService**，须新增窄构造能力并让 HTTP 共用，不能从外包调用私有字段/helper。
3. `cmd/api/personal_news.go` 已装配 contentcatalog/contentsubscriptions/userdigest；内部服务不依赖对应 HTTP 开关。本批只扩展所需服务创建条件和生命周期，不复制整套摘要生成算法，不改变事件窗口、订阅匹配、fallback、情绪/指标排序。
4. `internal/authlogin/mail_port.go` 已有公开 `NewMailSender(SMTPConfig)`、`MailMessage`、`Send`；`mailer.go` 已处理真实 SMTP、TLS/STARTTLS、连接/问候/socket 超时及发件人回退。直接复用，不修改登录/OIDC核心，不另建 SMTP 协议栈，不因复用而强开登录或邀请开关。模板依据 Nest `modules/email/templates/user-digest{,.text}.hbs` 和 EmailService 的具名模板上下文。
5. `internal/runtimesettings/{scheduler,store}.go` 已有 SystemSetting 全部十一并发字段的规范化和持久化读取，但 `readMultiTenantSchedulerSettings` 及返回类型私有。新增 `digest_delivery_port.go` 之类窄导出方法复用它，保持全记录校验；不假称已有公开 runtime API。运行读取可有与 Nest 一致的30秒进程缓存，不依赖设置管理 HTTP 开关。
6. Nest `common/multi-tenant-scheduler.ts`、`modules/org/active-org-registry.service.ts`、`modules/cache/cache.service.ts` 是 tick、活动组织缓存和自动续租协议依据。Go authlogin/store.go 已有同形私有 lock helper，只可参考，不为了复用把本任务绑定登录 Service。
7. `NotificationsService.notify` 先写 MySQL Notification，再经进程内 NotificationDispatcher 发布给 NotificationsGateway。**当前不存在 Go 可用的通知 Redis 入口**；Socket.IO Redis adapter 也不等于 NotificationDispatcher 的跨进程入口。本批必须补摘要专用桥，不能只写 Notification 表就宣称通知完整。

## 3. 精确入口、权限与返回契约

本批新增执行链，不新增 HTTP/GraphQL root。以下已有 HTTP 作为产品接口保持原开关与契约：

| 入口 | 契约与本批关系 |
|---|---|
| GET `/api/user-digest` | `items.read`；返回既有 `Digest`，保留空 `events: []`、可空标题/摘要/代表URL等字段；生成由相同 Go Service 复用 |
| GET/PUT `/api/user-digest/preference` | `items.read`；复用既有 `Preference`、DTO和订阅同步；不重写偏好CRUD |
| GET/PUT `/api/user-digest/delivery` | `items.read`；返回 `DeliverySettings`，本批使 lastStatus/lastSentAt 等由真实执行推进 |
| 每分钟 `runScheduledDeliveries` → 组织到期执行 | 内部可信调度，无用户传入 orgId/userId；只选活动组织、活动用户和该组织活动 membership，不引入管理权限作为后台扫描条件 |
| Nest `/notifications` Socket.IO namespace 的 `notification` 事件 | 协议、连接鉴权、撤销重查及Web入口保持；本批只桥接三种每日摘要通知 |

HTTP orgId/userId 继续取 authhttp.Identity，保留 JWT/机器令牌的既有行为；后台从受限 SQL 行绑定，不信任通知消息指定的任意用户数据。GET 保持 `Cache-Control: no-store`。返回 HTTP 现有数据包裹/错误 envelope 不变。

DTO依据 `dto/update-user-digest-delivery.dto.ts`、Go dto.go/parseDelivery 和 delivery.go：PUT 必需 enabled:boolean、time:string（严格 HH:mm，随后校验00:00–23:59）、timezone:string（最长128，trim后合法IANA）；缺省/null不自动补值，不新增 targetEmail 输入。未存日程返回 version=1、enabled=false、09:00、UTC、lastStatus=idle；nextRunAt/lastSentAt/lastStatusAt/lastError 为 null。targetEmail和emailVerified来自 User，不来自请求。

保留404 `Digest delivery user not found`；400 `Digest delivery is unavailable for inactive users`、`Verified email is required before enabling digest delivery` 以及现有时间/时区校验。禁用清 nextRunAt和lastError，不重置lastStatus或lastSentAt；启用不擅清旧错误。已有 `computeNextRunAt` 有明确实现与历史注释，复用其严格晚于reference的现行Go结果；本批不凭注释推断dayjs运行细节或改一轮DST算法。

后台状态用 idle/sent/empty_notified/failed；错误 trim并截到191字符，空错误用 `Digest email delivery failed`，对齐Nest字符串/Unicode字符语义。日期持久化UTC毫秒，API日期ISO；后台错误记录该组织/日程，不伪装HTTP成功或阻断其他组织。

## 4. 调度、缓存、数据库与必要副作用

按原链实现，不用缓存读取、设置保存或入队占位代替执行：

1. 每分钟边界tick，默认不补跑启动时历史每一分钟。tick gate Redis原始键 `cron:user-digest-delivery:tick-gate`，JSON `{claimedAt:<ISO>}`，SET NX EX 55；持有期间不提前删除。抢不到跳过，Redis错误本tick失败，不失锁继续投递。
2. 活动组织 `Org.isActive=true`、id ASC。沿用 `org:active:list:v1` 的具名数组缓存、15秒TTL和DB回退；如复用Nest wrap填充协议，锁实际为 `lock:org:active:list:v1`、2秒，不能把helper误当成现成Go端口。没有必要为只读DB回退另造缓存框架。
3. 读取 `SystemSetting.key=multi_tenant_scheduler_runtime_settings`，`userDigestDeliveryOrgConcurrency`缺省4、范围1–16；其他持久化并发字段存在非法值也不能被忽略，沿现有Go规范化器报错，不自修复。限并发跑组织；同组织日程顺序处理。tick结束记录组织completed/skipped/failed及due/sent/empty/failed计数。
4. 组织锁实际键 `lock:cron:user-digest-delivery:org:<orgId>`，SET NX PX 55000随机token；与Nest相同token比较后续租/释放，约TTL/3续租，持有到组织完成。不是只有55秒就失效的裸锁。停机停止新tick/新日程，收口in-flight及续租，再关闭Redis/Mongo/DB；初始化中途或HTTP监听失败也必须收口，不能只在SIGTERM分支清理。
5. 到期查询 MySQL `UserDigestDeliverySchedule`：orgId、enabled=true、非空nextRunAt<=本组织固定now，联User.isActive及同org活动Membership/Org；原排序nextRunAt ASC、updatedAt ASC。本批具体优化：采用加id稳定tie-breaker的轻字段游标分批扫描，固定cutoff，持续到耗尽，避免一次加载组织所有到期记录；不能用固定LIMIT截断当天投递。游标用读取时原nextRunAt/updatedAt/id，不因处理写回而跳项/重复；列投影包含email/emailVerified/firstName与必要日程字段。
6. 邮箱失去验证：对旧due slot条件认领，enabled=false、nextRunAt=NULL、failed、lastError=`Email is no longer verified for this user`、lastStatusAt=now，然后失败通知，禁止发信。
7. 有验证邮箱：调用同一 `GenerateDigest(orgId,userId)`；无事件时认领旧slot，推进nextRunAt、empty_notified、清lastError并发empty通知，**不发邮件**。有事件时先认领推进nextRunAt/lastStatusAt，再构造并发送邮件；成功写lastSentAt=now、sent、lastStatusAt=now、lastError=NULL，发送ready通知。认领条件至少id+orgId+enabled=true+旧nextRunAt，影响行数0返回idle、不产生邮件或通知。
8. 生成失败或SMTP失败按Nest推进下一日程并写failed/error，然后失败通知；SMTP失败不能自动重发或撤回已领取slot。已有Nest生成失败的failDueSchedule按id无条件update，本批修正这一个明确竞争问题：未领取slot的失败分支同样比较旧nextRunAt/enabled，不能覆盖生成期间用户禁用/改期后的新设置；认领失败就idle且无通知。已领取后的错误保持slotAlreadyClaimed语义，不再次推进日程。
9. SQL认领与状态更新保持原子，不把SMTP/摘要查询放在长事务里。SMTP成功与DB回写间的崩溃窗口不能称为exactly-once；保留当前先推进slot的语义并在PR说明，不引入邮件outbox/重试平台。摘要任务本身无BullMQ producer/worker，不认领其他Cron/Outbox。

数据依赖：日程/User/Membership/Org/SystemSetting/Notification；摘要既有 UserSetting、订阅、NewsEvent/NewsEventItem、Article/ProcessedArticle、情绪/指标表和Mongo processeditems，ES关键词读取可选并保留现有Mongo回退。不扩大为爬取、归档准备、新闻生成或模型任务。

## 5. 邮件与摘要专用实时通知桥

- `MailMessage`同时有HTML和text；保留subject `每日摘要｜<用户时区日期>`、中文日期标签、姓名、窗口天数、事件数、标题回退 title→primaryEntity→primaryTopic→eventId、summary空值回退`暂无摘要。`、条数/最近时间/链接。用模板等价转义；代表URL只接收http/https，其他回退Today链接。`NEXTAUTH_URL`去尾斜线，空值默认`http://localhost:3000`，链接`/today`。不要调用SMTP verify当投递成功。
- 按 safeNotifyReady/Empty/Failure 保存Notification，type=system、orgId/userId必填，readAt=NULL。具名data包含link=/today和presentation；kind分别 `user_digest_ready` / `user_digest_empty` / `user_digest_delivery_failed`（`packages/utils/src/notification-presentation.ts`）。ready.params含link/eventCount/generatedAt/nextRunAt；empty含link/nextRunAt；failed含link/targetEmail/message并有technicalDetail。保留Nest三种标题/body。通知失败best-effort，不把已发送邮件改为投递失败。
- 本批新增窄Redis通道 `user-digest:notifications:v1`：Go在Notification写入成功后发布具名 `{version:1, notificationId, orgId, userId}`；不把完整敏感邮件正文放进消息。Nest新增摘要专用subscriber，使用现有REDIS_CLIENT的duplicate连接，按id+orgId+userId重读Notification、仅接受上述三kind，再按现有NotificationEvent序列化。
- 各Nest实例只向本实例已认证且orgId/userId均匹配的socket发送一次notification；不要把每实例收到的消息再交给会跨实例广播的普通dispatcher，否则启用Socket.IO Redis adapter后会重复N次。在NotificationsGateway补窄local投递方法，按实际namespace本地socket结构实现；保持普通通知路径原样，不复刻Socket.IO adapter协议、不迁整个WS、不改房间鉴权。关闭subscriber时unsubscribe/quit，不能关闭共享Redis连接。
- 通道是本批明确新增的最小桥，**不是已存在/已验证的能力**。Redis Pub/Sub实时投递为best-effort，无监听/断线不伪造推送成功；Notification持久化及现有列表读取提供补读。本批不新增重放队列或全局通知基础设施。

## 6. 独立开关、装配、回退与执行所有权

新增同名跨进程开关 `API_GO_USER_DIGEST_DELIVERY_MODE`，仅空串/legacy/go，空视为legacy，非法值在Go和Nest都启动失败。Nest env.schema也要显式识别，不能被schema strip掉。legacy维持原Nest Cron；go由Go执行投递，Nest的 `runScheduledDeliveries` 在尝试tick gate之前直接退出，Nest摘要通知subscriber启用。两进程Compose注入同一`${API_GO_USER_DIGEST_DELIVERY_MODE:-legacy}`，样例默认legacy；本任务只提交切换能力，**不实际部署或启用**。

Go delivery-only须能在 `API_GO_USER_DIGEST_MODE`、CONTENT_SUBSCRIPTIONS、USER_NEWS_BEHAVIOR、RUNTIME_SETTINGS、AUTH_LOGIN、IDENTITY_ONBOARDING及全部GraphQL模式均legacy时运行：独立初始化/复用shared MySQL、Redis、Mongo、订阅服务、摘要Service、runtime读取器和既有SMTP。要求DATABASE_URL、REDIS_HOST、MONGO_URI及既有SMTP配置；后台本身不验JWT，不为方便硬要求JWT_SECRET或强开HTTP。SMTP按既有SMTPConfig校验，实际连接在到期发送时创建，不做启动实网探测；ES沿既有可选环境。

`main.go`补无效DSN阻断、资源OR、服务创建、启动/退出全部分支；当前Redis仅在needsCredentialedGo条件里创建，须最小拆出“现有鉴权资源或本后台需Redis”的条件，authenticator仍只在HTTP需要时创建，不全面重构启动框架。HTTP只在旧UserDigestMode=go时注册原五条，delivery-mode不改变proxy规则、不接管/graphql、不打开canary。若HTTP与后台同时开，尽量共用同一摘要服务与Mongo连接；legacy时不启动本批goroutine/subscriber或额外连接。

实际切换runbook写入交付文档：先部署默认legacy的新代码；启用时先让所有Nest实例go（停旧Cron、开relay）并等旧in-flight退出，再启Go后台go。回滚先停Go后台新任务并等in-flight/锁释放，再让Nest全部legacy恢复Cron。不能只改api-go变量就宣称回滚完成。共用tick/组织锁和SQL CAS是混合版本期间的既有保护，不能代替明确单一执行权；不停Nest其余Cron、GraphQL/Socket.IO服务。数据无格式迁移，保留日程/通知，绝不清lastSentAt、重置nextRunAt或重发已领取邮件。

## 7. 允许修改、并行边界与排除

- 业务所有权：Go `internal/userdigest`（新增delivery执行/模板/通知/调度文件，原服务仅最小构造与复用改动）、`internal/runtimesettings/digest_delivery_port.go`及必要缓存字段；`cmd/api/personal_news.go`、新增digest_delivery.go与main/config的最小接线。
- Nest仅允许本链必要改动：user-digest-delivery-scheduler.service.ts的开关跳过；config/env.schema.ts；notifications新增digest专用subscriber、notifications.module.ts注册和notifications.gateway.ts窄local投递方法。保留Controller/Resolver装饰器签名、原SMTP服务和普通通知/WS路径。现有邮件模板只读作依据；不改Web。
- 共享配置：`apps/api-go/README.md`、`infra/docker/.env.sample`和docker-compose.yml仅本开关/资源/退出说明；必要说明写 `docs/refactor/go-digest-delivery.md`。不改DB schema、不装新包、不改普通CI工作流。现有依赖足够，若发现确实缺失先说明必要性，不能本机安装。
- 并行占用（规划快照）：Ready #81 LLM-GATEWAY-OPS-001 head0b89196f；#82 SOURCE-POLICY-WRITE-001 head52340760（拥有GAP-GQL-001剩余两处设置写接线）；#83 OIDC-LOGIN-001 head2c52763c；#84 ANALYSIS-EXPORT-001 head38e4e0e1（发出前已复核新提交）；#80保留KNOWLEDGE-REVIEW-001认领，目录已存在于main基线、尚无业务实现证据，不能释放。开工再查实际head/diff/task。
- 不碰各批核心llmgatewayops/profiles/llmlogs、settingscrawl/settingswrite、oidclogin/authfactors/authlogin登录文件、analysisexport/itemsreading/newsevents导出端口、knowledgereview/knowledgegraph。SMTP端口已在main，**只读复用**。公共main/config/env/compose按任务语义段追加，保留其他开关和资源/注册并集；后合者正常merge后静态复查，禁止整段替换。
- 排除全局通知迁移、四GraphQL Subscription、BullMQ及其他worker、审计/原文/清理outbox、经济抓取、告警投递、来源策略、OIDC、导出、图谱复核、邮箱管理/诊断HTTP。BL-19单链认领，不认领整个BL-15/20/21或GAP-ASYNC-001。

## 8. 精简验证、记录与Ready PR

- 本机不安装依赖，不运行build/test、Docker或服务；可gofmt、git diff --check和只读静态审查。围绕控制流/类型/租户/状态迁移做file:line证据复核，尤其delivery-only资源、非法开关、legacy零后台、HTTP组合、CAS失败无副作用、用户改期与失败竞争、续租/关闭、多实例relay无重复/越租户。
- 只增加少量必要行为验证覆盖有内容sent、空摘要empty、未验证停用、生成/SMTP失败、旧slot竞争失败、稳定分页跨批；fake时钟/具名端口即可。远端普通CI执行，别建设整套新smoke、Nest Jest/e2e或测试依赖。SMTP/Redis/Mongo/Socket.IO真实验证未执行要明写，不用单元fake证明实网。
- 正常提交推送后观察现有普通CI，记录精确head SHA、run链接和关键job结果；失败修复正常追加提交，skipped不能算成功。若有新修改再次以最终head核对，禁止引用旧绿灯。
- 遵PLANNING轻量分工：编码窗口维护自己的task状态/PR/head/精简交付事实；若task未合main，可从已发布规划PR取本任务文件，不把整份规划分支混入业务PR。共享README/tasks索引/模块/AUDIT/GAPS/BACKLOG由规划窗口集中回填，编码窗口在PR明确提供逐项事实、剩余步骤、开关/所有权、验证与未核实项即可，不重复编辑共享地图。PR开放仍pr_open；main落地须有真实merge SHA及实现/注册证据，SMTP/部署独立记载；不增加本批HTTP/root迁移计数，不关闭整个异步缺口。
- 只stage自己的文件，中文emoji + type(scope)提交，正常push，创建**Ready PR**（非draft）并交付链接。不要合并、auto-merge、amend/rebase/force-push，不创建Codex对话、不跨对话发消息、不创建定时自动化。最终说明完整执行链、具体分页/竞争改善、复用位置、Nest保留的relay/WS职责、切换与回滚、精确CI证据和未实网验证范围。
