-- CreateTable
CREATE TABLE `EntitySentimentSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `entityName` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL DEFAULT '',
    `bucketStart` DATETIME(3) NOT NULL,
    `totalDocs` INT NOT NULL,
    `negativeDocs` INT NOT NULL,
    `positiveDocs` INT NOT NULL,
    `neutralDocs` INT NOT NULL,
    `scoreSum` INT NOT NULL,
    `avgScore` DOUBLE NOT NULL,
    `negativeRatio` DOUBLE NOT NULL,
    `evidenceProcessedItemIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EntitySentimentSnapshot_org_entity_type_bucket_uq`(`orgId`, `entityName`, `entityType`, `bucketStart`),
    INDEX `EntitySentimentSnapshot_orgId_bucketStart_idx`(`orgId`, `bucketStart`),
    INDEX `EntitySentimentSnapshot_orgId_entityName_bucketStart_idx`(`orgId`, `entityName`, `bucketStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TopicSentimentSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `bucketStart` DATETIME(3) NOT NULL,
    `totalDocs` INT NOT NULL,
    `negativeDocs` INT NOT NULL,
    `positiveDocs` INT NOT NULL,
    `neutralDocs` INT NOT NULL,
    `scoreSum` INT NOT NULL,
    `avgScore` DOUBLE NOT NULL,
    `negativeRatio` DOUBLE NOT NULL,
    `evidenceProcessedItemIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TopicSentimentSnapshot_orgId_topic_bucketStart_key`(`orgId`, `topic`, `bucketStart`),
    INDEX `TopicSentimentSnapshot_orgId_bucketStart_idx`(`orgId`, `bucketStart`),
    INDEX `TopicSentimentSnapshot_orgId_topic_bucketStart_idx`(`orgId`, `topic`, `bucketStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EntitySentimentSnapshot` ADD CONSTRAINT `EntitySentimentSnapshot_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TopicSentimentSnapshot` ADD CONSTRAINT `TopicSentimentSnapshot_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Org`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
