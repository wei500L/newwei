# 网页元数据预览（Go 接管说明）

> 本批：`API_GO_CRAWL_METADATA_MODE`（HTTP）与 `API_GO_GRAPHQL_CRAWL_METADATA_MODE`（GraphQL），默认都是 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源（逐段翻译）：`apps/api/src/modules/crawl/crawl.controller.ts` 的 `extractMetadata`、`apps/api/src/modules/crawl/crawl-metadata.service.ts` 的 `extract` → `normalizeInput` / `resolveUrls` / `discoverFromSitemaps` / `discoverFromSitemapsCandidates` / `extractFromSitemapPayload` / `resolveSitemapSeedUrls` / `discoverRobotsSitemapUrls` / `parseSitemapPayload` / `fetchMetadata` / `parseMetadata` / `fetchWithStatus` / `fetchMaybe` / `mapWithConcurrency` / `wildcardMatch` / `computeRelevance` / 条件缓存与网新闻时间解析、`apps/api/src/modules/crawl/dto/crawl-metadata.dto.ts`、`apps/api/src/common/validators/ssrf-url.validator.ts`、`is-safe-url.decorator.ts`、`apps/api/src/modules/cache/cache.service.ts`、`apps/api/src/graphql/resolvers/crawl.resolver.ts` 的 `crawlMetadata` / `toGraphMetadata`、`apps/api/src/graphql/dto/crawl.input.ts` 的 `CrawlMetadataInput`、`apps/api/src/graphql/models/crawl.model.ts` 的两个 metadata 模型、`apps/api/src/common/filters/global-exception.filter.ts` 的错误映射。

## 1. 迁移范围：真实业务链，不是空壳

`extract` 只支持 `source=urls` 与 `source=sitemap` 两条发现路径。本批迁移的正是这条链的**真实外调**：robots.txt 发现、sitemap 递归解析、与 Nest 共享的条件 GET 缓存、逐跳 SSRF 校验与手动重定向、gzip 解码、HTML5 DOM 解析 head、JSON-LD 压缩、相关性评分、有界并发。

**不迁移**（`extract` 不调用，属于其他入口/worker）：`discoverRss*`、`discoverList*`、`discoverDeep*`、`Crawl4aiClient`、`CrawlExecutionService`、任务创建/删除/重试/导入、Frontier、完整采集 worker、媒体/S3、来源 preview 以及所有相邻 GraphQL 读写。不新增 crawl4ai 依赖、配置或执行权。

## 2. 开关与回滚

| 变量 | 作用域 | 取值 | go 时的启动要求 |
|---|---|---|---|
| `API_GO_CRAWL_METADATA_MODE` | 只控制 `POST /api/crawl-tasks/metadata` | 空串 / `legacy` / `go`，其他值启动失败（`API_GO_CRAWL_METADATA_MODE must be one of legacy\|go`） | `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`；**不要求** `MONGO_URI` / S3 / crawl4ai / `STORAGE_MODE` |
| `API_GO_GRAPHQL_CRAWL_METADATA_MODE` | 只控制 `crawlMetadata` root | 空串 / `legacy` / `go`，其他值启动失败（同款文案） | 要求父开关 `API_GO_GRAPHQL_READ_MODE=go`，否则启动失败（`API_GO_GRAPHQL_CRAWL_METADATA_MODE=go requires API_GO_GRAPHQL_READ_MODE=go`）；Mongo 来自父 READ 的既有要求 |

- 二者**互不依赖**：HTTP 可以在 GraphQL 与其他采集模式全 `legacy` 时独立工作；GraphQL 可以在 HTTP metadata 与 `SETTINGS_CRAWL_READ` 都 `legacy` 时工作。两个入口**共享同一个 metadata 服务实例**（`cmd/api/main.go` 里只构造一次），不重复初始化 HTTP 连接或 Redis 客户端。
- 回滚：**只把对应变量改回 `legacy`**——纯配置变更。`legacy` 时不追加路由规则、不注册 root、不构造服务实例。
- HTTP 模式已纳入 main 的精确路由、无效 DSN 判断、`needsCredentialedGo` 与 handler 注册，不存在“校验通过却没有鉴权/Redis”的接线。
- GraphQL 只在既有 `graphqlReadGo` 注册区块新增一个独立 adapter，位于 `settingscrawl.Register` 之外；未修改 `settingscrawl.Options`、注册文件、顶层 GraphQL 接管 OR，也未顺手改 GAP-GQL-001。
- `crawlMetadata` **不在** GraphQL 全量响应缓存白名单（`exec.cacheableRootFields`）内，因此不进入响应缓存。

