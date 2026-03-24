ALTER TABLE `MongoOutbox`
  MODIFY `status` ENUM('pending', 'processing', 'failed', 'dead') NOT NULL DEFAULT 'pending';
