-- Support multiple roles per membership without losing existing primary roles.
-- Membership.roleId remains the primary role (backwards compatible), while MembershipRole holds the role set.

ALTER TABLE `Membership` ADD UNIQUE INDEX `Membership_id_orgId_key`(`id`, `orgId`);

CREATE TABLE `MembershipRole` (
  `membershipId` VARCHAR(191) NOT NULL,
  `roleId` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`membershipId`, `roleId`),
  INDEX `MembershipRole_orgId_membershipId_idx` (`orgId`, `membershipId`),
  INDEX `MembershipRole_orgId_roleId_idx` (`orgId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MembershipRole`
  ADD CONSTRAINT `MembershipRole_membershipId_orgId_fkey`
  FOREIGN KEY (`membershipId`, `orgId`) REFERENCES `Membership`(`id`, `orgId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MembershipRole`
  ADD CONSTRAINT `MembershipRole_orgId_fkey`
  FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MembershipRole`
  ADD CONSTRAINT `MembershipRole_roleId_orgId_fkey`
  FOREIGN KEY (`roleId`, `orgId`) REFERENCES `Role`(`id`, `orgId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT IGNORE INTO `MembershipRole` (`membershipId`, `roleId`, `orgId`)
SELECT `id`, `roleId`, `orgId` FROM `Membership`;
