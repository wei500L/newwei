-- Add fields needed for email binding and verification-code login.
ALTER TABLE `User`
  ADD COLUMN `emailVerified` DATETIME(3) NULL,
  ADD COLUMN `pendingEmail` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `User_pendingEmail_key` ON `User`(`pendingEmail`);
