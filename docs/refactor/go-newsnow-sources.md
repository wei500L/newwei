# NewsNow 来源获取与批量刷新 Go 迁移（NEWSNOW-SOURCES-001）

## 范围与结果

本批把 NestJS `NewsAggregatorController` 的两条公开来源路由完整迁入 `apps/api-go`：

| 方法 | 路径 | 成功状态 | 权限 |
|---|---|---|---|
| GET | `/api/news-aggregator/source?id=<id>&latest=<flag>` | 200 | 公开 |
| POST | `/api/news-aggregator/sources/batch?latest=<flag>` | 201 | 公开 |

Go 真实请求上游、解析条目、读写与 Nest 兼容的 fresh/stale 缓存、持有物理刷新锁，并在刷新产生新增条目时向 `newsnow:source-refresh:v1` 发布一次来源增量。NestJS 只在 `API_GO_NEWSNOW_SOURCES_MODE=go` 时订阅该通道，并按本实例已认证 socket 登记的组织经原 dispatcher → gateway → 组织 room 发送既有 `newsnow:update`。

不迁：hottest-analysis、recommended、热点模型/LLM backfill、新闻 pipeline、KG ingestion、通用 WS/Subscription、来源预热与热点分析 Cron、审计补偿。

## 实现结构

新增：

- `apps/api-go/internal/newsnowsources/`
  - `types.go`：`IDValue`（string/number 保留原始形态）、`DateValue`（number/string/null）、`InfoValue`（false/string/缺省）、`IconValue`（false/string/`{url,scale}`/缺省）、`NewsItem`、`SourceResponse`。
  - `service.go`：单源与批量、redirect、缓存、物理锁、轮询、Freebuf 空缓存规则、normalize、worker pool。
  - `store.go`：缓存/锁/relay 的窄 Redis 端口（生产复用 `*redis.Client`）。
  - `fetch.go`：UA、10s 超时、`retry: 3`（4 次尝试）与 ofetch 重试状态码；`$fetch.raw` 的原始 Set-Cookie 读取。
  - `html.go`：`x/net/html` + 受控 CSS 子集（tag/.class/#id/属性/`:nth-child`/`>`），覆盖全部可达选择器。
  - `rss.go`：RSS 2.0 / Atom 字段语义（guid/id、link href、updated/pubDate/created）。
  - `dateparse.go`：`Asia/Shanghai` 显式日期、相对日期与 dayjs 格式化语义。
  - `provider_*.go`：44 个 Nest registry 模块对应的 50 个可达 getter。
  - `handler.go`：参数/`latest`/batch body 校验、200/201、GlobalExceptionFilter 形状。
  - `relay.go`：`version=1` 具名消息。
- `apps/api-go/internal/newsnowclusteringops/registry_port.go`：只读元数据 port（64 项、redirect、interval），不复制来源表、不改生成文件。
- `apps/api-go/internal/infrastructuresettings/runtime_reader.go`：30 秒进程缓存的只读 runtime secret port，复用严格解析与 AES-GCM v1 解密；管理 CRUD 行为不变。
- `apps/api-go/internal/legacyproxy/newsnow_sources_routes.go`：两条精确规则（含 OPTIONS）。
- `apps/api-go/cmd/api/newsnow_sources.go`：wire、CORS、匿名 handler 注册。
- `apps/api/src/modules/news-aggregator/newsnow-source-refresh.subscriber.ts`：来源专用订阅者。

窄增量：

- `cmd/api/main.go`：开关、规则、Redis 需求、无效 DSN 启动失败、wire、关闭顺序。
- `internal/config/config.go`：`API_GO_NEWSNOW_SOURCES_MODE`（空串/legacy/go）。
- `apps/api/src/modules/config/env.schema.ts`：Nest 端同值校验。
- `news-aggregator.module.ts`：注册订阅者。
- compose 的 `api`/`api-go` 注入同一变量，默认 legacy；`.env.sample` 说明。

## 来源覆盖

64 个来源 ID 全部来自 `genSources()` 的 64 项元数据；14 个 redirect 父项在解析后复用目标 getter，50 个可达 getter 覆盖：

v2ex/v2ex-share、zhihu、weibo、zaobao、coolapk、mktnews(-flash)、wallstreetcn(-quick/-news/-hot)、36kr(-quick/-renqi)、douyin、hupu、tieba、toutiao、ithome、thepaper、sputniknewscn、cankaoxiaoxi、pcbeta(-windows11)、cls(-telegraph/-depth/-hot)、xueqiu(-hotstock)、gelonghui、fastbull(-express/-news)、solidot、hackernews、producthunt、github(-trending-today)、bilibili(-hot-search/-hot-video/-ranking)、kuaishou、kaopu、jin10、baidu、nowcoder、sspai、juejin、ifeng、chongbuluo(-latest/-hot)、douban、steam、tencent(-hot)、freebuf、qqvideo(-tv-hotsearch)、iqiyi(-hot-ranklist)。

特殊分支均按源码保留：

