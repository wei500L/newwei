# 目标

执行 KNOWLEDGE-REVIEW-001，将“查看待复核证据 → 批准/驳回/修正关系 → 图边与证据同步 → 审计与缓存更新”完整交付到 apps/api-go。新增一个 Mutation，并修复已有复核队列被已复核记录挡住的问题。工作量集中在关系规范化、实体及别名、证据合并和事务内聚合，不拼接其他模块。不要只更新 evidence.review 状态。

只做后端迁移和本批具体功能改善。不要防御性编程，不增加通用锁、重试、补偿或兼容框架；保留鉴权、租户隔离、业务校验、必要事务和源码已有的唯一键冲突处理。新增/修改源码注释用英文，解释关键契约与原因；文档、提交和 PR 描述用中文。

## 1. 基线与独立工作目录

仓库 /Users/oo/project/newwei。规划核实的 origin/main：90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通 CI 39149114456 success：https://github.com/wei500L/newwei/actions/runs/39149114456。

先 git fetch origin main，核对 origin/main、开放 PR、最近 main CI、git worktree list，读取适用 AGENTS.md、docs/refactor/migration-map/{README.md,PLANNING.md,tasks/README.md,GAPS.md,BACKLOG.md}、modules/knowledge.md 和本任务记录。旧 checkout 不代表最新实现；main 推进后只核本域和共享接线增量，已经落地的步骤不重迁。

从 fetch 后 origin/main 创建独立分支 refactor/go-knowledge-review，worktree /Users/oo/project/newwei-go-knowledge-review。若本任务目录已存在，先核其归属与改动，复用自己的目录，不重置或修改其他窗口。

认领记录在规划 Ready PR #80 的 docs/plan-llm-gateway-ops 分支；若尚未合入 main，只读该分支的本任务/提示词和最新占用记录，业务仍从 origin/main 开始，不合入整条规划分支。

## 2. 精确入口、权限与返回契约

- 新迁移：POST /graphql 的 Mutation reviewKnowledgeGraphEvidence(input: ReviewKnowledgeGraphEvidenceInput!): KnowledgeGraphEvidenceReviewItemModel，root 可为 null。使用服务端重推导的用户/组织身份；settings.manage OR knowledgegraph.review，使用 contract.Root.AnyPermissions，不能改为 AND、增加系统管理员要求或信任客户端 orgId/actorId。
- 现有 Query knowledgeGraphEvidenceReviewQueue(limit:Int,maxConfidence:Float,onlyUnreviewed:Boolean): [KnowledgeGraphEvidenceReviewItemModel!]! 已在 settingscrawl 注册。本批仅改善其设置一致性和选取算法，不重复计为新迁移，也不迁图谱其他十个读 root。
- 业务功能关闭时 Mutation 返回 null，队列返回 []；不能把 ingestionEnabled=false 当成禁止人工复核。
- 返回对象精确复用 settingscrawl/models_policy.go 中 KnowledgeGraphEvidenceReviewItemModel、KnowledgeGraphReviewEdgeModel、KnowledgeGraphReviewArticleModel、KnowledgeGraphNodeModel。包含 evidence/confidence/extractorVersion/createdAt、edge 的 type/weight/confidence/fromEntity/toEntity/properties、article 的 id/url/title/summary/language/crawlAt；实体 name 来自 canonicalName。
- title 使用 processed.title ?? article.titleGuess ?? null，language 使用 processed.language ?? article.language ?? null，summary 使用 processed.summary ?? null。空串是真值，不转 null、不触发回退。没有 ProcessedArticle 仍返回文章。日期、可空字段、JSON 保持 SDL 形状。

事实源：apps/api/schema.gql；apps/api/src/graphql/{resolvers/knowledge-graph-review.resolver.ts,dto/knowledge-graph-review.input.ts,models/knowledge-graph-review.model.ts,models/knowledge-graph.model.ts}；apps/api/src/common/{guards/gql-permissions.guard.ts,filters/global-exception.filter.ts}。

## 3. 输入、缺省/null 与错误

evidenceId:String!、status:String!；status 仅 approved/rejected/corrected，不 trim 输入后放宽。note 可省略或 null，最长 500 字符，保持原文和空串；correctedRelation:JSON 可省略/null。后两者缺省/null均存 null。evidenceId 不增加源码没有的非空、格式或长度规则，空串按查无证据处理。

correctedRelation 仅在 status=corrected 时要求可规范化；批准/驳回仍将提交值存入 review，不预先套用 corrected 分支的结构校验。复核文档是 status、note、correctedRelation、reviewerId、reviewedAt，reviewerId 来自身份，reviewedAt 为服务端 ISO UTC 毫秒时间。保留原 evidence 的其他字段，替换 review。

