-- CreateTable
CREATE TABLE `ArticleEntityLink` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `mention` VARCHAR(191) NULL,
    `confidence` DOUBLE NULL,
    `source` ENUM('seed', 'llm', 'derived', 'user') NOT NULL DEFAULT 'llm',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ArticleEntityLink_orgId_articleId_entityId_key`(`orgId`, `articleId`, `entityId`),
    INDEX `ArticleEntityLink_orgId_entityId_createdAt_idx`(`orgId`, `entityId`, `createdAt`),
    INDEX `ArticleEntityLink_orgId_articleId_createdAt_idx`(`orgId`, `articleId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ArticleEntityLink` ADD CONSTRAINT `ArticleEntityLink_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ArticleEntityLink` ADD CONSTRAINT `ArticleEntityLink_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ArticleEntityLink` ADD CONSTRAINT `ArticleEntityLink_entityId_fkey` FOREIGN KEY (`entityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

