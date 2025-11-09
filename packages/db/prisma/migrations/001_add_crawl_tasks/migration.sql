-- Add crawl task + result tables for crawl4ai orchestration
CREATE TABLE `CrawlTask` (
  `id` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `createdById` varchar(191) NOT NULL,
  `targetUrl` varchar(512) NOT NULL,
  `displayName` varchar(191) NULL,
  `status` ENUM('pending','queued','running','completed','failed','paused') NOT NULL DEFAULT 'pending',
  `config` json NULL,
  `timeRangeFrom` datetime(3) NULL,
  `timeRangeTo` datetime(3) NULL,
  `concurrency` int NOT NULL DEFAULT 1,
  `keywords` json NULL,
  `lastRunAt` datetime(3) NULL,
  `lastSuccessAt` datetime(3) NULL,
  `lastResultAt` datetime(3) NULL,
  `lastCursor` varchar(191) NULL,
  `lastError` text NULL,
  `runCount` int NOT NULL DEFAULT 0,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `CrawlTask_orgId_idx`(`orgId`),
  INDEX `CrawlTask_status_idx`(`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlResult` (
  `id` varchar(191) NOT NULL,
  `taskId` varchar(191) NOT NULL,
  `sourceUrl` text NOT NULL,
  `fetchedAt` datetime(3) NOT NULL,
  `markdownRef` varchar(191) NOT NULL,
  `contentHash` varchar(191) NOT NULL,
  `metadata` json NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `CrawlResult_taskId_fetchedAt_idx`(`taskId`, `fetchedAt`),
  UNIQUE INDEX `CrawlResult_taskId_contentHash_key`(`taskId`, `contentHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrawlTask`
  ADD CONSTRAINT `CrawlTask_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlTask_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlResult`
  ADD CONSTRAINT `CrawlResult_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `CrawlTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
