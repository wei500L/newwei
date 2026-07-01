-- CreateTable
CREATE TABLE `SituationMonitorExternalSnapshot` (
  `id` VARCHAR(191) NOT NULL,
  `scope` ENUM('gdelt_global') NOT NULL,
  `variantKey` VARCHAR(191) NOT NULL,
  `status` ENUM('completed', 'partial', 'failed') NOT NULL,
  `source` VARCHAR(191) NOT NULL DEFAULT 'scheduler',
  `payload` JSON NOT NULL,
  `warnings` JSON NULL,
  `diagnostics` JSON NULL,
  `generatedAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `SituationMonitorExternalSnapshot_scope_variant_generated_idx`
  ON `SituationMonitorExternalSnapshot`(`scope`, `variantKey`, `generatedAt`);

-- CreateIndex
CREATE INDEX `SituationMonitorExternalSnapshot_expires_idx`
  ON `SituationMonitorExternalSnapshot`(`expiresAt`);