## 3. HTTP 入口

`POST /api/crawl-tasks/metadata`，权限 `crawl.read`，成功 201 `{orgId,total,results}`。

- `orgId` 只来自已认证身份（JWT 验签 + Redis blacklist + MySQL membership/权限重推导；`mtk_` 机器令牌按既有 SHA-256 查询），body/query 无法指定租户。鉴权 → DTO → 业务顺序与 Nest 一致。
- `total` = 最终 `results.length`。
- 不额外写 `CrawlTask`、`RawItem` 或 `ProcessedItem`；无事务、无入队、无 worker/cron、无新增审计事件。
- 路由规则（`apps/api-go/internal/legacyproxy/crawl_metadata_routes.go`）只接管这一条精确 `POST` 及其 CORS 预检。其他方法、尾斜杠、更长路径、`POST /api/crawl-tasks`、`POST /api/crawl-tasks/:id/retry`、`DELETE /api/crawl-tasks/:id` 继续回 NestJS。`GET /api/crawl-tasks/metadata` 仍由既有 `GET /api/crawl-tasks/:id` 规则处理，本批没有新增规则改变其归属。
- Go 业务失败不会转 Nest 重放：单个网页失败是 `failed` 项，输入级错误是 400，权限错误是 401/403。

## 4. GraphQL 入口

`Query crawlMetadata(input: CrawlMetadataInput!): [CrawlMetadataResultModel!]!`，权限 `crawl.read`。

- SDL 早已存在（`apps/api-go/internal/graphqlread/schema/schema.gql`），本批只注册 `CrawlMetadataResultModel`、`CrawlMetadataTagModel` 两个具名模型与 `crawlMetadata` 一个 root；**不重复注册** `crawlTasks` / `crawlTask`（它们属于 `settingscrawl`）。未改 GraphQL 引擎、SDL 或生成物。
- 变量、别名、fragment 与整份 operation 的预规划/回退全部沿用引擎既有行为：本包只提供 `contract.Root` 与类型。
- 返回列表本身，没有 REST 的 `orgId`/`total` 封装。
- 输入级失败（`domain is required when source is sitemap` / `urls are required when source is urls`）按 Nest 的 `BadRequestException` 映射为 `code=BAD_REQUEST`、`http.status=400` 的字段错误（`contract.Failure`），不是 500。

## 5. REST 与 GraphQL 的校验差异（未合并成一套最严格 DTO）

- **REST**（`internal/crawlmetadata/dto.go`）：`source` 非 null 时只允许 `sitemap|urls`；`source != urls` 时 `domain` 必填、最长 255，且按原 hostname 正则拒绝裸 IP / localhost / `.local` / `.internal` / `.lan`（scheme 或 path 形式不能当合法 domain）；`source == urls` 时 `urls` 1..200 项、每项须带 `http/https` 并通过 `IsSafeUrl`（同步规则 + DNS）；`pattern` ≤255、`query` ≤160、`maxUrls` 1..200、`concurrency` 1..10、`scoreThreshold` 0..1、三个 `extract*` 为 boolean。`null` 与缺失按 `@IsOptional` 处理。校验消息与顺序、`whitelist + forbidNonWhitelisted` 的 `property X should not exist`、非 `application/json` 体按 `{}` 处理（`10mb` 限制、超限 413）都对齐 ValidationPipe/Express。
- **GraphQL**：同一字段在 schema 上没有上述范围限制，`source` 是可选 String（不等于 `urls` 时按 sitemap），`domain` 由 `normalizeDomain` 接受带 scheme 或缺省 `https` 并只保留 origin，`maxUrls`/`concurrency` 只要求 ≥1（服务再钳制 200/10），`scoreThreshold` 无 0..1 限制（服务再规范化），`urls` 没有数组数量与装饰器约束（但每一跳请求仍做 URL/SSRF 校验）。内部可选字段的 `null` 与缺省一律不变成 `0`/`false`（用 `contract.Lookup`/指针保留三态）。

### 共同 normalizeInput

