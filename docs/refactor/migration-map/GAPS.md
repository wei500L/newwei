# 已确认缺口与待核对事项

[入口](README.md) · [候选队列](BACKLOG.md) · [实现核对范围](AUDIT.md)。本轮源码基线均为 `3cedce9aa3200436aba3596f63b559de5490cec8`（2026-10-18 14:37–14:42 MSK 静态阅读）；PR #70 的候选代码另记 head，不能关闭 main 缺口。稳定 ID 不因任务 merged 而删除。关闭须有实际落地提交、对应入口/分支与证据。

## 当前摘要

| ID | 性质 / 所属域 | 影响范围 | 状态 / 归属 |
|---|---|---|---|
| GAP-GQL-001 | 接线；settings / GraphQL 公共运行时 | 设置 13 写单独启用 | 未分配；SETTINGS-WRITE-001 主体仍 merged；与 WORKSPACE-WRITE-001 共享接线冲突 |
| GAP-NEWS-001 | 部分实现；news | Query `newsEventBrief` 冷生成/forceRefresh | NEWS-BRIEF-001 in_progress（候选实现，未合 main）；缺口仍开放 |
| GAP-CRAWL-001 | 部分实现；crawl | `GET /api/crawl-media-assets/:assetId/:mode` 的 S3 分支 | 未分配；BL-03 |
| GAP-LEGACY-001 | 未迁移入口；跨域 | 域页精确清单中的 Nest HTTP/root | 工作台 8 写已由 WORKSPACE-WRITE-001 覆盖，Query `items` 由 ITEMS-LIST-001 覆盖（均 pr_open）；其余未分配，见 BACKLOG |
| GAP-ASYNC-001 | Nest 执行依赖；跨域 | 已迁读取/配置背后的生成、消费、调度、订阅 | 未分配；按链路拆分，见执行所有权表 |

“未迁移”是范围事实，不表示 Nest 有 bug；“缺少外部运行证据”不单独计为源码缺陷。当前没有因本轮文档维护而关闭的业务缺口。

<a id="gap-gql-001"></a>

## GAP-GQL-001 · 设置写独立开关漏入公共接线

