-- CreateTable
CREATE TABLE `MongoOutbox` (
  `id` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `type` ENUM('processed_item') NOT NULL DEFAULT 'processed_item',
  `payload` json NOT NULL,
  `status` ENUM('pending', 'processing', 'failed') NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT 0,
  `lastError` varchar(191) NULL,
  `availableAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lockedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `MongoOutbox_status_availableAt_idx`(`status`, `availableAt`),
  INDEX `MongoOutbox_orgId_status_idx`(`orgId`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MongoOutbox` ADD CONSTRAINT `MongoOutbox_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
