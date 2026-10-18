# 后端迁移地图

先读本页 → [PLANNING](PLANNING.md) → [当前任务](tasks/README.md) + [缺口摘要](GAPS.md#当前摘要) → [候选队列](BACKLOG.md) → 候选域与源码。[实现核对深度](AUDIT.md)、[开关/执行所有权/复用入口](DEPENDENCIES.md)、[证据](EVIDENCE.md)按需展开。Nest 暂时保留。

最新RSS选批增量（2026-10-18）：再次fetch main仍90765633，开放业务#81–#84未变；知识复核目录已见业务开发，摘要投递目录已创建但尚未见改动，均继续占用。新增[RSS-TRANSLATION-001](tasks/RSS-TRANSLATION-001.md) reserved，[完整提示词](tasks/RSS-TRANSLATION-001.prompt.md)随[规划PR #85](https://github.com/wei500L/newwei/pull/85)发布：单Mutation的双provider/四字段/正文分块/两层缓存/日志指标完整链，同时修复GAP-RSS-001状态投影覆盖共享完整网关缓存。仅深入RSS调用链，不重迁条目列表或导出，不启动业务，历史统计不提前增加。

最新digest选批增量（2026-10-18）：fetch后main为`90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`，普通CI39149114456 success；#69/#70已merged，#70–#76经#77合入，#79身份申请/邀请也已合入。开放业务Ready #81网关、#82来源策略、#83 OIDC、#84分析导出继续占用；开放规划[#80](https://github.com/wei500L/newwei/pull/80)的知识复核认领同样保留，不能以main尚无task文件重复派发。新增[DIGEST-DELIVERY-001](tasks/DIGEST-DELIVERY-001.md) reserved：[完整提示词](tasks/DIGEST-DELIVERY-001.prompt.md)，只补每日摘要Cron→到期认领→真实SMTP→状态/通知完整链，原五HTTP不重迁；包含摘要专用Nest通知桥及明确切换所有权。本次只深读该链、维护规划，未实施、未创建业务目录，历史全域统计/审查日期不更新为新验收。

最新规划增量（2026-10-18）：main已到c39f282f11952b487c3ef6fefb14882db265ed9e，#70–#76经[#77](https://github.com/wei500L/newwei/pull/77)合入，普通CI成功，当前无开放PR。新增[IDENTITY-ONBOARDING-001](tasks/IDENTITY-ONBOARDING-001.md)的14条申请/审批/邀请入组完整链，[提示词](tasks/IDENTITY-ONBOARDING-001.prompt.md)已发出。本次只深读identity候选并更新必要认领，不重建全仓地图；下面3cedce9a/9d0462e1日期和注册统计是历史快照，不能当作c39f282f现值，六批合并/新占用看任务索引。生产启用与外部验证不由merge/CI推断。

2026-10-18 本次规划增量：#69 已合并，最新代码基线为 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；相对下述3cedce9a仅文档/导航变化，业务与注册覆盖未变，main普通CI成功。#70仍OPEN/Ready，head adb765d0，继续占用工作台8写。[NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md) 已reserved，补新闻事件简报冷生成/强刷及必要日志/写回；[执行提示词](tasks/NEWS-BRIEF-001.prompt.md) 已保存，本窗口不实施。其余历史全域审查日期保持，只有本root按最新SHA深入续核。

用户随后要求再并行一批：同一main下认领[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)，补存储test、S3交付及已有REST/GraphQL详情URL；[独立提示词](tasks/STORAGE-MEDIA-001.prompt.md)已保存，与简报业务包隔离，共享接线按任务语义段最小增量。两批均reserved、未实施，统一在[规划PR #71](https://github.com/wei500L/newwei/pull/71)发布记录。

第三批增量（仍main9d0462e1）：用户简报目录已见业务开发，改in_progress；存储编码目录已创建，继续占用。新增[ITEMS-LIST-001](tasks/ITEMS-LIST-001.md) reserved：[提示词](tasks/ITEMS-LIST-001.prompt.md)完整迁移items分页/相关性/个性化与批量投影；核心文件与前两批隔离，共享只读selection元数据及items注册段已登记。本规划窗口只改文档，不把本地开发/提示词发出计为main进度。

本轮基线：`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`；2026-10-18 14:37–14:42 MSK 做结构/指定业务分支静态核对，14:49 再 fetch，main 未变。15:01–15:08续审补组织八写/设置缓存与来源策略、导出拆分证据，main未变；深度按审查组记录，未逐字段审完的内容在AUDIT明列。普通 CI 与启用证据只在 EVIDENCE 维护。

## 注册覆盖

HTTP/Query/Mutation 为“生产 Go 接管注册 / Nest 契约入口”，不是功能完成率或启用比例；`—` 为无此类主 API 入口。HTTP 以 METHOD+完整路径去重，SSE 算一条；四订阅和传输见域页。vector-go 三条独立 HTTP 不并入主 API 分母。

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
| `settings` | 设置中心与平台治理 | 39/43 | 16/16 | 13/17 | 共享设置缓存/SMTP | [详情](modules/settings.md) |
| `model-gateway` | 模型接入、密钥与 LLM 网关 | 21/33 | — | — | LiteLLM/密钥下发 | [详情](modules/model-gateway.md) |
| `infrastructure-data` | 基础设施、采集凭据与数据运行 | 15/25 | — | — | S3/vector/归档/地理 | [详情](modules/infrastructure-data.md) |
| `observability` | 日志、异常、质量、遥测与运维 | 26/32 | — | — | 分类报告/恢复队列 | [详情](modules/observability.md) |
| `assistant` | Assistant 与模型任务 | — | 3/3 | 0/4 | assistant worker/模型 | [详情](modules/assistant.md) |
| `economic` | 经济数据与 AkShare | 0/3 | 6/6 | 0/3 | AkShare/repeat job | [详情](modules/economic.md) |
| `archive` | 归档阅读与准备任务 | 1/1 | 0/3 | — | 准备任务/模型 | [详情](modules/archive.md) |
| `async-runtime` | 队列、调度、Outbox 与实时传输 | 0/4 | — | — | worker/Cron/Outbox/WS | [详情](modules/async-runtime.md) |
| `vector` | 独立 Go 服务与 vector 上游切换 | — | — | — | 独立 Qdrant 服务 | [详情](modules/vector.md) |


合计 **370 HTTP / 77 Query / 57 Mutation / 4 Subscription**；Go 注册 **274 / 71 / 21 / 0**。18 域/42 Nest 模块归属已重新核对，分母及 main 注册相对14:18均无变化。本轮是文档与证据完善，新增业务迁移数为0；公开 live 仍 shadow，由 Nest 响应，不计 Go 接管。

## 实现与接线缺口

- [GAP-NEWS-001](GAPS.md#gap-news-001)：newsEventBrief 已注册，缓存 miss/forceRefresh 缺模型生成与 metadata 写回。
- [GAP-CRAWL-001](GAPS.md#gap-crawl-001)：采集媒体入口已注册，MySQL blob 可下发，S3 分支固定空返回导致404。
- [GAP-GQL-001](GAPS.md#gap-gql-001)：设置13写已合并，但 main 的独立路由/资源条件漏接。可达组合和 #70 候选修复范围见运行时页；不重新派发13写。
- [GAP-ASYNC-001](GAPS.md#gap-async-001)：历史/配置/缓存读取在 Go，不代表生成、入队、worker、Cron、订阅执行也在 Go。
- wireDataRuntimeSettings 吞错已确认；当前合法初始化路径尚未证实可触发，列为 OBS-DATA-001，不能宣称九路必然不可用。

## 当前占用与剩余顺序

- [SETTINGS-WRITE-001](tasks/SETTINGS-WRITE-001.md)：merged，#68 → `3cedce9a`；剩余接线关联 GAP-GQL-001。
- [WORKSPACE-WRITE-001](tasks/WORKSPACE-WRITE-001.md)：pr_open，[Ready #70](https://github.com/wei500L/newwei/pull/70)，14:56 head `adb765d0180e8b34910181e8c6fde8be400a2dff`（比200ab944只多历史报告文档），worktree 干净，已正常 merge #68；8写仍未进 main，不重复派发。其公共接线仍需检查设置写路由遗漏。
- 地图首版 [#69](https://github.com/wei500L/newwei/pull/69) 已于2026-10-18 15:31 MSK合并，merge为9d0462e1；本次规划增量使用独立文档分支，见NEWS-BRIEF-001。目录存在、工作目录干净都不能证明执行器活跃。

[BACKLOG](BACKLOG.md) 保存未认领队列：先协调 BL-01 公共接线，再补 BL-02 简报/BL-03 S3；随后完整条目查询、来源策略、导出、metadata 与登录主链。归档/采集/告警/分析/Assistant/经济等异步链先明确生产者、消费者与外部边界。候选包含未迁入口、已注册部分实现、接线及必要 Nest 步骤，不只筛 Nest 行。

真实部署、生产流量和实网调用均未核实。源码默认/Compose pilot 与实际启用分别表达；目前不能给出“完整迁移总数”。新对话短启动提示词见 [PLANNING](PLANNING.md#新对话短启动提示词)。
