CREATE INDEX `AlertRule_org_provider_slug_idx`
  ON `AlertRule`(`orgId`, `metricProvider`, `metricSlug`);

CREATE INDEX `AlertRule_active_scan_idx`
  ON `AlertRule`(`status`, `metricProvider`, `metricSlug`, `orgId`, `checkIntervalSec`);

DROP INDEX `AlertRule_orgId_status_severity_idx` ON `AlertRule`;
