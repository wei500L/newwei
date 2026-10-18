# RSS-TRANSLATION-001 · RSS 阅读批量翻译完整链

- 状态pr_open，2026-10-18 Europe/Moscow；[完整提示词](RSS-TRANSLATION-001.prompt.md)已保存并发出。业务分支 `refactor/go-rss-translation`，worktree `/Users/oo/project/newwei-go-rss-translation`，[Ready PR #88](https://github.com/wei500L/newwei/pull/88)，业务 head `b443b9d70b37d1111f5a9a2ee537a50fdc048ec7`（非 draft）。
- 基线：origin/main `90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`，普通 CI39149114456 success。相对地图3cedce9a候选Nest RSS/DeepLX/指标与Go状态/地图翻译源码无变化；最新main条目列表已合，不再重复派发。
- 来源BL-24.RSS / GAP-LEGACY-001，仅认领同步RSS翻译，不认领其他item写/采集/内容流水线、worker/Cron。

精确root：Mutation translateRssItems(input:TranslateRssItemsInput!):TranslateRssItemsPayloadModel!，items.read，orgId取鉴权重推导。已迁rssTranslationStatus不重迁，只修共享缓存写回。支持deeplx/llm、默认zh-CN、title/summary/key_points默认字段和可选cleaned_markdown，含空/缺省/null、50数组上限、保序去重、逐项allSettled与原文回退、两层缓存、模型fallback/日志和每日原子指标写。

已深读Nest ItemsRssTranslationService全部分支、DTO/SDL/Resolver/Model；SituationMonitorTranslationService中RSS调用的配置/缓存/HTTP/重试/语言检测；LiteLlmService的请求/两协议/format/guardrails/日志与网关active配置；Go itemsreading状态/缓存、publicportal私有completion/完整设置reader、llmlogs强类型写、classificationrssops指标读；仅本链，未全仓复审。

复用与限制：itemsreading状态/config/helper私有，新增translation_support.go完整runtime窄端口；publicportal.NewMySQLStore.GatewaySettings公开，配置/解密/治理/HTTP helper私有在新增rss_completion.go选择性复用；BriefCompleter固定简报JSON和tokens不能直接翻译；dashboardwarmap旧translator私有且settings缓存key与本链不一致，不能直接引用为完整RSS客户端；新llmlogs/rss_translation.go复用稳定policy但不依赖#81未合方法或修改其completion.go。

具体缺口GAP-RSS-001：itemsreading.loadLLMGatewaySettings miss后把activeId/id/model/enabled投影写回llm_gateway:profiles，破坏Nest完整normalized profile缓存。已修复为状态miss只读DB投影返回、不回填窄结构，不清共享缓存。具体查询改善：Mongo按租户/完成状态/itemIds在数据库分组选最新result，不把全部历史读入Go；同createdAt用_id DESC确定顺序。

新增API_GO_GRAPHQL_RSS_TRANSLATION_MODE默认legacy、非法值启动失败，mutation独立于读/HTTP/日志/网关开关；需JWT/MySQL/Redis/Mongo，provider配置请求时校验。main路由/DSN/资源/handler/Mongo/注册并集一致；无队列/worker/cron，无原文写回，仅cache、指标upsert、LLM日志。回滚新模式legacy，旧status仍原模式，缓存修复不倒退。

并行#81/#82/#83/#84核心包及#80知识复核/#85摘要投递均排除；只共享main/config/env/compose最小语义增量。业务所有权为rsstranslation/adapter、translation_support与status缺口、publicportal RSS专用文件、llmlogs RSS writer；不碰csvexport/网关治理/摘要/runtime/通知。

本机只做静态检查（gofmt/git diff --check/只读审查），未安装依赖/运行build/test/Docker/服务，未真实调用DeepLX/fallback/LLM，未验证Redis/Mongo/MySQL真实读写。编码窗口只维护自己的task与PR精简交付，规划窗口集中更新共享地图；外部/生产证据独立，不能用候选PR关闭main缺口。
