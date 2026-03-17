CREATE TABLE `CrawlSiteProfile` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `matchHost` VARCHAR(191) NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `executionMode` ENUM('layered', 'native', 'hybrid') NOT NULL DEFAULT 'layered',
  `version` INTEGER NOT NULL DEFAULT 1,
  `config` JSON NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `updatedById` VARCHAR(191) NULL,
  `publishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `CrawlSiteProfile_orgId_name_key`(`orgId`, `name`),
  INDEX `CrawlSiteProfile_orgId_isActive_updatedAt_idx`(`orgId`, `isActive`, `updatedAt`),
  INDEX `CrawlSiteProfile_orgId_matchHost_isActive_idx`(`orgId`, `matchHost`, `isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlSiteProfileVersion` (
  `id` VARCHAR(191) NOT NULL,
  `profileId` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `matchHost` VARCHAR(191) NOT NULL,
  `isActive` BOOLEAN NOT NULL,
  `executionMode` ENUM('layered', 'native', 'hybrid') NOT NULL,
  `config` JSON NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CrawlSiteProfileVersion_profileId_version_key`(`profileId`, `version`),
  INDEX `CrawlSiteProfileVersion_orgId_createdAt_idx`(`orgId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlFrontierRun` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `profileId` VARCHAR(191) NULL,
  `seedUrl` VARCHAR(191) NOT NULL,
  `crawlTaskId` VARCHAR(191) NULL,
  `executionMode` ENUM('layered', 'native', 'hybrid') NOT NULL DEFAULT 'layered',
  `status` ENUM('pending', 'queued', 'running', 'completed', 'failed', 'canceled') NOT NULL DEFAULT 'pending',
  `maxDepth` INTEGER NOT NULL DEFAULT 3,
  `maxPages` INTEGER NOT NULL DEFAULT 60,
  `keywords` JSON NULL,
  `pageCount` INTEGER NOT NULL DEFAULT 0,
  `nodeCount` INTEGER NOT NULL DEFAULT 0,
  `articleCount` INTEGER NOT NULL DEFAULT 0,
  `failedCount` INTEGER NOT NULL DEFAULT 0,
  `duplicateCount` INTEGER NOT NULL DEFAULT 0,
  `nativeRunId` VARCHAR(191) NULL,
  `lastError` TEXT NULL,
  `metadata` JSON NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `CrawlFrontierRun_orgId_status_createdAt_idx`(`orgId`, `status`, `createdAt`),
  INDEX `CrawlFrontierRun_orgId_profileId_createdAt_idx`(`orgId`, `profileId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlFrontierNode` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `parentNodeId` VARCHAR(191) NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `url` VARCHAR(191) NOT NULL,
  `canonicalUrl` VARCHAR(191) NULL,
  `urlFingerprint` VARCHAR(64) NULL,
  `pageType` ENUM('home', 'category', 'list', 'article') NOT NULL,
  `depth` INTEGER NOT NULL,
  `queueClass` ENUM('hot', 'normal') NOT NULL DEFAULT 'normal',
  `status` ENUM('pending', 'queued', 'running', 'completed', 'failed', 'skipped', 'canceled') NOT NULL DEFAULT 'pending',
  `score` DOUBLE NULL,
  `freshnessScore` DOUBLE NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `queuedAt` DATETIME(3) NULL,
  `crawledAt` DATETIME(3) NULL,
  `crawlResultId` VARCHAR(191) NULL,
  `rejectionReason` VARCHAR(191) NULL,
  `lastError` TEXT NULL,
  `metadata` JSON NULL,
  `discoveredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `CrawlFrontierNode_runId_status_depth_idx`(`runId`, `status`, `depth`),
  INDEX `CrawlFrontierNode_orgId_pageType_status_idx`(`orgId`, `pageType`, `status`),
  INDEX `CrawlFrontierNode_runId_urlFingerprint_idx`(`runId`, `urlFingerprint`),
  INDEX `CrawlFrontierNode_runId_parentNodeId_idx`(`runId`, `parentNodeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrawlSiteProfile`
  ADD CONSTRAINT `CrawlSiteProfile_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlSiteProfileVersion`
  ADD CONSTRAINT `CrawlSiteProfileVersion_profileId_fkey`
    FOREIGN KEY (`profileId`) REFERENCES `CrawlSiteProfile`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlFrontierRun`
  ADD CONSTRAINT `CrawlFrontierRun_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlFrontierRun_profileId_fkey`
    FOREIGN KEY (`profileId`) REFERENCES `CrawlSiteProfile`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CrawlFrontierNode`
  ADD CONSTRAINT `CrawlFrontierNode_runId_fkey`
    FOREIGN KEY (`runId`) REFERENCES `CrawlFrontierRun`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlFrontierNode_parentNodeId_fkey`
    FOREIGN KEY (`parentNodeId`) REFERENCES `CrawlFrontierNode`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlFrontierNode_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
