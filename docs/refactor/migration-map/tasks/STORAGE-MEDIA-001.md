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

（首次 push 与 Ready PR 创建后回写 PR、精确 head、普通 CI run；实桶/部署未执行项逐条注明。）
