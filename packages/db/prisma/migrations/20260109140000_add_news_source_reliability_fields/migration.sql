-- AlterTable
ALTER TABLE `NewsSource`
  ADD COLUMN `lastSuccessAt` DATETIME(3) NULL,
  ADD COLUMN `lastFailureAt` DATETIME(3) NULL,
  ADD COLUMN `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `circuitOpenUntil` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `NewsSource_isActive_nextRunAt_idx` ON `NewsSource`(`isActive`, `nextRunAt`);

