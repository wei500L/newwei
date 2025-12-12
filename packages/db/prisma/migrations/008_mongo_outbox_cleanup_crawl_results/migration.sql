-- Extend MongoOutbox.type enum to support crawl cleanup intents.

ALTER TABLE `MongoOutbox`
  MODIFY `type` ENUM('processed_item', 'cleanup_crawl_results') NOT NULL DEFAULT 'processed_item';

