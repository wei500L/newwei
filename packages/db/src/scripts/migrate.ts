import { loadAndValidateEnv } from '@modular/utils';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

const schema = z
  .union([
    z.object({
      DATABASE_URL: z.string().min(1)
    }),
    z.object({
      MYSQL_HOST: z.string().min(1),
      MYSQL_PORT: z.coerce.number().int().positive(),
      MYSQL_USER: z.string().min(1),
      MYSQL_PASSWORD: z.string().min(1),
      MYSQL_DB: z.string().min(1)
    })
  ]);

const env = loadAndValidateEnv(schema, {
  dotenvPath: path.resolve(process.cwd(), '../../.env'),
  overrideProcessEnv: false
});

const connectionString =
  'DATABASE_URL' in env
    ? env.DATABASE_URL
    : `mysql://${env.MYSQL_USER}:${encodeURIComponent(env.MYSQL_PASSWORD)}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DB}`;

process.env.DATABASE_URL = connectionString;

const workingDir = path.resolve(process.cwd());
const execEnv = { ...process.env, DATABASE_URL: connectionString };
const schemaArgs = ['--schema', 'prisma/schema.prisma'];
const requestedAutoResolveFailedMigrations = ['1', 'true'].includes(
  (process.env.PRISMA_AUTO_RESOLVE_FAILED_MIGRATIONS ?? '').toLowerCase()
);
const autoResolveFailedMigrations =
  requestedAutoResolveFailedMigrations &&
  (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';

if (requestedAutoResolveFailedMigrations && !autoResolveFailedMigrations) {
  console.warn(
    '[migrate] PRISMA_AUTO_RESOLVE_FAILED_MIGRATIONS is enabled but NODE_ENV=production; skipping auto-resolve.'
  );
}

try {
  assertMigrationIdentifiersWithinLimit({
    migrationsDir: path.resolve(workingDir, 'prisma/migrations'),
    maxLength: 64
  });
  runPrismaMigrateDeploy({ workingDir, execEnv, schemaArgs, autoResolveFailedMigrations });
  runCommand('pnpm', ['run', 'prisma:generate'], { workingDir, execEnv });
  console.log('Prisma migrations deployed successfully');
} catch (error) {
  console.error('Failed to run migrations', error);
  process.exit(1);
}

interface RunOptions {
  workingDir: string;
  execEnv: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], options: RunOptions): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.workingDir,
    env: options.execEnv,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  return {
    status: result.status ?? 1,
    stdout,
    stderr
  };
}

function runPrismaMigrateDeploy(input: {
  workingDir: string;
  execEnv: NodeJS.ProcessEnv;
  schemaArgs: string[];
  autoResolveFailedMigrations: boolean;
}): void {
  const firstAttempt = runCommand('pnpm', ['exec', 'prisma', 'migrate', 'deploy', ...input.schemaArgs], {
    workingDir: input.workingDir,
    execEnv: input.execEnv
  });

  if (firstAttempt.status === 0) return;

  if (!input.autoResolveFailedMigrations) {
    throw new Error('Prisma migrate deploy failed.');
  }

  const combinedOutput = `${firstAttempt.stdout}\n${firstAttempt.stderr}`;
  if (!combinedOutput.includes('Error: P3009')) {
    throw new Error('Prisma migrate deploy failed.');
  }

  const failedMigrations = extractMigrationNames(combinedOutput);
  if (failedMigrations.length === 0) {
    throw new Error(
      'Prisma migrate deploy failed with P3009, but failed migration names could not be detected.'
    );
  }

  console.warn(
    [
      '[migrate] Detected failed migration records in database (P3009).',
      'Attempting to mark them as rolled back (dev-only behavior).',
      `Migrations: ${failedMigrations.join(', ')}`,
      'Set PRISMA_AUTO_RESOLVE_FAILED_MIGRATIONS=false to disable.'
    ].join(' ')
  );

  for (const migrationName of failedMigrations) {
    const resolveResult = runCommand(
      'pnpm',
      ['exec', 'prisma', 'migrate', 'resolve', '--rolled-back', migrationName, ...input.schemaArgs],
      { workingDir: input.workingDir, execEnv: input.execEnv }
    );
    if (resolveResult.status !== 0) {
      throw new Error(`Failed to mark migration as rolled back: ${migrationName}`);
    }
  }

  console.warn('[migrate] Re-running prisma migrate deploy after auto-resolve...');
  const secondAttempt = runCommand('pnpm', ['exec', 'prisma', 'migrate', 'deploy', ...input.schemaArgs], {
    workingDir: input.workingDir,
    execEnv: input.execEnv
  });

  if (secondAttempt.status !== 0) {
    throw new Error('Prisma migrate deploy failed after auto-resolving failed migrations.');
  }
}

function extractMigrationNames(output: string): string[] {
  const migrations = new Set<string>();
  const patterns = [/The `([^`]+)` migration started/g, /Migration name:\s*([^\s]+)/g];

  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const migrationName = match[1];
      if (migrationName) {
        migrations.add(migrationName);
      }
    }
  }

  return Array.from(migrations);
}

interface MigrationIdentifierViolation {
  filePath: string;
  identifier: string;
  length: number;
}

function assertMigrationIdentifiersWithinLimit(input: { migrationsDir: string; maxLength: number }): void {
  if (!existsSync(input.migrationsDir)) return;

  const sqlFiles = collectMigrationSqlFiles(input.migrationsDir);
  const violations: MigrationIdentifierViolation[] = [];

  for (const filePath of sqlFiles) {
    const sql = readFileSync(filePath, 'utf8');
    for (const identifier of extractSqlIdentifiers(sql)) {
      if (identifier.length > input.maxLength) {
        violations.push({ filePath, identifier, length: identifier.length });
      }
    }
  }

  if (violations.length === 0) return;

  violations.sort((a, b) => b.length - a.length || a.filePath.localeCompare(b.filePath));

  throw new Error(
    [
      `Found migration identifier(s) longer than ${input.maxLength} characters (MySQL limit).`,
      'Fix by setting `map:` on @@index/@@unique in prisma/schema.prisma or shortening the identifier in migration.sql.',
      '',
      ...violations.map((violation) => `${violation.length}\t${violation.identifier}\t${violation.filePath}`)
    ].join('\n')
  );
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

function extractSqlIdentifiers(sql: string): string[] {
  const identifiers = new Set<string>();
  const patterns = [/(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/g, /CONSTRAINT\s+`([^`]+)`/g];

  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) {
      const identifier = match[1];
      if (identifier) identifiers.add(identifier);
    }
  }

  return Array.from(identifiers);
}