查无当前组织证据：NOT_FOUND / 404，message="Knowledge graph evidence not found"；修正关系无效：BAD_REQUEST / 400，message="Invalid corrected knowledge graph relation"。使用现有 GraphQL Failure/过滤契约；权限失败保留 OR 权限扩展，其他 DB 错误正常上抛，不伪装成功或 null。关系被合法删除后的 null 与查无证据错误必须区分。

状态及 note 约束按 DTO/class-validator 和全局过滤器现有格式处理。静态源码另有 evidenceId 只有 @Field、而全局 ValidationPipe 开启 forbidNonWhitelisted 的不一致；尚无运行验证。Go 按 SDL 接收合法 evidenceId，不照搬意外白名单拒绝，也不为此扩改 Nest；在交付中注明这处契约取舍。

## 4. 已有 Go 基础与新增窄端口

- graphqlread/contract 已有 Registry.RegisterMutation、Root.AnyPermissions、Bind、Failure；graphqlread 的预检、认证、串行 Mutation 与整份 operation 回退直接复用，不重写执行器。
- settingscrawl/review.go 已有同组织联表、ProcessedArticle LEFT JOIN、isReviewedEvidence 与具名返回模型；抽取必要的投影读取以供写后重载复用，不复制一整套模型/SQL。
- knowledgegraph/settings.go 的 service.getSettings 已实现 Redis→MySQL、缺行 bootstrap enabled=true/ingestionEnabled=true、DB 失败 disabled fallback、60 秒共享缓存。新建 knowledgegraph/review_support.go 暴露具名的复核设置视图/读取窄端口；该导出端口当前不存在，需要本批新增。人工复核和队列使用同一设置来源，不能让队列只读 DB 而写端读缓存。
- knowledgegraph/normalize.go 已有 JS 空白集合、normalizeEntityKey、buildCompanyAliasCandidates、buildTickerAliases，通过同一个新端口文件少量暴露并复用。validEntityType/validRelationType 是读端严格枚举检查，不能直接代替 Nest 写端的模糊类型识别和关系同义词。
- 新建 settingscrawl/review_support.go，提供仅复核返回模型注册和必要的单条证据读取端口；不改来源策略任务占用的 register.go/policy.go。模型逐个按 Registry.HasType 判断，读关闭时也有全部嵌套模型，不注册额外读 root。
- settingswrite/store.go 等现有审计实现可参考 SQL 和 outbox payload，但其双失败吞错语义不等于本域 Nest writer；不要直接复用错误契约不一致的 helper，也不跨域重构审计。

## 5. 修正关系、实体与别名

按 KnowledgeGraphService.normalizeReviewedRelation、parseSeedEntityRef、upsertReviewedRelationEdge、upsertEntity 完整迁移人工修正所需分支，不迁全文抽取/实体消歧模型调用。

correctedRelation 必须为对象，subject/object 为含非空 trim 后 name/type 的对象；aliases 只取字符串，trim、去空，最多前 20 个；properties 只接收对象。predicate trim、lowercase，将空白/连字符连续段换下划线；按 Nest switch 保留 belongs_to_industry/belong_to_industry、supplies/supplier_of、customer_of/buys_from、competes_with/competitor_of、holds_position/works_for/employed_by、affects_industry、affects_company、upstream_of、downstream_of、has_ticker/ticker_of。

实体 type 按 Nest normalizeEntityType 的 contains 判断及顺序映射 person/policy/industry/commodity/instrument/company/organization，未知非空类型归 organization。canonicalName 为 trim+空白折叠，normalizedKey 再小写；唯一键 (orgId,type,normalizedKey)。已有实体只更新 canonicalName，不擅自写入 subject/object.properties。别名包含规范名、公司去括号/去后缀、证券 SH/SZ/BJ 展开及显式 aliases；按 (entityId,normalizedAlias) 去重，已有别名不覆盖 source，新别名 source=user。

边唯一键 (orgId,type,fromEntityId,toEntityId)。已有目标边直接复用，不覆盖属性/置信度；新边 weight=0、confidence=证据 confidence 缺省 0.5 后钳制 0..1，properties 为关系 properties 加 recordSource=user，时间按当前服务端时间。保留源码在 ingestion 并发创建同一唯一边时读取获胜记录的行为，不新建重试/锁系统。

事实源：apps/api/src/modules/knowledge-graph/knowledge-graph.service.ts 上述符号及 normalizeRelationType/normalizeEntityType/buildCompanyAliasCandidates/buildTickerAliases。

## 6. MySQL 事务、证据移动与合并

数据在 packages/db/prisma/schema.prisma 的 KnowledgeEntity、KnowledgeEntityAlias、KnowledgeEdge、KnowledgeEdgeEvidence、Article、ProcessedArticle；本链均为 MySQL，不因为文章有 markdownRef 就增加 Mongo。

