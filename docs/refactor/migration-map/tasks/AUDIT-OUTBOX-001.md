# AUDIT-OUTBOX-001 · 审计失败补偿完整消费链

- 状态：reserved；2026-10-19 13:12 MSK，规划窗口保存并发出[完整执行提示词](AUDIT-OUTBOX-001.prompt.md)，未开始业务实施，执行器活动未核实。
- 基线：`origin/main c70b0373990ab931758f7a000511c2d34572fc33`。只深入 BL-20 的 AuditLogOutbox，不认领其余 Outbox/worker；关联 GAP-ASYNC-001。
- 独立业务分支：`refactor/go-audit-outbox`；worktree：`/Users/oo/project/newwei-go-audit-outbox`（规划时未创建）。业务 PR、head、merge、CI 均未产生。
- 规划发布分支：`docs/plan-audit-outbox`，worktree：`/Users/oo/project/newwei-plan-audit-outbox`；首份认领/提示词已提交 `777abe3284214f2e9f787f5497169ad3f2eeef1b` 并正常推送，发布于 [Ready规划PR #91](https://github.com/wei500L/newwei/pull/91)。规划PR自身普通CI尚未确认完成，不能借用基线CI；业务PR仍未创建。
- 基线普通CI [39163544617](https://github.com/wei500L/newwei/actions/runs/39163544617) 在精确SHA c70b0373990ab931758f7a000511c2d34572fc33 success；verify/vector-integration/api-go-user-settings-integration success，两个regen skipped。非本任务实现/部署/故障恢复证据。

## 范围、契约与复用

唯一后台入口为Nest `modules/audit/audit-log-outbox.service.ts:retryPendingAuditLogOutbox`。用户可见出口是既有 `GET /api/admin/logs/audit`（settings.manage，orgId取身份），不重迁查询或任何生产者，不增加HTTP/GraphQL root。

完整迁每分钟扫描→Redis续租锁→三状态候选合并/200条→并发8→payload与org校验→条件事务认领→五元身份查重/写AuditLog→删除outbox，或失败退避/10次dead；5分钟stale恢复、缺省/null/日期/updatedAt与退出收口。payload存MySQL JSON，metadata可用RawMessage叶子；两张MySQL表，无Mongo/BullMQ/外部服务。

已有复用：sharedDB/OpenMySQLFromURL、sharedRedis；userdigest.NewRedisDeliveryStore公开端口与Lua token租约能力、Start/Close参考；adminlogs既有org-scoped读取；近期knowledgereview/llmgatewayops与历史各域已写同协议outbox。业务producer的错误语义不统一重构。优化仅为三路轻字段选200后批量补入选payload，避免最多600份大JSON预取；最终集合/顺序与状态机不变。

## 占用、开关与边界

新增Go internal/auditoutbox及cmd/api/audit_outbox.go；Nest仅本service gate/EnvService依赖与env schema；main/config/compose/env/README最小并集。拟新增API_GO_AUDIT_OUTBOX_MODE空/legacy/go默认legacy，双进程校验并注入；go由Go唯一消费，Nest锁前退出；SCHEDULE_ENABLED=false停本链。仅需MySQL/Redis、不强开JWT/Mongo/HTTP，实际key lock:cron:audit-log-outbox PX55000，比较token续租/释放。

启用先停旧Nest本链并drain，再开Go；回滚反向，实际部署未执行。排除RawItem/CrawlCleanup/NewsPipeline Outbox、审计retention、告警及其九provider/BullMQ、其他后台链/WS；不重迁#70八写、摘要通知桥、知识复核等。编码窗口更新本task和专属交付文档，规划窗口集中维护共享地图。

## 核对与剩余验证

2026-10-19仅静态深入本service全部状态分支、audit writer/schema/索引、CacheService租约、Go生产者envelope、adminlogs出口与digest生命周期和资源装配。相对地图3cedce9a，本Nest audit consumer与Go adminlogs没有源码增量；90765633之后增加近期Go生产者和可复用digest调度/Redis端口。没有全仓业务复验。

发出前fetch仍c70b0373、无开放PR；旧worktree无本链业务改动。kg-impact旧分支有一条未进main的纯历史文档提交，与本批无业务交集，不能据此宣称所有旧HEAD都已merged。当前无竞争本链任务，不代表已确认其他执行器在线/离线。

无本地build/test/依赖安装/Docker/服务；MySQL/Redis真实故障、租约与多实例切换未验证。下一检查点是编码PR精确head/普通CI/接线与退出；届时只回填本审计子链，不关闭整个GAP-ASYNC-001。
