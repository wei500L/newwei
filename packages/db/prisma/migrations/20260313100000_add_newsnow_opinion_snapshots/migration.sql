-- CreateTable
CREATE TABLE `NewsnowCandidateSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `bucketStart` DATETIME(3) NOT NULL,
    `candidateHash` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `summary` TEXT NULL,
    `themes` JSON NULL,
    `keywords` JSON NULL,
    `entities` JSON NULL,
    `sourceIds` JSON NULL,
    `sourceCount` INTEGER NOT NULL,
    `itemCount` INTEGER NOT NULL,
    `heatScore` DOUBLE NOT NULL,
    `freshnessScore` DOUBLE NOT NULL,
    `candidateScore` DOUBLE NOT NULL,
    `authorityScore` DOUBLE NOT NULL,
    `domesticSourceCount` INTEGER NOT NULL DEFAULT 0,
    `domesticItemCount` INTEGER NOT NULL DEFAULT 0,
    `domesticRatio` DOUBLE NOT NULL DEFAULT 0,
    `isDomestic` BOOLEAN NOT NULL DEFAULT false,
    `sentimentPressure` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NewsnowCandidateSnapshot_org_bucket_hash_uq`(`orgId`, `bucketStart`, `candidateHash`),
    INDEX `NewsnowCandidateSnapshot_org_bucket_idx`(`orgId`, `bucketStart`),
    INDEX `NewsnowCandidateSnapshot_org_bucket_domestic_idx`(`orgId`, `bucketStart`, `isDomestic`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NewsnowDomesticOpinionIndexSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `bucketStart` DATETIME(3) NOT NULL,
    `indexValue` DOUBLE NOT NULL,
    `attentionScore` DOUBLE NOT NULL,
    `breadthScore` DOUBLE NOT NULL,
    `freshnessScore` DOUBLE NOT NULL,
    `sentimentPressure` DOUBLE NOT NULL,
    `candidateCount` INTEGER NOT NULL DEFAULT 0,
    `keywordSummary` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NewsnowDomesticOpinionIndexSnapshot_org_bucket_uq`(`orgId`, `bucketStart`),
    INDEX `NewsnowDomesticOpinionIndexSnapshot_org_bucket_idx`(`orgId`, `bucketStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NewsnowCandidateSnapshot` ADD CONSTRAINT `NewsnowCandidateSnapshot_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NewsnowDomesticOpinionIndexSnapshot` ADD CONSTRAINT `NewsnowDomesticOpinionIndexSnapshot_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
