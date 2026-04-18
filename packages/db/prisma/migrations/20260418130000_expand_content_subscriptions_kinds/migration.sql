ALTER TABLE `UserContentSubscription`
  MODIFY `kind` ENUM('topic', 'entity', 'source', 'keyword', 'geo') NOT NULL;

ALTER TABLE `ContentSubscriptionCatalog`
  MODIFY `kind` ENUM('topic', 'entity', 'source', 'keyword', 'geo') NOT NULL;

ALTER TABLE `SituationMonitorMonitor`
  ADD COLUMN `approvedSources` JSON NULL,
  ADD COLUMN `approvedGeos` JSON NULL;
