# STORAGE-MEDIA-001 · 存储诊断与采集媒体交付

## 任务记录

- 状态：reserved；2026-10-18 15:58 MSK本次并行提示词交给用户编码窗口，无开工证据。
- 模块：[crawl](../modules/crawl.md)、[infrastructure-data](../modules/infrastructure-data.md)。
- 来源：BL-03/GAP-CRAWL-001，及BL-15仅storage/test子范围；其他诊断不认领。
- 规划代码基线：9d0462e16d88d146b8afbf67cdd58d8b7419ff29。main相对前批未变，最近5次普通CI success。
- [完整执行提示词](STORAGE-MEDIA-001.prompt.md)本次发出；执行器身份/活动未核实。
- 编码分支refactor/go-storage-media；worktree /Users/oo/project/newwei-go-storage-media，尚未创建。
- 文档发布分支docs/plan-news-event-brief；复用[Ready规划PR #71](https://github.com/wei500L/newwei/pull/71)，本批记录提交/推送后可见。不是业务PR。
- 业务PR/Ready/head/merge/业务CI：无。实桶验证、部署、流量：未核实；没有实施迁移。

## 精确范围和已核事实

唯一新增接管：POST /api/admin/settings/storage/test，settings.manage，默认201，mode=mysql真实SELECT1或s3的HeadBucket/PutObject/DeleteObject及具名checks。无platform_admin额外门槛。

剩余实现：

- GET /api/crawl-media-assets/:assetId/:mode：HMAC授权与orgId查询不变，补S3 presigned302。
- GET /api/crawl-tasks/:id：crawl.read，补详情S3媒体URL。
- Query crawlTask(id: ID!, resultLimit: Int = 20, resultSearch: String): CrawlTaskModel：crawl.read，同底层service但有独立构造器，必须同步注入S3能力；保留字段404错误及mediaAssets字符串JSON。

基线已读Nest storage.service.ts/testConnection/createObjectReadUrl/refreshClient；storage-settings.service.ts配置与缓存；crawl-media-asset controller/service的签名/交付/toCrawlStoredAsset；任务Controller/DTO与GraphQLadapter。Go service_media.go不仅S3交付返回nil，buildStoredMediaAsset也对非mysql直接返回无URL；两者同属缺少S3能力，扩充GAP-CRAWL-001而不重迁整批。

复用infrastructuresettings/loadStorageRecords缓存/解密，导出运行配置，新增窄objectstorage包及官方SDK。当前go.mod无AWS SDK；用现有CI go-modules-regen远端生成依赖，不本机安装。诊断每次唯一测试key是明确优化，保留三步执行/响应语义；详情单请求配置快照避免逐资产查库。

## 所有权与开关

NEWS-BRIEF-001继续reserved，排除newsevents/publicportal/llmlogs。#70仍OPEN/Ready adb765d0，排除工作台八写与GraphQL顶层接线/设置13写。

本批允许crawlreadtelemetry媒体与构造、infrastructuresettings运行配置/独立诊断、新objectstorage、settingscrawl.Options依赖注入。共享main/config仅本诊断HTTPmode/资源增量及settingscrawl参数，保留#70和简报并集；碰到同语义段新重叠则先做独立文件，等先行交付后正常merge。

新API_GO_STORAGE_DIAGNOSTICS_MODE空/legacy/go默认legacy，仅诊断HTTP；go独立需DB/JWT/Redis无Mongo，无须强开CRUD/REST/GraphQL。媒体REST沿原CRAWL_READ_TELEMETRY_MODE；GraphQL沿READ+SETTINGS_CRAWL_READ。S3补实现不依赖诊断mode。

没有BullMQ/cron/worker所有权；只诊断会写/删本次S3测试对象，媒体生成URL不下载/HEAD对象。不含头像、上传真实资产、清理Outbox或其余诊断。

## 交接

GAP-CRAWL-001仍开放；注册数/业务实现/main进度不因本规划增加。下一次fetch、刷新所有PR/认领，按完整提示词实施并回写业务PR/head/普通CI/外部验证与实际merge，禁止把规划PR当业务交付。
