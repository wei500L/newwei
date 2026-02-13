-- Persist crawl media assets in MySQL (blob) or S3 (object key reference).
CREATE TABLE `CrawlMediaAsset` (
  `id` VARCHAR(191) NOT NULL,
  `resultId` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `provider` ENUM('mysql', 's3') NOT NULL DEFAULT 'mysql',
  `kind` VARCHAR(191) NOT NULL,
  `sourceUrl` TEXT NOT NULL,
  `bytes` INTEGER NOT NULL,
  `contentType` VARCHAR(191) NULL,
  `blobData` LONGBLOB NULL,
  `storageKey` VARCHAR(512) NULL,
  `width` INTEGER NULL,
  `height` INTEGER NULL,
  `alt` VARCHAR(191) NULL,
  `title` VARCHAR(191) NULL,
  `desc` TEXT NULL,
  `poster` VARCHAR(512) NULL,
  `format` VARCHAR(191) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `CrawlMediaAsset_orgId_resultId_idx` ON `CrawlMediaAsset`(`orgId`, `resultId`);
CREATE INDEX `CrawlMediaAsset_orgId_taskId_createdAt_idx` ON `CrawlMediaAsset`(`orgId`, `taskId`, `createdAt`);
CREATE INDEX `CrawlMediaAsset_resultId_createdAt_idx` ON `CrawlMediaAsset`(`resultId`, `createdAt`);

ALTER TABLE `CrawlMediaAsset`
  ADD CONSTRAINT `CrawlMediaAsset_resultId_fkey`
  FOREIGN KEY (`resultId`) REFERENCES `CrawlResult`(`id`)
  ON DELETE CASCADE
  ON UPDATE CASCADE;
