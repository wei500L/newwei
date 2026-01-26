-- Expand Article.url to 512 chars so longer URLs do not fail persistence.
ALTER TABLE `Article`
  MODIFY `url` VARCHAR(512) NOT NULL;

