# Go-批7：个人订阅、行为画像与每日摘要

开工基线是 `origin/main` 的 `146b4b3c1e902419b443f359facab7e5b565cd61`（PR #29 的合并提交）。PR #27、#28、#29 均已在该提交之前合入 main，main CI [38088720394](https://github.com/wei500L/newwei/actions/runs/38088720394) 已成功。本批从该 SHA 新建 `refactor/go-personal-news-workspace`，不沿用旧分支。

生产入口仍是 Web → NestJS。三个开关在 Compose 样例里默认 `legacy`。本批不合并、不开启 auto-merge，也不把流量切到 Go。

## 路由与开关

只精确匹配下列方法和路径。多出来的路径段、未列出的方法继续回落 NestJS。合格 CORS 预检沿用现有 Go 策略。三条开关只决定 HTTP 归属，默认都是 `legacy`。

| 开关 | 方法 | 路径 |
| --- | --- | --- |
| `API_GO_CONTENT_SUBSCRIPTIONS_MODE` | GET | `/api/user-content-subscriptions` |
| 同上 | POST | `/api/user-content-subscriptions/batch-upsert` |
| 同上 | POST | `/api/user-content-subscriptions/batch-delete` |
| 同上 | GET | `/api/user-content-subscriptions/catalog` |
| 同上 | GET | `/api/user-content-subscriptions/recommendations` |
| 同上 | POST | `/api/user-content-subscriptions/catalog/lookup` |
| 同上 | GET | `/api/user-content-subscriptions/related-topics` |
| `API_GO_USER_NEWS_BEHAVIOR_MODE` | POST | `/api/user-news-behavior` |
| 同上 | GET | `/api/user-news-behavior/profile` |
| 同上 | DELETE | `/api/user-news-behavior/profile` |
| `API_GO_USER_DIGEST_MODE` | GET | `/api/user-digest/preference` |
| 同上 | PUT | `/api/user-digest/preference` |
| 同上 | GET | `/api/user-digest/delivery` |
| 同上 | PUT | `/api/user-digest/delivery` |
| 同上 | GET | `/api/user-digest` |

三条都要求 `items.read`。`orgId` / `userId` 只来自 JWT 验签、Redis 撤销名单和 MySQL membership/RBAC。不采信 JWT 里的 permissions，也不接受请求体里的身份字段。`mtk_` 不能访问这些接口。

内部装配不看另外两个 HTTP 开关：

- 订阅 HTTP 为 `go` 时，推荐直接读 Go 画像，即使行为 HTTP 仍是 `legacy`。
- 摘要 HTTP 为 `go` 时，偏好和摘要直接调用 Go 订阅查询、旧偏好迁移和目录刷新，即使订阅 HTTP 仍是 `legacy`。
- 行为 HTTP 单独为 `go` 时不打开 Mongo。订阅或摘要为 `go` 时才要求 `MONGO_URI`。
- Elasticsearch、embedding/rerank 凭据和 SMTP 不是启动条件。

不启用 shadow。目录刷新和旧数据迁移都有副作用，写请求和这些 GET 只由一个实现执行。

回滚时只改对应开关。只把行为切回 `legacy` 不会把订阅或摘要交回 NestJS。Go 写入的 MySQL JSON 与 Redis 值仍由 NestJS 读取，不需要数据格式迁移。

## 模块

| 模块 | 职责 |
| --- | --- |
| `internal/newsbehavior` | 事件权重、UTC 日桶、里程碑去重、七维画像、aggregate 与 similarity snapshot 脏标、清空 |
| `internal/contentsubscriptions` | 五种订阅、批量逐条结果、`GET_LOCK` 上限、旧偏好迁移、监控 ownership 与 reconciliation |
| `internal/contentcatalog` | 目录候选、taxonomy、刷新锁、lookup、推荐与相关主题排序 |
| `internal/llmembed` | 从 `llm_gateway_profiles` 读取 embedding/rerank 活动配置、解密凭据并调用；失败回退关键词/计数排序 |
| `internal/userdigest` | 摘要偏好、事件聚合、情感与指标、投递设置与时区；可选 ES 字面检索，失败回退 Mongo |
| `internal/personalnews` | 三个包之间的单向类型。推荐以参数接收已订阅集合，目录不 import 订阅包 |

邮件 Cron、采集流水线和 GraphQL 仍在 NestJS。Go 只读写 `UserDigestDeliverySchedule`，不发信、不写通知。

## 本轮修过的缺陷

NestJS `batchUpsertSubscriptions` 先数已有行，再 `createMany({ skipDuplicates: true })`。某种订阅已有 49 条时，两个并发请求各加一条不同的值，都会通过检查，最终超过 50。`skipDuplicates` 只防相同值。

Go 在专用连接上对 `ucs:<orgId>:<userId>`（超过 64 字符时改为 `ucs:` + sha256）执行 `GET_LOCK`，锁从计数一直持有到 `INSERT IGNORE`、回读、监控 reconciliation 和最终 counts，然后 `RELEASE_LOCK`。逐条 `limit_reached` 保留。不删除已经超过 50 的历史行。手动监控补回订阅仍可能把该种类推过 50，这是原 reconciliation 契约，不是上限漏洞。

NestJS 定点修复在 `apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.service.ts`：`RepeatableRead` 事务里 `SELECT id ... FOR UPDATE`，再计数和 `createMany`。Prisma 连接池不能把 `GET_LOCK` 钉在同一条连接上跨提交，所以 Nest 用间隙锁。两条实现不会同时处理同一条 HTTP，因此两套锁不必互认。

## 保留的既有语义

- 重复的 `engaged_read` / `deep_read` / `completed_read` 返回 POST 默认 201 和空正文，不返回 `{"recorded":true}`。
- 画像保留 positive、negative、net、时间分段和 meta，不只返回正向 topic。Go Redis 客户端固定 RESP2，这样 `HGETALL` 仍是扁平数组，同分排序和 ioredis 一致。go-redis v9 默认 RESP3 会把同一个命令收成 map，推荐读取画像时会失败。
- 清空会删 legacy hash、窗口内日桶、profile cache，并在同一事务里删除该用户 aggregate/snapshot，再把同组织其他用户的 snapshot 标脏。
- 摘要 `windowEnd` 是当天 UTC 00:00。`loadEvents` 只有 `lastAt >= windowStart`，没有上界。
- 投递时区使用 Go 内置 `time/tzdata`。`nextRunAt` 按请求时区的当地钟点计算，不是固定加 24 小时。Nest dayjs 在 UTC 进程上会冻住参考时刻的偏移；Go 使用 `time.Date` 所在时区。非夏令时切换日两者一致，夏令时切换日可能差一小时。关闭投递时把 `nextRunAt` 和 `lastError` 写成 NULL，不覆盖 `lastStatus` / `lastSentAt`。

## 验证边界

普通 CI 编译并跑已有 Go 测试，包含路由开关互不覆盖的断言。真实栈验收是 `.github/workflows/api-go-personal-news-smoke.yml`，不进普通 CI，用 label `api-go-personal-news-smoke` 或 `workflow_dispatch` 触发。

模型实网调用、可选 Elasticsearch 实网和浏览器点击不在本批验收里。embedding/rerank 代码路径已落地；没有活动凭据时按原逻辑回退，不把空向量当成排序成功。ES 客户端在 `ELASTICSEARCH_ENABLED` 且 node 非空时发出字面检索，失败回退 Mongo。验收工作流关闭 ES，用来源订阅加 MySQL `Article.sourceId` 证明相关内容筛选。
