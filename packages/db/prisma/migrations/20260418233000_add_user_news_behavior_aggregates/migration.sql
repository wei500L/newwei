CREATE TABLE `UserNewsBehaviorAggregate` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `signalType` ENUM('source', 'topic', 'entity', 'item', 'event', 'domain') NOT NULL,
  `signalKey` VARCHAR(191) NOT NULL,
  `score` DOUBLE NOT NULL,
  `lastInteractedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `UserNewsBehaviorAggregate_orgId_userId_signalType_signalKey_key`(`orgId`, `userId`, `signalType`, `signalKey`),
  INDEX `UserNewsBehaviorAggregate_orgId_signalType_signalKey_idx`(`orgId`, `signalType`, `signalKey`),
  INDEX `UserNewsBehaviorAggregate_orgId_userId_updatedAt_idx`(`orgId`, `userId`, `updatedAt`),
  INDEX `UserNewsBehaviorAggregate_orgId_userId_lastInteractedAt_idx`(`orgId`, `userId`, `lastInteractedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `UserNewsSimilaritySnapshot` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `dirty` BOOLEAN NOT NULL DEFAULT true,
  `computedAt` DATETIME(3) NULL,
  `neighbors` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `UserNewsSimilaritySnapshot_orgId_userId_key`(`orgId`, `userId`),
  INDEX `UserNewsSimilaritySnapshot_orgId_dirty_computedAt_idx`(`orgId`, `dirty`, `computedAt`),
  INDEX `UserNewsSimilaritySnapshot_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UserNewsBehaviorAggregate`
  ADD CONSTRAINT `UserNewsBehaviorAggregate_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `UserNewsBehaviorAggregate_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `UserNewsSimilaritySnapshot`
  ADD CONSTRAINT `UserNewsSimilaritySnapshot_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `UserNewsSimilaritySnapshot_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
