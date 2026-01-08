-- AlterTable
ALTER TABLE `ItemMeta` ADD COLUMN `publishedAt` DATETIME(3) NULL,
    ADD COLUMN `sortAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Backfill sortAt to createdAt for existing rows
UPDATE `ItemMeta` SET `sortAt` = `createdAt`;

-- CreateIndex
CREATE INDEX `ItemMeta_orgId_sortAt_id_idx` ON `ItemMeta`(`orgId`, `sortAt`, `id`);

