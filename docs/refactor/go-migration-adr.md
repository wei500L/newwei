# ADR：主后端渐进式迁移 Go（Strangler Fig）

> 状态：已接受 · 2026-09-03 · 适用仓库 newwei @ `edf0c8cf`
> 决策人：重构任务（第一阶段产出）。实现始于 roadmap M2。

---

## 0. 背景与目标

主后端 `apps/api` 为 NestJS 11（770 文件：71 controller / 25 resolver / 6 gateway / 10 processor / 222 service）。迁移动机：单进程承载 REST+GraphQL+WS+队列+cron 导致资源争抢与部署耦合；目标语言 Go 的并发模型与部署形态（静态二进制、低内存、CD 交叉编译）匹配「采集-处理-推送」负载特征。

**目标**：Go 逐步接管 API 网关、鉴权、编排、cron、realtime；**非目标**：重写 Crawl4AI/Akshare/LiteLLM/model-service（保留为独立 HTTP 服务），更换数据库（MySQL/Mongo/Redis/Qdrant/MinIO/ES 一律不动）。

## 1. 决策：Strangler Fig（绞杀者模式），拒绝一次性重写

- 新代码进 `apps/api-go/`，旧 `apps/api` 保持线上运行；反向代理按路由粒度分流
- **每个迁移单元独立可回滚**：代理层一条路由规则回切即回滚，无数据迁移耦合
- 禁止「删旧再补」：Go 侧实现未达契约差分通过前，旧实现不下线
- 迁移期间契约冻结（`api-contract-inventory.md` 为基线）

被否决的方案：
- **大爆炸重写**：770 文件单体无测试保护网（api 0 测试），风险不可控；违反任务红线
- **仅新增功能用 Go（双栈长期并存）**：两套鉴权/队列语义长期漂移，维护成本高于迁移本身
- **Node 内微服务化**：不解决运行时资源问题，反而增加进程数

## 2. 目标架构（apps/api-go/）

```
apps/api-go/
├── cmd/api/main.go              # 入口：装配 + 路由注册 + legacy 路由表
├── internal/
│   ├── platform/                # 横切能力（不含业务）
│   │   ├── httpx/               # 中间件：trace-id、recover、日志、超时
│   │   ├── authn/               # JWT 验签（aud/iss/jti 黑名单）、机器令牌、MFA 中间件
│   │   ├── authz/               # 28 权限点 RBAC、orgId 服务端推导、fail-closed 语义
│   │   ├── config/              # env 加载（对齐 env.schema.ts 的 Zod 语义）
│   │   ├── mysql/  mongo/  redis/  # 连接池（复用既有库，不加 schema 变更）
│   │   └── observability/       # 指标、异常事件 side-channel（对齐 REST/GraphQL 错误结构）
│   ├── domains/<bounded-context>/   # 按限界上下文（auth、items、alerts…），禁止横向 import
│   └── legacyproxy/             # 未迁移路由的反向代理（默认全量兜底）
├── migrations/README.md         # 空目录占位：Phase 1 禁止任何 DB schema 变更
└── tests/contract/              # 契约差分测试（Go 实现vs NestJS 双发比对）
```

- Web 框架：**标准库 net/http + chi**（或纯 165 路由表自实现——以最小依赖为原则决策）；不引入 Nest 风格 DI 容器，用显式构造函数
- 路由模式：`legacy | shadow | canary | go` 四态（见 §4）
- BullMQ：**最后迁移**，且不手工复刻其内部语义（见 §5）

## 3. 迁移顺序（依赖倒排，低风险先行）

