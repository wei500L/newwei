# NEWS-BRIEF-001 · 事件简报生成与刷新闭环

## 任务记录

- 模块：[news](../modules/news.md)；状态：in_progress（本编码窗口已在本机实现并推送候选，等待普通 CI 与合并复核）。
- 来源：BL-02 / GAP-NEWS-001；仅一个已注册但部分实现的 Query，不新增接口计数。GAP-NEWS-001 仍未关闭，PR 只记候选实现。
- 代码基线：9d0462e16d88d146b8afbf67cdd58d8b7419ff29；编码分支 `refactor/go-news-event-brief`；worktree `/Users/oo/project/newwei-go-news-event-brief`（从该 SHA 创建）。规划记录原在 docs/plan-news-event-brief，本窗口把[本任务](NEWS-BRIEF-001.md)与[提示词](NEWS-BRIEF-001.prompt.md)带入本分支，未覆盖其他任务条目。
- 提示词：[完整执行提示词](NEWS-BRIEF-001.prompt.md)。
- 规划记录：docs/plan-news-event-brief；规划 worktree /Users/oo/project/newwei-plan-news-event-brief；Ready 文档 PR #71（仅文档）。
- 业务 PR/Ready/head：Ready [PR #72](https://github.com/wei500L/newwei/pull/72)，head `517a73f98b495c1664c45fdfaf2bd2692a3b2210`（首个 head b9c4d4f3 因既有测试仍按旧 map metadata 引用未过 lint，已正常追加修复提交）。尚未合 main，缺口未关闭。
- 普通 CI（本批 head 517a73f9）：[run 39132616859](https://github.com/wei500L/newwei/actions/runs/39132616859) —— verify success（含 Lint、Typecheck、Go tests (api-go gateway + vector-go pilot)、Build）、api-go-user-settings-integration success、vector-integration success；PR 触发的 smoke/regen 全部 skipped，不计通过。
- main 普通 CI：9d0462e1，run 39127631691 success；不是本任务验证。模型实网、部署与流量未核实。

## 精确范围与源码证据

POST /graphql，Query newsEventBrief(eventId: String!, forceRefresh: Boolean, language: String, maxSources: Int): NewsEventBriefModel，权限 items.read，orgId 来自服务端身份。

实际实现（相对 main 9d0462e1）：

- `apps/api-go/internal/graphqlread/newsevents/brief.go`：命中、合法 null 与租户绑定保留；cache miss/forceRefresh/语言或指纹变化走 `generateBrief`；`briefSource` 补 `Summary`/`KeyPoints`；`saveBriefV1` 用 MySQL `JSON_SET(..., '$.briefV1', CAST(? AS JSON))` 只更新叶子，`WHERE id = ? AND orgId = ?`，模型调用期间不持事务/行锁。
- 新增 `brief_generate.go`：按 Nest 口径构造提示词（title `?? primaryEntity ?? primaryTopic ?? id`、事件摘要 600/来源 700/前 8 条 keyPoints 拼 900、UTF-16 截断），解析代码块/文本包裹 JSON，按 Nest zod schema 校验并清洗（key_points 出现时 1..10、why_it_matters 10、what_to_watch 12、comparison 两组 12、citations 正整数且 ≤12；latest_update/comparison/limitations 允许缺省/null；citations 先过滤 1..来源数、截 12、去重升序；latest_update trim 后保留，不因空白改 null）。
- 新增 `brief_log.go`：把每次真实模型尝试转成 llmlogs completion 日志（best effort，失败只 warning）。
- `internal/publicportal`：新增导出简报 completion 表面 `brief_completion.go`（`BriefCompleter`/`BriefCompletionRequest`/`BriefCompletionResult`/`BriefCompletionAttempt`/`BriefCompletionObserver`/`NewBriefCompleter`）；`gateway.go` 复用为 attempt 感知，补 usage/cost、`responses` surface、404/405 路径回退、治理 503、guardrail 阻断不回落备用模型；`story.go` 改用强类型 metadata。
- `internal/llmlogs/completion.go`：新增 completion writer，复用既有 `MetadataPolicy` 与归一化；默认策略下 metadata 只保留 `feature`，`eventTitle`/`sources` 被过滤。
- `internal/config/config.go`：新增 `API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE`（空串/legacy/go，默认 legacy，非法值启动失败）；`go` 依赖 READ 与 NEWS_EVENTS 父模式，否则 Load 报错。
- `cmd/api/main.go`：仅调整已有 read/newsEvents 区块的 `newsevents.Register` 参数与对应日志；未改顶层路由/资源 OR、无效 DSN 判断或多写模型注册（仍归 #70/BL-01）。
- 新变量在 `.env.sample`/`docker-compose.yml` 显式默认 legacy，api-go README 增加单项说明。

## 所有权与排除

本任务拥有 newsevents 简报、publicportal 简报 completion 导出/必要共用适配、llmlogs 独立 completion writer 与最小 policy 共享。BL-17 未认领，其后续客户端修改需避开本任务；本批不改 alerts/history/workspacewrite/settingswrite/orgaccesswrite，不认领 BL-01/GAP-GQL-001，不修 #70 的顶层接线，不重复迁设置 13 写。

## 完成与恢复

业务源码、开关、日志与缓存写回实现已在 PR #72 head `517a73f9`，普通 CI verify/integration 通过。本机仍未运行 build/test/Docker/服务，未做模型实网、MySQL/Mongo 或部署切流验证；实网模型、Redis/Mongo 与真实部署未分别验证，不假称成功。下一步等合并复核，GAP-NEWS-001 只在确认 main 落地后关闭。