- `source` 只在输入 `urls` 时取 `urls`，否则 `sitemap`。
- URL 列表按 `new URL` 语义规范化，**丢掉无法解析的项**并按首次出现去重；**不给列表自动补 https**（自动补 https 只用于 sitemap `loc` 与 robots 的 `Sitemap:` 行）。
- `maxUrls` 默认 50、clamp 1..200；`concurrency` 默认 5、clamp 1..10；round 语义与源码一致。
- 三个 `extract*` 缺省 `true`，显式 `false` 保留，`null` 按 nullish 缺省 `true`。
- `query` 小写并按空白切 token，**保留重复 token**（分母是 token 数）。
- `scoreThreshold` 有限数字先保留 3 位再 clamp 0..1，默认 0。
- `requestTimeoutMs` 固定 15000，不新增公开参数。
- 输入错误文本：`domain is required when source is sitemap`、`urls are required when source is urls`。
- `pattern`：trim、小写；空值不筛选；服务最大 512 字符、最多 32 个 `*`/`?`，超过时**按源码忽略 pattern**（不新增错误），REST 在此前还有 255 字符 DTO 限制。迁移的是既有通配算法（`*` 任意串、`?` 单字符），不是正则、也不是 path glob。

## 6. sitemap 发现、共享缓存与真实抓取

- **发现顺序**：`source=urls` 按规范化顺序取前 `maxUrls`（源码**不**对这条分支套用 pattern）；`source=sitemap` 从 domain origin 发现，不遍历任意网页链接。
- **robots 优先**：GET `/robots.txt` → 按不区分大小写的 `Sitemap:` 行收集 → 规范化去重 → 最多 256 条。robots 至少发现一条时**只用该列表**，后续抓取失败也不会再追加 common paths；只有未发现时，才按 `DEFAULT_SITEMAP_SEEDS` 的 11 个路径与**原顺序**尝试。
- **解析与顺序**：解析 `urlset/url` 与 `sitemapindex/sitemap`，保留“父 URL 条目 → 子 sitemap 深度优先”的既有顺序、`visited` 去重与 `maxUrls` 停止规则；URL 按 `normalizeUrl` 处理后进行 pattern 筛选；去重保留首次顺序，不按日期或相关性重排。支持 `loc` 文本/CDATA 与命名空间前缀（按 local name 匹配），并保留 `lastmod` 与 `news:publication_date` 的解析。
- **共享条件缓存**：键 `crawl:discover:http-state:<sha1(url)>`，TTL 7 天，`JSON.stringify` 形状（`etag` / `lastModified` / `body` / `parsedSitemapPayload` / `updatedAt` 毫秒；payload 为 `urls[{loc,lastmodTs?,newsPublishedAtTs?}]` + `childSitemaps[{loc,lastmodTs?}]`）。本包写缓存时保留新闻发布时间与 lastmod，避免其他发现调用方丢字段；未新增本入口没有的 freshness 公开筛选。
- **fetchMaybe 仅用于 robots/sitemap**：发送 `If-None-Match` / `If-Modified-Since`；304 且有旧 body → 复用 body 并刷新状态、保留 parsed payload；304 且无 body → 按源码**再无条件请求一次**；200 body 相同 → 保留 parsed payload；不同 → 清旧 parsed 后重解析；body 完全相同时复用已解析 sitemap。缓存读写失败按源逻辑降级，不新建锁。可选抓取失败或非法 XML 跳过，最终可以合法返回空列表。
- **fetchMetadata 直接抓取每个页面**，不使用 robots/sitemap 条件缓存冒充页面最新内容。
- **fetchWithStatus**：真实 GET；固定 `MetadataBot/1.0 (+https://github.com/unclecode/crawl4ai) crawl-metadata-service` User-Agent；不携带调用方的 `Authorization`/`Cookie`；**每一跳**先做 scheme/host/private IP/cloud metadata/DNS 校验（复用 `internal/newssources` 的既有 SSRF 实现），再手动跟随相对或绝对 `Location`；禁用 Go 默认自动重定向；最多 5 次重定向（连同首次最多 6 个请求）；整个单次调用共用 15 秒超时，不每跳重置；保留“DNS 解析失败允许继续、实际 HTTP 再失败”的语义。不引入 DNS pinning、重试框架或响应大小/内容类型等新产品限制。
- **错误边界**：保留 `Metadata request failed with status N`、`Metadata response body missing`、`Metadata request failed: too many redirects`、`Metadata request failed: invalid redirect`、`Blocked metadata target (potential SSRF): …`。gzip：`.gz` URL 或 `content-encoding`/`content-type` 指示 gzip 时解压，解压失败按源码回退到原字节 UTF-8；Go transport 自己协商 `Content-Encoding` 并已解压时（`resp.Uncompressed`）不再二次解压。

## 7. HTML 解析、评分与结果顺序

按 Cheerio `parseMetadata` 语义，且**一次 DOM 解析 + 一次 head 遍历**收集全部字段（保持 first/continue/截断语义，不为 title/meta/JSON-LD 反复解析或遍历）：

