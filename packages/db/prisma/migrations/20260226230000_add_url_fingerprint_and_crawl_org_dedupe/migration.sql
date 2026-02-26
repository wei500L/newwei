-- AlterTable
ALTER TABLE `CrawlResult`
  ADD COLUMN `orgId` VARCHAR(191) NULL,
  ADD COLUMN `sourceUrlFingerprint` VARCHAR(64) NULL;

-- Backfill CrawlResult.orgId from CrawlTask
UPDATE `CrawlResult` AS `cr`
INNER JOIN `CrawlTask` AS `ct`
  ON `ct`.`id` = `cr`.`taskId`
SET `cr`.`orgId` = `ct`.`orgId`
WHERE `cr`.`orgId` IS NULL;

-- Backfill legacy URL fingerprints for existing data
UPDATE `CrawlResult`
SET `sourceUrlFingerprint` = SHA2(`sourceUrl`, 256)
WHERE `sourceUrlFingerprint` IS NULL
  AND `sourceUrl` IS NOT NULL
  AND CHAR_LENGTH(`sourceUrl`) > 0;

-- Enforce non-null after backfill
ALTER TABLE `CrawlResult`
  MODIFY COLUMN `orgId` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `PipelineJob`
  ADD COLUMN `urlFingerprint` VARCHAR(64) NULL;

-- Backfill legacy URL fingerprints for existing jobs
UPDATE `PipelineJob`
SET `urlFingerprint` = SHA2(`url`, 256)
WHERE `urlFingerprint` IS NULL
  AND `url` IS NOT NULL
  AND CHAR_LENGTH(`url`) > 0;

-- AlterTable
ALTER TABLE `Article`
  ADD COLUMN `urlFingerprint` VARCHAR(64) NULL;

-- Backfill legacy URL fingerprints for existing articles
UPDATE `Article`
SET `urlFingerprint` = SHA2(`url`, 256)
WHERE `urlFingerprint` IS NULL
  AND `url` IS NOT NULL
  AND CHAR_LENGTH(`url`) > 0;

-- CreateIndex
CREATE INDEX `CrawlResult_orgId_fetchedAt_idx` ON `CrawlResult`(`orgId`, `fetchedAt`);

-- CreateIndex
CREATE INDEX `CrawlResult_orgId_contentHash_fetchedAt_idx` ON `CrawlResult`(`orgId`, `contentHash`, `fetchedAt`);

-- CreateIndex
CREATE INDEX `CrawlResult_orgId_sourceUrlFingerprint_fetchedAt_idx` ON `CrawlResult`(`orgId`, `sourceUrlFingerprint`, `fetchedAt`);

-- CreateIndex
CREATE INDEX `PipelineJob_sourceId_urlFingerprint_createdAt_idx` ON `PipelineJob`(`sourceId`, `urlFingerprint`, `createdAt`);

-- CreateIndex
CREATE INDEX `Article_orgId_urlFingerprint_crawlAt_idx` ON `Article`(`orgId`, `urlFingerprint`, `crawlAt`);
