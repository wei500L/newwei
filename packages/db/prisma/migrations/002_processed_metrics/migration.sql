ALTER TABLE `ProcessedArticle`
  ADD COLUMN `location` varchar(191) NULL,
  ADD COLUMN `promptTokens` int NULL,
  ADD COLUMN `completionTokens` int NULL,
  ADD COLUMN `totalTokens` int NULL,
  ADD COLUMN `costUsd` double NULL,
  ADD COLUMN `latencyMs` int NULL;
