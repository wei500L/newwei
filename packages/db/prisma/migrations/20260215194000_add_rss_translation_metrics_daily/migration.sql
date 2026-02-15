-- CreateTable
CREATE TABLE `RssTranslationMetricsDaily` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `targetLanguage` VARCHAR(191) NOT NULL,
    `requestCount` INTEGER NOT NULL DEFAULT 0,
    `itemCount` INTEGER NOT NULL DEFAULT 0,
    `textCount` INTEGER NOT NULL DEFAULT 0,
    `cacheHitCount` INTEGER NOT NULL DEFAULT 0,
    `cacheMissCount` INTEGER NOT NULL DEFAULT 0,
    `translatedCount` INTEGER NOT NULL DEFAULT 0,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `skipTooLongCount` INTEGER NOT NULL DEFAULT 0,
    `totalLatencyMs` INTEGER NOT NULL DEFAULT 0,
    `maxLatencyMs` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RssTransMetricsDaily_org_date_provider_lang_uq`(`orgId`, `date`, `provider`, `targetLanguage`),
    INDEX `RssTranslationMetricsDaily_orgId_date_idx`(`orgId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RssTranslationMetricsDaily` ADD CONSTRAINT `RssTranslationMetricsDaily_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
