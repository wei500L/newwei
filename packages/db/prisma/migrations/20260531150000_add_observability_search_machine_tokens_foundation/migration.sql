-- CreateTable
CREATE TABLE `MachineAccessToken` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `permissions` JSON NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MachineAccessToken_tokenHash_key`(`tokenHash`),
    INDEX `MachineAccessToken_orgId_revokedAt_idx`(`orgId`, `revokedAt`),
    INDEX `MachineAccessToken_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MachineAccessToken` ADD CONSTRAINT `MachineAccessToken_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineAccessToken` ADD CONSTRAINT `MachineAccessToken_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed permission catalog entries for existing installations.
INSERT IGNORE INTO `Permission` (`id`, `name`, `description`) VALUES
  ('perm-metrics-read', 'metrics.read', 'Scrape and inspect protected service metrics.');

-- Admins receive metrics scrape permission for protected Prometheus access.
INSERT IGNORE INTO `RolePermission` (`id`, `roleId`, `permissionId`)
SELECT CONCAT('rp-', r.`id`, '-', p.`id`), r.`id`, p.`id`
FROM `Role` r
JOIN `Permission` p ON p.`name` = 'metrics.read'
WHERE r.`name` = 'admin';
