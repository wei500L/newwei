你在 newwei 的独立编码窗口执行 `CRAWL-TABLE-NORMALIZATION-001`。直接完成采集表格从 crawl4ai 到 Mongo、REST/GraphQL、Web 展示的功能修复，提交并 push，创建 Ready PR；不要停在调查/方案，不合并、不启用 auto-merge。已有三个 Go 迁移退役任务全部 merged，不重新迁移或恢复 Node 后端。

先读仓库 AGENTS.md、`docs/refactor/migration-map/README.md`、`PLANNING.md` 和本 task。规划记录与提示词在 `codex/plan-go-cutover-next` / 规划 PR #149；未合入 main 时从该分支只取本 task/提示词，不合并整条规划分支。fetch 最新 main，检查开放 PR、worktree 与认领，匹配任务工作树可复用，否则建独立工作树，分支建议 `codex/fix-crawl-tables`。规划核对基线是 `e04fc4d8bb54596afd302a309ebc852c7676d958`，不能据旧 checkout 判断当前代码。

目标与已确认事实：

- `apps/api-go/internal/crawlexecution/results.go` 的 `writeResultContent` 当前将 `entry.Article.Tables` 直接解码写入 `crawlresultcontents.tables`。复核 EX-05 / `GAP-CRAWL-TABLES-001` 未关闭。
- `internal/crawlreadtelemetry/model_crawl.go` 的 `CrawlResultTable` 与 Web `app/(app)/crawl/[taskId]/task-detail-types.ts` 已期待 `id/caption/headers/rows/rowCount/columnCount/source/metadata/dataFrame`。补完整业务模型，不只在 UI 填默认值掩盖写入缺失。
- 旧实现已删除，行为依据用 `git show e72440e186acbdf671be904cc98d1dd2f9858cbf:apps/api/src/modules/crawl/crawl-result.service.ts`，重点 `normalizeTablesFromResult` 及下游 helper（原 2166–2400 附近）和保存调用点。已合入的新 Go 行为优先；如要纠正旧实现的实际缺陷，给具体输入/前后结果，不无条件照搬或泛化 JS 仿真。

完成以下同一条产品链：

1. 将上游顶层 `tables` 与 `media.tables` 按既有顺序提取并归一化；即使二进制媒体存储关闭也保留表格。支持二维 `rows` 与对象记录 `data`，明确 rows 优先级、空/无效表处理，生成稳定默认 ID、caption/source/metadata、去重表头、按列数截断/补 null 的行、真实维度，以及列顺序一致的 `dataFrame.columns/rows`。对象记录列顺序以输入与历史可观察行为为依据，不能依赖 Go map 遍历顺序。
2. 标量单元格保留 string/number/bool/null，JSON 对象/数组按历史协议成为字符串；表头 trim、截断、默认列与冲突后缀规则对照旧 helper。所有新业务模型具名强类型；动态列名可以用具名 record 类型，扩展元信息/协议 JSON 叶子可用 `json.RawMessage`，禁止用 `any/interface{}/map[string]any/[]any` 承载新增业务数据。
3. 把归一化结果真正接入 Mongo 写入，证明 JSON/BSON 与现有读模型可往返。保持内容 hash、org/task 去重、`$setOnInsert` 幂等、媒体写入与入库副作用顺序。不要通过强制更新已有文档规避去重。
4. 核对 `crawlreadtelemetry` 的结果内容装配、GraphQL `settingscrawl` 的 tables JSON 标量和既有查询返回。规范化历史数据继续可读；若已写入 raw 表导致现有详情不可读/无内容，用同一表格规则做最小读取兼容并加实际样例，不批量改库、不写读时落库。保持鉴权、任务/结果 orgId 范围和无表格 null/空数组语义，不改 SDL 或接口签名。
5. 用真实归一化输出形状贯通 `task-detail-table-model.ts`、`task-detail-tables-section.tsx` 和结果列表：稳定 ID/标题、维度、dataFrame 列顺序和单元格、前五行预览与剩余行数都正确。按需要调整 UI/共享类型；现有 UI 已足够时保留其布局并补行为覆盖，不添加无关交互、文案或新设置。
6. 增加必要的规则测试和链路测试：覆盖 rows/data/media.tables、重复或缺失表头、不齐行、标量/结构单元格、无效/无表格、历史规范化与 raw 样例，以及 Mongo 往返后 API 投影。优先扩展现有 `TestCrawlExecutionQueuedIntegration...`，确保既有 CI 的 `-run 'TestCrawlExecutionQueuedIntegration'` 实际选中新增集成场景；Web 在 `task-detail-results.test.tsx` 等既有体系断言用户看到的结果。不能只测 helper、源码字符串或自造成功返回，也不追求测试数量。

文件所有权与边界：

- 主要修改 `apps/api-go/internal/crawlexecution`，必要时涉及采集输入、读侧/GraphQL 表格投影与 `apps/web/app/(app)/crawl/[taskId]`。共用表格逻辑放在合适的 API 采集域内部，避免把读 handler 包作为写入层的 DTO 依赖。
- 另一个窗口拥有 `MONITOR-GEOCODING-001`。本任务不改 `cmd/api/main.go`、config、geocoding、态势监控、`.github/workflows/ci.yml` 或共享语言资源；采集集成使用现有 CI 选择器。具体阻塞确需越界时先协调，不能覆盖另一个窗口改动。
- 只更新本 task 和 PR，不改共享 README/GAPS/统计/认领索引。无关脏文件视为其他会话工作，不提交或清理。不要增加新迁移 mode、锁、重试框架、包依赖、批量回填或专用 smoke workflow。

验证与交付：

- 本机不安装依赖，不运行 build/test/lint/typecheck/vet/Docker/服务；允许只读静态检查、diff 检查及必要格式化。新增/修改 Go 注释用英文，解释职责、协议与必要原因；文档、提交、PR 用中文。
- 对触及路径做纯静态审查：类型与 JSON/BSON/GraphQL 契约、归一化控制流和错误处理、orgId 读写隔离；结论有 `file:line` 证据并反向复核，可参照 `.workflow/reviews/static-audit.md`。修复本范围发现的问题。
- 只 stage 自己的文件，中文 emoji + `type(scope)` 正常 commit/push，不 amend/rebase/force-push。Ready PR 说明具体失败输入、修复后的用户行为、兼容边界与验证证据。
- 等最终精确 head 的普通 GitHub Actions CI，修复本范围失败再正常提交。必须如实记录 lint/typecheck、Web coverage、Go 相关单元/采集集成等实际步骤与结果；Node vector app 已删除，不执行旧命令、不减弱现有 Go vector 门禁。skipped 不是通过，源 head 不替代 merge head。CI fixture 不等于真实 crawl4ai/网站验证。
- 最终返回 PR 链接、head、普通 CI 链接/结果、静态审查结论、仍未验证事项；task 回填实际状态。源码、CI、真实运行证据分开陈述，不部署、不调用真实外部服务。
