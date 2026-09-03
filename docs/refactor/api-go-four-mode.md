# api-go 四态路由与首个迁移单元（shadow/canary 实现说明）

> 2026-09-03 · 本轮（refactor/phase2-sec01-contract-shadow）落地
> 关联：docs/refactor/go-migration-adr.md §3/§4、roadmap M2

---

## 1. 四态从「类型声明」到可运行实现

`apps/api-go/internal/legacyproxy/proxy.go` 的路由表（`DefaultRules()`）：

| 前缀 | 模式 | 说明 |
|---|---|---|
| `/api/` | legacy | 全量反向代理到 NestJS（事实源） |
| `/api/healthz/live` | **shadow** | 首个迁移单元（见 §3） |
| `/graphql` `/socket.io/` `/docs` `/admin/queues` | legacy | 无 /api 前缀的挂载点分别声明 |
| `/__go/healthz` | go | 网关自省（路由表 + shadow/canary 状态） |

### shadow（`internal/shadow/runner.go`）

- **客户端响应始终来自 NestJS**：网关先代理到上游捕获响应（captureWriter），写回客户端后异步触发差分——主响应不受 Go 侧执行成败/快慢影响。
- **只读白名单**：GET/HEAD/OPTIONS 之外的请求（POST/PUT/PATCH/DELETE）直接跳过差分，**禁止对写请求双发**（`IsShadowableMethod` 双层强制：legacyproxy + shadow runner）。
- **资源预算**（`Budget`，环境变量可调）：单次超时（`SHADOW_TIMEOUT_MS`，默认 2s）、请求体上限（`SHADOW_MAX_BODY_BYTES`，默认 1MiB）、并发上限（`SHADOW_MAX_INFLIGHT`，默认 16）、每分钟令牌桶（`SHADOW_MAX_PER_MINUTE`，默认 600）。任一超限 → 该次差分直接丢弃（不排队、不阻塞）。
- **结构化差异记录**：JSON 行（traceId/method/path/两侧状态码与响应体/diffFields）；`/__go/healthz` 暴露 executed/diffs/dropped/inflight 统计。
- **差分忽略集**（登记制）：`traceId`/`timestamp`/`snapshotAt`/`now`/`generatedAt`/`requestId`——只忽略这些明确登记的非确定字段；扩展需 `RegisterIgnoredField` 且在 PR 说明理由，不允许用它掩盖真实差异。

### canary（`internal/canary/router.go`）

- **稳定一致的路由依据**：Bearer JWT payload 的 `orgId` claim → `sha256("canary-org:"+orgId)` 前 8 字节 big-endian → `[0,100)` 桶位；桶位 < `CANARY_PERCENT` → go，否则 legacy。同一组织永远进同一实现（比例变化只移动边界，不重排组织）。
- **fail-safe**：无 token / 非 JWT（mtk_ 机器令牌）/ payload 无 orgId / 解析失败 → 一律 legacy（未知流量不进新实现）。canary 只读 claim 分流不验签——两侧共享同一鉴权语义，伪造 orgId 不构成提权。
- **比例语义**：`CANARY_PERCENT=0` 等价 legacy（默认）；`100` 等价 go；中间按桶位分流。越界值 clamp。
- **回滚**：`CANARY_PERCENT=0` 或路由表规则改回 `ModeLegacy`——纯配置变更，无代码回滚。
- **canary 命中但未注册 handler**：回退 legacy（不 501 客户端）。

## 2. 首个迁移单元：`GET /api/healthz/live`

- **选择理由**（迁移序 2「低副作用只读端点」）：`@Public()`、无副作用、无依赖（不连 MySQL/Redis/Mongo）——NestJS 实现是纯常量返回（`health.controller.ts:75-84`，刻意不含版本/时间戳防泄露）。
- **Go 实现**（`internal/health/handler.go`）：`{"status":"ok"}`、200、非 GET → 404（NestJS 只注册 GET）。shadow 差分执行者与 canary/go 模式 handler 是**同一实现**——差分通过即切换可信。
- **不是 `/__go/healthz`**：那是网关自省端点，不属于业务迁移；本单元是真实业务端点 `/api/healthz/live` 的契约等价实现。
- **迁移边界**：`GET /api/healthz`（AllowAuthenticated + 7 项真实依赖探针 + 5s 缓存）**未迁移**——需要数据库连接层，属后续单元；NestJS 实现保留为事实源。
- **回滚**：路由表 `/api/healthz/live` 改回 `ModeLegacy`（单行配置）。

## 3. 与鉴权矩阵/契约快照的关系

- 路由扫描器（`apps/api/tools/scan-routes.ts`）同时驱动 OpenAPI 快照与鉴权矩阵——Go 侧后续单元迁移时，以矩阵行为准（orgId 推导/fail-closed/错误形状逐字段对齐）。
- Go 网关自身的测试（`legacyproxy/proxy_test.go`）覆盖四态行为：legacy 透传、shadow 主响应来自上游且写请求不差分、canary 分流与 fail-safe、go 原生处理与 501 fail-closed。

## 4. 尚未验证项（诚实登记）

- shadow 差分「真实流量 0 差异」验收未做（需要真实流量或集成环境；`/api/healthz/live` 的差分已在 CI 单测层验证等价）
- canary 真实分流未在真实部署验证（单测层验证了稳定哈希/回退/比例语义）
- 本机按任务约束未运行 `go test`/`go vet`（vet 误跑过一次见 PR 描述）；全部 Go 测试在远端 CI 执行
