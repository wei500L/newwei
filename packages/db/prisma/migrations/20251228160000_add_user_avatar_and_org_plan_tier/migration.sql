-- Add missing profile + org columns required by current Prisma schema.
ALTER TABLE `User`
  ADD COLUMN `avatarUrl` VARCHAR(191) NULL;

ALTER TABLE `Org`
  ADD COLUMN `planTier` VARCHAR(191) NULL,
  ADD COLUMN `subscriptionStatus` VARCHAR(191) NULL;
