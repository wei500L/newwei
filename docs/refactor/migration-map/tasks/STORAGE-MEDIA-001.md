# STORAGE-MEDIA-001 · 存储诊断与采集媒体交付

## 任务记录

- 状态：in_progress；2026-10-18 开工。规划认领记录（reserved）由 Ready 文档 PR [#71](https://github.com/wei500L/newwei/pull/71) / 分支 `docs/plan-news-event-brief` 发布，尚未合 main；本页在业务分支恢复并更新为自己的任务，未改动 NEWS-BRIEF-001 / ITEMS-LIST-001 / AUTH-LOGIN-001 与 #70 的认领状态。
- 模块：[crawl](../modules/crawl.md)、[infrastructure-data](../modules/infrastructure-data.md)。
- 来源：BL-03/GAP-CRAWL-001，及 BL-15 仅 storage/test 子范围；其他诊断不认领。
- 规划代码基线：`9d0462e16d88d146b8afbf67cdd58d8b7419ff29`（2026-10-18 MSK）。开工时 fetch 后 `origin/main` 仍为该 SHA；main 最近 5 次普通 CI 均 success（最新 [run 39127631691](https://github.com/wei500L/newwei/actions/runs/39127631691)）。
- 编码分支 `refactor/go-storage-media`；worktree `/Users/oo/project/newwei-go-storage-media`，由 `origin/main` 在基线 SHA 创建，创建时工作目录干净、无其他窗口占用。
- 文档发布分支 `docs/plan-news-event-brief`；复用 Ready 规划 PR #71。本页不是业务 PR 记录。
- 本批无部署、无实桶调用、无采集迁移；业务 PR / head / 普通 CI 见[交付记录](#交付记录)。

## 精确范围和已核事实

唯一新增接管：`POST /api/admin/settings/storage/test`，`settings.manage`，默认 201，mode=mysql 真实 SELECT 1 或 s3 的 HeadBucket/PutObject/DeleteObject 及具名 checks。无 platform_admin 额外门槛。独立开关 `API_GO_STORAGE_DIAGNOSTICS_MODE`（空/legacy/go，默认 legacy，非法值启动失败），只接管这一条精确路由及其 CORS 预检。

补齐的剩余实现（均为已有入口，不算新增迁移）：

- `GET /api/crawl-media-assets/:assetId/:mode`：HMAC 授权与 orgId 查询不变，补 S3 presigned 302。
- `GET /api/crawl-tasks/:id`：`crawl.read`，补详情 S3 媒体 URL（preview/download 独立签名）。
- `Query crawlTask(id: ID!, resultLimit: Int = 20, resultSearch: String)`：`crawl.read`，与 REST 同一底层 service 但有独立构造器，已同步注入同一份对象存储能力；保留字段 404 语义与 mediaAssets 字符串 JSON。

基线已读 Nest `storage.service.ts` 的 testConnection/createObjectReadUrl/refreshClient、`storage-settings.service.ts` 配置与缓存、crawl 媒体 controller/service 的签名/交付/toCrawlStoredAsset/`getSignedUrlTtlSeconds`/`buildContentDisposition`、任务 Controller/DTO 与 GraphQL adapter。Go `service_media.go` 原不仅 S3 交付返回 nil，`buildStoredMediaAsset` 也对非 mysql 直接返回无 URL；两处同属缺少 S3 能力，扩充 GAP-CRAWL-001 而不重迁整批。

## 实现边界与复用位置

- 新窄包 `apps/api-go/internal/objectstorage`：`RuntimeConfig`/`ReadURLOptions`、官方 AWS SDK for Go v2 的 S3 client 与 `PresignGetObject`、诊断所需 HeadBucket/PutObject/DeleteObject。配置由 `ConfigReader` 接口注入，objectstorage 不反向依赖设置包（无循环）。
- `infrastructuresettings` 新增 `StorageRuntimeConfig`（复用九键、`storage:settings` 60 秒缓存与回退、明文/加密密钥解密）与 `storage_diagnostics.go`（复用私有 `authorize`，不重迁 7 条配置路由、不改平台管理员写权限）。
- `crawlreadtelemetry` 媒体服务/构造/详情接入；`settingscrawl.Options` 增加 `StorageConfig` 并经 `newCrawlReader` 注入。
- main/config/legacyproxy 只做本批增量：新诊断 mode、精确 HTTP 规则与资源条件、`settingscrawl.Options` 依赖参数、`newInfrastructureSettingsService` 共享配置映射；未删除他人条件，未动 #70 的 GraphQL 顶层接线或简报 newsevents 段。
- 依赖：`go.mod` 现无 AWS SDK；按既有 `ci.yml` 的 `go-modules-regen` label 通道远端生成并固定 go.mod/go.sum，本机不安装/不 build/test。

## 交付记录

- 状态：pr_open（业务 PR 已创建，未合 main）。分支 `refactor/go-storage-media`；首次提交 `a7cba649`（代码+测试+开关/Compose/示例/本记录）。
- 业务 PR：[Ready #73](https://github.com/wei500L/newwei/pull/73)。带 `go-modules-regen` label 由既有 CI job 远端生成 `apps/api-go/go.mod`/`go.sum`；`gh pr create --label` 先建 PR 后加 label，首次 run 的 `pull_request.opened` payload 不含 label，故该 job 在首个 run 中 skipped，需后续 push 触发 `synchronize` 才会运行。生成后正常 fetch + fast-forward 合并机器人提交、移除 label，再以最终 head 的普通 CI 为准。
- 精确 head 与普通 CI：实现最终 head `907d3d4c5cff5dcf33ccb46673ce2c1f7444fb3a`，[run 39135727891](https://github.com/wei500L/newwei/actions/runs/39135727891) success（详见下方「验证证据」；不把 skipped、旧 head 成功或 main 成功当本批通过）。
- 入口与实现落点：新接管 `POST /api/admin/settings/storage/test`（[storage_diagnostics.go](../../../../apps/api-go/internal/infrastructuresettings/storage_diagnostics.go)、[storage_diagnostics_routes.go](../../../../apps/api-go/internal/legacyproxy/storage_diagnostics_routes.go)、[cmd/api/storage_diagnostics.go](../../../../apps/api-go/cmd/api/storage_diagnostics.go)）；S3 交付（[service_media.go](../../../../apps/api-go/internal/crawlreadtelemetry/service_media.go)、[service_media_storage.go](../../../../apps/api-go/internal/crawlreadtelemetry/service_media_storage.go)）；运行配置导出（[storage_runtime.go](../../../../apps/api-go/internal/infrastructuresettings/storage_runtime.go)）；对象存储窄包（[objectstorage](../../../../apps/api-go/internal/objectstorage)）；GraphQL 注入（[settingscrawl/register.go](../../../../apps/api-go/internal/graphqlread/settingscrawl/register.go)）。
- 独立开关：`API_GO_STORAGE_DIAGNOSTICS_MODE`（空/legacy/go，默认 legacy，非法值启动失败），只接管该精确 POST 及 CORS 预检；只要求 JWT_SECRET/DATABASE_URL/REDIS_HOST，不要求 MONGO_URI，也不要求其他接管开关。媒体 REST/详情仍由 `API_GO_CRAWL_READ_TELEMETRY_MODE` 控制，GraphQL 详情仍由 READ + SETTINGS_CRAWL_READ 双父模式控制。
- TTL 与测试对象优化：详情每次只读一份存储配置快照，TTL 由完整快照钳制 30..86400（读失败 300），修正原实现只读 `storage_s3_presigned_url_ttl_seconds` 单键、丢失 `S3_PRESIGNED_URL_TTL_SECONDS` 环境回退；诊断测试对象 key 由固定键改为 `__healthcheck__/` 前缀下每次唯一，delete 只删本次 key。
- 副作用：mode=s3 诊断确实产生一次远端测试对象写入与删除（每次唯一 key，删除失败在 checks 中如实报告）；媒体 GET/presign 不 HEAD、不下载、不新增探测 I/O。无媒体业务写、无迁库、无新审计/outbox/事务、无 worker/队列。
- 未验证外部项（逐条）：未执行真实 S3/MinIO 连通与签名下载、未跑本机 build/test（遵守仓库约束）、未部署、无生产流量；诊断的 `error` 文本对 AWS 异常类名的还原（Go `ErrorCode()` vs JS 异常类名）只在静态契约测试下对齐，未做实桶比对。
- 后续（规划窗口）：本 PR 实际合入 main 后方可关闭 GAP-CRAWL-001、把 BL-03/BL-15.storage/test 标为已交付并更新 main 注册数；#71 合入后本记录需与其中的 reserved 版本取并集（同一文件 add/add）。

## 独立契约审查发现的既有偏差（不在本批范围）

对 HEAD 做了独立静态契约比对（Nest 事实源 vs Go），本批范围内的问题已修（见下），以下为**本批之前既存**、与本批 S3 分支无关的偏差，本批按“不重写任务列表/搜索/结果内容读取”的边界**未修**，登记为后续候选（建议由规划窗口按域页缺口编号登记）：

- REST `GET /api/crawl-tasks/:id` 在无 “complete” task log 时省略 `memoryStats`/`lastRunSummary`，Nest 显式输出 `null`（`model_crawl.go` 的 `omitempty` 同时被列表模式依赖，需拆详情投影结构）。
- `stringPtrFromNull` 把空串当缺省（`alt`/`title`/`desc`/`poster`/`format`，以及任务视图的 `displayName`/`lastCursor`/`lastError`）；Nest 的 `?? undefined` 保留 `""`。
- 媒体路由用 `normalizeAccessScopeValue` 后的 orgId 查库，Nest 用原始 query 值（仅手工构造 `?org=%20abc` 这类填充值时可观察）。
- 长度上限按字节（191）而 Nest 用 UTF-16 码元；`parseInt` 溢出时 Go 返回 “Invalid expires timestamp” 而 Nest 返回 “Signature window too large”（两者都 400）。

本批已修：`publicBaseUrl` 回显改为归一化（去一个末尾斜杠）；DTO-less POST 的请求体语义改为对齐 body-parser（零长度 JSON body = `{}` 通过；顶层非对象/数组按 strict 模式 400；空白体仍是语法错误；超限仍 413）；并把“求值顺序与 Nest 完全一致”的注释改为如实说明 401 先于 400（与既有 7 条配置路由同约定）。

## 验证证据

- Ready 业务 PR：[#73](https://github.com/wei500L/newwei/pull/73)。
- 实现最终 head：`907d3d4c5cff5dcf33ccb46673ce2c1f7444fb3a`（提交链：`a7cba649` 实现 → `7666f79e` 契约对齐 + 地图回写 → `1d5ff672` 远端再生成 go.mod/go.sum → `907d3d4c` 三处测试期望修正）。
- 最终 head 普通 CI：[run 39135727891](https://github.com/wei500L/newwei/actions/runs/39135727891)（event `pull_request`，conclusion **success**）。适用 job：`verify` success（含 `Go modules drift gate (api-go go.mod/go.sum)`、Lint、Typecheck、Web/Vitest、Vector tests、API unit tests + route scanner、OpenAPI 快照确定性与漂移、Auth matrix、GraphQL SDL 漂移、`Go tests (api-go gateway + vector-go pilot)`）、`api-go-user-settings-integration` success、`vector-integration` success；`contract-baseline-regen` skipped（非本批）；`go-modules-regen` skipped（label 已移除，最终 head 恢复漂移门禁 fail-on-drift 语义，同一 run 的漂移门禁通过）。本批新增/修改的 Go 包在该 run 中均 `ok`：`internal/objectstorage`、`internal/infrastructuresettings`、`internal/crawlreadtelemetry`、`internal/graphqlread/settingscrawl`、`internal/legacyproxy`、`internal/config`。
- 依赖生成：`go-modules-regen` job 在 head `7666f79e` 远端 `go mod tidy` + `go build ./...` 成功并提交机器人提交 `1d5ff672`，只新增 `github.com/aws/aws-sdk-go-v2 v1.47.3`、`.../credentials v1.20.9`、`.../service/s3 v1.114.3`、`github.com/aws/smithy-go v1.28.5` 及 8 个间接模块；没有上传 manager、没有其他 AWS 服务。该提交由机器人推送，其 run 初始为 `action_required`，维护者批准后 `verify` 仅因上述三处测试期望失败（已修）；不把这次失败或 label 通道的临时检查当本批通过。
- 首轮 head `a7cba649` 的 [run 39133724820](https://github.com/wei500L/newwei/actions/runs/39133724820) 中 `go-modules-regen` 因 label 在 PR `opened` 事件之后才生效而 skipped，故依赖生成改由后续 `synchronize` 触发；这不是通过证据。
- **未验证外部项**：未执行真实 S3/MinIO 连通与签名下载、未做 mode=s3 实桶三步验证、未部署、无生产流量；本机全程未安装依赖、未运行 build/test/Docker/服务。
