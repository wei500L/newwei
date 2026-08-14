DELETE n1 FROM `CrawlFrontierNode` n1
INNER JOIN `CrawlFrontierNode` n2
  ON n1.runId = n2.runId
  AND n1.urlFingerprint = n2.urlFingerprint
  AND n1.urlFingerprint IS NOT NULL
  AND (
    n1.createdAt > n2.createdAt
    OR (n1.createdAt = n2.createdAt AND n1.id > n2.id)
  );

DROP INDEX `CrawlFrontierNode_runId_urlFingerprint_idx` ON `CrawlFrontierNode`;

CREATE UNIQUE INDEX `CrawlFrontierNode_runId_urlFingerprint_key`
  ON `CrawlFrontierNode`(`runId`, `urlFingerprint`);
