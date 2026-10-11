# 分析工作台协作迁入 Go

开工 main：`6fdd4c90b352bc4a3c5f31f9d72fccdd6e6b7687`（PR #30 合并）。

本批把分析工作台里 23 条同步 HTTP 迁到 `apps/api-go`。Web 的 URL、方法、DTO、响应和权限名保持不变。三条导出、GraphQL、Redis 订阅 backplane、分析/助手 worker、采集流水线和邮件 Cron 仍由 NestJS 承担。不能把本批写成“整个 analysis-workspace 已迁完”。

## 路由与开关

三个开关默认都是 `legacy`，只接受 `legacy` 或 `go`。非法值启动失败。Compose 样例与 pilot 都保持 `legacy`。开关只决定 HTTP 进 Go 还是继续代理 NestJS。

| 开关 | 条数 | 路径 |
| --- | --- | --- |
| `API_GO_ANALYSIS_VIEWS_MODE` | 5 | `GET/POST /api/analysis/views`，`GET/PATCH/DELETE /api/analysis/views/:id` |
| `API_GO_ANALYSIS_BOARDS_MODE` | 13 | 看板 5 条、列 4 条、任务 4 条。任务创建是 `POST /api/analysis/boards/:boardId/tasks`，移动是 `POST /api/analysis/tasks/:taskId/move` |
| `API_GO_ANALYSIS_THREADS_MODE` | 5 | `GET/PUT /api/analysis/threads/:subjectType/:subjectId`，`POST .../comments`，`PATCH/DELETE /api/analysis/comments/:commentId` |

动态 ID 恰好一个非空路径段；讨论主体恰好两段。更长路径、其他方法，以及 `POST /api/analysis/exports/{search,items,events}` 仍是 legacy。不启用 shadow。GET 带 `Cache-Control: no-store`。POST 默认 201。

`GET /api/analysis/boards` 和 `GET /api/analysis/boards/:id` 在组织没有未归档看板时创建 `Team board` 和 Backlog / Triage / In progress / Review / Done 五列。这是 `analysis.read` 的既有副作用。

回滚：把对应开关改回 `legacy`。表和 JSON 不迁移，Nest 可以继续读写。导出、GraphQL 和 worker 不随这三个开关变化。

## 权限与内部调用

orgId、userId 和权限来自验签、Redis 撤销检查，以及 MySQL 上的有效用户、组织和 membership 重推导。不信任 body、query 或 JWT 里的权限数组。不额外开放 `mtk_`。

保存视图的 `canEdit`、视图删除和评论编辑/删除是创建者或 `users.write`。`users.write` 不能读取别人的私有视图。组织看板、列和任务没有 owner 限制，只有 `analysis.write` 和组织边界。

看板读取评论计数、删除任务或视图时清理讨论、讨论写入前检查任务或视图，都在 Go 进程内直接查这六张表。不因为另一个 HTTP 开关是 `legacy` 就回调 NestJS。

## 锁

Go 与 Nest 使用同一条 InnoDB 行锁，顺序固定：

1. `Org` 行：没有未归档看板时的默认看板首建，以及“至少留下一块未归档看板”。
2. `AnalysisBoard` 行：列和卡片的结构修改，以及 `analysis_task` 讨论写入。
3. `SavedAnalysisView` 行：删除视图，以及 `saved_view` 讨论写入。

归档先锁组织再锁看板。锁内重新检查未归档状态、数量和归属。事务里的查询走同一连接。item 与 event 的讨论首建只靠 `(orgId, subjectType, subjectId)` 唯一约束；只有 MySQL 1062 才重读胜者。

这次收紧的缺陷：

- 默认看板原先在事务里再查一次就插入，没有跨进程锁。现在两边都先 `SELECT ... FROM Org ... FOR UPDATE`。
- 归档的 count 与 update 原先在普通事务里，不能把两个看板的并发归档串起来。现在先锁组织行。
- 删列的列数和目标列检查原先在事务外。现在在看板行锁内重查后再挪卡、删列、重排。
- 列重排原先用去重集合判断完整性，却按原数组写入，重复 ID 可以穿过。Go 和 Nest 都改成完整、无重复排列。

## 验收与未验证

普通 CI 编译并测试 Go 包。真实栈用 `.github/workflows/api-go-analysis-collaboration-smoke.yml`：真实 MySQL、Redis、Nest 签发的 access token，以及 Go 与 Nest 两个入口。验收只操作隔离的 smoke 用户。

未验证：浏览器点击、生产流量、长期并发压力。上一批模型、检索和 DST 路径不因本批而变成已验证。本批不要求模型服务或新 worker。
