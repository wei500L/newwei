-- CreateTable
CREATE TABLE `NewsEvent` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `status` ENUM('active', 'archived') NOT NULL DEFAULT 'active',
    `language` VARCHAR(191) NULL,
    `primaryTopic` VARCHAR(191) NULL,
    `primaryEntity` VARCHAR(191) NULL,
    `title` VARCHAR(191) NULL,
    `summary` VARCHAR(191) NULL,
    `startAt` DATETIME(3) NOT NULL,
    `lastAt` DATETIME(3) NOT NULL,
    `representativeProcessedArticleId` VARCHAR(191) NULL,
    `representativeProcessedItemId` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NewsEvent_orgId_lastAt_idx`(`orgId`, `lastAt`),
    INDEX `NewsEvent_orgId_status_lastAt_idx`(`orgId`, `status`, `lastAt`),
    INDEX `NewsEvent_orgId_primaryTopic_lastAt_idx`(`orgId`, `primaryTopic`, `lastAt`),
    INDEX `NewsEvent_orgId_primaryEntity_lastAt_idx`(`orgId`, `primaryEntity`, `lastAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NewsEventItem` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `processedArticleId` VARCHAR(191) NOT NULL,
    `processedItemId` VARCHAR(191) NULL,
    `similarity` DOUBLE NULL,
    `assignedBy` ENUM('vector', 'overlap', 'manual') NOT NULL DEFAULT 'overlap',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `NewsEventItem_orgId_processedArticleId_key`(`orgId`, `processedArticleId`),
    INDEX `NewsEventItem_orgId_eventId_createdAt_idx`(`orgId`, `eventId`, `createdAt`),
    INDEX `NewsEventItem_orgId_processedItemId_idx`(`orgId`, `processedItemId`),
    INDEX `NewsEventItem_eventId_createdAt_idx`(`eventId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NewsEventTimelineEntry` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `bucketStart` DATETIME(3) NOT NULL,
    `title` VARCHAR(191) NULL,
    `summary` VARCHAR(191) NULL,
    `keyPoints` JSON NULL,
    `referencedArticleIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NewsEventTimelineEntry_eventId_bucketStart_key`(`eventId`, `bucketStart`),
    INDEX `NewsEventTimelineEntry_orgId_bucketStart_idx`(`orgId`, `bucketStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NewsEventIngestionState` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `lastProcessedAt` DATETIME(3) NULL,
    `lastProcessedArticleId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NewsEventIngestionState_orgId_key`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NewsEvent` ADD CONSTRAINT `NewsEvent_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `NewsEvent` ADD CONSTRAINT `NewsEvent_representativeProcessedArticleId_fkey` FOREIGN KEY (`representativeProcessedArticleId`) REFERENCES `ProcessedArticle`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NewsEventItem` ADD CONSTRAINT `NewsEventItem_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `NewsEventItem` ADD CONSTRAINT `NewsEventItem_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `NewsEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `NewsEventItem` ADD CONSTRAINT `NewsEventItem_processedArticleId_fkey` FOREIGN KEY (`processedArticleId`) REFERENCES `ProcessedArticle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NewsEventTimelineEntry` ADD CONSTRAINT `NewsEventTimelineEntry_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `NewsEventTimelineEntry` ADD CONSTRAINT `NewsEventTimelineEntry_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `NewsEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NewsEventIngestionState` ADD CONSTRAINT `NewsEventIngestionState_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

