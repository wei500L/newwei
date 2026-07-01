CREATE INDEX `ItemMeta_org_createdAt_id_idx` ON `ItemMeta`(`orgId`, `createdAt`, `id`);

CREATE INDEX `NewsEvent_org_status_last_start_id_idx` ON `NewsEvent`(`orgId`, `status`, `lastAt`, `startAt`, `id`);

CREATE INDEX `NewsEvent_org_status_topic_last_start_idx` ON `NewsEvent`(`orgId`, `status`, `primaryTopic`, `lastAt`, `startAt`);

CREATE INDEX `NewsEvent_org_status_entity_last_start_idx` ON `NewsEvent`(`orgId`, `status`, `primaryEntity`, `lastAt`, `startAt`);
