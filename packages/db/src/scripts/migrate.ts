import { loadAndValidateEnv } from '@modular/utils';
import { execSync } from 'node:child_process';
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
