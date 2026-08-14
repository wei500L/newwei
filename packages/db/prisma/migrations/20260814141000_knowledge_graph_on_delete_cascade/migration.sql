ALTER TABLE `KnowledgeEntityAlias` DROP FOREIGN KEY `KnowledgeEntityAlias_entityId_fkey`;
ALTER TABLE `KnowledgeEntityAlias` ADD CONSTRAINT `KnowledgeEntityAlias_entityId_fkey` FOREIGN KEY (`entityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KnowledgeEdge` DROP FOREIGN KEY `KnowledgeEdge_fromEntityId_fkey`;
ALTER TABLE `KnowledgeEdge` ADD CONSTRAINT `KnowledgeEdge_fromEntityId_fkey` FOREIGN KEY (`fromEntityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KnowledgeEdge` DROP FOREIGN KEY `KnowledgeEdge_toEntityId_fkey`;
ALTER TABLE `KnowledgeEdge` ADD CONSTRAINT `KnowledgeEdge_toEntityId_fkey` FOREIGN KEY (`toEntityId`) REFERENCES `KnowledgeEntity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KnowledgeEdgeEvidence` DROP FOREIGN KEY `KnowledgeEdgeEvidence_edgeId_fkey`;
ALTER TABLE `KnowledgeEdgeEvidence` ADD CONSTRAINT `KnowledgeEdgeEvidence_edgeId_fkey` FOREIGN KEY (`edgeId`) REFERENCES `KnowledgeEdge`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KnowledgeEdgeEvidence` DROP FOREIGN KEY `KnowledgeEdgeEvidence_articleId_fkey`;
ALTER TABLE `KnowledgeEdgeEvidence` ADD CONSTRAINT `KnowledgeEdgeEvidence_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
