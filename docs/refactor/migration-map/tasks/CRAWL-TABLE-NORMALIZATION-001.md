# CRAWL-TABLE-NORMALIZATION-001 · 采集表格保存与展示闭环

- 状态：`merged`；2026-11-01 核实 [#155](https://github.com/wei500L/newwei/pull/155) 实际 merge `2e63645d60446d28241ca022ee10caa752a2cb3e`；最终源 head `6da27a40a5520b47f6daba042e4caff56c2d495d` 已是 main 祖先，[源 head 普通 CI 41249733335](https://github.com/wei500L/newwei/actions/runs/41249733335) 三主 job success，两个 regen skipped。此前代码 head `8ef0d031` 的 run 41248815858 亦 success；不再按原 pr_open 重派。
- 最新 main [CI 41286944654](https://github.com/wei500L/newwei/actions/runs/41286944654) 核对时尚未完成，源 head 不替代 merge head；`GAP-CRAWL-TABLES-001` 按本 task 的源码范围关闭，未部署/实网验证。
- 缺口：`GAP-CRAWL-TABLES-001`，对应[采集复核 EX-05](../../review/crawl.md)。这是 Go 上的功能修复，不重做迁移退役。
- 核对基线：main `e04fc4d8bb54596afd302a309ebc852c7676d958`；[普通 CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 三主 job success，两个 regen skipped。开工已 fetch origin/main 并核对开放 PR #149（规划）与 worktree，无本任务业务占用。
- 分支：`codex/fix-crawl-tables`；worktree `/Users/oo/project/newwei-crawl-tables`，从 `e04fc4d8` 创建。未复用其他认领工作树。
- 根因证据：`apps/api-go/internal/crawlexecution/results.go:648`（修复前）直接保存 `entry.Article.Tables`，没有形成读侧与 UI 所需的完整表格模型，也没有合并 `media.tables`。旧实现行为依据固定在 [e72440e1 的 crawl-result.service.ts](https://github.com/wei500L/newwei/blob/e72440e186acbdf671be904cc98d1dd2f9858cbf/apps/api/src/modules/crawl/crawl-result.service.ts#L2166)。
- 产品链：crawl4ai 结果 → 表格归一化 → `crawlresultcontents` → REST `GET /api/crawl-tasks/:id` 与 GraphQL `crawlTask`/`crawlTasks` → 采集详情表格区。

## 交付范围（实现/接线）

- 新增 `apps/api-go/internal/crawltables`：共享具名强类型 `Table`/`DataFrame`/`Record`/`Cell` 及 `NormalizeFromArticle`（顶层 `tables` + `media.tables` 顺序合并、rows/data、表头规则、单元格标量/结构、维度与 dataFrame）、`EncodeBSON`、`FromStored`（历史 raw 读取兼容，规则幂等）。
- `crawlexecution/results.go` `writeResultContent` 写入归一化结果（无表 `null`）；内容 hash、org/task 去重、`$setOnInsert`、媒体写入与入库副作用顺序不变。
- `crawlreadtelemetry` 复用共享模型别名；`crawlResultContentDoc.Tables` 改为 `StoredTable` 并在 `attachResultContent` 用 `FromStored` 投影，orgId 过滤不变；GraphQL `settingscrawl` tables JSON 标量沿用。未改 SDL/接口签名。
- Web `task-detail-results.test.tsx` 增加真实 dataFrame 形状行为断言；未改既有布局/文案/设置。

## 验证

- 本机：仅只读静态检查、`gofmt -l`（干净）、`git diff --check`；**未**运行 go build/test/vet、pnpm、lint/typecheck、Docker 或服务（按任务约束）。
- 测试：`internal/crawltables/tables_test.go`（规则 + BSON 往返幂等 + 历史 raw 升级）；扩展 `TestCrawlExecutionQueuedIntegrationTablesPersist`（命中既有 `-run 'TestCrawlExecutionQueuedIntegration'`：成功写表、未存媒体仍保留 media.tables、二次运行去重不重写、API 投影）；Web `task-detail-results.test.tsx`。
- 普通 CI：代码 head `8ef0d031` 的 [run 41248815858](https://github.com/wei500L/newwei/actions/runs/41248815858) 中 `verify`（lint/typecheck/Web coverage/Go contract gate/Go tests（api-go+vector-go）/build）、`vector-integration`、`api-go-user-settings-integration`（含 `-run 'TestCrawlExecutionQueuedIntegration'` 新增场景）全部 success；两个 regen job skipped。skipped 不算通过，CI fixture 不等于真实 crawl4ai/网站验证。
- 未部署、未调用真实 crawl4ai/外部服务、未做真实站点采集。

## 所有权与并行边界

- 主要修改 `internal/crawlexecution`、新增 `internal/crawltables`、读侧 `internal/crawlreadtelemetry` 表格投影、Web `app/(app)/crawl/[taskId]` 表格行为测试。
- 未改 `cmd/api/main.go`、config、geocoding、态势监控、`.github/workflows/ci.yml` 或共享语言资源；另一窗口 `MONITOR-GEOCODING-001` 不受影响。
- 只更新本 task 与 PR，不改共享 README/GAPS/统计/认领索引；未新增迁移 mode、锁、重试框架、包依赖、批量回填或专用 smoke workflow。
