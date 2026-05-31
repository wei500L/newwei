ALTER TABLE `AnalysisThread`
  MODIFY `subjectType` ENUM('saved_view', 'item', 'event', 'analysis_task') NOT NULL;

CREATE TABLE `AnalysisBoard` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `updatedById` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `archivedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisBoardColumn` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `boardId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `color` VARCHAR(191) NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `isDone` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AnalysisTaskCard` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `boardId` VARCHAR(191) NOT NULL,
  `columnId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `updatedById` VARCHAR(191) NOT NULL,
  `assigneeId` VARCHAR(191) NULL,
  `title` VARCHAR(191) NOT NULL,
  `bodyMarkdown` TEXT NULL,
  `priority` ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  `linkedSubjectType` ENUM('saved_view', 'item', 'event') NULL,
  `linkedSubjectId` VARCHAR(191) NULL,
  `dueAt` DATETIME(3) NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `AnalysisBoard_orgId_archivedAt_updatedAt_idx`
  ON `AnalysisBoard`(`orgId`, `archivedAt`, `updatedAt`);
CREATE INDEX `AnalysisBoard_orgId_createdById_updatedAt_idx`
  ON `AnalysisBoard`(`orgId`, `createdById`, `updatedAt`);

CREATE INDEX `AnalysisBoardColumn_orgId_boardId_sortOrder_idx`
  ON `AnalysisBoardColumn`(`orgId`, `boardId`, `sortOrder`);
CREATE INDEX `AnalysisBoardColumn_boardId_sortOrder_idx`
  ON `AnalysisBoardColumn`(`boardId`, `sortOrder`);

CREATE INDEX `AnalysisTaskCard_orgId_boardId_columnId_sortOrder_idx`
  ON `AnalysisTaskCard`(`orgId`, `boardId`, `columnId`, `sortOrder`);
CREATE INDEX `AnalysisTaskCard_orgId_assigneeId_updatedAt_idx`
  ON `AnalysisTaskCard`(`orgId`, `assigneeId`, `updatedAt`);
CREATE INDEX `AnalysisTaskCard_orgId_linkedSubjectType_linkedSubjectId_idx`
  ON `AnalysisTaskCard`(`orgId`, `linkedSubjectType`, `linkedSubjectId`);

ALTER TABLE `AnalysisBoard`
  ADD CONSTRAINT `AnalysisBoard_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisBoard_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisBoard_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AnalysisBoardColumn`
  ADD CONSTRAINT `AnalysisBoardColumn_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisBoardColumn_boardId_fkey`
    FOREIGN KEY (`boardId`) REFERENCES `AnalysisBoard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AnalysisTaskCard`
  ADD CONSTRAINT `AnalysisTaskCard_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisTaskCard_boardId_fkey`
    FOREIGN KEY (`boardId`) REFERENCES `AnalysisBoard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisTaskCard_columnId_fkey`
    FOREIGN KEY (`columnId`) REFERENCES `AnalysisBoardColumn`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisTaskCard_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisTaskCard_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AnalysisTaskCard_assigneeId_fkey`
    FOREIGN KEY (`assigneeId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
