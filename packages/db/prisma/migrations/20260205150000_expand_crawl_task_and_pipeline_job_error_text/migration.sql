-- Expand crawl + pipeline error fields to TEXT to avoid truncation (Prisma P2000)
ALTER TABLE `CrawlTask`
  MODIFY `lastError` TEXT NULL;

ALTER TABLE `PipelineJob`
  MODIFY `error` TEXT NULL;

