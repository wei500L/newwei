-- CreateTable
CREATE TABLE `KnowledgeEntity` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `type` ENUM('company', 'industry', 'person', 'policy', 'commodity', 'instrument', 'organization') NOT NULL,
    `canonicalName` VARCHAR(191) NOT NULL,
    `normalizedKey` VARCHAR(191) NOT NULL,
    `properties` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `KnowledgeEntity_orgId_type_normalizedKey_key`(`orgId`, `type`, `normalizedKey`),
    INDEX `KnowledgeEntity_orgId_type_idx`(`orgId`, `type`),
    INDEX `KnowledgeEntity_orgId_canonicalName_idx`(`orgId`, `canonicalName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeEntityAlias` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `alias` VARCHAR(191) NOT NULL,
    `normalizedAlias` VARCHAR(191) NOT NULL,
    `source` ENUM('seed', 'llm', 'derived', 'user') NOT NULL DEFAULT 'llm',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `KnowledgeEntityAlias_entityId_normalizedAlias_key`(`entityId`, `normalizedAlias`),
    INDEX `KnowledgeEntityAlias_orgId_normalizedAlias_idx`(`orgId`, `normalizedAlias`),
    INDEX `KnowledgeEntityAlias_orgId_entityId_idx`(`orgId`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeEdge` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `type` ENUM('belongs_to_industry', 'supplies', 'customer_of', 'competes_with', 'holds_position', 'affects_industry', 'affects_company', 'upstream_of', 'downstream_of', 'has_ticker') NOT NULL,
    `fromEntityId` VARCHAR(191) NOT NULL,
    `toEntityId` VARCHAR(191) NOT NULL,
    `weight` DOUBLE NOT NULL DEFAULT 1,
    `confidence` DOUBLE NOT NULL DEFAULT 0.5,
    `properties` JSON NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `KnowledgeEdge_orgId_type_fromEntityId_toEntityId_key`(`orgId`, `type`, `fromEntityId`, `toEntityId`),
    INDEX `KnowledgeEdge_orgId_type_idx`(`orgId`, `type`),
    INDEX `KnowledgeEdge_orgId_fromEntityId_idx`(`orgId`, `fromEntityId`),
    INDEX `KnowledgeEdge_orgId_toEntityId_idx`(`orgId`, `toEntityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeEdgeEvidence` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `edgeId` VARCHAR(191) NOT NULL,
    `articleId` VARCHAR(191) NOT NULL,
    `extractorVersion` VARCHAR(191) NULL,
    `confidence` DOUBLE NULL,
    `evidence` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `KnowledgeEdgeEvidence_edgeId_articleId_key`(`edgeId`, `articleId`),
    INDEX `KnowledgeEdgeEvidence_orgId_articleId_idx`(`orgId`, `articleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeGraphIngestionState` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `lastProcessedAt` DATETIME(3) NULL,
    `lastProcessedArticleId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `KnowledgeGraphIngestionState_orgId_key`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `KnowledgeEntity` ADD CONSTRAINT `KnowledgeEntity_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeEntityAlias` ADD CONSTRAINT `KnowledgeEntityAlias_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeEntityAlias` ADD CONSTRAINT `KnowledgeEntityAlias_entityId_fkey` FOREIGN KEY (`entityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeEdge` ADD CONSTRAINT `KnowledgeEdge_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeEdge` ADD CONSTRAINT `KnowledgeEdge_fromEntityId_fkey` FOREIGN KEY (`fromEntityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeEdge` ADD CONSTRAINT `KnowledgeEdge_toEntityId_fkey` FOREIGN KEY (`toEntityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeEdgeEvidence` ADD CONSTRAINT `KnowledgeEdgeEvidence_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeEdgeEvidence` ADD CONSTRAINT `KnowledgeEdgeEvidence_edgeId_fkey` FOREIGN KEY (`edgeId`) REFERENCES `KnowledgeEdge`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `KnowledgeEdgeEvidence` ADD CONSTRAINT `KnowledgeEdgeEvidence_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeGraphIngestionState` ADD CONSTRAINT `KnowledgeGraphIngestionState_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
