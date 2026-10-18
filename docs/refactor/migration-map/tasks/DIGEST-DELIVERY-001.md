# DIGEST-DELIVERY-001 · 每日摘要定时邮件投递完整链

- 状态 reserved；2026-10-18 Europe/Moscow，本规划窗口保存并发出[独立执行提示词](DIGEST-DELIVERY-001.prompt.md)，未实施业务。执行会话/活跃状态未核实。
- 规划基线 origin/main `90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`；[普通CI39149114456](https://github.com/wei500L/newwei/actions/runs/39149114456)在精确SHA success。候选userdigest/Nest调度/邮件/runtime业务相对地图3cedce9a无改动，NotificationService有#70已合的已读语义改动，不影响notify生产者。
- 来源 BL-19 / GAP-ASYNC-001，仅认领digest投递，不认领全部异步/通知/邮件诊断。独立分支 `refactor/go-digest-delivery`；业务worktree `/Users/oo/project/newwei-go-digest-delivery`，规划时未创建。业务PR未开/未合，Go执行/生产启用/实网验证均无新增。
- 记录发布：独立文档分支 `docs/plan-digest-delivery`、worktree `/Users/oo/project/newwei-plan-digest-delivery`，正常提交推送后发布Ready规划PR；不改已有#80规划工作目录。

## 精确范围与独立条件

现有GET /api/user-digest、GET/PUT /preference、GET/PUT /delivery均items.read，org/user取鉴权身份，原HTTP开关不变。不重迁五路，不新增GraphQL root。补每分钟Cron→活动组织/并发→组织续租锁→到期日程CAS→既有Go GenerateDigest→SMTP→日程状态→Notification持久化与实时桥完整链。入口少但有实际后台和跨进程业务，不拼接不相关CRUD。

复用userdigest具名模型/GenerateDigest、contentsubscriptions/contentcatalog、authlogin公开NewMailSender/MailMessage、runtimesettings既有私有规范化器（新增窄端口）、shared DB/Redis/Mongo。未假设当前已有独立digest构造器或Go通知bridge。数据库为UserDigestDeliverySchedule/User/Membership/Org/SystemSetting/Notification及摘要读模型；关键词ES可选回退Mongo，无BullMQ。

tick key `cron:user-digest-delivery:tick-gate` NX EX55；组织锁实际 `lock:cron:user-digest-delivery:org:<orgId>` PX55000、token续租/释放；活动org缓存15秒；运行并发默认4、1–16、全记录严格校验。未验证邮箱停用；空摘要不发信；成功/失败/空通知状态与原lastSentAt/null语义保留。生成错误发生前未领slot的失败写也采用旧slot条件，避免覆盖并发禁用/改期；到期列表固定cutoff、nextRunAt/updatedAt/id游标分批至耗尽。SMTP不放长事务，不加重发平台、不称exactly-once。

NotificationDispatcher当前仅进程内。明确新增摘要专用Redis通道 `user-digest:notifications:v1`（version/notificationId/orgId/userId），Nest按租户重读通知后仅发本实例org/user匹配的认证socket，避免各实例经Socket.IO adapter重复广播；普通通知/WS鉴权保持。该bridge是必要迁移接缝，不能计为整个WS已迁。三kind详见提示词。

## 开关、文件与并行

拟新增 `API_GO_USER_DIGEST_DELIVERY_MODE` 空/legacy/go，默认legacy、非法值两进程启动失败；同名变量注入Nest和Go。go仅Go投递，Nest原Cron在tick gate前退出、保留并启用摘要relay；delivery-only需MySQL/Redis/Mongo/SMTP，不强制JWT或任何HTTP模式。启动/失败/关机均收口调度与续租后关闭共享资源。启用先停所有Nest旧Cron并drain再开Go；回滚先停Go并drain再恢复Nest，未实际执行部署。

拥有Go userdigest执行/构造、runtimesettings/digest_delivery_port及必要缓存字段、personal_news.go和新增cmd/api/digest_delivery.go；Nest仅user-digest scheduler开关、env schema、notifications专用subscriber/module/gateway local方法。共享main/config/env/compose/README仅本任务最小增量，不改Web/schema/普通CI，不重构全局通知。

已读开放#81/#82/#83/#84实际业务文件及main/config/env接线diff；各核心包与本批无交集。#82继续拥有旧13设置写两处漏接线；本批不领取。#80包含KNOWLEDGE-REVIEW-001认领，业务目录已在main存在、无开发证据仍reserved；不能因尚无PR重派。#84已Ready head38e4e0e1（原1276182e后续改动已提交推送，发出前已复核），仍占用。公共main/config/env按语义增量合并并集。

源码事实源与具体符号、DTO/null/error、通知/邮件模板、退出及精简验证全部保存在提示词。仅静态核对指定链；未实跑dayjs/SMTP/多实例relay、未安装依赖/运行build/test/Docker/服务。编码窗口更新本task和PR精简交付说明，规划窗口集中维护共享地图；任务开放时不增加main计数、不关闭整个GAP-ASYNC-001。
