# 目标

执行 SOURCE-POLICY-WRITE-001：完整迁移新闻来源策略的编辑、预设保存、历史回滚、重置四个 GraphQL Mutation。管理员保存后，Go/Nest 的现有策略读取、版本差异与同步状态能继续读取同一份数据；分类权重、审计和 Redis 同步副作用完整保留。另补已合设置13写的两处公共接线缺口，不重新迁13个业务 resolver。

这是包含差量、版本历史、预设和分类权重的完整产品链路，不增加无关入口凑数。专注迁移与功能，不堆防御性编程，不加通用锁、重试、CAS/补偿框架，不要求固定bug数。保留鉴权、租户隔离、原业务校验和必要事务。Go业务DTO、数据库JSON、缓存、响应、审计用具名强类型，不用any/interface{}/map[string]any/[]any承载业务；现有GraphQL协议边界沿用，解析后立即转具名结构。新增或修改源码注释写英文，说明差量顺序、null/presence、版本和副作用等关键原因；文档、提交、PR描述中文。

# 最新基线与独立工作目录

- 仓库 /Users/oo/project/newwei；已核 origin/main=90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通CI39149114456成功。#70–#76通过#77合入，#79身份14路也已合入；不重派这些已完成范围。生产启用和真实外部验证不能从合并/CI推断。
- 先fetch origin main，核最新SHA、开放PR、最近五次main CI和git worktree list，读适用AGENTS.md。旧checkout在历史分支，不按旧工作文件判断main。若main前进，只读本批和共享接线增量，不重新审计全仓。
- 从fetch后的origin/main创建 refactor/go-source-policy-write，worktree=/Users/oo/project/newwei-go-source-policy-write；若已存在先核归属，不覆盖或借用其他业务目录。
- 地图来自已合#69。最新认领在规划分支 docs/plan-llm-gateway-ops 的 docs/refactor/migration-map（规划PR #80，https://github.com/wei500L/newwei/pull/80）；未合时只读该分支文档，不合入文档分支。读README、PLANNING、tasks/README、GAPS摘要/GAP-GQL-001、BACKLOG的BL-07/BL-01、modules/settings、AUDIT.settings、DEPENDENCIES相关复用及本任务文件。
- LLM-GATEWAY-OPS-001已发出，refactor/go-llm-gateway-ops及/Users/oo/project/newwei-go-llm-gateway-ops继续占用治理/真实探测12路；已见llmgatewayprofiles/ports.go开发证据。它没有开放业务PR也不能重复分配。本批不改其profiles、llmlogs、HTTP客户端和wire业务；共享main/config/env只做自己的语义增量，保留并集。不开新对话、不发送跨对话消息。

# 精确root、权限与模型

POST /graphql，新增接管且仅新增以下四个Mutation：

| root(input参数均为非空) | input | 返回非空类型 |
|---|---|---|
| updateNewsEventSourcePolicy | UpdateNewsEventSourcePolicyInput! | NewsEventSourcePolicySettingsModel! |
| updateNewsEventSourcePolicyPresets | UpdateNewsEventSourcePolicyPresetInput! | NewsEventSourcePolicyPresetSettingsModel! |
| rollbackNewsEventSourcePolicy | RollbackNewsEventSourcePolicyInput! | NewsEventSourcePolicySettingsModel! |
| resetNewsEventSourcePolicy | ResetNewsEventSourcePolicyInput! | NewsEventSourcePolicySettingsModel! |

全部根权限settings.manage，此外必须执行SettingsResolver.assertAdmin：只能是调用者本组织的isSystem=true、名称大小写不敏感admin角色。不能接受其他组织角色、同名自定义admin或仅有platform_admin；身份/权限由服务端重推导，不信JWT中的org/权限自报值。复用settingscrawl.AssertSystemAdmin；缺角色为403 Unauthenticated，非系统admin为403 Admin access required，GraphQL错误extensions沿用现有执行器，不发明HTTP接口错误格式。

Policy返回四名单、categoryAuthority、activeRevision、updatedAt(DateTime|null)、overrides八个add/remove名单、warnings{domainConflicts,labelConflicts,hasConflicts}、revisions[{revision,operation,actorId,createdAt,note,delta}]、syncWarnings。Preset返回四名单、categoryAuthority、updatedAt和syncWarnings。非空列表返回[]，nullable actor/note/date保留null，枚举update/rollback/reset按SDL既有值。

模型依赖必须全部注册，包括Delta/Conflict/CategoryAuthorityRule/DomainBoost/Revision/Settings/Preset等嵌套类型。已有settingscrawl.RegisterSettingsModelTypes只注册普通设置类型，不包含policy模型；新增窄的RegisterSourcePolicyModelTypes等模型注册表面，不能为返回类型而注册整批读root或Mongo/crawl对象。保留只开本批写、同时开旧设置写、读开/关的类型注册并集。

