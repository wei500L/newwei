你在 newwei 的独立编码窗口执行 `NEWS-SOURCE-SNAPSHOTS-001`。直接修复新闻源列表缺失运营快照时没有补齐的问题，贯通当前页来源、真实快照聚合/持久化/重读与运维 UI，提交并 push，创建 Ready PR；不要停在调查或方案，不合并、不启用 auto-merge。已完成的表格修复 #155、监控地理编码 #156 和迁移退役不重新实施。

先读仓库 AGENTS.md、`docs/refactor/migration-map/README.md`、`PLANNING.md` 与本 task。fetch 最新 main，检查开放 PR/worktree/认领；复用匹配独立工作树，否则创建，分支建议 `codex/fix-news-source-snapshots`。规划基线 `a8cb0028d38f7237a2586d0d4e5d4571435aebca`；文档在 `codex/plan-go-functional-next`，未合 main 时只取本 task/prompt，不合并整条规划分支。记录实际 main CI，不把前一 head 的成功当作当前通过。

已确认事实与依据：

- 采集复核 NS-02 / `GAP-SOURCE-SNAPSHOTS-001` 仍存在。`internal/newssources/store.go` 的 List 读取当前页和已存快照后直接装配 runtime/空 summary；真实已有任务/文章但没有 NewsSourceOpsSnapshot 的来源因此缺 latestJob/latestCrawlTask/latestArticle 和 24 小时统计。
- `internal/newssourcescheduler/snapshot.go` 已有 RefreshSnapshotForSource / RefreshSnapshotsForSources(ctx, orgID, sourceIDs)，可生成并 upsert 快照；`cmd/api/news_sources.go` 当前只 NewServiceWithRedis，没有注入此能力。只为缺失行补齐，不是每次强制刷新已存在快照。GET 列表保持现有 crawl.read 和 identity.OrgID，不能为读侧补齐追加 crawl.write 或管理员权限。
- 历史依据：`git show e72440e186acbdf671be904cc98d1dd2f9858cbf:apps/api/src/modules/crawl/news-source.service.ts` 的列表装配（原 306–357 附近）以及旧 NewsSourceOpsSnapshotService；固定提交内查实际路径，不恢复 Node。原逻辑先找缺失 IDs，await 刷新，再 orgId-scoped 重读合并，没有把刷新异常吞成成功。
- NS-03 已修：缺快照时仍保留排队/运行/背压等 runtime 计数。此次补齐必须保留这个行为，不能通过改空 summary 把它回退。

完成以下一条产品链：

1. 为 newssources Service 注入具名、窄的快照刷新接口/函数，参数显式包含 orgID 与来源 IDs，复用 scheduler 现有聚合/持久化逻辑，不复制第二套 latest/24h 查询算法，也不让两包反向 import 成环。只对本次分页 SQL 已授权读出的来源建立缺失集合，不能拿用户任意 ID 列表直接刷新。
2. List 按当前页 readSnapshots → 确定缺失 → 调用刷新 → 仅重读缺失行 → 合并已有 summary → 原 runtime/返回装配执行。保留现有筛选/排序、total/page/pageSize 和空值形状；空页无刷新，已有快照不刷新，重复列表不重复生成，有来源但无历史活动时写合法空快照而非虚构任务/文章。
3. 复用 RefreshSnapshotForSource 的 latestJob/latestCrawlTask/latestArticle/stats24h 计算与幂等 upsert。核对聚合 SQL 和 UpsertOpsSnapshot 的 orgId/sourceId 范围，测试包含跨组织/同名来源和缺失来源。补齐前后保留 applyRuntimeStates 的队列、背压与 RSS 自适应值，不以空统计覆盖已修 runtime。
4. 将能力真正接到 `cmd/api/news_sources.go` 的生产 handler。当前 main 在 wireNewsSources 之后才构造 scheduler，不能只在测试注入、生产仍 nil，也不能为补齐重排整段启动或启动 cron/worker。可从既有 DB/Redis 资源构造窄快照能力或复用合适工厂；补齐应在 SCHEDULE_ENABLED/BULLMQ_WORKERS_ENABLED 关闭时仍可完成，且不派发采集、队列作业、外部 HTTP 或 LLM。检查相关构造器调用点并保持原有用途。
5. 处理刷新和重读错误/取消，遵循现有列表及历史明确语义，不吞错误后返回伪造零统计；复用既有 upsert 应对重复读，不新增锁/重试/异步补齐框架。这里不做过期快照更新策略、全库回填或一键重建产品。
6. 核对 Web `app/(app)/admin/ops/news-sources`：缺快照来源第一次列表响应即可显示真实最近任务/文章与 24h 数量/成功率/耗时，同时保留排队/运行/背压展示。按需要修正实际类型/投影/展示，布局足够时保留，补与真实返回一致的组件行为测试；不另造刷新按钮或新设置，也不只测 API mock 被调用。
7. 在既有 scheduler 集成体系用真实 CI MySQL/Redis 覆盖：来源有任务/文章但无快照 → List 同次补齐并返回 → DB 行正确；部分已有快照只补缺失；二次 List 不再刷新；空页不调用；无历史的合法空值；orgId 隔离与 runtime 不回退；刷新/重读失败的错误语义。新增函数命名匹配 `TestNewsSourceSchedulerIntegration...`，当前 CI 用 `./internal/newssourcescheduler/ -run 'TestNewsSourceSchedulerIntegration'`，确保场景实际执行，不创建未被选择的测试文件；规则测试可用窄接口 fake，不假装 fake 已证明 SQL 聚合正确。

