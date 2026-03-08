import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  assertMigrationIdentifiersWithinLimit,
  findMigrationIdentifierViolations
} from './migration-identifier-validator';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'migration-id-validator-'));

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeMigrationSql(relativeDir: string, content: string): string {
  const migrationDir = path.join(tempDir, relativeDir);
  mkdirSync(migrationDir, { recursive: true });
  const sqlPath = path.join(migrationDir, 'migration.sql');
  writeFileSync(sqlPath, content, 'utf8');
  return sqlPath;
}

describe('migration-identifier-validator', () => {
  it('accepts checked-in migrations in this package', () => {
    const repoMigrationsDir = path.resolve(process.cwd(), 'prisma/migrations');
    const violations = findMigrationIdentifierViolations({
      migrationsDir: repoMigrationsDir,
      maxLength: 64
    });

    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  });

  it('returns no violations for valid identifier lengths', () => {
    writeMigrationSql(
      'ok_case',
      [
        'CREATE TABLE `Example` (',
        '  `id` VARCHAR(191) NOT NULL,',
        '  UNIQUE INDEX `Example_orgId_date_uq`(`id`),',
        '  PRIMARY KEY (`id`)',
        ');'
      ].join('\n')
    );

    const violations = findMigrationIdentifierViolations({
      migrationsDir: tempDir,
      maxLength: 64
    });

    assert.equal(violations.length, 0);
  });

  it('finds over-limit identifiers and reports line numbers', () => {
    const longIdentifier = 'RssTranslationMetricsDaily_orgId_date_provider_targetLanguage_key';
    const sqlPath = writeMigrationSql(
      'long_case',
      [
        'CREATE TABLE `RssTranslationMetricsDaily` (',
        '  `id` VARCHAR(191) NOT NULL,',
        `  UNIQUE INDEX \`${longIdentifier}\`(\`id\`),`,
        '  PRIMARY KEY (`id`)',
        ');'
      ].join('\n')
    );

    const violations = findMigrationIdentifierViolations({
      migrationsDir: tempDir,
      maxLength: 64
    });

    const found = violations.find((item) => item.identifier === longIdentifier);
    assert.ok(found);
    assert.equal(found.length, longIdentifier.length);
    assert.equal(found.line, 3);
    assert.equal(found.filePath, sqlPath);
  });

  it('throws with actionable error details from assertion helper', () => {
    const longIdentifier = 'RssTranslationMetricsDaily_orgId_date_provider_targetLanguage_key';
    writeMigrationSql(
      'assert_case',
      [
        'CREATE TABLE `RssTranslationMetricsDaily` (',
        '  `id` VARCHAR(191) NOT NULL,',
        `  UNIQUE INDEX \`${longIdentifier}\`(\`id\`),`,
        '  PRIMARY KEY (`id`)',
        ');'
      ].join('\n')
    );

    assert.throws(
      () =>
        assertMigrationIdentifiersWithinLimit({
          migrationsDir: tempDir,
          maxLength: 64
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Found migration identifier\(s\) longer than 64/);
        assert.match(error.message, /Fix by setting `map:` on @@index\/@@unique/);
        assert.match(error.message, /assert_case[\\/]+migration\.sql:3/);
        assert.match(error.message, /RssTranslationMetricsDaily_orgId_date_provider_targetLanguage_key/);
        return true;
      }
    );
  });

  it('allows grandfathered identifiers in preserved historical migrations', () => {
    writeMigrationSql(
      '20260306120000_add_archive_article_classification',
      [
        'CREATE TABLE `ArchiveVerticalAnchorEmbedding` (',
        '  `id` VARCHAR(191) NOT NULL,',
        '  UNIQUE INDEX `ArchiveVerticalAnchorEmbedding_vertical_taxonomyVersion_embeddingModel_anchorTextHash_key`(`id`),',
        '  PRIMARY KEY (`id`)',
        ');'
      ].join('\n')
    );

    const violations = findMigrationIdentifierViolations({
      migrationsDir: tempDir,
      maxLength: 64
    });

    assert.equal(
      violations.some(
        (item) =>
          item.identifier ===
          'ArchiveVerticalAnchorEmbedding_vertical_taxonomyVersion_embeddingModel_anchorTextHash_key'
      ),
      false
    );
  });
});
