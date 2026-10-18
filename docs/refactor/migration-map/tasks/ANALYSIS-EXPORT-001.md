# ANALYSIS-EXPORT-001 · 条目与事件CSV完整导出

本轮占用刷新（2026-10-18）：状态in_progress；目录 `/Users/oo/project/newwei-go-analysis-export` 在90765633，已见analysisexport、itemsreading/csvexport.go、newsevents/export.go及main/config等本批开发，无业务PR。继续占用两导出链与对应端口；后续reserved/未创建为原发出快照，不干预编码对话。

- reserved，2026-10-18；origin/main90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通CI39149114456成功；[完整提示词](ANALYSIS-EXPORT-001.prompt.md)，认领复用规划#80发布。
- refactor/go-analysis-export；/Users/oo/project/newwei-go-analysis-export，规划时未创建。精确POST /api/analysis/exports/items、/events，analysis.write，成功201/text-csv附件；queryString可选/null、字符串<=4000，最多5000行。
- 两入口业务工作量集中在完整time/相关性/个性化选择、5000内部端口、Mongo/SQL字段批量联查、事件热度/可信度/强制权威来源与去重。search整路因headlines归档准备依赖留Nest，不领取归档、采集生命周期或worker；不凑无关入口。

## 已核事实与优化

读两Controller/DTO与AnalysisWorkspaceService全部items/events构造、参数/排序/去重/CSV助手；Nest ItemsService→ItemsListService.list(maxPageSize)与rerank错误、NewsEvents热度/权威/来源策略；对照Go itemsreading.List/ListItems页分支/画像/rerank日志/store、newsevents私有聚合/排序去重、analysiscollab规范化和认证范围。候选Nest导出相对3cedce9a至当前main无变化。

现有ListItems固定50且REST List不含完整排序，需窄ListForExport端口，不能改交互上限或循环50条重复rerank。Mutation/事件Query默认100/300候选不能套导出5000；events在5000候选后过滤/去重，不额外补采。直接导出不写审计，不新增任务/Outbox；复用搜索可真实ES/vector/embedding/rerank并写既有rerank日志。

具体优化：按已保留事件建立token倒排索引，缩小精确Jaccard/5天时间OR比较集合，保持贪心结果/0.74边界/保留顺序；比较参考算法id序列。CSV避免构造整份大字符串，数据错误仍先于响应头。

## 依赖、所有权与排除

新analysisexport/wire/精确路由、itemsreading export窄端口、newsevents export窄端口，独立API_GO_ANALYSIS_EXPORT_MODE默认legacy，JWT/MySQL/Redis/Mongo；独立Personalization与资源初始化，不依赖旧读/协作/GraphQL开关。

网关Ready #81 head0901ca15核心profiles/日志/wire不碰；来源策略在独立worktree开发，policy/register/写端与GAP-GQL-001补线不碰；OIDC-LOGIN-001 reserved保持占用。只对共同main/config/env/compose自己的语义增量保留并集。真实外部与生产导出未验证，编码窗口仅业务/PR说明，规划窗口集中回填地图。

本窗口不实施业务、不创建业务worktree，不重建地图。采集生命周期仅作候选准入阅读，未认领其入队/入库/清理范围，不据本任务声称BullMQ已迁移。
