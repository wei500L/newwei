-- CreateTable
CREATE TABLE `CrawlQualityTaskSnapshot` (
    `taskId` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `taskCreatedAt` DATETIME(3) NOT NULL,
    `taskUpdatedAt` DATETIME(3) NOT NULL,
    `rolledAt` DATETIME(3) NOT NULL,
    `lowSignalTaskCount` INTEGER NOT NULL DEFAULT 0,
    `expansionTriggeredTaskCount` INTEGER NOT NULL DEFAULT 0,
    `expansionImprovedTaskCount` INTEGER NOT NULL DEFAULT 0,
    `markdownCount` INTEGER NOT NULL DEFAULT 0,
    `markdownCharsTotal` INTEGER NOT NULL DEFAULT 0,
    `emptyMarkdownCount` INTEGER NOT NULL DEFAULT 0,
    `candidateRejectIncludePatternCount` INTEGER NOT NULL DEFAULT 0,
    `candidateRejectExcludePatternCount` INTEGER NOT NULL DEFAULT 0,
    `candidateRejectPublishConfidenceCount` INTEGER NOT NULL DEFAULT 0,
    `publishConfidenceLt04Count` INTEGER NOT NULL DEFAULT 0,
    `publishConfidenceFrom04To06Count` INTEGER NOT NULL DEFAULT 0,
    `publishConfidenceFrom06To08Count` INTEGER NOT NULL DEFAULT 0,
    `publishConfidenceGte08Count` INTEGER NOT NULL DEFAULT 0,
    `fitMarkdownPreferenceTaskCount` INTEGER NOT NULL DEFAULT 0,
    `headSignalAttemptedCount` INTEGER NOT NULL DEFAULT 0,
    `headSignalSucceededCount` INTEGER NOT NULL DEFAULT 0,
    `headSignalSoftFailureCount` INTEGER NOT NULL DEFAULT 0,
    `headSignalTruncatedCount` INTEGER NOT NULL DEFAULT 0,
    `headSignalNoPublishSignalCount` INTEGER NOT NULL DEFAULT 0,
    `preflightRunCount` INTEGER NOT NULL DEFAULT 0,
    `preflightFailureCount` INTEGER NOT NULL DEFAULT 0,
    `preflight304HitCount` INTEGER NOT NULL DEFAULT 0,
    `dedupeEvaluatedCount` INTEGER NOT NULL DEFAULT 0,
    `dedupeOrgReuseCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`taskId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `CrawlTask_org_createdAt_idx` ON `CrawlTask`(`orgId`, `createdAt`);

-- CreateIndex
CREATE INDEX `CrawlQualityTaskSnapshot_org_created_idx`
  ON `CrawlQualityTaskSnapshot`(`orgId`, `taskCreatedAt`);

-- CreateIndex
CREATE INDEX `CrawlQualityTaskSnapshot_org_source_created_idx`
  ON `CrawlQualityTaskSnapshot`(`orgId`, `sourceId`, `taskCreatedAt`);

-- AddForeignKey
ALTER TABLE `CrawlQualityTaskSnapshot`
  ADD CONSTRAINT `CrawlQualityTaskSnapshot_taskId_fkey`
  FOREIGN KEY (`taskId`) REFERENCES `CrawlTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
