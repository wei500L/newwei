-- CreateTable
CREATE TABLE `NewsIndicatorAssociation` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `scopeType` ENUM('entity', 'topic') NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
    `scopeKeyType` VARCHAR(191) NOT NULL DEFAULT '',
    `featureMetric` ENUM('volume', 'avg_score', 'negative_ratio') NOT NULL,
    `indicatorItemId` VARCHAR(191) NOT NULL,
    `windowDays` INT NOT NULL,
    `lagDays` INT NOT NULL,
    `correlation` DOUBLE NOT NULL,
    `pValue` DOUBLE NULL,
    `sampleSize` INT NOT NULL,
    `analyzedStartAt` DATETIME(3) NOT NULL,
    `analyzedEndAt` DATETIME(3) NOT NULL,
    `metadata` JSON NULL,
    `lastEvaluatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NewsIndicatorAssociation_orgId_scopeType_scopeKey_scopeKeyType_featureMetric_indicatorItemId_key`(`orgId`, `scopeType`, `scopeKey`, `scopeKeyType`, `featureMetric`, `indicatorItemId`),
    INDEX `NewsIndicatorAssociation_orgId_indicatorItemId_lastEvaluatedAt_idx`(`orgId`, `indicatorItemId`, `lastEvaluatedAt`),
    INDEX `NewsIndicatorAssociation_orgId_scopeType_scopeKey_lastEvaluatedAt_idx`(`orgId`, `scopeType`, `scopeKey`, `lastEvaluatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NewsIndicatorAssociationBacktestRun` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `associationId` VARCHAR(191) NOT NULL,
    `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    `windowStart` DATETIME(3) NOT NULL,
    `windowEnd` DATETIME(3) NOT NULL,
    `config` JSON NULL,
    `metrics` JSON NULL,
    `error` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NewsIndicatorAssociationBacktestRun_associationId_createdAt_idx`(`associationId`, `createdAt`),
    INDEX `NewsIndicatorAssociationBacktestRun_orgId_createdAt_idx`(`orgId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NewsIndicatorAssociation` ADD CONSTRAINT `NewsIndicatorAssociation_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `NewsIndicatorAssociation` ADD CONSTRAINT `NewsIndicatorAssociation_indicatorItemId_fkey` FOREIGN KEY (`indicatorItemId`) REFERENCES `EconomicDataItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NewsIndicatorAssociationBacktestRun` ADD CONSTRAINT `NewsIndicatorAssociationBacktestRun_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `NewsIndicatorAssociationBacktestRun` ADD CONSTRAINT `NewsIndicatorAssociationBacktestRun_associationId_fkey` FOREIGN KEY (`associationId`) REFERENCES `NewsIndicatorAssociation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

