CREATE TABLE `SavedAnalysisView` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `updatedById` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `surface` ENUM('search', 'items', 'events') NOT NULL,
  `routePath` VARCHAR(191) NOT NULL,
  `queryState` JSON NOT NULL,
  `visibility` ENUM('private', 'org_shared') NOT NULL DEFAULT 'private',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisThread` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `updatedById` VARCHAR(191) NOT NULL,
  `subjectType` ENUM('saved_view', 'item', 'event') NOT NULL,
  `subjectId` VARCHAR(191) NOT NULL,
  `noteMarkdown` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisComment` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `threadId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `bodyMarkdown` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `SavedAnalysisView_orgId_surface_visibility_updatedAt_idx`
  ON `SavedAnalysisView`(`orgId`, `surface`, `visibility`, `updatedAt`);
CREATE INDEX `SavedAnalysisView_orgId_createdById_updatedAt_idx`
  ON `SavedAnalysisView`(`orgId`, `createdById`, `updatedAt`);

CREATE UNIQUE INDEX `AnalysisThread_orgId_subjectType_subjectId_key`
  ON `AnalysisThread`(`orgId`, `subjectType`, `subjectId`);
CREATE INDEX `AnalysisThread_orgId_updatedAt_idx`
  ON `AnalysisThread`(`orgId`, `updatedAt`);

CREATE INDEX `AnalysisComment_orgId_threadId_createdAt_idx`
  ON `AnalysisComment`(`orgId`, `threadId`, `createdAt`);
CREATE INDEX `AnalysisComment_threadId_createdAt_idx`
  ON `AnalysisComment`(`threadId`, `createdAt`);

ALTER TABLE `SavedAnalysisView`
  ADD CONSTRAINT `SavedAnalysisView_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `SavedAnalysisView_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `SavedAnalysisView_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AnalysisThread`
  ADD CONSTRAINT `AnalysisThread_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisThread_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisThread_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AnalysisComment`
  ADD CONSTRAINT `AnalysisComment_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisComment_threadId_fkey`
    FOREIGN KEY (`threadId`) REFERENCES `AnalysisThread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisComment_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
