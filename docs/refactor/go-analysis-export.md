# 分析条目与事件 CSV 导出迁入 Go

开工 main：`90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`（普通 CI 39149114456 成功）。

本批把分析工作台的两条 CSV 导出迁到 `apps/api-go`：`POST /api/analysis/exports/items` 与 `POST /api/analysis/exports/events`。Web 的 URL、方法、DTO、权限、状态码、响应头和 CSV 字节保持不变，单次最多 5000 行。

`POST /api/analysis/exports/search` 继续留在 NestJS：它的 `mode=headlines` 会经 `getDigest` 触发归档准备，第三路整迁依赖归档执行边界。归档准备、采集任务/BullMQ、analysis 请求/worker、Subscription 都不在本批范围，不能因为 items/events 两路已迁就声称整组导出完成。

## 路由与开关

| 开关 | 路径 | 方法 | 权限 |
| --- | --- | --- | --- |
| `API_GO_ANALYSIS_EXPORT_MODE` | `/api/analysis/exports/items` | 仅 `POST` | `analysis.write` |
| 同上 | `/api/analysis/exports/events` | 仅 `POST` | `analysis.write` |

开关只接受空串/`legacy`/`go`，空串视为 `legacy`，默认 `legacy`，非法值启动失败。只有这两条精确路径进 Go；`search`、其他方法和其他路径继续回落 `/api/` 代理 NestJS。合格的 CORS 预检由 Go 回答 204，缺少预检头的 OPTIONS 仍回 NestJS。回滚只把该变量改回 `legacy`：路由重新走 Nest，不在 Go 侧删改任何业务数据。

