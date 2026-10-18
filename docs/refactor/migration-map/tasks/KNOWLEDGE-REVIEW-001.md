# KNOWLEDGE-REVIEW-001 · 知识图谱证据复核与关系校正闭环

- 状态 reserved；2026-10-18（Europe/Moscow）。本窗口规划并发出[完整提示词](KNOWLEDGE-REVIEW-001.prompt.md)，未实施业务、未创建业务 worktree；执行会话身份/活跃状态未核实。
- 基线 origin/main `90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`；[普通 CI 39149114456](https://github.com/wei500L/newwei/actions/runs/39149114456) success。相对地图3cedce9a，候选Nest复核业务无变化；Go settingscrawl 注册仅受已合S3详情注入变化影响，未新增复核写。
- 分支 `refactor/go-knowledge-review`；目录 `/Users/oo/project/newwei-go-knowledge-review`，规划时不存在。记录随 `docs/plan-llm-gateway-ops` 的 Ready [规划 PR #80](https://github.com/wei500L/newwei/pull/80)正常提交推送发布，业务 PR 未开、未合并；本任务 Go 实现/生产注册/部署/流量均无新增，真实依赖未运行。
- 来源 BL-16 / GAP-LEGACY-001；新增具体部分实现缺口 GAP-KG-001（复核队列固定 overfetch 遮挡）。仅领取人工复核链，ingestion Cron、历史 reconcile 脚本及审计outbox消费留Nest，不认领整个候选队列或GAP-ASYNC-001。

## 精确范围与工作量

| 入口 | 权限与事实源 | 交付 |
|---|---|---|
| Mutation `reviewKnowledgeGraphEvidence(input: ReviewKnowledgeGraphEvidenceInput!)`，可空返回 | settings.manage OR knowledgegraph.review；Nest knowledge-graph-review.resolver.ts / input / models；KnowledgeGraphReviewService.reviewEvidence/applyReviewToEvidence/recomputeEdgeAggregate；KnowledgeGraphService.normalizeReviewedRelation/upsertReviewedRelationEdge/upsertEntity | 批准、驳回、关系修正，实体与别名、证据移动/去重、事务内新旧边聚合、审计/outbox、缓存失效、返回重载 |
| 已迁 Query `knowledgeGraphEvidenceReviewQueue` 的具体改善 | 同一OR权限；settingscrawl/review.go；Nest listEvidenceReviewQueue | 缺省50/1..200、同组织联表；轻字段游标扫描至够数/耗尽，最终批量投影，修正500候选遮挡并明确同时间id顺序；设置读取对齐缓存端口 |

虽只有一个新Mutation，事务业务含同边、移动、重复合并、拒绝后删除/耐久边保留、均值/权重/首尾时间重算及三类副作用，不是单行状态更新，不拼接其他域凑数。

## 已核事实与复用

限定阅读：Resolver/DTO/模型/SDL；ReviewService 全部人工复核及reconcile边界；GraphService人工修正/实体/别名/关系归一化；Prisma表/唯一键/级联；Nest设置getSettings、审计writer、CacheService.delByPrefix；Go settingscrawl队列/模型/注册、knowledgegraph设置/normalize、contract Registry/Failure、settingswrite审计与main装配。未扩大图谱遍历/冲击算法/ingestion模型的核对范围。

关系修正使用MySQL KnowledgeEntity/Alias/Edge/Evidence/Article/ProcessedArticle，**不需要Mongo**。实体已有记录仅更新canonicalName；别名user来源但不覆盖既有来源；新目标边user属性、已有目标边原样复用。证据重复合并保留目标ID与extractorVersion/createdAt，confidence采用nullish合并；重算active排除合法rejected状态；无active时seed/user/derived边保留旧值，其他边连证据删除。

事务提交→AuditLog失败写现有outbox→缓存双前缀SCAN/DEL best-effort→响应重载；审计双失败Nest实际抛原错误，现有Go settingswrite/helper吞错不等价，不盲目复用。未复核队列目前固定候选take会遮挡更后记录，标为具体已注册缺口而不重派11读。DTO的evidenceId只有@Field，与全局白名单存在静态不一致，未实跑；提示词明确Go遵SDL接收、保留status/note约束，不扩改Nest。

新增Go knowledgereview包、knowledgegraph/review_support.go、settingscrawl/review_support.go与本域review.go最小改动；复用现有模型、JS别名和设置缓存/错误fallback，新增导出窄端口而非假定已有公开API。不改settingscrawl/register.go、policy.go或其他图谱读算法。具名强类型、扩展JSON叶子RawMessage。

## 开关与并行所有权

`API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE` 空/legacy/go，默认legacy、非法值启动失败；写独立于全部读/其他写开关，只需JWT/MySQL/Redis。route OR、无效DSN、资源OR、handler OR与返回模型须完整接入；只写不初始化Mongo。队列改善仍跟随原read+settingscrawl子开关，不借新写开关新增读root；两者回滚分别使用对应开关。无新worker/cron/外部调用。

#81网关head0b89196f、#82来源策略head52340760、#83OIDC head2c52763c均Ready开放，实际diff/接线已核；ANALYSIS-EXPORT-001目录在90765633已见业务开发、无PR，本轮改in_progress。各自核心文件不碰。来源策略继续拥有register/policy与GAP-GQL-001的旧13写两处补线，本批只追加自己的main/config/env/compose语义并集，不重新领取共享修复。

编码窗口只交业务和Ready PR/精简说明，不改共享地图；规划窗口集中回填。交付后核精确head普通CI、实际merge与Go实现/注册，随后更新本任务、knowledge域、GAP-KG-001与BL-16人工复核子范围；后台构图和生产验证未完成不能随本任务关闭。