以 KnowledgeGraphReviewService.applyReviewToEvidence/recomputeEdgeAggregate 为事实源，用同一 sql.Tx 完成人工关系/别名写入、证据更新/迁移/去重以及全部被触及边的聚合；失败整体回滚。读取和投影约束证据、边、两端实体、文章、ProcessedArticle 的 orgId，保留现有队列防跨租户联表语义。

- approved/rejected：只替换原证据 review，再重算原边。
- corrected 且目标边相同：更新原证据 JSON。
- corrected 且目标边不同：若目标边没有同 articleId 证据，把原证据移动过去，保持其 id/createdAt/extractorVersion/confidence；若已有 (edgeId,articleId) 记录，保留目标证据 id/createdAt/extractorVersion，confidence=duplicate.confidence ?? original.confidence，合并顺序为原 evidence → duplicate evidence → 本次 review，删除原记录，返回目标证据 ID。
- touchedEdgeIds 按原边、目标边去重，逐一重算；边/证据所有唯一键和级联删除以 schema 为准，不改 schema 或引入新表。
- active evidence 指 review.status 经 trim 后不为 rejected；其他未知/缺失值仍 active。weight=active 数，confidence=各 active confidence（非有限/缺省取0.5、钳制0..1）的算术平均，firstSeenAt/lastSeenAt 为按 createdAt 升序 active 的首尾时间。
- active 为空且边 properties.recordSource 为 seed/user/derived：边保留且现有聚合值不改；否则删除该边的全部本组织证据及边。非 corrected 复核因此删除原边时返回 null；corrected 后重算两边，允许清理原空边。

不要简化成 UPDATE status，不丢 JSON 兄弟字段，不把 0 当缺省值，不在事务外分步写图。

## 7. 提交后的审计与缓存

事务提交后先写 AuditLog：resource=knowledge_graph，action=knowledge_graph_evidence_review；具名 metadata 包含 evidenceId、status、edgeIds、returnedEvidenceId、deletedEdgeIds。actor/org 来自身份，ipAddress=null。失败写兼容 AuditLogOutbox pending/attempts=0/availableAt 的现有 payload，消费者仍唯一由 Nest AuditLogOutboxService 执行，不新增 Go consumer。

apps/api/src/modules/audit/audit-log.writer.ts 实际语义：直接审计失败但 outbox 成功则继续；两者均失败则抛原审计错误。不能误信 BestEffort 名字而吞掉双失败，也不能回滚已提交的图更新。审计抛错时按原调用顺序不继续 cache invalidation。

随后按 CacheService.delByPrefix 的 SCAN+DEL 语义失效 knowledgeGraph:subgraph:<orgId>:* 与 knowledgeGraph:impact:<orgId>:*，覆盖所有扫描游标，不用 KEYS、不只删第一页、不清其他组织。缓存失效异常记录日志但仍返回复核结果；然后按 returnedEvidenceId 重载完整响应，空 ID 返回 null。

本批无模型/向量/SMTP/外部 HTTP、无 BullMQ、无新 cron。KnowledgeGraphIngestionService 与历史 reconcile-knowledge-graph-reviews.ts 继续留 Nest；人工复核无需等 ingestion 迁移，但共享唯一键/证据聚合行为必须兼容。

## 8. 具体查询改善

现有队列先最多取 min(500,max(50,limit*4)) 行再在 Go 跳过已复核记录，导致前面都是已复核时，后面的待办不可见。本批修正为按 (createdAt DESC,id DESC) 稳定游标分批筛选，直到选满 limit 或候选耗尽；固定 take 只作单页大小，不再作总扫描上限。

采用轻字段扫描+最终选中 ID 批量联表投影，保留同组织关联过滤，避免每个被跳过证据都加载文章/实体，也不做逐条 N+1。不要用 OFFSET、整组织全部装入内存，或添加另一个固定总数上限掩盖遗漏。每页正确关闭 rows，游标推进不依赖是否选中。

limit 默认50、钳制1..200；maxConfidence 缺省/null取设置 minEdgeConfidence；onlyUnreviewed 缺省/null为true。confidence=NULL 保持不满足 <= 筛选；review 仅对象且 status 字符串 trim 后为三种合法值时才算已复核。onlyUnreviewed=false 仍按序限量。对 createdAt 相同的证据用 id 明确顺序，这是本批明确的行为完善。

队列继续受原 API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE 控制；它的优化随已有 Go 读启用生效，不扩大新写开关的读注册范围。

## 9. 允许修改范围与并行隔离

