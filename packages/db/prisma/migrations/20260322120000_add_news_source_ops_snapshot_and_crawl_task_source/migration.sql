ALTER TABLE `CrawlTask`
  ADD COLUMN `newsSourceId` VARCHAR(191) NULL;

CREATE TABLE `NewsSourceOpsSnapshot` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `sourceId` VARCHAR(191) NOT NULL,
  `latestJob` JSON NULL,
  `latestCrawlTask` JSON NULL,
  `latestArticle` JSON NULL,
  `stats24h` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `NewsSourceOpsSnapshot_sourceId_key`(`sourceId`),
  INDEX `NewsSourceOpsSnapshot_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

UPDATE `CrawlTask`
SET `newsSourceId` = JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.itemPayload.metadata.sourceId'))
WHERE `newsSourceId` IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.itemPayload.metadata.sourceId')) IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.itemPayload.metadata.sourceId')) <> '';

UPDATE `CrawlTask`
SET `newsSourceId` = SUBSTRING_INDEX(SUBSTRING(`displayName`, 12), ':', 1)
WHERE `newsSourceId` IS NULL
  AND `displayName` LIKE 'NewsSource:%:%';

ALTER TABLE `CrawlTask`
  ADD CONSTRAINT `CrawlTask_newsSourceId_fkey`
  FOREIGN KEY (`newsSourceId`) REFERENCES `NewsSource`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `NewsSourceOpsSnapshot`
  ADD CONSTRAINT `NewsSourceOpsSnapshot_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `NewsSourceOpsSnapshot`
  ADD CONSTRAINT `NewsSourceOpsSnapshot_sourceId_fkey`
  FOREIGN KEY (`sourceId`) REFERENCES `NewsSource`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX `CrawlTask_orgId_newsSourceId_status_updatedAt_idx`
  ON `CrawlTask`(`orgId`, `newsSourceId`, `status`, `updatedAt`);
