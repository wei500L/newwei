// Package newsbehavior 是 NestJS user-news-behavior 的 Go 生产移植。
//
// HTTP 三条路由（POST /api/user-news-behavior、GET/DELETE
// .../profile）与画像计算、Redis 日桶、MySQL 聚合行和相似度快照
// 脏标记对齐 apps/api/src/modules/user-news-behavior。协同过滤的
// 邻居查询算法不在这里：record 与 clearProfile 的持久化副作用留下，
// 让仍在 NestJS 里的协同推荐能读到新数据。
package newsbehavior
