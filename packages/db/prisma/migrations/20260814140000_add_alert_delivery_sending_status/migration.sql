ALTER TABLE `AlertDelivery`
  MODIFY `status` ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending';
