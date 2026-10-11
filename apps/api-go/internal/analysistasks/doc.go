// Package analysistasks 实现分析任务卡片的创建、更新、删除和移动。
//
// 路由由 main 挂在 /api/analysis/tasks，创建任务的
// POST /api/analysis/boards/{boardId}/tasks 也会进到这里。
// 本包只依赖 analysiscollab 和鉴权，不引用看板、视图或讨论包。
// 移动成功后的完整看板通过 BoardReader.GetBoard 取回。
package analysistasks
