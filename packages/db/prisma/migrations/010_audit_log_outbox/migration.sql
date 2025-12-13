-- CreateTable
CREATE TABLE `AuditLogOutbox` (
  `id` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `payload` json NOT NULL,
  `status` ENUM('pending', 'processing', 'failed', 'dead') NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT 0,
  `lastError` varchar(191) NULL,
  `availableAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lockedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `AuditLogOutbox_status_availableAt_idx`(`status`, `availableAt`),
  INDEX `AuditLogOutbox_orgId_status_idx`(`orgId`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AuditLogOutbox` ADD CONSTRAINT `AuditLogOutbox_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