- 只取 DOM head 中第一个 `title` 的文本并 trim；不用 `og:title` 替代。
- `meta` 取 `name` 优先、否则 `property`；`content` trim 后为空则跳过；保留字段名原大小写与重复条目顺序。
- `includeOpenGraph=true`（缺省）且名称匹配 `og:`/`twitter:`（不区分大小写）时进 `openGraph` 并跳出普通 meta 分支；**关闭时按源码继续普通 meta 分支**（不直接丢弃）。
- `extractStandardMeta=false` 只禁止 `metaTags` 收集，**不禁止** `description`/`keywords`/`author` 提取。
- `description`/`author` 取首次匹配；`keywords` 首次匹配后按逗号 trim、去空、最多 15 条，不新增去重。
- `metaTags`/`openGraph` 各截 25 条，但仍完成用于单值字段的扫描。
- JSON-LD：仅 head 中 `type="application/ld+json"` 的**非空** script，最多 5 条；合法 JSON 按 `JSON.stringify` 紧凑输出，非法 JSON 保留 trim 后原文；返回字符串数组，不变成业务 map，也不丢非法项。
- 相关性：`[url,title,description]` 拼接小写，逐 query token 做包含匹配，`hits/tokens.length` 保留 3 位；无 query 不返回分数。`scoreThreshold>0` 时按 `(result.relevanceScore ?? 0) >= threshold` 过滤（失败项与无 query 结果可能被过滤），`threshold=0` 保留失败项。最后 `slice(maxUrls)`，不为补足数量继续抓后续页面。
- 并发：限制 `config.concurrency`，结果按原 URL 输入/发现顺序保存，不按完成顺序 append，不按分数排序；单页失败不阻断其他页面。

## 8. 单项结果与两个入口的返回差异

字段：`url`、`status`（`success`/`failed`）、`httpStatus`、`fetchedAt`、`title`、`description`、`keywords`、`author`、`metaTags`、`openGraph`、`jsonLd`、`relevanceScore`、`error`。

- `metaTags`/`openGraph` 是 `{name,value}` 列表，`jsonLd` 是字符串列表；空时都是 `[]`（不会变成 null）。
- **REST**：可选字段缺省时**省略键**（`*string`/`*int`/`*float64` + `omitempty`），`keywords` 为空数组时保留 `[]`；`fetchedAt` 是 UTC 毫秒 ISO（`Date.toISOString()` 等价）。
- **GraphQL**：按 `toGraphMetadata` 映射，缺省为 `null`；SDL 中 `httpStatus`/`relevanceScore` 是 `Float`、`keywords` 可 `null`。
- 单个网页失败：`{url,status:"failed",error,metaTags:[],openGraph:[],jsonLd:[]}`，**不填**不存在的 `httpStatus`/`fetchedAt`；不把整批变成 500。
- 没有发现 URL 时返回 `[]`（REST `total=0`），不伪造 failed 项。

## 9. 解析器依赖（共享清单条目）

HTML 使用成熟 HTML5 DOM 解析器 `golang.org/x/net/html`（`html.Parse`，与 Cheerio 默认的 parse5 同为 HTML5 树构造），不使用整段正则或严格 XML 解析器冒充 HTML 语义。

`go.mod` / `go.sum` 的 `golang.org/x/net` 条目按仓库既有 **`go-modules-regen` label 远端生成通道**产生：远端 job 执行 `go mod tidy` 并空跑 `go build ./...` 后提交 **`golang.org/x/net v0.55.0`**（提交 `657b1975`，只新增 go.mod 1 行 + go.sum 2 行，未升级其他依赖）。本机未执行 `go get`/`go mod tidy`，未手编 `go.sum`；本批只负责该条目及 tidy 必需关联，不整理/升级/删除 AWS 等并行批次依赖。

该远端 job 的 `go build ./...` 通过是本批全部新增 Go 包在真实依赖清单下的首次编译证据；但它是生成通道的构建，**不替代普通 CI**（单元测试、`go vet`、NestJS 侧门禁仍由普通 CI 决定）。

## 10. 共享文件增量（仅本批语义）