| 序 | 单元 | 理由 |
|---|---|---|
| 0 | 骨架 + legacyproxy 全量兜底 + 契约快照/差分框架 | 先立保护网再动刀 |
| 1 | **vector 服务 Go 重写（试点）** | 独立部署、3 端点、无队列无 DB——验证 Go 出包/部署/回滚全链路；顺带修 SEC-02（orgId 推导）与 SEC-04（常量时间比较） |
| 2 | 低副作用只读端点：health、public-portal、dashboard/stats 类 | 无写入，差分失败零数据风险 |
| 3 | 用户偏好 CRUD（user-settings/user-digest/subscriptions） | 单租户、幂等、写入面小 |
| 4 | GraphQL 层（gqlgen 或自研执行器，消费冻结 SDL） | 复杂度高峰，放在保护网成熟后 |
| 5 | Auth/Org/RBAC | 最高风险：JWT/MFA/OIDC/refresh 轮换/机器令牌语义逐项对齐（鉴权矩阵驱动） |
| 6 | crawl 编排、news-pipeline、scheduler、BullMQ、WebSocket | 最后：见 §5 边界 |

## 4. 流量切换与回滚

- 入口代理（web 的 NEXT_PUBLIC_API_BASE_URL 指向处，或独立 nginx/网关）维护路由表：默认 `legacy`
- **shadow**：请求仍由 NestJS 执行，异步复制到 Go 实现比对（差分日志，不影响响应）
- **canary**：按 orgId 哈希小比例切真实流量到 Go
- **go**：全量；NestJS 对应路由保留 ≥2 个发布周期后摘除
- 回滚 = 路由表改回 legacy（配置变更，无代码回滚）；canary 期任一契约差分失败自动回切

## 5. 队列/cron/outbox 边界（红线）

- 全部 BullMQ 队列、21 个 @Cron/@Interval、3 套 MongoOutbox 的**写入权在最终阶段前仅属 NestJS**——Go 侧提前双写会制造消息重复/顺序破坏
- Go 接管队列时**重新实现的是「行为契约」**（job name、重试语义、DLQ 效果、repeat 间隔），不是 BullMQ 内部数据结构；旧队列内积压任务排空后才切换 worker
- 三个非标准语义必须在对齐清单中显式覆盖：DLQ 在 worker failed 事件入队（`queue.processor.ts:281-334`）、itemPipeline 结果缺失时同步触发抓取（`news-pipeline-crawl-bridge.service.ts:185-188`）、CrawlTaskJanitor 直改状态
- GraphQL Subscription 进程内 PubSub → Go 侧统一 Redis pub/sub（多实例语义变更，需在切换公告中明示）

## 6. 契约与安全保护网（迁移的门禁）

1. OpenAPI + SDL 快照差分（CI）
2. 鉴权矩阵：369 端点 × {匿名, 无权限 JWT, 有权限 JWT, 错 org} 四态断言（含 403 `PERMISSION_METADATA_MISSING` fail-closed 语义）
3. 错误结构逐字段比对（statusCode/message/code/traceId/extensions.appCode——REST 与 GraphQL 两套）
4. orgId **一律服务端推导**（membership 重推导），请求体 orgId 仅作展示——SEC-01/02 的教训写进 Go 侧 code review checklist
5. 性能基线：每单元迁移前后 P95/P99 对比（shadow 期采集）

## 7. 后果与风险登记

- **正面**：部署解耦（编排类负载可独立扩缩容）；单路由渐进降险；契约保护网同时服务前端重构
- **负面/成本**：双栈并存期（预计 6–10 个里程碑）review/CI 复杂度上升；NestJS 侧冻结期新功能排期受影响
- **风险**：① JWT/MFA 语义细节差导致会话失效（缓解：鉴权矩阵 + canary 按 org 灰度）；② BullMQ 行为差异导致任务丢失/重复（缓解：排空切换 + 行为清单）；③ GraphQL 错误 extensions 形状漂移（缓解：快照差分覆盖错误路径）
- **退出条件（放弃迁移的预案）**：若连续 2 个里程碑契约差分无法收敛或回滚次数 >3，冻结 Go 侧范围，已迁移的只读/低风险单元保留，其余回到 NestJS 演进——本 ADR 不构成「必须迁完」的承诺
