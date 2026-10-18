# 后端迁移地图

本索引保存 `apps/api → apps/api-go` 的事实、任务占用和规划入口；Nest 暂时保留。本地图用于恢复上下文，具体任务必须再读最新源码。先读本页与 [PLANNING.md](PLANNING.md)，然后只展开候选域、[任务认领](tasks/README.md)及[执行模板](templates/migration-task.md)。

最近核对 main 源码：**2026-10-18 13:51 MSK（UTC+03:00）**；任务/开放 PR 于 **14:03 MSK** 增量刷新；fetch 后的 `origin/main`：`7fc17faa3dc5043537bad4038299d11fdba4758d`。
基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) **success**，head SHA 与上述基线完全相同；verify、vector-integration、api-go-user-settings-integration 均通过，两个按需 regen job 为 skipped。[核对证据与口径](EVIDENCE.md)。

代码已合并、Go 已实现、CI 通过、额外集成验证、开关配置和真实切流是六类不同事实。部署/真实流量均**未核实**；仓库默认 Web → Nest，可选 pilot 不等于部署，canary 默认关闭。

## 模块导航

HTTP/Query/Mutation 列为“已在生产 Go 注册的入口数 / 本域 Nest 契约入口数”，不是业务实现完成率或启用比例；`—` 表示无此类主 API 入口。HTTP 以 METHOD + 完整路径去重，SSE 算一条；订阅单列于域页与 [GraphQL 运行时](modules/graphql-runtime.md)。vector-go 三条独立 HTTP 不并入主 API 分母。没有“整个后端迁移百分比”。

| 模块 ID | 产品域 | HTTP | Query | Mutation | 队列与外部依赖 | 详情 |
|---|---|---|---|---|---|---|
| `identity` | 身份、组织与访问控制 | 21/51 | 7/7 | 8/8 | 邮件/OIDC；会话缓存 | [详情](modules/identity.md) |
| `personal` | 个人设置、阅读工作台与公共门户 | 31/31 | — | — | 邮件 Cron；模型冷路径 | [详情](modules/personal.md) |
| `workspace` | 通知、看板与告警交互 | 13/13 | 10/11 | 0/11 | 告警 worker；Nominatim/OpenSky | [详情](modules/workspace.md) |
| `items` | 条目检索、RSS 阅读与处理结果 | 6/7 | 6/7 | 0/4 | 索引后台任务；ES/vector | [详情](modules/items.md) |
| `analysis` | 分析协作工作区与导出 | 23/26 | 1/1 | 0/3 | analysis 队列/导出 | [详情](modules/analysis.md) |
| `news` | 新闻事件、指标、聚类与内容流水线 | 12/17 | 9/9 | 0/1 | 流水线/聚类恢复/模型 | [详情](modules/news.md) |
| `knowledge` | 知识图谱、实体情报与影响传播 | — | 11/11 | 0/1 | ingestion Cron/证据 | [详情](modules/knowledge.md) |
| `crawl` | 采集源、模板、画像、工作流与 Frontier | 54/68 | 2/3 | 0/5 | crawl4ai/Frontier/BullMQ | [详情](modules/crawl.md) |
| `situation` | 态势监控、地理与实时信号 | 12/16 | — | — | Telegram/Oref/AIS/刷新 | [详情](modules/situation.md) |
| `settings` | 设置中心与平台治理 | 39/43 | 16/16 | 0/17 | 共享设置缓存/SMTP | [详情](modules/settings.md) |
| `model-gateway` | 模型接入、密钥与 LLM 网关 | 21/33 | — | — | LiteLLM/密钥下发 | [详情](modules/model-gateway.md) |
| `infrastructure-data` | 基础设施、采集凭据与数据运行 | 15/25 | — | — | S3/vector/归档/地理 | [详情](modules/infrastructure-data.md) |
| `observability` | 日志、异常、质量、遥测与运维 | 26/32 | — | — | 分类报告/恢复队列 | [详情](modules/observability.md) |
| `assistant` | Assistant 与模型任务 | — | 3/3 | 0/4 | assistant worker/模型 | [详情](modules/assistant.md) |
| `economic` | 经济数据与 AkShare | 0/3 | 6/6 | 0/3 | AkShare/repeat job | [详情](modules/economic.md) |
| `archive` | 归档阅读与准备任务 | 1/1 | 0/3 | — | 准备任务/模型 | [详情](modules/archive.md) |
| `async-runtime` | 队列、调度、Outbox 与实时传输 | 0/4 | — | — | worker/Cron/Outbox/WS | [详情](modules/async-runtime.md) |
| `vector` | 独立 Go 服务与 vector 上游切换 | — | — | — | 独立 Qdrant 服务 | [详情](modules/vector.md) |

