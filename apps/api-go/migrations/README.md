# migrations

Phase 1（Strangler Fig 起步阶段）**禁止任何数据库 schema 变更**——Go 实现必须
复用既有 MySQL/MongoDB/Redis/Qdrant/MinIO。与 NestJS 双轨期间的 schema 漂移会让
回滚（路由切回 legacy）直接损坏数据。

当某个限界上下文完成 Go 接管且 NestJS 对应路由摘除后，其后续 schema 演进才允许
出现在本目录（Prisma migration 以 SQL 形式固化，两侧共享同一套迁移历史，
`packages/db/prisma/migrations` 仍是唯一真源——本目录只放 Go 侧需要的
补充说明与验证脚本，不产生第二套迁移）。