所有权与边界：

- 主要修改 `apps/api-go/internal/newssources`、`internal/newssourcescheduler` 的快照能力、`cmd/api/news_sources.go` 与必要的既有构造复用，Web 仅新闻源运维目录。另一窗口 `FRONTIER-SITEMAP-001` 拥有 crawlmetadata/crawlfrontiernode/Frontier UI 与必要 CI 增量；本任务不改这些路径和 `.github/workflows/ci.yml`。不要为 discovery 新参数跟进修改 scheduler/discovery.go，另一个任务须保留其旧调用面。
- main/config/共享语言资源原则上不动；若确有最小接线需求，给具体调用证据并保持其他分支并集，不整体替换。只更新本 task 与 PR，不改共享 README/GAPS/索引或覆盖统计；无关脏文件不提交/清理。
- 新增快照依赖/业务类型具名强类型，不用 `any/interface{}/map[string]any/[]any` 新承载业务数据；现有 List 动态 envelope 不要求顺带全包改造，扩展 JSON 叶子可保留 RawMessage。新增/修改源码注释用英文，文档/提交/PR 中文。
- 不新建迁移 mode、包依赖、数据库表/索引/迁移、专用 workflow 或不必要并发框架。保持鉴权、tenant、已有业务验证和副作用归属；这是缺失快照的功能恢复，不是开启后台调度。

验证与交付：

- 本机不安装依赖，不运行 build/test/lint/typecheck/vet/Docker/服务；仅静态检查、diff 检查与必要格式化，执行验证放到现有普通 GitHub Actions CI。
- 对类型/JSON/API 契约、构造器与生产注入、补齐/重读错误、orgId/sourceId SQL 范围、分页和 runtime 装配做纯静态审查并反向复核，结论有 file:line 证据，参照 `.workflow/reviews/static-audit.md`，修复本范围问题。
- 只 stage 自己的改动，中文 emoji + type(scope) 正常 commit/push，不 amend/rebase/force-push。Ready PR 说明具体缺快照输入、修复后列表/页面行为、刷新范围和错误/副作用边界。
- 等最终精确 head 的普通 CI，修复本范围失败再正常提交；记录 lint/typecheck、Web coverage、Go 单元和 scheduler 集成实际步骤/结果/链接。skipped 不算通过，源 CI 不代替 merge CI；不执行旧 Node vector 命令、不减弱 Go vector 门禁。
- 最终返回 Ready PR、head、普通 CI、静态审查和未验证事项，task 回填实际状态。不合并、不部署、不访问真实外部服务；CI 快照验证不等于生产采集验收。
