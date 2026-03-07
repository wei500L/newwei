-- Add region-oriented indexes for archive classification reads and preparation scans.
ALTER TABLE `ArchiveArticleClassification`
  ADD INDEX `ArchiveArticleClassification_orgId_region_updatedAt_idx` (`orgId`, `region`, `updatedAt`),
  ADD INDEX `ArchiveArticleClassification_orgId_region_vertical_updatedAt_idx` (`orgId`, `region`, `vertical`, `updatedAt`);
