import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface MigrationIdentifierViolation {
  filePath: string;
  identifier: string;
  length: number;
  line: number;
}

interface IdentifierMatch {
  identifier: string;
  offset: number;
}

const ALLOWED_MIGRATION_IDENTIFIER_EXCEPTIONS = new Set([
  '20260306120000_add_archive_article_classification/migration.sql::ArchiveVerticalAnchorEmbedding_vertical_taxonomyVersion_embeddingModel_anchorTextHash_key'
]);

export function assertMigrationIdentifiersWithinLimit(input: {
  migrationsDir: string;
  maxLength: number;
}): void {
  const violations = findMigrationIdentifierViolations(input);
  if (violations.length === 0) return;

  violations.sort(
    (a, b) =>
      b.length - a.length ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.identifier.localeCompare(b.identifier)
  );

  throw new Error(
    [
      `Found migration identifier(s) longer than ${input.maxLength} characters (MySQL limit).`,
      'These identifiers can make `pnpm docker:up` fail when the API runs DB migrations.',
      'Fix by setting `map:` on @@index/@@unique in prisma/schema.prisma or shortening the identifier in migration.sql.',
      '',
      ...violations.map((violation) => {
        const relativePath = path.relative(process.cwd(), violation.filePath) || violation.filePath;
        return `${violation.length}\t${violation.identifier}\t${relativePath}:${violation.line}`;
      })
    ].join('\n')
  );
}

export function findMigrationIdentifierViolations(input: {
  migrationsDir: string;
  maxLength: number;
}): MigrationIdentifierViolation[] {
  if (!existsSync(input.migrationsDir)) return [];

  const sqlFiles = collectMigrationSqlFiles(input.migrationsDir);
  const violations: MigrationIdentifierViolation[] = [];
  const seen = new Set<string>();

  for (const filePath of sqlFiles) {
    const sql = readFileSync(filePath, 'utf8');
    const relativePath = normalizeRelativePath(path.relative(input.migrationsDir, filePath));
    for (const match of extractSqlIdentifierMatches(sql)) {
      if (match.identifier.length <= input.maxLength) continue;
      if (ALLOWED_MIGRATION_IDENTIFIER_EXCEPTIONS.has(`${relativePath}::${match.identifier}`)) {
        continue;
      }

      const line = lineNumberFromOffset(sql, match.offset);
      const dedupeKey = `${filePath}:${line}:${match.identifier}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      violations.push({
        filePath,
        identifier: match.identifier,
        length: match.identifier.length,
        line
      });
    }
  }

  return violations;
}

function collectMigrationSqlFiles(dirPath: string): string[] {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMigrationSqlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'migration.sql') {
      files.push(fullPath);
    }
  }

  return files;
}

function extractSqlIdentifierMatches(sql: string): IdentifierMatch[] {
  const patterns = [/(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/g, /CONSTRAINT\s+`([^`]+)`/g];
  const matches: IdentifierMatch[] = [];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(sql);
    while (match) {
      const identifier = match[1];
      if (identifier) {
        matches.push({
          identifier,
          offset: match.index
        });
      }
      match = pattern.exec(sql);
    }
  }

  return matches;
}

function lineNumberFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
