-- Enforce org-scoped role assignments at the database layer
ALTER TABLE `Role` ADD UNIQUE INDEX `Role_id_orgId_key`(`id`, `orgId`);

ALTER TABLE `Membership` DROP FOREIGN KEY `Membership_roleId_fkey`;
CREATE INDEX `Membership_roleId_orgId_idx` ON `Membership`(`roleId`, `orgId`);
ALTER TABLE `Membership`
  ADD CONSTRAINT `Membership_roleId_orgId_fkey` FOREIGN KEY (`roleId`, `orgId`) REFERENCES `Role`(`id`, `orgId`) ON DELETE CASCADE ON UPDATE CASCADE;
