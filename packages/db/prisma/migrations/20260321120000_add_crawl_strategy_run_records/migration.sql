ALTER TABLE `CrawlFrontierRun`
  ADD COLUMN `workflowRunId` VARCHAR(191) NULL;

ALTER TABLE `CrawlStrategyWorkflowRun`
  DROP FOREIGN KEY `CrawlStrategyWorkflowRun_workflowId_fkey`,
  DROP FOREIGN KEY `CrawlStrategyWorkflowRun_workflowVersionId_fkey`;

ALTER TABLE `CrawlStrategyWorkflowRun`
  MODIFY `workflowId` VARCHAR(191) NULL,
  MODIFY `workflowVersionId` VARCHAR(191) NULL,
  ADD COLUMN `workflowOrigin` VARCHAR(191) NOT NULL DEFAULT 'bound';

CREATE TABLE `CrawlStrategyWorkflowRunStep` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `stepKey` VARCHAR(191) NOT NULL,
  `sequence` INTEGER NOT NULL DEFAULT 0,
  `workflowNodeId` VARCHAR(191) NULL,
  `nodeType` VARCHAR(191) NOT NULL,
  `label` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `durationMs` INTEGER NULL,
  `inputCount` INTEGER NOT NULL DEFAULT 0,
  `outputCount` INTEGER NOT NULL DEFAULT 0,
  `rejectedCount` INTEGER NOT NULL DEFAULT 0,
  `sampleUrls` JSON NULL,
  `metrics` JSON NULL,
  `error` TEXT NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CrawlStrategyWorkflowRunStep_runId_stepKey_key`(`runId`, `stepKey`),
  INDEX `CrawlStrategyWorkflowRunStep_runId_sequence_idx`(`runId`, `sequence`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlStrategyWorkflowRunCandidate` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `candidateKey` VARCHAR(191) NOT NULL,
  `externalId` VARCHAR(191) NULL,
  `sourceNodeId` VARCHAR(191) NULL,
  `sourceNodeType` VARCHAR(191) NULL,
  `url` TEXT NOT NULL,
  `title` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `author` VARCHAR(191) NULL,
  `pageType` VARCHAR(191) NULL,
  `relevanceScore` DOUBLE NULL,
  `score` DOUBLE NULL,
  `freshnessScore` DOUBLE NULL,
  `qualityScore` DOUBLE NULL,
  `publishedAt` DATETIME(3) NULL,
  `crawledAt` DATETIME(3) NULL,
  `effectiveAt` DATETIME(3) NULL,
  `status` VARCHAR(191) NOT NULL,
  `rejectedByNodeId` VARCHAR(191) NULL,
  `rejectedReason` VARCHAR(191) NULL,
  `metadata` JSON NULL,
  `traceCount` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CrawlStrategyWorkflowRunCandidate_runId_candidateKey_key`(`runId`, `candidateKey`),
  INDEX `CrawlStrategyWorkflowRunCandidate_runId_status_updatedAt_idx`(`runId`, `status`, `updatedAt`),
  INDEX `CrawlStrategyWorkflowRunCandidate_runId_sourceNodeId_updatedAt_idx`(`runId`, `sourceNodeId`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlStrategyWorkflowRunCandidateTrace` (
  `id` VARCHAR(191) NOT NULL,
  `candidateId` VARCHAR(191) NOT NULL,
  `sequence` INTEGER NOT NULL DEFAULT 0,
  `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `nodeId` VARCHAR(191) NOT NULL,
  `nodeType` VARCHAR(191) NOT NULL,
  `action` VARCHAR(191) NOT NULL,
  `message` TEXT NOT NULL,
  `accepted` BOOLEAN NULL,
  `scoreDelta` DOUBLE NULL,
  `freshnessDelta` DOUBLE NULL,
  `ruleHits` JSON NULL,
  `beforeSnapshot` JSON NULL,
  `afterSnapshot` JSON NULL,
  `details` JSON NULL,

  INDEX `CrawlStrategyWorkflowRunCandidateTrace_candidateId_sequence_idx`(`candidateId`, `sequence`),
  INDEX `CrawlStrategyWorkflowRunCandidateTrace_candidateId_timestamp_idx`(`candidateId`, `timestamp`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CrawlStrategyWorkflowRunEvent` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `sequence` INTEGER NOT NULL DEFAULT 0,
  `level` VARCHAR(191) NOT NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `nodeId` VARCHAR(191) NULL,
  `nodeType` VARCHAR(191) NULL,
  `message` TEXT NOT NULL,
  `triggerReason` VARCHAR(191) NULL,
  `beforeCount` INTEGER NULL,
  `afterCount` INTEGER NULL,
  `rescuedCount` INTEGER NULL,
  `details` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `CrawlStrategyWorkflowRunEvent_runId_sequence_idx`(`runId`, `sequence`),
  INDEX `CrawlStrategyWorkflowRunEvent_runId_createdAt_idx`(`runId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `CrawlFrontierRun_workflowRunId_key` ON `CrawlFrontierRun`(`workflowRunId`);

ALTER TABLE `CrawlFrontierRun`
  ADD CONSTRAINT `CrawlFrontierRun_workflowRunId_fkey`
  FOREIGN KEY (`workflowRunId`) REFERENCES `CrawlStrategyWorkflowRun`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowRun`
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_workflowId_fkey`
  FOREIGN KEY (`workflowId`) REFERENCES `CrawlStrategyWorkflow`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CrawlStrategyWorkflowRun_workflowVersionId_fkey`
  FOREIGN KEY (`workflowVersionId`) REFERENCES `CrawlStrategyWorkflowVersion`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowRunStep`
  ADD CONSTRAINT `CrawlStrategyWorkflowRunStep_runId_fkey`
  FOREIGN KEY (`runId`) REFERENCES `CrawlStrategyWorkflowRun`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowRunCandidate`
  ADD CONSTRAINT `CrawlStrategyWorkflowRunCandidate_runId_fkey`
  FOREIGN KEY (`runId`) REFERENCES `CrawlStrategyWorkflowRun`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowRunCandidateTrace`
  ADD CONSTRAINT `CrawlStrategyWorkflowRunCandidateTrace_candidateId_fkey`
  FOREIGN KEY (`candidateId`) REFERENCES `CrawlStrategyWorkflowRunCandidate`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CrawlStrategyWorkflowRunEvent`
  ADD CONSTRAINT `CrawlStrategyWorkflowRunEvent_runId_fkey`
  FOREIGN KEY (`runId`) REFERENCES `CrawlStrategyWorkflowRun`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
