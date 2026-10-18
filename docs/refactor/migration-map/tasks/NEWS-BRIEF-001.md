# NEWS-BRIEF-001 · 事件简报生成与刷新闭环

## 任务记录

- 模块：[news](../modules/news.md)；状态：in_progress（第三批规划时已见本机对应业务开发差异；无业务PR，不推断执行器实时活动）。
- 来源：BL-02 / GAP-NEWS-001；仅一个已注册但部分实现的 Query，不新增接口计数。
- 代码基线：9d0462e16d88d146b8afbf67cdd58d8b7419ff29；2026-10-18 15:48 MSK 本域增量静态核对。地图业务基线3cedce9a至此没有业务源码变化。
- 提示词：[完整执行提示词](NEWS-BRIEF-001.prompt.md)；2026-10-18本次规划聊天发出；编码执行器身份与活动尚未核实。
- 编码分支：refactor/go-news-event-brief；worktree：/Users/oo/project/newwei-go-news-event-brief，HEAD9d0462e1；第三批规划时见newsevents/{brief,service}.go、publicportal/{gateway,story}.go及新增brief_completion.go、llmlogs/completion.go等开发差异。只读核占用，未改该目录，不据快照推断当前活跃/退出。
- 规划记录：docs/plan-news-event-brief；规划 worktree /Users/oo/project/newwei-plan-news-event-brief；首提交efa819e3已正常推送，[Ready文档PR #71](https://github.com/wei500L/newwei/pull/71) 已发布。该PR仅文档，不是本批业务PR；CI状态应按其最新head查询，不要求或暗示模型验证。
- 业务 PR/Ready/head：未创建；实际 merge SHA：无；本批普通 CI/额外集成验证：尚无。
- main 普通 CI：9d0462e1，run 39127631691 success；不是本任务验证。模型实网、部署与流量未核实。

## 精确范围与源码证据

POST /graphql，Query newsEventBrief(eventId: String!, forceRefresh: Boolean, language: String, maxSources: Int): NewsEventBriefModel，权限 items.read，orgId 来自服务端身份。仅补 cache miss、forceRefresh、参数/来源变化后的生成，以及必要日志/metadata写回；合法null与命中继续保留。

按上述完整SHA阅读：

- Nest graphql/resolvers/news-events.resolver.ts:261、graphql/models/news-event-brief.model.ts、modules/news-events/news-event-brief.service.ts:180–543 及 schema。
- Go graphqlread/newsevents/{brief,register,store,models,service}.go，确认冷路径固定错误、来源行已有Summary/KeyPoints但生成source未携带。
- Go publicportal/{story,brief,gateway,store}.go：完整同步生成能力私有，可导出小型强类型completion表面；不得把公开组织/事件语言当GraphQL语义。
- Nest news-pipeline/litellm.service.ts acompletion、两种surface尝试、日志/guardrail/运行上下文；llm-request-log.service.ts 写入与metadata过滤。news_event_brief不自动请求moderation；运行上下文不是租约。
- MySQL NewsEvent/NewsEventItem/ProcessedArticle/Article/SystemSetting；Mongo llmrequestlogs必要best-effort日志；没有BullMQ/cron前置。

具体优化：只原子更新metadata.briefV1叶子，避免Go把旧metadata快照整份覆盖；不宣称修复Nest其他写入器的竞争。

## 所有权与排除

本任务拥有newsevents简报、publicportal简报completion导出/必要共用schema适配、llmlogs独立completion writer与最小policy共享。BL-17未认领，其后续客户端修改需避开本任务。

#70 仍OPEN/Ready，head adb765d0180e8b34910181e8c6fde8be400a2dff；实际main/config/模型diff已读，verify通过，worktree干净但执行活动未知。工作台八写继续被WORKSPACE-WRITE-001占用。本任务不改alerts/history/workspacewrite/settingswrite/orgaccesswrite，不取得BL-01或GAP-GQL-001。

main.go仅已有read/newsEvents区块Register参数与对应日志，config仅新子开关，env/compose仅单项默认legacy增量。顶层route/资源OR、无效DSN判断和多写模型注册仍归先行任务；如同一语义段出现新重叠，业务文件可先做，共享段等先行交付/正常merge后接入。

新开关目标API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE，默认legacy；go要求READ和NEWS_EVENTS父模式均go。不强开父模式。legacy时不注册该root，预规划整份回Nest；不回调Nest业务。复用父模式DB/auth/Redis/Mongo，独立于PUBLIC_PORTAL/LLM_LOGS模式。源码仍未实现此开关，不能作为当前可部署事实。

## 完成与恢复

规划窗口只维护文档；编码目录已有本地开发，未逐分支验收、无业务PR，main实现/注册/缺口计数仍不变。规划窗口没有安装/构建/测试/启动服务；其他窗口运行情况未核实。恢复时先fetch与刷新PR/任务占用；交付须区分本地代码、业务PR、规划PR、main落地、普通CI、模型实网与部署。
