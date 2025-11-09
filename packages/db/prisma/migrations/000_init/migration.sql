-- Initial schema migration
CREATE TABLE `Org` (
  `id` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `slug` varchar(191) NOT NULL,
  `description` text NULL,
  `isActive` boolean NOT NULL DEFAULT true,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Org_slug_key`(`slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `User` (
  `id` varchar(191) NOT NULL,
  `email` varchar(191) NOT NULL,
  `passwordHash` varchar(191) NOT NULL,
  `firstName` varchar(191) NOT NULL,
  `lastName` varchar(191) NOT NULL,
  `isActive` boolean NOT NULL DEFAULT true,
  `lastLoginAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `User_email_key`(`email`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Role` (
  `id` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `description` text NULL,
  `orgId` varchar(191) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Role_orgId_name_key`(`orgId`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Permission` (
  `id` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `description` text NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Permission_name_key`(`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RolePermission` (
  `id` varchar(191) NOT NULL,
  `roleId` varchar(191) NOT NULL,
  `permissionId` varchar(191) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `RolePermission_roleId_permissionId_key`(`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Membership` (
  `id` varchar(191) NOT NULL,
  `userId` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `roleId` varchar(191) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Membership_userId_orgId_key`(`userId`, `orgId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AuditLog` (
  `id` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `actorId` varchar(191) NULL,
  `resource` varchar(191) NOT NULL,
  `action` varchar(191) NOT NULL,
  `metadata` json NULL,
  `ipAddress` varchar(191) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ItemMeta` (
  `id` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `externalId` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `status` varchar(191) NOT NULL DEFAULT 'draft',
  `mongoRef` varchar(191) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ItemMeta_externalId_key`(`externalId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RefreshToken` (
  `id` varchar(191) NOT NULL,
  `userId` varchar(191) NOT NULL,
  `tokenHash` varchar(191) NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revokedAt` datetime(3) NULL,
  `ipAddress` varchar(191) NULL,
  `userAgent` varchar(191) NULL,
  PRIMARY KEY (`id`),
  INDEX `RefreshToken_userId_idx`(`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlTask` (
  `id` varchar(191) NOT NULL,
  `orgId` varchar(191) NOT NULL,
  `createdById` varchar(191) NOT NULL,
  `targetUrl` varchar(512) NOT NULL,
  `displayName` varchar(191) NULL,
  `status` ENUM('pending','queued','running','completed','failed','paused') NOT NULL DEFAULT 'pending',
  `config` json NULL,
  `timeRangeFrom` datetime(3) NULL,
  `timeRangeTo` datetime(3) NULL,
  `concurrency` int NOT NULL DEFAULT 1,
  `keywords` json NULL,
  `lastRunAt` datetime(3) NULL,
  `lastSuccessAt` datetime(3) NULL,
  `lastResultAt` datetime(3) NULL,
  `lastCursor` varchar(191) NULL,
  `lastError` text NULL,
  `runCount` int NOT NULL DEFAULT 0,
  `lastServerMemoryMb` double NULL,
  `lastPeakMemoryMb` double NULL,
  `lastMemoryEfficiency` double NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `CrawlTask_orgId_idx`(`orgId`),
  INDEX `CrawlTask_status_idx`(`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlResult` (
  `id` varchar(191) NOT NULL,
  `taskId` varchar(191) NOT NULL,
  `sourceUrl` text NOT NULL,
  `fetchedAt` datetime(3) NOT NULL,
  `markdownRef` varchar(191) NOT NULL,
  `contentHash` varchar(191) NOT NULL,
  `metadata` json NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `CrawlResult_taskId_fetchedAt_idx`(`taskId`, `fetchedAt`),
  UNIQUE INDEX `CrawlResult_taskId_contentHash_key`(`taskId`, `contentHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Role`
  ADD CONSTRAINT `Role_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `RolePermission`
  ADD CONSTRAINT `RolePermission_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `RolePermission_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `Permission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Membership`
  ADD CONSTRAINT `Membership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `Membership_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `Membership_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AuditLog`
  ADD CONSTRAINT `AuditLog_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ItemMeta`
  ADD CONSTRAINT `ItemMeta_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `RefreshToken`
  ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlTask`
  ADD CONSTRAINT `CrawlTask_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlTask_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlResult`
  ADD CONSTRAINT `CrawlResult_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `CrawlTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
