CREATE TABLE `ObservabilitySnapshot` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `scope` ENUM(
    'quality_pipeline',
    'quality_news_sources',
    'rss_diagnostics',
    'crawl_quality_metrics'
  ) NOT NULL,
  `variantKey` VARCHAR(191) NOT NULL,
  `payload` JSON NOT NULL,
  `generatedAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `lastRequestedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ObservabilitySnapshot_org_scope_variant_uq`(`orgId`, `scope`, `variantKey`),
  INDEX `ObservabilitySnapshot_org_scope_expires_idx`(`orgId`, `scope`, `expiresAt`),
  INDEX `ObservabilitySnapshot_org_lastRequested_idx`(`orgId`, `lastRequestedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ObservabilitySnapshot`
  ADD CONSTRAINT `ObservabilitySnapshot_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
