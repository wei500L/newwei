# api-go —— 主后端 Go 网关（Strangler Fig 骨架）

NestJS `apps/api` 的渐进替代入口。当前行为：**全部流量反向代理到 NestJS**（`LEGACY_API_URL`，默认 `http://localhost:4000`），仅 `/__go/healthz` 由 Go 原生应答（存活探针 + 路由表自省）。

## 运行

```bash
PORT=4020 LEGACY_API_URL=http://localhost:4000 go run ./cmd/api
curl http://localhost:4020/__go/healthz     # {"ok":true,"routes":[...]}
curl http://localhost:4020/api/healthz/live # 代理到 NestJS
```

## 迁移一个路由（四态）

路由表在 `internal/legacyproxy/proxy.go` 的 `DefaultRules()`：把目标前缀的 `ModeLegacy` 改为 `ModeGo` 并 `SetGoHandler` 注册处理器；回滚 = 改回 `ModeLegacy`（单条路由规则，无数据耦合）。`shadow`/`canary` 两态在首个迁移单元落地时实现（见 `docs/refactor/go-migration-adr.md` §4）。

## 验证

```bash
pnpm --filter @modular/api-go test    # 网关行为测试（代理透传/go 路由/502/trace）
pnpm --filter @modular/api-go lint    # go vet
pnpm --filter @modular/api-go build   # go build
```

## 约束

- 纯标准库，不引入 Web 框架（路由表足够小）
- `migrations/` 在 Phase 1 禁止 schema 变更（见该目录 README）
- 契约以 `docs/refactor/api-contract-inventory.md` 为冻结基线
