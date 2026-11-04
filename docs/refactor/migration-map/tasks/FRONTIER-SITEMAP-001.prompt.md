你在 newwei 的独立编码窗口执行 `FRONTIER-SITEMAP-001`。直接修复 Frontier 站点地图发现的配置与诊断缺失，贯通配置、真实 sitemap 发现、种子/运行诊断落地和 Web 使用，提交并 push，创建 Ready PR；不要停在调查/方案，不合并、不启用 auto-merge。上一批表格修复 #155、监控地理编码 #156 和迁移退役都已合入，不重新派发或恢复 Node 后端。

开工先读仓库 AGENTS.md、`docs/refactor/migration-map/README.md`、`PLANNING.md` 与本 task。fetch 最新 main，检查开放 PR、worktree 与认领；复用匹配的独立工作树，否则创建，分支建议 `codex/fix-frontier-sitemap-discovery`。规划基线 `a8cb0028d38f7237a2586d0d4e5d4571435aebca`；任务记录在 `codex/plan-go-functional-next`，未合 main 时只取本 task/prompt，不合并整条规划分支。刷新精确 main CI，不用旧 head 的成功替代新 head。

已确认事实：

- 采集复核 FN-03 / `GAP-FRONTIER-SITEMAP-001` 仍存在：`internal/crawlfrontiernode/discover.go` 的 discoverSeedNodes 已产生 RequestTimeoutMs/DiscoveryMode，但 discoverSitemapSeeds 只处理 disabled，其余调用 `crawlmetadata.DiscoverSitemapSeedCandidates`，没有传模式/超时；诊断只有 discoveryMode/candidateCount，seedMethod 为空。
- `internal/crawlmetadata/discover_seed.go` 没有相应参数和完整返回。sitemap.go 的默认种子解析固定请求 robots 后回退常用路径；不能只在 Frontier 填几个静态诊断字段。
- 历史依据从 `git show e72440e186acbdf671be904cc98d1dd2f9858cbf:apps/api/src/modules/crawl/crawl-metadata.service.ts` 读取：discoverSitemap（原 243 起）、诊断类型、resolveSitemapSeedUrls（原 2358 起）、sitemap 遍历/解析及条件 HTTP 缓存。旧 Node 源码已删除，不能以当前工作目录缺文件判未实现。

完成以下一条产品链：

1. 在 crawlmetadata 增加合适的具名 sitemap 参数、模式与结果/诊断模型，支持本次 requestTimeoutMs、freshnessCutoffTs、pattern/maxUrls 与 discoveryMode。保留既有 preview、workflow、news-source scheduler 等调用的默认行为和调用面，不强制改这些调用方，不改整个 metadata 服务的共享超时来实现单次覆盖。
2. 实现四种模式的真实历史语义：disabled 完全不抓取；common_paths 跳过 robots；robots 与 sitemap_only 在旧 seed URL helper 中均可先查 robots、无发现时回退常用路径，不能凭 sitemap_only 名字发明“只查一个 XML”规则。保留 seeds 顺序、嵌套 sitemap/去重、时间信号优先级、freshness 与 pattern 过滤、maxUrls，且本次 timeout 真正进入相关 HTTP 请求/取消链路。
3. 从实际执行过程生成完整诊断：discoveryMode、seedMethod、robotsUrl、robotsDiscoveredSitemaps、attemptedSitemaps、fetchedSitemaps、parsedSitemaps、candidateCount。字段空值/空数组、计数时机、缓存命中和失败处理对照旧实现，不把结果条数当解析数、不用请求模式冒充实际 seedMethod。无域名、无结果、disabled、失败等合法分支同样返回准确形状。
4. 将结果接回 discoverSeedNodes / ProcessQueuedNode，使 candidates、seedMethod、sitemapDiagnostics 进入现有节点物化、run/node metadata、workflow 事件/步骤及读取投影。保留 run/node orgId 绑定、状态转换、取消、预算、既有 seed_first/frontier_only/降级策略；不能只测发现 helper 而漏掉持久化和前端所读位置。
5. 核对 Web `app/(app)/admin/ops/crawl-frontier` 的 profile 配置提交与运行/节点诊断展示：用户选模式/请求预算后实际生效，seedMethod 和 sitemap 诊断可见。按实际缺口调整现有类型/投影/展示，补必要行为测试；已有 UI 足够时保留布局，验证其消费真实返回，不新增设置页或无关交互。不要把实现细节塞进用户流程。
6. 用受控 fixture 测四种模式的请求序列、超时/取消、robots 声明与常用路径、嵌套 XML/去重/过滤、诊断和候选的对应关系。现有 crawlmetadata 测试可替换 HTTP 资源；跨包若需测试接缝，只加窄的可注入依赖，保留生产逐跳 SSRF/重定向校验，不开私网白名单、不全局替换 DefaultTransport、不访问公网。
7. 扩展既有 `TestFrontierNode...` 集成场景，至少让非 disabled 的 sitemap 成功结果经过实际种子/metadata 落地及读侧投影。CI 当前注释明确只覆盖 frontier_only/seed_branch_skipped，不得沿用该跳过分支声称已验证 sitemap。使用现有普通 CI 的 `./internal/crawlfrontiernode/ -run 'TestFrontierNode'`；按实际覆盖修正该步骤注释/必要命令，不另建 workflow。可以组合 discovery 层受控 transport 与节点层依赖注入，但实际被替换的层必须说明，不能把 fake 候选冒充真实 XML 抓取验证。

