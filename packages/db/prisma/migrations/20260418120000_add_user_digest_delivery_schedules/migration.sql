-- CreateTable
CREATE TABLE `UserDigestDeliverySchedule` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `timezone` VARCHAR(191) NOT NULL,
  `sendHour` INTEGER NOT NULL,
  `sendMinute` INTEGER NOT NULL,
  `nextRunAt` DATETIME(3) NULL,
  `lastSentAt` DATETIME(3) NULL,
  `lastStatus` ENUM('idle', 'sent', 'empty_notified', 'failed') NOT NULL DEFAULT 'idle',
  `lastStatusAt` DATETIME(3) NULL,
  `lastError` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `UserDigestDeliverySchedule_orgId_userId_key`(`orgId`, `userId`),
  INDEX `UserDigestDeliverySchedule_enabled_nextRunAt_idx`(`enabled`, `nextRunAt`),
  INDEX `UserDigestDeliverySchedule_orgId_nextRunAt_idx`(`orgId`, `nextRunAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `UserDigestDeliverySchedule`
  ADD CONSTRAINT `UserDigestDeliverySchedule_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserDigestDeliverySchedule`
  ADD CONSTRAINT `UserDigestDeliverySchedule_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
