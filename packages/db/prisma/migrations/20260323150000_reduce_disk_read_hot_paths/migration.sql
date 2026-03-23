CREATE INDEX `AuditLogOutbox_status_availableAt_createdAt_idx`
  ON `AuditLogOutbox`(`status`, `availableAt`, `createdAt`);

CREATE INDEX `AuditLogOutbox_status_lockedAt_createdAt_idx`
  ON `AuditLogOutbox`(`status`, `lockedAt`, `createdAt`);

CREATE INDEX `CrawlTask_status_updatedAt_id_idx`
  ON `CrawlTask`(`status`, `updatedAt`, `id`);

CREATE INDEX `CrawlTask_status_lastRunAt_id_idx`
  ON `CrawlTask`(`status`, `lastRunAt`, `id`);

CREATE INDEX `CrawlTask_org_updatedAt_id_idx`
  ON `CrawlTask`(`orgId`, `updatedAt`, `id`);

CREATE INDEX `MongoOutbox_type_status_availableAt_createdAt_idx`
  ON `MongoOutbox`(`type`, `status`, `availableAt`, `createdAt`);

CREATE INDEX `MongoOutbox_type_status_lockedAt_createdAt_idx`
  ON `MongoOutbox`(`type`, `status`, `lockedAt`, `createdAt`);

CREATE INDEX `MongoOutbox_orgId_type_status_idx`
  ON `MongoOutbox`(`orgId`, `type`, `status`);