- JSON：各 filter/map/sort、广告/置顶过滤、移动链接、数字格式、id 形态。
- HTML：实际选择器、相对 URL、文本/缺字段分支；Baidu 注释 JSON、Ifeng `allData`、Kuaishou Apollo 引用、Jin10 JS 变量仅解析不执行。
- RSS：pcbeta/chongbuluo、RSS/Atom 字段；Freebuf 双 RSSHub 实例 × web/system 并发、任一实例有结果即采用、原生 feed 分类回退、去重与日期排序。
- Cookie：Douyin/Xueqiu 先取 Cookie 再请求；Weibo 三别名 + `WEIBO_COOKIE` 回退。
- 签名：CLS `query→SHA1→MD5`；Coolapk 设备 ID、四舍五入秒、base64/MD5 token 与请求头。
- 编码：Zaobao GB2312（GB18030 解码）。
- 日期：显式 `Asia/Shanghai` 与相对日期；无法解析时保留原字符串（`.valueOf()` 语义），坏日期不伪造当前时间。
- ProductHunt token 四别名、去 Bearer、GraphQL POST。

`normalizeItems` 只过滤 nullish id、空/非字符串 title、空/非字符串 URL、非 http(s) URL，保持顺序并截前 50；id 为数字 0 合法；不做全源去重/标题 trim。

## 缓存、锁与批量

- fresh：`news-aggregator:source:<requestedId>`，TTL `max(1, floor(interval/1000))`。
- stale：`news-aggregator:source:<requestedId>:stale`，TTL 86400s。
- 锁：`lock:news-aggregator:source:<requestedId>:refresh`，`SET NX PX 45000`，token 比较续租/释放；锁竞争先轮询 fresh（200ms × 45s），再 stale，最后 refresh。
- 缓存持久化完整 `SourceResponse`；命中只改返回 `status=cache`。
- Freebuf 空缓存 `updatedTime` 无效或距今 ≥2 分钟时忽略并重试。
- 两次缓存写均成功后才发布增量；写失败使请求失败。
- 批量：最多 10 个 `fetchSource` 的持续 worker pool；任一完成即领取下一项；结果写回原 index；`results`/`errors` 各自保持输入顺序；去重、前 100、`requested/processed` 与部分成功语义不变。

## 实时接缝

Go → Redis `newsnow:source-refresh:v1`：

```json
{"version":1,"refreshId":"...","sourceId":"weibo","newItemsCount":2,
 "topTitles":["..."],"updatedTime":"2026-10-19T12:00:00.000Z","intervalMs":120000}
```

算法与 Nest 原实现一致：previous 缺失/无 items 不发；previous 的 `String(id)` 集合；current 新 id 计数；前 3 个非空 title trim 后截 200；`newItemsCount=0` 不发。

Nest 订阅者：

- 仅 `API_GO_NEWSNOW_SOURCES_MODE=go` 时用 `REDIS_CLIENT.duplicate()` 订阅；初始化失败抛错，不静默就绪；退出先 unsubscribe/quit 专用连接。
- orgId 只来自 `NewsnowActiveSourceRegistryService`（认证 socket 登记），不来自消息。
- Socket.IO Redis adapter 开启：每个 `(refreshId, orgId)` 用 `newsnow:source-refresh:fanout:<refreshId>:<orgId>` `SET NX EX 60` 选出唯一实例；该实例经原 dispatcher 跨实例组织广播。
- adapter 关闭：各实例只做本地组织广播，不做跨实例领取。
- 原 Web 事件字段不变：`orgId/sourceId/newItemsCount/topTitles/updatedTime/intervalMs/timestamp`；内部 `version/refreshId` 不进入 WS。

## 开关与所有权

- 新增 `API_GO_NEWSNOW_SOURCES_MODE`：空串/legacy 默认，go 接管两条 HTTP；非法值 Nest 与 Go 均启动失败。
- Go 仅要求 `DATABASE_URL`、`REDIS_HOST` 与现有 Redis 配置；不强开 JWT/Mongo/GraphQL/模型/旧 ops 开关。
- Nest 预热（每分钟、并发 6、`lock:cron:newsnow-source-warm`）与热点分析（每 10 分钟）继续由 Nest 执行并调用原 `fetchSource`；本批不新增 Go Cron、不接管锁。
- 回滚：把变量改回 legacy，drain 本批在途 HTTP/relay；兼容缓存保留，Nest 预热照常。

## 验证

本机按约束未安装依赖、未运行 build/test/Docker/服务、未读取真实 `.env`、未调用真实站点。已完成：

- `gofmt` 语法/格式检查。
- 静态复核 typed DTO、缺省/null/false、错误过滤器、全局 secret/socket 组织边界、缓存/锁、资源关闭与 #92 公共接线并集。

新增 Go 测试（交普通 CI 执行）：

- `newsnowsources`：参数/201、batch 计数/部分失败/顺序、fresh/stale/Freebuf、锁竞争轮询与 stale、redirect/secret 顺序、worker pool 第 11 项提前启动与峰值 ≤10、relay 载荷、JSON false/icon 对象/数字 id。
- provider fixture：Zhihu JSON、Ithome HTML 广告过滤、Pcbeta RSS、Atom link href、Zaobao GB2312、CLS 签名、Coolapk token、Weibo 环境回退/运行时 secret 覆盖、ProductHunt token 别名与 Bearer、Freebuf 去重排序。
- `infrastructuresettings`：runtime secret 覆盖、解密失败跳过、30 秒缓存、坏文档降级。
- `legacyproxy`：默认 legacy、两路精确规则/OPTIONS、邻近路径隔离、与聚类 ops 开关并存。
- `config`：默认/空串/非法值、DATABASE_URL/REDIS_HOST 要求且不要求 JWT/Mongo。

## 未验证项

- 64 个来源的真实上游可达性、Cookie/token 有效性、Cloudflare/限额。
- MySQL/Redis 实际读写、多实例 relay 与 Socket.IO adapter 跨实例行为。
- 部署与生产流量；本批不实际部署。
