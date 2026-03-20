ALTER TABLE `CrawlSiteProfile`
  ADD COLUMN `workflowId` VARCHAR(191) NULL,
  ADD COLUMN `workflowVersionId` VARCHAR(191) NULL,
  ADD COLUMN `workflowBindingMode` ENUM('published', 'pinned') NOT NULL DEFAULT 'published',
  ADD INDEX `CrawlSiteProfile_orgId_workflowId_updatedAt_idx`(`orgId`, `workflowId`, `updatedAt`);

ALTER TABLE `CrawlSiteProfileVersion`
  ADD COLUMN `workflowId` VARCHAR(191) NULL,
  ADD COLUMN `workflowVersionId` VARCHAR(191) NULL,
  ADD COLUMN `workflowBindingMode` ENUM('published', 'pinned') NOT NULL DEFAULT 'published';

CREATE TABLE `CrawlStrategyWorkflow` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `draftDefinition` JSON NOT NULL,
  `publishedVersionId` VARCHAR(191) NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `updatedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `CrawlStrategyWorkflow_orgId_name_key`(`orgId`, `name`),
  INDEX `CrawlStrategyWorkflow_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlStrategyWorkflowVersion` (
  `id` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `definition` JSON NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CrawlStrategyWorkflowVersion_workflowId_version_key`(`workflowId`, `version`),
  INDEX `CrawlStrategyWorkflowVersion_orgId_createdAt_idx`(`orgId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlStrategyWorkflowRun` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `workflowVersionId` VARCHAR(191) NOT NULL,
  `profileId` VARCHAR(191) NULL,
  `newsSourceId` VARCHAR(191) NULL,
  `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `runKind` VARCHAR(191) NOT NULL DEFAULT 'trial',
  `input` JSON NULL,
  `output` JSON NULL,
  `graphSnapshot` JSON NULL,
  `stepResults` JSON NULL,
  `candidates` JSON NULL,
  `parameterSources` JSON NULL,
  `error` TEXT NULL,
  `stepCount` INTEGER NOT NULL DEFAULT 0,
  `candidateCount` INTEGER NOT NULL DEFAULT 0,
  `selectedCount` INTEGER NOT NULL DEFAULT 0,
  `createdById` VARCHAR(191) NOT NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `CrawlStrategyWorkflowRun_orgId_createdAt_idx`(`orgId`, `createdAt`),
  INDEX `CrawlStrategyWorkflowRun_workflowId_createdAt_idx`(`workflowId`, `createdAt`),
  INDEX `CrawlStrategyWorkflowRun_workflowVersionId_createdAt_idx`(`workflowVersionId`, `createdAt`),
  INDEX `CrawlStrategyWorkflowRun_profileId_createdAt_idx`(`profileId`, `createdAt`),
  INDEX `CrawlStrategyWorkflowRun_newsSourceId_createdAt_idx`(`newsSourceId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `NewsSource`
  ADD COLUMN `workflowId` VARCHAR(191) NULL,
  ADD COLUMN `workflowVersionId` VARCHAR(191) NULL,
  ADD COLUMN `workflowBindingMode` ENUM('published', 'pinned') NOT NULL DEFAULT 'published',
  ADD INDEX `NewsSource_orgId_workflowId_updatedAt_idx`(`orgId`, `workflowId`, `updatedAt`);

ALTER TABLE `CrawlStrategyWorkflow`
  ADD CONSTRAINT `CrawlStrategyWorkflow_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowVersion`
  ADD CONSTRAINT `CrawlStrategyWorkflowVersion_workflowId_fkey`
    FOREIGN KEY (`workflowId`) REFERENCES `CrawlStrategyWorkflow`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowRun`
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_workflowId_fkey`
    FOREIGN KEY (`workflowId`) REFERENCES `CrawlStrategyWorkflow`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_workflowVersionId_fkey`
    FOREIGN KEY (`workflowVersionId`) REFERENCES `CrawlStrategyWorkflowVersion`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_profileId_fkey`
    FOREIGN KEY (`profileId`) REFERENCES `CrawlSiteProfile`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_newsSourceId_fkey`
    FOREIGN KEY (`newsSourceId`) REFERENCES `NewsSource`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflow`
  ADD CONSTRAINT `CrawlStrategyWorkflow_publishedVersionId_fkey`
    FOREIGN KEY (`publishedVersionId`) REFERENCES `CrawlStrategyWorkflowVersion`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CrawlSiteProfile`
  ADD CONSTRAINT `CrawlSiteProfile_workflowId_fkey`
    FOREIGN KEY (`workflowId`) REFERENCES `CrawlStrategyWorkflow`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlSiteProfile_workflowVersionId_fkey`
    FOREIGN KEY (`workflowVersionId`) REFERENCES `CrawlStrategyWorkflowVersion`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `NewsSource`
  ADD CONSTRAINT `NewsSource_workflowId_fkey`
    FOREIGN KEY (`workflowId`) REFERENCES `CrawlStrategyWorkflow`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `NewsSource_workflowVersionId_fkey`
    FOREIGN KEY (`workflowVersionId`) REFERENCES `CrawlStrategyWorkflowVersion`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
