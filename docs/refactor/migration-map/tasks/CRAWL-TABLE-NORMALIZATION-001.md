# CRAWL-TABLE-NORMALIZATION-001 · 采集表格保存与展示闭环

- 状态：`reserved`；2026-11-01 已提供[执行提示词](CRAWL-TABLE-NORMALIZATION-001.prompt.md)，尚无编码 PR/head/CI 证据。
- 缺口：`GAP-CRAWL-TABLES-001`，对应[采集复核 EX-05](../../review/crawl.md)。这是 Go 上的功能修复，不重做迁移退役。
- 核对基线：main `e04fc4d8bb54596afd302a309ebc852c7676d958`；[普通 CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 三主 job success，两个 regen skipped。开工重新 fetch 并检查认领。
- 分支建议：`codex/fix-crawl-tables`；复用匹配的独立工作树，否则创建。当前尚未创建该业务 worktree。
- 根因证据：`apps/api-go/internal/crawlexecution/results.go:648` 直接保存 `entry.Article.Tables`，没有形成读侧与 UI 所需的完整表格模型，也没有合并 `media.tables`。旧实现依据固定在 [e72440e1 的 crawl-result.service.ts](https://github.com/wei500L/newwei/blob/e72440e186acbdf671be904cc98d1dd2f9858cbf/apps/api/src/modules/crawl/crawl-result.service.ts#L2166)，不恢复已删除 Node app。
- 产品链：crawl4ai 结果 → 表格归一化 → `crawlresultcontents` → REST `GET /api/crawl-tasks/:id` 与 GraphQL `crawlTask`/`crawlTasks` → 采集详情表格区。
- 所有权：`internal/crawlexecution`、必要的 `internal/crawl4ai` 表格输入、`internal/crawlreadtelemetry` 与 `internal/graphqlread/settingscrawl` 表格投影、Web `app/(app)/crawl/[taskId]` 的表格组件/行为测试；均位于现有 Go/Web app。可新增采集域内部共用的具名表格模型/归一化文件。
- 并行边界：可与 `MONITOR-GEOCODING-001` 分窗口执行。这里不改 Go main/config/geocoding/态势监控、CI workflow、共享地图/索引或语言资源；如发现确需越界，先记录具体调用证据并协调所有权。

验收重点：顶层 `tables` 与 `media.tables` 顺序合并；`rows`/`data` 两种输入、表头去重/宽度对齐、单元格与元信息、`dataFrame` 生成；规范化 JSON/BSON 能被现有读侧正确解码；REST/GraphQL 与 UI 的 ID、标题、维度、列顺序、值和行预览一致。媒体不落盘时仍提取表格；无表格/无效输入维持既有空值契约。历史规范化数据继续可读，历史 raw 数据读取兼容按实际证据实现，不进行数据库批量回填。

不改变内容 hash、去重、`$setOnInsert`、任务生命周期、媒体下载策略、队列协议、读写鉴权/租户边界或 GraphQL SDL。使用现有普通 CI 的 Go 采集集成和 Web coverage；本机仅静态审查和必要格式化，不安装/运行 build/test/lint/typecheck/vet/Docker/服务。

编码窗口只更新自己的 task 与 PR，交付 Ready PR、精确 head、普通 CI 结果与链接、静态审查 `file:line`、未验证边界。正常提交/push，不合并/auto-merge，不把 CI 的 crawl4ai fixture 当作真实网站采集验证。
