-- Expand AlertEvent.status enum to support review states (confirmed/ignored)
ALTER TABLE `AlertEvent`
  MODIFY `status` ENUM('pending', 'delivered', 'failed', 'confirmed', 'ignored') NOT NULL DEFAULT 'pending';

