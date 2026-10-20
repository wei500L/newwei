# NEWSNOW-SOURCES-001 · NewsNow来源获取、批量刷新与实时接缝

- 状态pr_open；[Ready PR #94](https://github.com/wei500L/newwei/pull/94)，分支 `refactor/go-newsnow-sources`，worktree `/Users/oo/project/newwei-go-newsnow-sources`，从执行时 `origin/main 91e759b449c4511dc96d86539ea0eb258754d07e` 创建。
- 代码 head `cf25026ff99b26fb3bf2122cd240d4ac4021889a`；普通 CI [39297914942](https://github.com/wei500L/newwei/actions/runs/39297914942) success：verify、vector-integration、api-go-user-settings-integration success，contract-baseline-regen/go-modules-regen skipped。此前 24d491ee/06542a7f 的 Lint/Go tests 失败已由追加提交修复，不用失败 run 充当通过。
- 基线普通CI [39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593) 在精确 head success（verify、vector-integration、api-go-user-settings-integration；两 regen skipped），不是本批实现/真实上游/部署证据。
- 规划 [PR #93](https://github.com/wei500L/newwei/pull/93) 分支 `docs/plan-newsnow-feed`，任务/提示词从该远端分支读取，未覆盖其他地图文件。
- 审计补偿 [PR #92](https://github.com/wei500L/newwei/pull/92) head `28c8f761a2ce4a447080414f154b567648cc6bd1` 保持开放；本批只在其共享 main/config/env/compose 接线旁追加本批增量，不改其业务包、不依赖未合入符号。
- 来源 BL-18 的 source/batch 子链，关联 GAP-LEGACY-001；来源实时接缝受 GAP-ASYNC-001 索引，但不认领通用 WS 或 cron。

## 精确交付

GET `/api/news-aggregator/source?id=<id>&latest=<flag>`（公开，200）与 POST `/api/news-aggregator/sources/batch?latest=<flag>`（公开，201）完整冷获取/强刷。64 个来源 ID、41 个可达来源族全部覆盖；ID 不是 HTTP 计数。包含 JSON/HTML/RSS/GraphQL、前置 Cookie、CLS/Coolapk 签名、GB2312、相对日期、别名 redirect、全局 runtime secret 解密、fresh/stale 缓存/租约和实时 relay。

返回契约：单源 `{status,id,updatedTime,items}`；batch `{requested,processed,results,errors}`；items/results/errors 空值为 `[]`，成功/错误各自保持输入相对顺序；不改成对象映射或 207。

优化：10 项整块 `Promise.allSettled` 改为最多 10 个 `fetchSource` 的持续 worker pool；完成即领取下一项，结果按输入 index 回收；底层 getter 内部并发不变。

## 执行所有权与冲突

新增 `API_GO_NEWSNOW_SOURCES_MODE` 默认 legacy，Nest/Go 空串按 legacy、非法值启动失败；独立公开两路只要求 DATABASE_URL/REDIS_HOST，不强开 JWT/Mongo/旧 ops。新增 `newsnowsources` 业务包与 providers；`newsnowclusteringops` 只加元数据只读 port，`infrastructuresettings` 只加 runtime-reader。Nest 只新增 source-refresh subscriber、module 与 env.schema 增量。

实时：Go 发布 `newsnow:source-refresh:v1`（不含 orgId）；Nest 订阅者按认证 socket 的 ActiveSourceRegistry 选组织；Socket.IO adapter 开启时用 `(refreshId, orgId)` 60 秒 NX 标记避免重复组织广播，关闭时各实例本地广播。原 WS 事件字段不变。

Nest 预热（每分钟、并发 6、`lock:cron:newsnow-source-warm`）与热点分析（每 10 分钟）仍是唯一后台 owner，继续调用原 Nest fetchSource 与兼容缓存/锁；本批不新增 Go Cron、不接管其锁。

## 执行记录

- 2026-10-19：创建 Ready PR #94；代码 head `cf25026f` 普通 CI `39297914942` 全绿（skipped 不计通过）。
- 2026-10-19：完成两路实现、64 ID/50 可达 getter、特殊 provider 分支、兼容缓存/锁、worker pool、relay、Nest subscriber、开关/路由/compose/env 接线与 Go 测试；本机未运行 build/test/Docker/服务，未读取真实 `.env` 或调用真实站点。
- 详细交付与未验证项见 [go-newsnow-sources.md](../../go-newsnow-sources.md)。
- 共享地图由规划窗口集中回填；本文件不关闭整个 GAP-LEGACY-001 或 GAP-ASYNC-001。

- 2026-10-20 本批整合：最终 head `cf25026ff99b26fb3bf2122cd240d4ac4021889a`，普通 CI [39297914942](https://github.com/wei500L/newwei/actions/runs/39297914942) success；随 `integration/merge-open-prs-b92-113` 一次性合并，merged 回填留待后续文档提交。
