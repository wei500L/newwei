CREATE TABLE `SituationMonitorMonitor` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `kind` ENUM('manual', 'system_sync') NOT NULL DEFAULT 'manual',
  `name` VARCHAR(191) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `color` VARCHAR(191) NULL,
  `rawKeywords` JSON NOT NULL,
  `approvedTopics` JSON NOT NULL,
  `approvedEntities` JSON NOT NULL,
  `approvedLexicalTerms` JSON NOT NULL,
  `rejectedSuggestions` JSON NULL,
  `locationName` VARCHAR(191) NULL,
  `locationLat` DOUBLE NULL,
  `locationLng` DOUBLE NULL,
  `locationBounds` JSON NULL,
  `locationCountryCode` VARCHAR(191) NULL,
  `queryEmbeddingModel` VARCHAR(191) NULL,
  `queryEmbeddingVector` JSON NULL,
  `lastResolvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `SituationMonitorMonitor_orgId_userId_kind_updatedAt_idx`(`orgId`, `userId`, `kind`, `updatedAt`),
  INDEX `SituationMonitorMonitor_orgId_userId_createdAt_idx`(`orgId`, `userId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SituationMonitorMonitor`
  ADD CONSTRAINT `SituationMonitorMonitor_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `SituationMonitorMonitor_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
