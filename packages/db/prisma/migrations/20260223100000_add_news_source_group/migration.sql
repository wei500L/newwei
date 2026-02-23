-- AlterTable
ALTER TABLE `NewsSource` ADD COLUMN `group` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `NewsSource_orgId_group_idx` ON `NewsSource`(`orgId`, `group`);
