CREATE TABLE `ArchiveArticleClassification` (
  `id` VARCHAR(191) NOT NULL,
  `orgId` VARCHAR(191) NOT NULL,
  `articleId` VARCHAR(191) NOT NULL,
  `processedArticleId` VARCHAR(191) NOT NULL,
  `region` VARCHAR(191) NOT NULL,
  `vertical` VARCHAR(191) NOT NULL,
  `ruleScores` JSON NOT NULL,
  `embeddingScores` JSON NOT NULL,
  `rerankScores` JSON NOT NULL,
  `fusedScores` JSON NOT NULL,
  `classificationTextHash` VARCHAR(191) NOT NULL,
  `classificationTextVersion` VARCHAR(191) NOT NULL,
  `taxonomyVersion` VARCHAR(191) NOT NULL,
  `pipelineVersion` VARCHAR(191) NOT NULL,
  `embeddingModel` VARCHAR(191) NOT NULL,
  `rerankModel` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ArchiveArticleClassification_articleId_key`(`articleId`),
  UNIQUE INDEX `ArchiveArticleClassification_processedArticleId_key`(`processedArticleId`),
  INDEX `ArchiveArticleClassification_orgId_updatedAt_idx`(`orgId`, `updatedAt`),
  INDEX `ArchiveArticleClassification_orgId_vertical_updatedAt_idx`(`orgId`, `vertical`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ArchiveVerticalAnchorEmbedding` (
  `id` VARCHAR(191) NOT NULL,
  `vertical` VARCHAR(191) NOT NULL,
  `taxonomyVersion` VARCHAR(191) NOT NULL,
  `anchorText` TEXT NOT NULL,
  `anchorTextHash` VARCHAR(191) NOT NULL,
  `embeddingModel` VARCHAR(191) NOT NULL,
  `embeddingVector` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ArchiveVerticalAnchorEmbedding_vertical_taxVer_embModel_hash_uq`(`vertical`, `taxonomyVersion`, `embeddingModel`, `anchorTextHash`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ArchiveArticleClassification`
  ADD CONSTRAINT `ArchiveArticleClassification_orgId_fkey`
    FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `ArchiveArticleClassification_articleId_fkey`
    FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ArchiveArticleClassification_processedArticleId_fkey`
    FOREIGN KEY (`processedArticleId`) REFERENCES `ProcessedArticle`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
