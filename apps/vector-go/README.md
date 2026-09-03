# vector-go —— vector 服务的 Go 重写（Strangler Fig 迁移序 1）

`apps/vector`（NestJS Qdrant 适配器）的契约等价 Go 实现。**调用方（`packages/vector-client`）无需任何修改即可切换**——三个端点的请求/响应/错误形状、校验语义、Qdrant 行为（集合命名、确定性 point ID、orgId 过滤）逐条对齐，细节见 `docs/refactor/api-contract-inventory.md` 与源码内逐段注释。

## 与 NestJS 版的差异（有意为之）

- 内部 token 比较改为常量时间（`crypto/subtle`，SEC-04）
- 单二进制部署，纯标准库（无 Nest/Zod 依赖）

## 运行

```bash
VECTOR_INTERNAL_TOKEN=dev-token PORT=4010 go run .
curl http://localhost:4010/healthz                                        # 公开
curl -X POST localhost:4010/v1/search -H 'x-internal-token: dev-token' \
  -d '{"orgId":"o","embeddingModel":"m","vector":[0.1]}'                  # → Qdrant
```

环境变量语义与 `apps/vector/src/modules/config/env.schema.ts` 完全一致（含生产禁用 dev-token 的 fail-closed 规则）。

## 回滚开关

与 NestJS 版可并行部署（不同端口）。上游 `apps/api` 经 vector 服务配置（`VECTOR_SERVICE_URL` / 系统设置）指向其一；**回滚 = baseUrl 指回 NestJS 版**。两侧共用同一 Qdrant 集合命名与 point ID 算法，切换无数据迁移。

## 验证

```bash
pnpm --filter @modular/vector-go test    # 30 个行为测试（镜像 NestJS 11 用例 + Go 侧契约细节）
pnpm --filter @modular/vector-go lint    # go vet
pnpm --filter @modular/vector-go build   # go build
```

## 待办（见 roadmap M2 余项）

Dockerfile + compose `go-pilot` profile 接线、与 NestJS 版的 shadow 差分联调（需 Docker 环境）。