- `apps/api-go/internal/config/config.go`：新增 `CrawlMetadataMode` 类型/字段与 `GraphQLCrawlMetadataMode` 字段、两个 `switch` 解析分支、两处启动校验（HTTP 凭据；GraphQL 父开关依赖）。未改动任何既有变量的默认值。
- `apps/api-go/cmd/api/main.go`：新增模式变量、`WithCrawlMetadata` 规则、无效 DSN 判断分支、`needsCredentialedGo` 项、共享服务实例构造、`wireCrawlMetadata` 调用、GraphQL 注册与日志。保留既有并集，未整段覆盖或重新格式化。
- `infra/docker/.env.sample`、`infra/docker/docker-compose.yml`：各新增两个默认 `legacy` 的变量及说明段。
- 新增文件：`apps/api-go/internal/crawlmetadata/**`、`apps/api-go/internal/graphqlread/crawlmetadata/**`、`apps/api-go/cmd/api/crawl_metadata.go`、`apps/api-go/internal/legacyproxy/crawl_metadata_routes.go`、`apps/api-go/internal/newssources/ssrf_target.go`（**窄导出包装**，不改 `newssources` 既有规则与私有实现）。

## 11. 语义差异（刻意保留的差异都列在这里）

1. **平台网络错误文案**：Node 的 `fetch` 失败报 `fetch failed`（原因在 `cause`）；Go 报 transport 错误原文，例如 `Metadata request failed: dial tcp 1.2.3.4:443: connect: connection refused`。超时同理：Node 是 `AbortError: This operation was aborted`，Go 是 `context deadline exceeded`。失败项与边界一致，文案不同，**没有伪造 Node 文案**。
2. **HTML/XML 解析器**：HTML 用 HTML5 DOM（与 parse5 同构）；sitemap XML 用 `encoding/xml`（宽松模式）按 local name 匹配，fast-xml-parser 对非法实体的容错略宽；解析失败都按“跳过该文档”处理。
3. **URL 规范化**：按 `new URL(...).toString()` 语义实现（小写 scheme/host、去默认端口、空路径补 `/`、去 tab/CR/LF）；与 Node 在极端输入（如畸形 host）上可能有差异，但 REST 入口的 DTO 已在更早处拒绝这些输入。
4. **JSON-LD 字符串化**：实现了 key 插入顺序与 ECMAScript 数字格式（含 `1e-7`、`1e+21`、超精度整数取 float64 精度）；`encoding/json` 的 `U+2028/U+2029` 转义与 JS 略有差异，未引入通用 JS 解释器。
5. **`utf8`/UTF-16**：`MaxLength` 与 pattern 长度按 UTF-16 code unit 计数（对齐 JS `String.length`）。
6. **REST 校验消息**：按 class-validator 的约束插入顺序（源码声明倒序；`IsSafeUrl` 异步所以在同字段最后）与 `"; "` 拼接复刻；ValidationPipe 会为同一字段产出多条消息，Go 侧同样逐条产出。REST `Content-Type` 非 `application/json` 时按空对象处理（Express 行为）；非法 JSON 文本对齐 body-parser 文案。

## 12. 未在真实环境验证的外部行为

本机未安装依赖、未运行 build/test、未启动 Docker/服务、未做真实站点抓取。因此**以下都没有实测证据**：

- 真实公网 robots.txt / sitemap（含 `.gz`、嵌套 sitemapindex、超大站点）的抓取结果与字段质量；
- 真实站点的 `ETag`/`Last-Modified`/304 行为与 Redis 共享缓存的跨运行时复用（NestJS 写入、Go 读取，以及反向）；
- 真实重定向链（跨主机、相对 Location、压缩传输）与真实 DNS 解析（含 CDN 多 A 记录）下的逐跳校验表现；
- 生产公网网络错误的具体文案；
- 真实 HTML 页面（含 SPA、超大 head、异常 JSON-LD）的解析结果。

普通 CI 只覆盖单元测试与静态检查，**不能**据此推断真实外调成功。

## 13. 给规划窗口回填的事实

- 任务：CRAWL-METADATA-001。分支 `refactor/go-crawl-metadata`，worktree `/Users/oo/project/newwei-go-crawl-metadata`，基线 `origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29`。
- 两个入口均已实现并接线，默认 `legacy`；HTTP 与 GraphQL 开关互相独立、共享服务实例。
- `crawl` 域 HTTP 清单中 `POST /api/crawl-tasks/metadata` 由“Nest；尚未接管”变为“WithCrawlMetadata”；GraphQL root 清单中 `Query crawlMetadata` 由“Nest；未注册”变为 `graphqlread/crawlmetadata.Register`（`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_CRAWL_METADATA_MODE`）。
- 依赖：新增 `golang.org/x/net`（HTML5 解析），由远端 `go-modules-regen` 通道生成清单。
- 未合并前只能说 `pr_open`；**不**提前把整个采集域标为迁完：任务创建/删除/重试/导入、Frontier、worker、RSS/list/deep 发现、crawl4ai 队列、媒体/S3、来源 preview 与相邻 GraphQL 读写仍未迁移。