分域清单合计覆盖 370 条主 API HTTP、77 Query、57 Mutation、4 Subscription；Go 路由/root 注册分别为 274、71、8、0。公开 liveness 仍为 shadow，由 Nest 响应，未计入 Go 接管。GraphQL/Socket.IO/Bull Board 传输挂载、42 个 Nest 模块目录归属与异步任务另见证据页，不与业务 root 重复计算。

## 已发出、已认领与当前任务

- [SETTINGS-WRITE-001](tasks/SETTINGS-WRITE-001.md)：`pr_open`。13 个设置 Mutation；历史提示词已发出，现有 Ready [PR #68](https://github.com/wei500L/newwei/pull/68)，head `a1c96172b7ebf44a18ca71429d29dca8f9096d02`；CI 进行中，尚未合入 main。
- [WORKSPACE-WRITE-001](tasks/WORKSPACE-WRITE-001.md)：`in_progress`。8 个通知/看板/告警交互 Mutation；历史提示词已发出，worktree 已有 config/alerts 本地开发增量，尚无 PR。保留占用，执行器活动未核实。
- 首次 13:51 MSK 开放 PR 为 0；14:03 MSK 再核对发现业务 PR #68。其他本机旧 worktree/历史合并索引在 [tasks/README.md](tasks/README.md)，不按 worktree 存在推断在执行。
- 本地图是文档任务，业务迁移提示词未在本次重新发出；索引已在 [Ready PR #69](https://github.com/wei500L/newwei/pull/69) 发布，对其他机器可见，main 可发现入口需等 PR 合入。

## 剩余主线（尚未分配候选）

1. 登录/refresh/邮件验证码、注册邀请审批完整链；已认证 MFA 与组织管理写已在 main，排除重复范围。
2. GraphQL `items`、`crawlMetadata`、`alertRules` 和归档三读；归档 digest/calendar 会入准备队列，不能只搬查询。
3. 已注册但不完整的 `newsEventBrief`：缓存 miss/forceRefresh 生成与 metadata 写回尚未实现，见新闻域；与已实现 publicportal 冷路径分开。
4. 除已占用 21 个 Mutation 外的写链：来源策略四写、条目/RSS 翻译、采集/导入、告警规则/触发、分析/Assistant 请求、经济调度、图谱证据 review。
5. 三个分析导出，NewsNow 上游读取/推荐，模型网关 proxy-governance 与真实探测，态势主动刷新/Telegram 授权，外部连接诊断和运维恢复。
6. BullMQ 入队与 worker、repeat/Cron、Outbox、四个 GraphQL Subscription 和 Socket.IO 的执行所有权；独立 vector 上游部署切换。

这些是候选主线，不是任务认领；选批必须按规划规则做远端增量与候选域复核。

## 当前具体未核实范围

- 两批历史提示词的原始发出时间、执行器当前活动和预计交付；设置写 PR #68 代码未由本地图任务完整审查/运行，工作台写剩余开发范围和其他机器状态未知。
- 真实部署配置、pilot 是否实际启动、Web/vector 上游流量去向、生产切流与回滚实测。
- SMTP、LiteLLM/模型冷路径、crawl4ai、Nominatim、OpenSky、Telegram/Oref、AkShare 的真实外部调用；本次无运行验证，不用普通 CI 代替。
- 历史报告引用的额外 smoke 尚未逐个关联其精确 head SHA；仅基线普通 CI 的三个成功 job 有本次直接证据。
- 动态运行期的 job/repeat 注册数量、租约竞争及 Socket.IO 实际订阅拓扑未运行验证；源码入口和消费者已索引。
- `cmd/api/main.go` 调用 `wireDataRuntimeSettings` 的错误分支为空；失败时的启动/回退行为需在下一项相关任务中核对，本次不改业务源码。