`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，缺失或 DSN 无效都在启动阶段失败。它**不**依赖 `API_GO_ITEMS_READING_MODE`、`API_GO_GRAPHQL_READ_MODE`、`API_GO_ANALYSIS_{VIEWS,BOARDS,THREADS}_MODE`：本单元自行初始化条目读取服务、Personalization、Mongo 连接与新闻事件读取端口，并按需懒调用 ES/vector/模型，不在启动探测外部服务。

## HTTP 契约

- 两个 POST 成功都是 **201**（Nest Controller 没有 `@HttpCode` 覆盖），直接返回 CSV 流；`Content-Type: text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="analysis-items-export.csv"` / `"analysis-events-export.csv"`。不返回 JSON 包装或 `rowCount`，不新增路由。
- 请求体只有可选 `queryString`：`@IsOptional @IsString @MaxLength(4000)`。省略、`null` 与空串都是无过滤导出；非字符串/超长沿用既有 ValidationPipe 400（message 用 `"; "` 拼成字符串）。空 body 与非 JSON content-type 都按 body-parser 语义当“没有 body”，不额外报错。
- 组织与用户来自服务器验证身份：复用 `accountsecurity.Authenticator.Authorize(..., "analysis.write")`，即人类 JWT 验签 + Redis 撤销名单 + MySQL membership/权限重推导，**以及 `mtk_` 机器令牌路径**。不接受 query/body 里的 `orgId`/`userId` 覆盖，也不新增 `items.read`/`dashboards.read`/`settings.manage` 或平台管理员要求。
- 所有业务失败都发生在提交 CSV 响应头之前：401/403/DTO 400/上游 503/数据库 500 先写错误投影；200 的 CSV 只在查询与投影全部成功后才开始写。真实空结果仍是 201，且只有表头。
- 源导出没有新增审计或业务表写入。本批不加导出审计、导出任务、Outbox、锁或重试框架，保留复用读取链中原有的缓存、外部调用与 rerank 日志副作用。

## 条目导出契约

参数解析对齐 `AnalysisWorkspaceService`：

- `q` trim 后非空作为 search（历史 `__items_filters__` payload 也走既有 `ParseSearchPayload`）；`order=published` → `PUBLISHED_DESC`，`personalized` → `PERSONALIZED`，其余 `CREATED_DESC`；无 search 为 `RECENCY`，有 search 时 `ranking=recency` 才是 `RECENCY`，否则 `RELEVANCE`，相关性判断优先于 personalized 分支。
- `region`/`topic`/`sentiment`/`contentType` 取重复键的全部 trim 后非空值（不按逗号拆分）；`from`/`to` 解析为日期区间，无效值忽略；`dedup` trim 小写为 `hide`/`1`/`true` 时 `excludeDuplicates=true`。其余参数不凭 Web UI 想象加入筛选。
- 复用 `itemsreading` 既有 search scope/read-model/画像/时间排序逻辑，只把 `page=1`、`maxPageSize=5000` 的源语义通过新的窄 `ListForExport` 端口暴露；不放宽 REST/GraphQL 交互上限（仍是 50），不循环 50 条反复重新排序或重复 rerank。RELEVANCE 的召回/rerank 候选上限沿用现有运行配置，不要求 ranker 把有限召回扩到 5000。ReadModelEnabled 开/关、CREATED/PUBLISHED/PERSONALIZED 的候选与稳定顺序、缺失行行为与既有实现一致。
- PERSONALIZED 必须传调用者 `userId`，独立模式下也接真实画像 provider，不静默降级。
- 字段补全先批量读 Mongo `itemreadmodels`（条件同时有 `orgId`/`itemMetaId`，同 id 首次文档保留），再由 `processed.id` 批量查 MySQL `NewsEventItem`（`orgId` 过滤、`createdAt DESC`、关联 `event{id,title}`、每个 processedId 取首条）。不逐行 N+1，不跨组织补字段。
- CSV 列顺序：`id,title,source,domain,publishedAt,language,region,sentiment,contentType,eventId,eventTitle,url`。`title = readModel.title ?? item.name`（显式空串保留）；其余文本缺省空串；`publishedAt` 取 read model 优先、再回退 ItemMeta，按有效 Date 转 UTC 毫秒 ISO，无效/缺失为空；事件缺省空串。不导出内部 payload、密码或完整 Mongo 文档。

## 事件导出契约

- `window` 按 JS `parseInt` 规则，默认 30、有效正数上限 365；`status` 仅 `active`/`archived`，其余不过滤；`entity` trim 后按 `contains` 匹配；`sort` 仅 `heat`/`credibility`，其余 `latest`；`sourceType` 仅 `authoritative`/`mixed`/`blog`/`unknown`，其余 `all`；`minHeat`/`minCredibility` 按 JS `parseFloat` 接受有限非负数，无效/负数忽略（不照 GraphQL 压到 100，也不给 entity 加 120 字符截断）。
- MySQL 先按 `orgId`、status/entity、`lastAt >= now-window` 过滤，`lastAt DESC, startAt DESC` 最多取 5000 个候选并带 items count；再批量补热度/权威 → 业务筛选 → 稳定排序 → 贪心相似去重 → 最多 5000。禁止先取列表默认 100/300，禁止去重后额外补采。
- 热度用最近 1 小时/4 小时成员、来源数与 `lastAt`，复用已有 `EventHeat` 公式与四舍五入；权威统计窗口是导出 `windowDays`（不是其他 root 的 45 天默认），复用组织 source policy 与 `EventAuthority`，输出 authoritative/unique 来源数。缺 map 条目按源 `unknown`/0，真实 DB 错误不伪装成空成功。
- 从 news event settings 读 `forceAuthoritativeMode`/`forceMinAuthoritativeSources`：为 true 时覆盖请求 `sourceType=authoritative`，阈值按源 `Math.max(1, Math.min(10, ...))` 应用；设置读取失败沿源忽略。只读适配留在 `newsevents` 导出端口，不改 settingscrawl policy 或写端。
- 排序：heat 按 `heat DESC → credibility DESC → lastAt DESC`；credibility 按 `credibility DESC → heat DESC → lastAt DESC`；latest 按 `lastAt DESC → heat DESC → credibility DESC`，保持初始相同键顺序。
- `title` 取 trim 后非空的 `title → summary → primaryTopic → primaryEntity → id`；token 去重仍用原 `primaryEntity`/`primaryTopic`/`title`，不改成 fallback 标题。
- CSV 列顺序：`id,title,status,primaryTopic,primaryEntity,startAt,lastAt,heatScore,credibilityScore,itemCount,authoritativeSourceCount,uniqueSourceCount`。时间 UTC 毫秒 ISO，缺文本为空、源数值默认 0。

## 事件去重的 token 倒排索引优化

源流程按已排序结果依次考察，只与已保留事件比较：`startAt` 或 `lastAt` 任一距离 `<= 5 天`且 token Jaccard `>= 0.74` 就丢弃当前事件。token 是 entity/topic/title 拼接、小写、非 `[a-z0-9]` 与中文（`U+4E00..U+9FFF`）替换空格，分词后只保留长度 `>= 3` 或含中文的 token，先取前 24 个再 Set 去重；空 token 集合相似度 0。

本批在导出路径的窄 helper 内实现“token → 已保留事件下标”倒排索引：只对共享至少一个 token 的已保留候选再做原时间条件与精确 Jaccard 比较，新事件被保留后才加入索引。Jaccard 为 0 的集合不可能达到 0.74，所以该裁剪不改变保留的 id 序列、5 天 OR 条件、`>=` 边界和贪心语义；被丢弃事件不加入索引，因此不会出现传递去重。5000 条事件下减少无共享 token 的无效两两比较，但不宣称最坏复杂度必然线性。既有 GraphQL `newsEvents` 的筛选/候选契约不变。

等价性验证用固定与生成数据对比参考贪心算法（`dedupeEvents`）的保留 id 序列，覆盖跨 5 天边界、阈值两侧、空 token 集合、重复 token，以及“被丢弃事件不参与后续判断”。CSV 侧验证公式前缀、逗号/引号/CR/LF 引号与分隔符字节契约。

## CSV 字节契约

- LF 分隔、UTF-8、无 BOM、无结尾额外换行；空结果只有表头。逐行编码到响应，不构造 `[header, ...rows]` 或整份大字符串。
- 单元格含逗号/双引号/CR/LF 才加双引号，内部双引号加倍，其余空格与文本原样保留。
- 字符串先按源 JS whitespace 跳过开头空白检查：以 `=`/`+`/`-`/`@` 开头且不是 `^-?\d+(\.\d+)?$` 普通数字字符串时，在原全文前加单引号再做 CSV 转义。`-12`/`-0.5` 保留，`+12`/`-1e3`/`=SUM(...)` 按源处理。

## 复用端口与实现文件

- 新增 `internal/analysisexport/**`：DTO/参数解析、CSV 编码、两路行模型、HTTP handler 与错误投影。
- `internal/itemsreading/csvexport.go`：`ExportItemsQuery`/`ListForExport`（复用 `listItemsPage` 的时间/相关性/个性化分支）、`FindExportReadModels`（Mongo 批量投影，不做 hydration 写）、`FindExportEventLinks`（`NewsEventItem → NewsEvent` 批量联查）。
- `internal/graphqlread/newsevents/export.go`：`NewExporter`/`ExportQuery`/`ExportEventRow`，复用私有 `heatMap`/`authorityMap`/`loadSettings`/`sortEvents`/`eventTokens`/`jaccard`，新增导出候选查询与 token 索引去重，不调用 GraphQL root，也不改 brief/日志业务。
- `internal/analysiscollab/validate.go`：新增 `ExportQuerySpecs()` 复用既有 ValidationPipe 复刻；`NormalizeQueryString` 直接复用。
- `internal/legacyproxy/analysis_export_routes.go`、`cmd/api/analysis_export.go`、`internal/config` 与 `cmd/api/main.go` 的本批增量（模式、资源 OR、无效 DSN 阻断、共享 Mongo 指针与 close 生命周期）。

## 未验证与保留

- 本机未安装依赖，未运行 build/test/Docker/服务；只有静态检查、`gofmt` 与 `git diff --check`。等价性与 CSV 用例交现有普通 CI 的 Go 测试执行。
- 真实 ES/vector/embedding/rerank、真实模型配置、真实 MySQL/Mongo/Redis、真实外部网络与生产大数据导出（接近 5000 行）都未执行；不能写“已通过”。
- `POST /api/analysis/exports/search` 完整保留 NestJS；归档准备、采集任务/BullMQ、analysis 请求与 worker、Subscription 未认领。
- Web → NestJS/canary 部署变量不变；地图由规划窗口集中回填。