业务主体新增 apps/api-go/internal/graphqlread/knowledgereview/**；窄端口新增 knowledgegraph/review_support.go、settingscrawl/review_support.go；现有 settingscrawl/review.go 仅作本链设置/分页/投影复用修改。新增 cmd/api/knowledge_review.go。可补必要的本域小测试和 apps/api-go/README.md 开关说明。

共享 cmd/api/main.go、internal/config/config.go、infra/docker/.env.sample、infra/docker/docker-compose.yml 仅追加本开关/资源/注册最小语义增量，保留各任务并集，不重排整段。无需改 GraphQL 引擎、Nest、Web、Prisma schema、go.mod/go.sum 或其他十个图谱读算法。

规划时其他占用：
- LLM-GATEWAY-OPS-001，Ready #81 head0b89196fa1408d5adbad9fb953dae36eb6868a6f：llmgatewayops、llmgatewayprofiles/ports.go、llmlogs 与网关 wire 不碰。
- SOURCE-POLICY-WRITE-001，Ready #82 head52340760fdedde3f914b384badd30aee2a5c6fbf：settingscrawl/policy.go/register.go/policywritesupport.go、settingswrite/sourcepolicy_*及旧13写的两处接线补漏不碰。用新 review_support.go 避开该模型注册文件，不重新领取 GAP-GQL-001。
- OIDC-LOGIN-001，Ready #83 head2c52763ccbb6db95d5b84b3b5d57add3f13adfc5：oidclogin、authlogin/authfactors 的新端口与 wire 不碰。
- ANALYSIS-EXPORT-001 已在 /Users/oo/project/newwei-go-analysis-export 开发：analysisexport、itemsreading/csvexport.go、newsevents/export.go 及 analysiscollab 不碰。

开工和交付前刷新上述状态。若其中已合并，只在自己的分支正常 merge origin/main 并保留语义并集；不直接 cherry-pick 其他开放 PR，不改其他 worktree，不消息或暂停其他对话。

## 10. 独立开关与公共装配

新增 API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE，接受空串/legacy/go，默认legacy，非法值启动失败。单独 go 时就具备 MySQL、JWT、Redis 和本 Mutation 所需模型，不依赖任何读开关/其他写开关，也不要求 MONGO_URI。仅写启用不得初始化读域 Mongo 或其他服务。

逐点将本开关加入 /graphql 路由 OR、无效 DATABASE_URL 的接管错误分支、sharedDB/authenticator/Redis 资源 OR、GraphQL handler 装配 OR、独立 Mutation 和模型注册。保留 #82 对旧设置写的修复及其他并行开关，不扩领其接线任务。使用独立 wire helper，复用共享连接及现有关闭路径，不再开一套池或 worker。

检查仅写、读+写、多写并开的模型注册；不要重复 root 注册或为返回模型顺带注册全部设置/crawl 查询。新开关 legacy 时 Mutation 不注册，含未迁 root/字段的整份 operation 必须在任何写副作用之前回退 Nest，不执行一半后再转发。

Web→NestJS 与 canary 默认保持。回滚人工复核写只改新开关legacy；若需回滚已有队列算法，按原 settings/crawl read 开关退回 Nest。无 schema 迁移、无持久化格式变更，已经提交的复核数据由 Nest 继续读取。

## 11. 精简验证与交付

本机不安装依赖，不运行 build/test、go mod tidy、Docker 或任何服务；可做 gofmt、git diff --check 和只读静态核对。使用现有普通 GitHub Actions CI，不新增专用 smoke，不把 skipped 当通过。

只补能验证业务分支的少量测试：approved/rejected 聚合与耐久边；corrected 同边/移动/重复合并及旧边删除；关系别名/空白/类型；事务失败回滚和组织归属；超过500条已复核前缀后仍能选出待办、同时间游标、nullable投影；新写独立开关和整份回退。沿用已有测试边界，不搭建新测试框架或大规模源码字符串测试，全部交普通 CI 执行。

静态检查具名强类型贯穿 DTO、关系、证据review、DB行、聚合、审计和返回模型；不以 any/interface{}/map[string]any/[]any 承载新业务数据。现有 GraphQL/SQL驱动边界可沿用，确实扩展的 evidence/properties 叶子用 json.RawMessage 保留未知字段，不借本批重构旧读包的全部 JSON。

完成后中文 emoji+type(scope) 正常提交，只 stage 本任务改动并正常 push，创建 Ready PR，不合并、不 auto-merge、不 amend/rebase/force-push。观察最终 head 的普通 CI，记录 SHA、run URL、job结果；失败修复后正常追加提交。未运行真实 MySQL/Redis/生产混合写验证就明确写未验证。

共享地图由规划窗口集中维护；本编码窗口不修改 migration-map 的共享索引/其他任务，不新增长任务文档。PR 描述（必要时一份简短 docs/refactor/go-knowledge-review.md）交代 KNOWLEDGE-REVIEW-001、实际root/算法/副作用、开关/资源/回滚、源契约取舍、PR head/CI、剩余 Nest ingestion/reconcile/outbox 所有权和未验证项，供规划窗口回填任务、knowledge域、GAP-KG-001及相关缺口。PR开放不写main已迁，不发布全后端完成百分比。
