-- Add the ProcessedArticle.status column introduced in schema.prisma.
-- Existing rows default to 'completed' so dashboard queries can filter safely.
ALTER TABLE `ProcessedArticle`
  ADD COLUMN `status` ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'completed';

