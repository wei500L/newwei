ALTER TABLE `Article`
    ADD INDEX `Article_orgId_crawlAt_idx`(`orgId`, `crawlAt`);

ALTER TABLE `ProcessedArticle`
    ADD COLUMN `orgId` VARCHAR(191) NULL,
    ADD COLUMN `eventAt` DATETIME(3) NULL,
    ADD COLUMN `hasLocation` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `ProcessedArticle`
    ADD CONSTRAINT `ProcessedArticle_orgId_fkey`
        FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX `ProcessedArticle_orgId_status_processedAt_articleId_idx`
    ON `ProcessedArticle`(`orgId`, `status`, `processedAt`, `articleId`);

CREATE INDEX `ProcessedArticle_orgId_status_eventAt_articleId_idx`
    ON `ProcessedArticle`(`orgId`, `status`, `eventAt`, `articleId`);

CREATE INDEX `ProcessedArticle_orgId_status_hasLocation_eventAt_articleId_idx`
    ON `ProcessedArticle`(`orgId`, `status`, `hasLocation`, `eventAt`, `articleId`);

CREATE TABLE `ProcessedArticleTermHourly` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `processedArticleId` VARCHAR(191) NOT NULL,
    `bucketStart` DATETIME(3) NOT NULL,
    `term` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `articleCount` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProcessedArticleTermHourly_processedArticleId_term_source_key`(`processedArticleId`, `term`, `source`),
    INDEX `ProcessedArticleTermHourly_orgId_bucketStart_term_idx`(`orgId`, `bucketStart`, `term`),
    INDEX `ProcessedArticleTermHourly_orgId_bucketStart_source_idx`(`orgId`, `bucketStart`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProcessedArticleTermHourly`
    ADD CONSTRAINT `ProcessedArticleTermHourly_orgId_fkey`
        FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `ProcessedArticleTermHourly_processedArticleId_fkey`
        FOREIGN KEY (`processedArticleId`) REFERENCES `ProcessedArticle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `CrawlMediaBlob` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `bytes` INTEGER NOT NULL,
    `contentType` VARCHAR(191) NULL,
    `blobData` LONGBLOB NOT NULL,
    `refCount` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CrawlMediaBlob_orgId_sha256_key`(`orgId`, `sha256`),
    INDEX `CrawlMediaBlob_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrawlMediaBlob`
    ADD CONSTRAINT `CrawlMediaBlob_orgId_fkey`
        FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlMediaAsset`
    ADD COLUMN `blobId` VARCHAR(191) NULL,
    ADD INDEX `CrawlMediaAsset_blobId_idx`(`blobId`);

ALTER TABLE `CrawlMediaAsset`
    ADD CONSTRAINT `CrawlMediaAsset_blobId_fkey`
        FOREIGN KEY (`blobId`) REFERENCES `CrawlMediaBlob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `EconomicDataItemCategory_categoryId_itemId_idx`
    ON `EconomicDataItemCategory`(`categoryId`, `itemId`);

CREATE INDEX `EconomicDataPoint_itemId_sourceField_recordedAt_idx`
    ON `EconomicDataPoint`(`itemId`, `sourceField`, `recordedAt`);
