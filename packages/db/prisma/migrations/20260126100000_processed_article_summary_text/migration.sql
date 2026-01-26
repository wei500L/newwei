-- Expand ProcessedArticle.summary to TEXT so LLM summaries do not exceed the column limit.
ALTER TABLE `ProcessedArticle`
  MODIFY `summary` TEXT NULL;

