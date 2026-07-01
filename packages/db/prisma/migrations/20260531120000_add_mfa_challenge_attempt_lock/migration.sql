ALTER TABLE `AuthChallenge`
  ADD COLUMN `failedAttempts` INTEGER NOT NULL DEFAULT 0 AFTER `consumedAt`,
  ADD COLUMN `lockedAt` DATETIME(3) NULL AFTER `failedAttempts`;