# 必须阅读的事实源与可复用实现

Nest：
- apps/api/src/graphql/resolvers/settings.resolver.ts：四Mutation、assertAdmin、toSourcePolicyModel/toSourcePolicyPresetModel。
- 同目录settings.resolver.helpers.ts：toNewsEventSourcePolicyInput的categoryAuthority property presence逻辑。
- apps/api/src/graphql/dto/settings.input.ts：四Input、NewsEventSourceCategoryAuthorityRuleInput/DomainBoostInput；graphql/models/settings.model.ts和apps/api/schema.gql确定返回及nullable。
- apps/api/src/modules/news-events/news-event-source-policy.service.ts：updatePolicy/updatePolicyPreset/rollbackPolicy/resetPolicy、getState/loadState、legacy→v2、persistState/persistCategoryAuthority、delta/history/conflict及cache失败分支。
- 同目录news-event-source-classifier.ts：normalizeSourcePolicy/normalizeSourceCategoryAuthority、默认四名单、域名/标签/category/domainBoost归一化；modules/audit/audit-log.writer.ts确定审计/Outbox边界。

Go：
- apps/api-go/internal/graphqlread/settingscrawl/policy.go：stateFromStoredValue、normalizeSourcePolicyState、effectiveFromDelta、deltaFromEffectivePolicy、diffAdd、applyDeltaList、category normalizer、fallbackPresetPolicy、getPolicyDetails/getRevisionDiff/getSyncStatus及具名模型。大多为私有，不能假设已有导出写API。
- internal/publicportal/policy.go导出的DefaultSourcePolicyLists、NormalizeSourcePolicyDomain/Label；复用同一默认值和规则，不复制另一套名单或另改门户分类算法。
- internal/graphqlread/settingscrawl/writesupport.go的AssertSystemAdmin；register.go中的普通模型与policy/crawl混合注册需要区分。
- internal/graphqlread/settingswrite的typed input/validation、RegisterMutation模式、service/upsertSettingForceDescription、writeAuditLogBestEffort/AuditLogOutbox协议。现有cacheSet吞错误且无warning返回，不能直接用于本批并声称syncWarnings完整。
- internal/graphqlread/{contract,exec,handler}的参数coercion、整份operation预检/回退、Mutation串行和错误投影；cmd/api/main.go及internal/config/config.go的独立写模式接线。

建议在settingswrite新增sourcepolicy_*.go和独立RegisterSourcePolicy入口，复用现有私有存储/审计；settingscrawl新增小型policywritesupport.go导出具名状态/normalizer/投影。可以按源码调整具体窄端口设计，但不得复制整套policy读写算法、循环依赖、顺手重构所有设置。旧Register保持原13写，四新root只由本批独立开关注册。

上述候选Nest/Go业务相对地图3cedce9a到90765633无变化。现有Go读端主要从DB读，不完整等同Nest getState的cache-first路径；写端必须按源读取/归一化当前状态，不直接拿Query的30条历史投影当可持久化完整state。

# DTO、缺省/null与错误契约

1. update和preset四名单authoritativeDomains/authoritativeLabels/blogDomains/blogLabels均必填[String!]!，每组0..1000项，每项字符串最长180。空数组是清空该有效名单，不是恢复默认；缺省/null由GraphQL非空契约拒绝。归一化domain/label后去空、去重且保留首次顺序；默认策略与默认preset不是同一套名单。
2. categoryAuthority可缺省/null/数组，最多200项。未传必须保留对应现有分类规则；显式null或[]是清空，不能因指针nil把二者混为一谈。源helper对显式null转换成[]并保留属性存在。categoryPrefix字符串最长160；authoritativeBoost/blogPenalty/unknownPenalty必填Float，-1..1；minConfidenceFloor/mismatchPenalty可缺省或null，默认0，0..1。domainBoosts可缺省/null，默认[]，最多100项；domain最长180，delta必填Float -1..1。保留nested DTO校验与源normalizer的清洗、去重和四位小数，不把所有输入都默默clamp后跳过校验。
3. note可缺省/null，字符串最长500；service trim后空值为null。回滚note归一化为空时默认rollback-><targetRevision>。
4. update/rollback/reset的expectedRevision可缺省/null，GraphQL Int，0..1000000。缺省和显式null都不做版本匹配；0是有效期望，不能用truthiness跳过。rollback.revision必填Int且>=1，查保留历史，不擅加1000000上限。
5. preset.expectedUpdatedAt可缺省/null/字符串最长120；未传不比较，显式null表示期望当前不存在时间戳，仍要比较。字符串按源日期解析转UTC毫秒ISO；空串/非法日期归一化null，当前非空时间与null不相等，不把null一律当跳过。
6. 冲突按源GraphQL业务错误：Stale source policy revision: expected <x>, current <y>；Stale source policy preset timestamp: expected <x>, current <y或null>；Revision <n> not found。保留现有400/forbidden/internal错误扩展，不把冲突改409或吞成成功。
7. Mutation返回历史默认20条倒序；已有Query请求30条，两者不能混用。持久化保留最新60条升序revision；响应切片不能截断将要写回的历史。createdAt/updatedAt采用UTC毫秒ISO，preset的updatedAt来自实际SystemSetting保存后的数据库时间，不随意用另一时钟伪造比较值。