- 精确入口：SETTINGS-WRITE-001 列出的 13 个 `update*` Mutation；根因共用，不按 13 条重复建 bug。
- 触发：`API_GO_GRAPHQL_SETTINGS_WRITE_MODE=go`，`API_GO_GRAPHQL_READ_MODE=legacy`，`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=legacy`。其他模式都关时，即使配置校验通过，仍缺 Redis/authenticator，`run` 在 GraphQL 装配检查处返回错误，进程不监听。若其他 HTTP go 模式补齐资源，handler 可以构造，但 `/graphql` 路由仍走 legacy，写实际由 Nest 执行。
- Nest 应有行为：SettingsResolver 先校验 settings.manage / assertAdmin，再调用设置服务进行规范化、持久化和缓存更新。Go 的 13 个业务 resolver 已存在；这是入口/资源选择缺口，不重迁整批业务。
- 源码：[main.go](../../../apps/api-go/cmd/api/main.go) `run`：681–685 `graphqlRouteMode`；746–796 无效 DSN 的接管判断也漏设置写；877 `needsCredentialedGo`；1418–1422 handler 判断却含 `settingsWriteGo`。资源校验见 [config.go](../../../apps/api-go/internal/config/config.go) `Load` 2483；模型装配 1501–1509 已有读关闭/开启分支。
- 当前可达组合：设置写 + 总读（另需 Mongo），或设置写 + 组织写（无须 Mongo）。模型使用 settingscrawl.Register / RegisterSettingsModelTypes，详见 [GraphQL 组合表](modules/graphql-runtime.md#本轮有意义的组合复核)。
- 任务关系：#68 合并事实不撤销。#70 head `db6339122263658148072f65dc641d9b769117e7` 基于 #67，路由和资源 OR 仅增加 workspaceWrite，尚没有 settingsWrite；因此不能据 #70 描述宣称 main 已修复。14:49 再核 #70 已正常 merge #68，head `200ab9440bc2c4d217f429999468c90b81a968e0`：needsCredentialedGo 补了设置写，graphqlRouteMode 和无效 DSN 条件仍漏设置写。14:56 PR head推进到adb765d0但只追加交付报告，业务未变。工作目录已干净；PR 仍 OPEN，此候选资源修复不关闭 main 缺口。
- 主要文件：`cmd/api/main.go`；必要时 `internal/config/config.go`；模型复用见 `graphqlread/{workspace,settingscrawl}/register.go`。前置：先确认 #70 与 #68 的并集落地方式；这些共享文件一次只交给一个执行任务。BL-01 当前须等待或明确接线所有权，不重复认领 13 写。
- 关闭证据：**无**。需要落地 SHA 中 OR/资源/handler 一致，静态组合核对与该 head 普通 CI；独立开关运行证据另外记，不能由 CI 自动推断。

<a id="gap-news-001"></a>

## GAP-NEWS-001 · 事件简报缺少生成与写回

- 入口：Query `newsEventBrief(eventId, language, maxSources, forceRefresh)`，items.read；总读和新闻事件子模式均 go。
- 触发/影响：存在可访问事件且有有效来源；briefV1 缺失、语言/指纹失配或 `forceRefresh=true` 时固定字段错误 `Internal server error`，无法生成新简报。事件不存在/无来源返回 null 是合法结果，不算缺口。命中有效缓存可返回简报。
- Nest：[news-events.resolver.ts](../../../apps/api/src/graphql/resolvers/news-events.resolver.ts) → [NewsEventBriefService.getBrief](../../../apps/api/src/modules/news-events/news-event-brief.service.ts) → `generateBriefWithLlm`，清洗引用并合并 `metadata.briefV1`；写缓存失败记录 warning，仍返回已生成内容。
- Go：[newsevents/brief.go](../../../apps/api-go/internal/graphqlread/newsevents/brief.go) `newsEventBrief` 18–59，loadEvent/loadItems、选源/指纹与缓存命中已实现，末尾固定报错；没有模型调用/metadata 更新。注册在 [register.go](../../../apps/api-go/internal/graphqlread/newsevents/register.go)。核对 SHA 如页首。
- 可复用但不可直接调用：[publicportal/story.go](../../../apps/api-go/internal/publicportal/story.go) `Service.brief` 已实现选源→Complete→JSON 清洗→SaveEventMetadata；`brief`、`completionRequest`、gateway helper 均为包内私有，公共门户语言/组织选择与 GraphQL 参数也不同，不能声称已共享。
- 主要文件：newsevents `brief.go` / store/model；如抽共享能力，需明确 publicportal/story.go、brief.go、gateway.go 的所有权。MySQL NewsEvent/NewsEventItem/ProcessedArticle、模型配置/密钥、HTTP 模型上游；无须为了这个同步入口迁 BullMQ。前置是确定具名共享模型/客户端边界，BL-02 可独立窗口评估，避开 BL-17 公共门户客户端并行修改。
- 状态：已分配 [NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md)；编码窗口在 main 9d0462e1 上给出候选实现（BRIEF 子开关 + Go 选源→模型→校验清洗→`JSON_SET` 写 briefV1 叶子 + best-effort LLM 请求日志），Ready [PR #72](https://github.com/wei500L/newwei/pull/72) head 517a73f9 普通 CI verify/integration 通过，但**尚未合 main**，故缺口仍开放。关闭证据：**无**；需该候选实际 merge SHA 中命中、miss、forceRefresh、无事件/来源、写回与日志分支的落地证据，实网模型验证另记。

<a id="gap-crawl-001"></a>

## GAP-CRAWL-001 · 已注册媒体入口丢失 S3 下发

- 入口：`GET /api/crawl-media-assets/:assetId/:mode`，mode 为 preview/download；公开路由使用 HMAC 的 exp/org/user/sig 授权，不由公开二字推断可越租户。
- 触发/用户影响：`API_GO_CRAWL_READ_TELEMETRY_MODE=go`；签名有效、orgId 匹配且资产 provider 为 s3，有合法 storageKey/存储配置，Go 仍返回 404。任务详情返回的媒体 URL 可能因此失效。
- Nest：[CrawlMediaAssetService.getAssetDeliveryPayload](../../../apps/api/src/modules/crawl/crawl-media-asset.service.ts) 433–520，MySQL blob 与 S3 分支分开，S3 调 storage.createObjectReadUrl，附 content-type/disposition/cache-control；[controller](../../../apps/api/src/modules/crawl/crawl-media-asset.controller.ts) 对 redirectUrl 重定向。
- Go：[service_media.go](../../../apps/api-go/internal/crawlreadtelemetry/service_media.go) `getAssetDeliveryPayload` 456–515，MySQL joined blob/legacy blob 已实现；非 MySQL 末尾固定 `(nil,nil)`。`serveMediaAsset` 151 将 nil 映射为 404，虽有 RedirectURL 分支却没有 S3 生产者。核对 SHA 如页首。
- 主要文件：crawlreadtelemetry/service_media.go、模型/构造与 `cmd/api/crawl_read_telemetry.go`；读取存储配置/解密可能涉及 infrastructuresettings/storage.go，当前该包只提供配置管理，不能当现成 S3 对象客户端。S3/Nest StorageService 是外部对象边界；不需要迁 crawl worker 才可补读。
- 前置/冲突：明确 S3 配置优先级、endpoint/path-style/publicBaseURL/TTL 与租户签名；BL-03 与 BL-15 的存储配置辅助函数串行。原 #50 已 merged，未迁的是剩余 S3 分支，不重新分配整个 7 路批次。
- 状态：未分配。关闭证据：**无**；需合法 S3 下发分支源码/提交/CI，实桶验证与配置缺失错误另记。

<a id="gap-legacy-001"></a>

## GAP-LEGACY-001 · 尚无 Go 接管的契约入口

- 精确范围的唯一事实源：18 个域页的 HTTP/root 表。当前 95 条 HTTP 标为 Nest、6 Query、36 Mutation、4 Subscription 未被 Go 注册；另有 `GET /api/healthz/live` 仍为 shadow，单列为切流状态，不能算新增缺陷。与 274/370 接管口径相容。
- 触发/影响：请求到达 legacy 规则或包含未接管 GraphQL root，业务由 Nest 执行；停掉 Nest 会失去相应功能。Go 并没有把这些入口返回空值来冒充完成。
- Nest / Go：Nest Controller/Resolver/Service 定位已在域表；Go [legacyproxy](../../../apps/api-go/internal/legacyproxy) 与 [exec/walk.go](../../../apps/api-go/internal/graphqlread/exec/walk.go) 决定回退。未注册 root 在副作用前整份回退。
- 任务覆盖：工作台 8 写由 WORKSPACE-WRITE-001 / #70 占用，保持 pr_open；Query `items` 由 [ITEMS-LIST-001](tasks/ITEMS-LIST-001.md) 覆盖（pr_open，未合 main，不提前改本页分母）；其余候选见 BACKLOG 各自精确范围、文件和前置，不能领取整个集合。主要共享冲突是 main/config/Registry，其余按域隔离。
- 状态：部分已被任务覆盖，其余未分配；关闭证据按入口分批关联实际 main 提交，不因一批合并关闭整个 ID。新增/删契约另改分母，不以文档行数算迁移进度。

<a id="gap-async-001"></a>

## GAP-ASYNC-001 · 已迁读取背后的 Nest 执行所有权

这是迁移边界，不是“所有 Go 读都未实现”。精确步骤和源码见 [DEPENDENCIES 执行所有权](DEPENDENCIES.md#产品链路与执行所有权) 与 [异步域](modules/async-runtime.md)。

| 受影响的 Go 范围 | 仍须 Nest 执行的必要步骤 | 用户影响 / 触发 | 候选与前置 |
|---|---|---|---|
| `analysisResults` / `assistantRuns` | submit* 入队、processor→process、Mongo 结果更新、事件发布 | 查询可读历史；新分析/Assistant 运行仍须 Nest | BL-12/13；明确队列 payload 与唯一消费者 |
| 归档准备状态 HTTP | archiveDigest/Calendar→ensure*Coverage→ArchivePreparationProcessor→分类写回/markReady | status 可以读，但不会自己生成缺失归档；无 Nest worker 状态不能正常推进 | BL-09；准备配置已迁不代表 worker 已迁 |
| Telegram/Oref 信号和 refresh-run 读 | signals processor、轮询器、external snapshot Cron、refresh 入队 | Go 读取已有 Redis 缓存；停 Nest 会失去后续刷新 | BL-14；外部凭据与租约先确认 |
| 经济六读、新闻事件/指标、知识图谱读 | AkShare repeat/processor、news pipeline/ingestion、KG ingestion | 已有数据查询在 Go；新数据/关联仍依赖 Nest 更新 | BL-11/16/18；先划每条数据写入所有权 |
| digest 投递配置；审计补偿 | UserDigestDeliveryScheduler；AuditLogOutboxService 等 Cron | 配置已保存不等于邮件发送；设置写审计失败时 Go 写 outbox，重放仍在 Nest | BL-19/20；去重键、租约、关闭与外部 SMTP |
| 四 Subscription 与 Socket.IO | Nest executor / Redis backplane / WS gateway | Go SSE 不替代 GraphQL/WS；协议升级仍回退 | BL-21；先确定事件生产者/租户与字段权限 |

主要文件与独立交付边界分别保存在 BACKLOG，避免复制全部 worker 清单。状态：未分配；WORKSPACE-WRITE-001 只写交互数据，不覆盖告警扫描/SMTP/Webhook worker。关闭证据：**无**，按链路迁移后逐行缩小范围。

## 观察项与缺少验证（不计入已确认业务缺口）

- **OBS-DATA-001**：[main.go](../../../apps/api-go/cmd/api/main.go) 1245 空错误分支确实吞掉 `wireDataRuntimeSettings` 错误。当前 helper 仅在 go 且 db/redis/auth 为 nil 时返回错误；`config.Load` 要求 JWT/MySQL/Redis，main 的无效 DSN 阻断列表和 `needsCredentialedGo` 都含 dataRuntimeSettingsGo，先行完成这些资源装配。因此本轮未确认合法当前启动路径能触发它；不能写成“九路必然不可用”。若以后可触发，run 会继续，已选 ModeGo 却无 handler 的请求在 Gateway.ServeHTTPWithShadow 返回 **501**，不会自动回 Nest。跟踪候选 BL-01，需先证明可达路径/或说明仅错误传播修正，不改业务。
- **VERIFY-EXT-001**：真实 SMTP、模型、S3、crawl4ai、Nominatim/OpenSky、Telegram/Oref、AkShare 未在本轮调用。源码中有客户端不等于实网已通；正常外部错误/配置未设不自动登记 bug。
- **VERIFY-CONTRACT-001**：未逐字段复验所有 DTO/返回投影、跨进程缓存 TTL、事务竞争、全部游标/筛选边界，范围按 [AUDIT](AUDIT.md) 各组列明。静态阅读不是运行验收。
- **VERIFY-DEPLOY-001**：部署值、Web/vector 真实流量、生产启用与回滚均未核实。只读 Compose 源码，不读取真实 .env 或秘密。