文件所有权与约束：

- 主要修改 `apps/api-go/internal/crawlmetadata`、`internal/crawlfrontiernode` 及必要诊断投影，Web 仅 Frontier 目录。共享的新业务参数/诊断具名强类型；现有扩展 metadata Object/JSON 边界可转换适配，不能用 `any/interface{}/map[string]any/[]any` 承载新增业务模型。
- 另一个窗口 `NEWS-SOURCE-SNAPSHOTS-001` 拥有 newssources/newssourcescheduler、news_sources wiring 和新闻源 Web；这里不触及它们。保留旧 discovery 调用面，避免为了新参数修改 scheduler/discovery.go。这里可做既有 Frontier CI 的必要增量，另一窗口不改 CI。
- 不改 Go main/config、共享语言资源或共享地图/索引/GAPS，只维护本 task 与 PR。发现确需越界时先给具体调用证据并协调，不能覆盖别人的改动；无关脏文件不提交或清理。
- 不新增迁移 mode、锁/重试框架、包依赖、批量回填或无关重构。新增/修改 Go 注释用英文，解释职责、发现顺序、缓存/诊断与必要原因；文档/提交/PR 中文。

验证与交付：

- 本机不安装依赖，不运行 build/test/lint/typecheck/vet/Docker/服务；仅静态检查、diff 检查与必要格式化。执行验证放在现有普通 GitHub Actions CI。
- 纯静态审查并反向复核：类型/JSON/返回契约、模式和超时传递、错误/取消、条件缓存与逐跳 SSRF、orgId/run/node 范围、副作用和所有现有调用点，保留 file:line 证据，参照 `.workflow/reviews/static-audit.md`，修复本范围问题。
- 只 stage 自己的改动，中文 emoji + type(scope) 正常 commit/push，不 amend/rebase/force-push。Ready PR 说明具体失败配置、修复后用户行为、模式语义、兼容范围和测试替换边界。
- 等最终精确 head 的普通 CI，修复本范围失败再正常提交；记录 lint/typecheck、Web coverage、Go 单元和 Frontier 集成实际步骤/结果/链接。skipped 不算通过，不用源 CI 代替 merge CI；不执行已删除 Node vector 命令、不减弱 Go vector 门禁。
- 最终返回 PR、head、普通 CI、静态审查结论与未验证事项，task 回填实际状态。不合并、不部署、不访问真实网站/crawl4ai；fixture 不等于实网验收。
