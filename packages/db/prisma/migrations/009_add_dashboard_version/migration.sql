-- Add optimistic locking support to Dashboard updates.

ALTER TABLE `Dashboard`
  ADD COLUMN `version` INT NOT NULL DEFAULT 1;