# 四条业务链与差量规则

- update：归一化有效四名单→相对内置默认策略生成八组delta→加载完整prevState→可选expectedRevision检查→activeRevision+1，追加operation=update、actor、时间、note、delta快照→保存v2 state及审计/共享cache→仅输入显式含categoryAuthority时保存分类规则→返回本次state和当前分类规则。名单有交叉时返回warnings，不新增拒绝保存逻辑。
- rollback：先检查expectedRevision，在保留历史中找目标；恢复目标的delta快照并创建当前revision+1的新rollback版本，不把activeRevision倒退。分类权重单独存储且没有历史快照，回滚必须保留当前categoryAuthority，不擅自回滚/清空它。
- reset：检查expectedRevision，追加新的reset版本，delta八组全空，从而恢复当前内置默认四名单；保留历史、分类规则与preset，不删除整条SystemSetting。
- preset：可选expectedUpdatedAt检查→按preset默认值归一化输入→保存独立preset文档并取得真实DB updatedAt→审计→cache→按显式presence保存preset分类规则→返回。保存preset不自动应用到active policy，不增加policy revision；preset与active分类规则是不同键。
- delta是相对内置默认列表的add/remove，不是存整份有效名单冒充v2。apply顺序为默认保序→追加尚未出现的add→最后remove，移除优先；差量列表按target顺序。复用已有基于set的线性实现，不能改成无序map输出或额外字典排序。
- 缺失state为version2/revision0/epoch更新时间/空delta/空history；legacy四名单按源转成revision1，note=migrated-from-legacy、actor/时间来自原记录，再继续追加；不把迁移前历史抹掉或每次重造revision1。unknown/不完整存储按源normalizer/read fallback处理，DB写失败必须上抛。
- categoryPrefix小写、过滤[a-z0-9/_-]、合并/修剪斜杠，首次相同prefix保留；domainBoost按规范化domain去重。规则中的-1..1/0..1数值按源四位小数。业务主要是完成这些功能；不强制额外算法改造，不引入新依赖。

# 数据、缓存、事务与副作用

以下MySQL键与Redis键全部追加服务端identity.OrgID，不接受客户端orgId：

| 内容 | SystemSetting前缀 | Redis前缀 | TTL |
|---|---|---|---|
| v2策略state | news_event_source_policy: | newsEvents:sourcePolicy: | 60秒 |
| active分类权重 | news_event_source_policy_category_authority: | newsEvents:sourcePolicyCategoryAuthority: | 60秒 |
| preset文档 | news_event_source_policy_preset: | newsEvents:sourcePolicyPreset: | 30秒 |
| preset分类权重 | news_event_source_policy_preset_category_authority: | newsEvents:sourcePolicyPresetCategoryAuthority: | 30秒 |

- SystemSetting upsert保留isPublic、更新actor/description/updatedAt，JSON字段名/版本/数组/时间与Nest共用。state缓存含version:2的完整state，不缓存GraphQL投影；preset缓存含源完整preset/updatedAt/syncWarnings形状；分类缓存是规则数组。
- 源顺序为主文档DB→best-effort审计→cache，再按需分类DB→分类cache。各独立upsert不是一个总事务；分类DB失败可能发生在主文档已保存后，应按源传播，不能伪称全部回滚。已有必要事务仍保留，不添加跨MySQL/Redis/审计总事务。
- Redis写失败不抹去已保存结果，返回CACHE_WRITE_FAILED；保持policy的warning合并与preset去重行为。未配置/未接入Redis不能伪报同步成功。读取cache失败按源回落DB；DB读取/legacy解析fallback按getState/loadPreset实际边界实现，不拿空对象假装读成功。
- 审计resource=system_settings，动作news_event_source_policy_update/rollback/reset与news_event_source_policy_preset_update；state metadata含activeRevision/updatedAt/delta，preset含updatedAt/note/preset。直接AuditLog失败复用现有AuditLogOutbox pending格式；重放消费者仍Nest，不新增Go消费、cron或BullMQ。
- categoryAuthority独立persist路径没有额外源审计动作，不凭想象增加每规则审计或重复业务事件。已有newsEventSourcePolicy/Presets/RevisionDiff及newsEventSourcePolicySyncStatus等查询继续兼容同一数据；syncStatus按DB/cache真实状态判断，不因Mutation成功就固定返回健康。
- 本链无Mongo、模型、LiteLLM、SMTP、S3或HTTP外部调用，无队列/worker/cron。保存策略不代表新闻重分类/ingestion运行器已迁移，不触发额外批量回填。

