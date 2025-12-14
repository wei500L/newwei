import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import { loadAndValidateEnv } from '@modular/utils';
import { z } from 'zod';

const schema = z
  .object({
    DATABASE_URL: z.string().optional(),
    MYSQL_HOST: z.string().min(1).optional(),
    MYSQL_PORT: z.coerce.number().int().positive().optional(),
    MYSQL_USER: z.string().min(1).optional(),
    MYSQL_PASSWORD: z.string().min(1).optional(),
    MYSQL_DB: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (value.DATABASE_URL) {
      return;
    }

    const required = [
      'MYSQL_HOST',
      'MYSQL_PORT',
      'MYSQL_USER',
      'MYSQL_PASSWORD',
      'MYSQL_DB'
    ] as const;

    for (const key of required) {
      if (value[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when DATABASE_URL is not set`
        });
      }
    }
  });

const env = loadAndValidateEnv(schema, {
  dotenvPath: path.resolve(process.cwd(), '../../.env'),
  overrideProcessEnv: false
});

const connectionString =
  env.DATABASE_URL ??
  `mysql://${env.MYSQL_USER}:${encodeURIComponent(env.MYSQL_PASSWORD)}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DB}`;

process.env.DATABASE_URL = connectionString;

try {
  execSync('pnpm exec prisma generate --schema prisma/schema.prisma', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: connectionString },
    cwd: path.resolve(process.cwd())
  });
  ensureWorkspacePrismaClient();
  console.log('Prisma client generated and ready');
} catch (error) {
  console.error('Failed to generate Prisma client', error);
  process.exit(1);
}

function ensureWorkspacePrismaClient() {
  const dbPackageDir = process.cwd();
  const workspaceRoot = path.resolve(dbPackageDir, '../..');

  const workspacePrismaDir = path.resolve(workspaceRoot, 'node_modules/.prisma');
  if (hasPrismaClient(workspacePrismaDir)) {
    return;
  }

  const candidatePrismaDirs = new Set<string>([
    path.resolve(dbPackageDir, 'node_modules/.prisma'),
    resolvePrismaDirNearClient(workspaceRoot),
    path.resolve(workspaceRoot, 'node_modules/.pnpm/node_modules/.prisma')
  ]);

  let sourcePrismaDir: string | undefined;
  for (const candidate of candidatePrismaDirs) {
    if (candidate && hasPrismaClient(candidate)) {
      sourcePrismaDir = candidate;
      break;
    }
  }

  if (!sourcePrismaDir) {
    throw new Error(
      [
        'Prisma client generation did not produce expected output.',
        `Checked workspace: ${workspacePrismaDir}`,
        ...Array.from(candidatePrismaDirs)
          .filter(Boolean)
          .map((candidate) => `Checked candidate: ${candidate}`)
      ].join('\n')
    );
  }

  rmSync(workspacePrismaDir, { recursive: true, force: true });
  mkdirSync(path.dirname(workspacePrismaDir), { recursive: true });
  cpSync(sourcePrismaDir, workspacePrismaDir, { recursive: true, dereference: true });

  if (!hasPrismaClient(workspacePrismaDir)) {
    throw new Error(
      [
        'Failed to place Prisma client in workspace node_modules.',
        `Source: ${sourcePrismaDir}`,
        `Target: ${workspacePrismaDir}`
      ].join('\n')
    );
  }
}

function hasPrismaClient(prismaDir: string): boolean {
  return (
    existsSync(path.resolve(prismaDir, 'client', 'default.js')) ||
    existsSync(path.resolve(prismaDir, 'client', 'default.cjs')) ||
    existsSync(path.resolve(prismaDir, 'client', 'default', 'index.js')) ||
    existsSync(path.resolve(prismaDir, 'client', 'default', 'index.cjs')) ||
    existsSync(path.resolve(prismaDir, 'client', 'default.mjs')) ||
    existsSync(path.resolve(prismaDir, 'client', 'index.mjs')) ||
    existsSync(path.resolve(prismaDir, 'client', 'index.js')) ||
    existsSync(path.resolve(prismaDir, 'client', 'index.cjs'))
  );
}

function resolvePrismaDirNearClient(workspaceRoot: string): string {
  try {
    const nodeRequire = createRequire(path.resolve(workspaceRoot, 'package.json'));
    const prismaClientPkgJson = nodeRequire.resolve('@prisma/client/package.json', {
      paths: [workspaceRoot, process.cwd()]
    });

    const prismaClientDir = path.dirname(prismaClientPkgJson);
    const prismaClientNodeModulesDir = path.resolve(prismaClientDir, '../..');
    return path.resolve(prismaClientNodeModulesDir, '.prisma');
  } catch {
    return '';
  }
}
