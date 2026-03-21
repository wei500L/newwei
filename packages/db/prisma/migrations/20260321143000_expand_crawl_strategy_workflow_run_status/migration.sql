ALTER TABLE `CrawlStrategyWorkflowRun`
  MODIFY `status` ENUM('pending', 'queued', 'running', 'completed', 'failed', 'canceled') NOT NULL DEFAULT 'pending';
