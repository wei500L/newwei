ALTER TABLE `AuthChallenge`
  MODIFY `type` ENUM('mfa_login', 'mfa_enrollment', 'sso_handoff') NOT NULL;

ALTER TABLE `UserTotpFactor`
  ADD COLUMN `pendingSecret` JSON NULL AFTER `secret`,
  ADD COLUMN `pendingLabel` VARCHAR(191) NULL AFTER `label`,
  ADD COLUMN `pendingStartedAt` DATETIME(3) NULL AFTER `pendingLabel`;
