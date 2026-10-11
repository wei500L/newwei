// Package analysiscollab 是分析工作台四个域的共享调用面。
//
// 路由（HTTP 开关只决定这些路径进 Go 还是 Nest；内部调用不看开关）：
//
//	API_GO_ANALYSIS_VIEWS_MODE
//	  GET/POST        /api/analysis/views
//	  GET/PATCH/DELETE /api/analysis/views/:id
//	API_GO_ANALYSIS_BOARDS_MODE
//	  GET/POST        /api/analysis/boards
//	  GET/PATCH/DELETE /api/analysis/boards/:boardId
//	  POST            /api/analysis/boards/:boardId/columns
//	  POST            /api/analysis/boards/:boardId/columns/reorder
//	  PATCH/DELETE    /api/analysis/columns/:columnId
//	  POST            /api/analysis/boards/:boardId/tasks
//	  PATCH/DELETE    /api/analysis/tasks/:taskId
//	  POST            /api/analysis/tasks/:taskId/move
//	API_GO_ANALYSIS_THREADS_MODE
//	  GET/PUT         /api/analysis/threads/:subjectType/:subjectId
//	  POST            /api/analysis/threads/:subjectType/:subjectId/comments
//	  PATCH/DELETE    /api/analysis/comments/:commentId
//
// 不接管 POST /api/analysis/exports/{search,items,events}，也不接管 /graphql。
// 不启用 shadow。GET /boards 与 GET /boards/:id 会创建默认看板，不是纯读。
//
// 锁顺序（同一事务、同一连接；Go 与 Nest 用同一条 SELECT ... FOR UPDATE）：
//
//  1. Org 行：没有 active 看板时的默认看板首建，以及「至少留下一个 active 看板」。
//  2. AnalysisBoard 行：列与卡片的结构修改（建列、改列、删列、重排、建卡、改卡、移卡、删卡、改看板、归档该看板）。
//  3. SavedAnalysisView 行：删除视图，以及 saved_view 讨论的写入。
//
// 归档同时锁 Org 再锁看板。任务讨论写入只锁看板。不要先锁看板再锁 Org。
// 不要用进程内 mutex 或 GET_LOCK。锁内重新检查 active、数量、归属和目标。
// item/event 讨论只靠 (orgId, subjectType, subjectId) 唯一约束；只有 1062 才重读胜者。
//
// 包边界：analysisviews、analysisboards、analysistasks、analysisthreads
// 只依赖本包和既有 auth/db。看板与任务互不 import。任务通过 BoardReader
// 取回完整看板。删除视图或任务时，在同一事务里调用 DeleteSubjectThread。
// 主体可读性走 AssertSubjectReadable / LockSubjectForWrite，不要各写一套。
//
// 身份里的 orgId、userId、权限来自鉴权链。canEdit 与评论管理是 owner 或
// users.write，不是 analysis.write。组织共享看板没有 owner 限制。
package analysiscollab
