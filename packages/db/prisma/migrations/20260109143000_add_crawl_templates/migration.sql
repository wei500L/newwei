-- CreateTable
CREATE TABLE `CrawlTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `crawlOptions` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CrawlTemplate_orgId_name_key`(`orgId`, `name`),
    INDEX `CrawlTemplate_orgId_isActive_idx`(`orgId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `NewsSource` ADD COLUMN `crawlTemplateId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `CrawlTemplate` ADD CONSTRAINT `CrawlTemplate_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NewsSource` ADD CONSTRAINT `NewsSource_crawlTemplateId_fkey` FOREIGN KEY (`crawlTemplateId`) REFERENCES `CrawlTemplate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