# 独立开关、公共接线与允许范围

- 新API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE接受空串/legacy/go，默认legacy，非法值启动失败。go要求JWT/MySQL/Redis，独立于READ、SETTINGS_CRAWL_READ、SETTINGS_WRITE、ORG_ACCESS_WRITE、WORKSPACE_WRITE；只开本批不得要求MONGO_URI或初始化只读Mongo service。
- main完整覆盖/graphql路由OR、sharedDB无效DSN失败条件、needsCredentialedGo、handler初始化OR、四root注册、嵌套模型注册、启动诊断和生命周期；config.Load、env示例/compose透传默认legacy同步落地。mode=legacy时四root不注册；含未支持root/字段的operation必须在任何副作用前整份回退Nest，不在resolver里逐字段代理Nest。
- 已核GAP-GQL-001仍在main：graphqlRouteMode只含READ/ORG_ACCESS_WRITE/WORKSPACE_WRITE，漏旧GraphQLSettingsWriteMode；无效DATABASE_URL的接管错误分支也漏旧设置写。needsCredentialedGo和handler已有旧settingsWrite，不能重写。此批只给这两处补旧settingsWrite条件，同时接好新policy条件；旧13业务不改、不新增计数。该具体剩余接线由本任务拥有，不再另派BL-01竞争main。
- 允许修改settingswrite新增sourcepolicy文件和必要小型复用表面、settingscrawl的policy写支持/独立policy模型注册、main/config/独立wire、必要模式/路由检查和env/compose/README本批增量。一份短交付说明可选。
- 不修改Nest Resolver/DTO/SDL签名、Web入口、旧13业务算法、policy默认名单、门户分类、新闻pipeline、归档、身份与队列。现有schema已含四root，不以注册需要为由大规模重生成/改动contract或执行引擎。
- 不碰LLM-GATEWAY-OPS-001业务文件；共享main/config/env/compose保留其并集。若先后合并，正常merge最新origin/main，只处理本批冲突；禁止rebase。地图不是原子锁，发现新认领冲突只暂停冲突范围，不创建协调机器人。
- Web→NestJS和canary默认保持现状，不改部署变量、不实际启用生产Go。回退只把本批模式改legacy，已存v2/legacy/preset与共享cache仍能被Nest读取；不删除revision或把业务reset当代码回滚。旧13写接线修复不改变其默认legacy。

# 精简验证、记录与交付

- 本机不安装依赖，不运行build/test、Docker或服务；可以静态阅读、gofmt和git diff --check。验证聚焦四root完整注册/嵌套返回、仅本批go、仅旧设置写go、二者并集、读开关开/关、legacy整份operation先回退；不用生产数据库做验证。
- 少量必要契约用例交现有普通CI执行：更新→新revision→回滚→重置，20/30/60历史边界；categoryAuthority omitted/null/[]；expectedRevision=0/null与preset expectedUpdatedAt omitted/null/UTC；DB成功Redis失败warning、审计outbox、分类DB失败边界、跨租户/自定义admin拒绝。不要为每个字段堆镜像测试或增加专用smoke workflow。
- 使用现有普通GitHub Actions，记录最终head SHA、实际检查结果和链接，修复本批引入错误。skipped不是通过；静态/mock不是实际数据库/跨进程验证，不虚写运行结果。
- 共享地图由规划窗口集中维护。编码窗口不要改migration-map共享索引、域页、BACKLOG、其他任务，也不要要求已运行对话停止重做记录。PR说明或本批短交付说明列任务ID、四root、两处旧接线修复、数据/缓存/审计、独立开关、复用、PR/head/CI与未验证项，供规划窗口回填；未合并不提前计入main，不预先关闭GAP-GQL-001。
- 只提交自己改动，中文emoji+type(scope)正常commit/push，创建Ready PR；不amend/rebase/force-push、不合并、不auto-merge。创建后附PR链接。
- 最终交付Ready PR、分支/worktree、最终SHA、四root完成情况、旧13写具体接线修复、普通CI结果链接、开关/回退与剩余边界。做到可审查交付，不自行启动下一批。
