-- Align ItemMeta indexes with current Prisma schema and search patterns.
-- 1) Drop the legacy global unique constraint on externalId (multi-tenant safety).
-- 2) Add composite uniqueness scoped to orgId.
-- 3) Add supporting b-tree index for prefix searches.
-- 4) Add FULLTEXT index for boolean-mode search.

DROP INDEX `ItemMeta_externalId_key` ON `ItemMeta`;

CREATE UNIQUE INDEX `ItemMeta_orgId_externalId_key` ON `ItemMeta` (`orgId`, `externalId`);
CREATE INDEX `ItemMeta_orgId_name_idx` ON `ItemMeta` (`orgId`, `name`);
CREATE FULLTEXT INDEX `ItemMeta_name_externalId_idx` ON `ItemMeta` (`name`, `externalId`);
