SET @schema_name = DATABASE();
SET @old_index_name = 'ArchiveVerticalAnchorEmbedding_vertical_taxonomyVersion_embeddingModel_anchorTextHash_key';
SET @new_index_name = 'ArchiveVerticalAnchorEmbedding_vertical_taxVer_embModel_hash_uq';
SET @old_index_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'ArchiveVerticalAnchorEmbedding'
    AND INDEX_NAME = @old_index_name
);
SET @new_index_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'ArchiveVerticalAnchorEmbedding'
    AND INDEX_NAME = @new_index_name
);
SET @quoted_table_name = CONCAT(CHAR(96), 'ArchiveVerticalAnchorEmbedding', CHAR(96));
SET @quoted_old_index_name = CONCAT(CHAR(96), @old_index_name, CHAR(96));
SET @quoted_new_index_name = CONCAT(CHAR(96), @new_index_name, CHAR(96));
SET @rename_index_sql = IF(
  @old_index_exists > 0 AND @new_index_exists = 0,
  CONCAT(
    'ALTER TABLE ',
    @quoted_table_name,
    ' RENAME INDEX ',
    @quoted_old_index_name,
    ' TO ',
    @quoted_new_index_name
  ),
  'SELECT 1'
);
PREPARE rename_index_stmt FROM @rename_index_sql;
EXECUTE rename_index_stmt;
DEALLOCATE PREPARE rename_index_stmt;
