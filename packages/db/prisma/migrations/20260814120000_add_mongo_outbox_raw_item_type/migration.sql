ALTER TABLE `MongoOutbox`
  MODIFY `type` ENUM('processed_item', 'cleanup_crawl_results', 'raw_item') NOT NULL DEFAULT 'processed_item';
