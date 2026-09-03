# vector-go 试点部署与回滚（go-pilot profile）

> 2026-09-03 · 本轮（refactor/phase2-sec01-contract-shadow）落地
> 关联：docs/refactor/go-migration-adr.md §4、roadmap M2、bug-ledger SEC-01

---

## 1. 部署形态

`infra/docker/docker-compose.yml` 新增 `vector-go` 服务（**独立 `go-pilot` profile**）：

- 镜像：`infra/docker/vector-go.Dockerfile`（多阶段：golang 构建静态二进制 → distroless nonroot 运行，`USER 65532`，无 shell 无包管理器）
- 端口：宿主 `4011` → 容器 `4010`（与 NestJS vector 的 4010 并存，不冲突）
- 依赖：仅 `qdrant`（与 NestJS vector 共用同一 Qdrant、同一集合命名与 point ID 算法）
- **默认部署不启动**：`docker compose up`（无 profile）只有 NestJS vector；启动试点需 `--profile go-pilot`

## 2. 切换与回滚（无数据迁移耦合）

```
默认（现状）   : api 的 vector 配置 baseUrl → http://vector:4010       （NestJS）
切换到 Go 试点 : api 的 vector 配置 baseUrl → http://vector-go:4010    （环境变量 VECTOR_SERVICE_BASE_URL 或系统设置 PUT，后者仅平台管理员——SEC-01 修复后）
回滚           : baseUrl 指回 http://vector:4010                        （纯配置变更）
```

两侧共用 Qdrant 集合（`{VECTOR_COLLECTION_PREFIX}_{sha256(model)[:16]}`）与确定性 point ID（`sha256("{model}:{processedItemId}")` UUID）——切换前后数据零迁移、可反复来回。

## 3. 健康检查

- NestJS vector：compose healthcheck `curl :4010/healthz`（原有）
- vector-go：distroless 无 curl，容器内不加 healthcheck；由编排/CI 层从宿主网络探测 `:4011/healthz`（`{"ok":true}`，与 NestJS 版响应一致）

## 4. 远端集成验证（本机禁 Docker，全部在 GitHub Actions）

CI `vector-integration` job（`.github/workflows/ci.yml`）：

1. `services.qdrant` 启动真实 Qdrant v1.10.1（与 compose 同版本，health-gated）
2. 构建并启动 NestJS vector（`:4010`）与 vector-go 二进制（`:4012`），共享同一 Qdrant、同一 token、同一 collection prefix
3. 运行 `apps/vector/src/integration/vector-go-diff.test.ts` 契约差分（vitest，`VECTOR_INTEGRATION=1` 时激活；本机默认 skip）

差分覆盖矩阵：

| 维度 | 用例 |
|---|---|
| HTTP 状态码 | 成功/401/400/全路径 |
| NestJS 错误体形状 | `{statusCode, message, error}` 逐字段 |
| json.Number 精度 | createdAtMs > 2^31 回读原值 |
| collection 命名 | `^processed_item_summary_[0-9a-f]{16}$`（注：集成用独立 prefix `integration_processed`） |
| UUID 稳定性 | 相同 (model, processedItemId) 两侧同 upserted/collection |
| orgId filter | 不存在 org → 两侧空 matches |
| wait=true | upsert 同步写语义（两侧实现均带 wait=true，见 vector-go 测试） |
| x-internal-token | 缺 token/错 token 401 同形 |
| trace header | x-trace-id 请求→响应回显 |
| 空数组 | points=[] 跳过 Qdrant |
| 错误输入 | 非 JSON/空 orgId/空 id/limit=0/维度不一致 |
| Qdrant 不可用 | 两侧 5xx 行为（由单测层镜像覆盖；集成 job 中 Qdrant 常在，断网场景不在该 job） |

## 5. 远端集成发现的真实契约事实（run 33743840248 差分结果）

差分测试不是摆设——首跑就暴露了三个此前单测层未发现的契约事实：

1. **POST 成功状态码是 201 而非 200**：NestJS `@Post` 默认 201（upsert 与 search 都是）。
   vector-go 此前返回 200——已对齐为 201（调用方 packages/vector-client 的
   response.ok 检查两者皆可，但契约以 NestJS 为准）。契约清单 §1.2 相应更新。
2. **并发集合创建的 409 竞态**：两侧共用同一 Qdrant 集合命名，首次 upsert 时
   两个实现的 ensureCollection 并发创建同一 collection → 后到者收到 409 并
   抛 500。这是 Strangler Fig 并行部署形态下的**常态**而非异常——两侧实现
   （TS qdrant.service.ts + Go qdrant/client.go）均已补 409 → 重新 GET 校验
   维度的处理。
3. **非 JSON 请求体的 400 message 不逐字对齐**：NestJS 由 Express JSON 解析器
   直接 400（message 为解析器原文，Node 版本相关）；Go 返回稳定的
   'Invalid upsert request'。契约结论：两侧均 400 + 同形状（statusCode/
   message/error 三键）；message 文本差异登记为已知项（部署方不应依赖
   Express 解析器错误文案）。

## 6. 尚未验证项（诚实登记）

- 本机无 Docker：compose `go-pilot` profile 与 Dockerfile **未经本机构建/启动**
- CI 首跑后仍有待验证项以最新 Actions run 为准（409/201 修复后的复跑）
- distroless 镜像在目标部署环境的拉取可达性（`gcr.io/distroless/static-debian12`）——受限网络部署可用 `golang:1.27-alpine` 重打或走内部镜像仓库
