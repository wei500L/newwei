CREATE TABLE `UserContentSubscription` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `kind` ENUM('topic', 'entity') NOT NULL,
  `normalizedValue` VARCHAR(191) NOT NULL,
  `displayValue` VARCHAR(191) NOT NULL,
  `taxonomyPath` VARCHAR(191) NULL,
  `taxonomyVersion` VARCHAR(191) NULL,
  `source` ENUM('manual', 'recommendation', 'related', 'legacy') NOT NULL DEFAULT 'manual',
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `UserContentSubscription_orgId_userId_kind_normalizedValue_key`(`orgId`, `userId`, `kind`, `normalizedValue`),
  INDEX `UserContentSubscription_orgId_userId_kind_createdAt_idx`(`orgId`, `userId`, `kind`, `createdAt`),
  INDEX `UserContentSubscription_orgId_userId_updatedAt_idx`(`orgId`, `userId`, `updatedAt`),
  INDEX `UserContentSubscription_orgId_taxonomyPath_kind_idx`(`orgId`, `taxonomyPath`, `kind`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ContentSubscriptionCatalog` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `kind` ENUM('topic', 'entity') NOT NULL,
  `normalizedValue` VARCHAR(191) NOT NULL,
  `displayValue` VARCHAR(191) NOT NULL,
  `count` INTEGER NOT NULL,
  `lastSeenAt` DATETIME(3) NOT NULL,
  `taxonomyPath` VARCHAR(191) NULL,
  `taxonomyVersion` VARCHAR(191) NULL,
  `embeddingModel` VARCHAR(191) NULL,
  `embeddingVector` JSON NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ContentSubscriptionCatalog_orgId_kind_normalizedValue_key`(`orgId`, `kind`, `normalizedValue`),
  INDEX `ContentSubscriptionCatalog_orgId_kind_count_idx`(`orgId`, `kind`, `count`),
  INDEX `ContentSubscriptionCatalog_orgId_kind_lastSeenAt_idx`(`orgId`, `kind`, `lastSeenAt`),
  INDEX `ContentSubscriptionCatalog_orgId_taxonomyPath_kind_idx`(`orgId`, `taxonomyPath`, `kind`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UserContentSubscription`
  ADD CONSTRAINT `UserContentSubscription_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `UserContentSubscription_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ContentSubscriptionCatalog`
  ADD CONSTRAINT `ContentSubscriptionCatalog_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
