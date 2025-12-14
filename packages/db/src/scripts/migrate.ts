import { execSync } from 'node:child_process';
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
  execSync('pnpm exec prisma migrate deploy --schema prisma/schema.prisma', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: connectionString },
    cwd: path.resolve(process.cwd())
  });
  execSync('pnpm run prisma:generate', { stdio: 'inherit', cwd: path.resolve(process.cwd()) });
  console.log('Prisma migrations deployed successfully');
} catch (error) {
  console.error('Failed to run migrations', error);
  process.exit(1);
}
