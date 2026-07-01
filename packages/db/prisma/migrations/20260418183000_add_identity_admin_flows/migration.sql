-- CreateTable
CREATE TABLE `GlobalRoleAssignment` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `role` ENUM('platform_admin') NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `GlobalRoleAssignment_userId_role_key`(`userId`, `role`),
  INDEX `GlobalRoleAssignment_role_createdAt_idx`(`role`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgInvite` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `firstName` VARCHAR(191) NULL,
  `lastName` VARCHAR(191) NULL,
  `primaryRoleId` VARCHAR(191) NOT NULL,
  `roleIds` JSON NOT NULL,
  `invitedById` VARCHAR(191) NULL,
  `acceptedById` VARCHAR(191) NULL,
  `tokenHash` VARCHAR(191) NOT NULL,
  `status` ENUM('pending', 'accepted', 'revoked') NOT NULL DEFAULT 'pending',
  `expiresAt` DATETIME(3) NOT NULL,
  `acceptedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `OrgInvite_tokenHash_key`(`tokenHash`),
  INDEX `OrgInvite_orgId_status_createdAt_idx`(`orgId`, `status`, `createdAt`),
  INDEX `OrgInvite_orgId_email_status_idx`(`orgId`, `email`, `status`),
  INDEX `OrgInvite_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RegistrationApplication` (
  `id` VARCHAR(191) NOT NULL,
  `type` ENUM('new_org', 'join_org') NOT NULL,
  `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `email` VARCHAR(191) NOT NULL,
  `firstName` VARCHAR(191) NOT NULL,
  `lastName` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NULL,
  `requestedOrgName` VARCHAR(191) NULL,
  `requestedOrgSlug` VARCHAR(191) NULL,
  `requestedDescription` VARCHAR(191) NULL,
  `decisionReason` VARCHAR(191) NULL,
  `generatedInviteId` VARCHAR(191) NULL,
  `reviewedById` VARCHAR(191) NULL,
  `reviewedAt` DATETIME(3) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `RegistrationApplication_status_type_createdAt_idx`(`status`, `type`, `createdAt`),
  INDEX `RegistrationApplication_orgId_status_type_createdAt_idx`(`orgId`, `status`, `type`, `createdAt`),
  INDEX `RegistrationApplication_email_status_createdAt_idx`(`email`, `status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PasswordResetToken` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `tokenHash` VARCHAR(191) NOT NULL,
  `ipAddress` VARCHAR(191) NULL,
  `userAgent` VARCHAR(191) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `PasswordResetToken_tokenHash_key`(`tokenHash`),
  INDEX `PasswordResetToken_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `PasswordResetToken_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuthChallenge` (
  `id` VARCHAR(191) NOT NULL,
  `type` ENUM('mfa_login', 'sso_handoff') NOT NULL,
  `userId` VARCHAR(191) NULL,
  `orgId` VARCHAR(191) NULL,
  `payload` JSON NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AuthChallenge_type_expiresAt_idx`(`type`, `expiresAt`),
  INDEX `AuthChallenge_userId_type_expiresAt_idx`(`userId`, `type`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserTotpFactor` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `secret` JSON NOT NULL,
  `label` VARCHAR(191) NULL,
  `enrolledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `verifiedAt` DATETIME(3) NULL,
  `disabledAt` DATETIME(3) NULL,
  `lastUsedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `UserTotpFactor_userId_key`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserRecoveryCode` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `codeHash` VARCHAR(191) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `UserRecoveryCode_codeHash_key`(`codeHash`),
  INDEX `UserRecoveryCode_userId_usedAt_createdAt_idx`(`userId`, `usedAt`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgOidcConfig` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `issuerUrl` VARCHAR(191) NOT NULL,
  `discoveryUrl` VARCHAR(191) NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `clientSecret` JSON NULL,
  `scopes` JSON NULL,
  `buttonLabel` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `OrgOidcConfig_orgId_key`(`orgId`),
  INDEX `OrgOidcConfig_enabled_updatedAt_idx`(`enabled`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `GlobalRoleAssignment`
  ADD CONSTRAINT `GlobalRoleAssignment_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgInvite`
  ADD CONSTRAINT `OrgInvite_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgInvite`
  ADD CONSTRAINT `OrgInvite_primaryRoleId_orgId_fkey`
  FOREIGN KEY (`primaryRoleId`, `orgId`) REFERENCES `Role`(`id`, `orgId`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgInvite`
  ADD CONSTRAINT `OrgInvite_invitedById_fkey`
  FOREIGN KEY (`invitedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgInvite`
  ADD CONSTRAINT `OrgInvite_acceptedById_fkey`
  FOREIGN KEY (`acceptedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RegistrationApplication`
  ADD CONSTRAINT `RegistrationApplication_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RegistrationApplication`
  ADD CONSTRAINT `RegistrationApplication_generatedInviteId_fkey`
  FOREIGN KEY (`generatedInviteId`) REFERENCES `OrgInvite`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RegistrationApplication`
  ADD CONSTRAINT `RegistrationApplication_reviewedById_fkey`
  FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PasswordResetToken`
  ADD CONSTRAINT `PasswordResetToken_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuthChallenge`
  ADD CONSTRAINT `AuthChallenge_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuthChallenge`
  ADD CONSTRAINT `AuthChallenge_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserTotpFactor`
  ADD CONSTRAINT `UserTotpFactor_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRecoveryCode`
  ADD CONSTRAINT `UserRecoveryCode_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgOidcConfig`
  ADD CONSTRAINT `OrgOidcConfig_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
