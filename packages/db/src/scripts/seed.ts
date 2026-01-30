import { baseEnvSchema, loadAndValidateEnv } from '@modular/utils';
import path from 'node:path';
import process from 'node:process';

import { seed } from '../seeds';

const env = loadAndValidateEnv(baseEnvSchema, {
  dotenvPath: path.resolve(process.cwd(), '../../.env'),
  overrideProcessEnv: true
});

const connectionString =
  process.env.DATABASE_URL ??
  `mysql://${env.MYSQL_USER}:${encodeURIComponent(env.MYSQL_PASSWORD)}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DB}`;

process.env.DATABASE_URL = connectionString;

function requireEnvValue(key: string): string {
  const value = process.env[key];
  if (typeof value !== 'string') {
    throw new Error(`Missing required env var: ${key}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return trimmed;
}

seed({
  orgSlug: requireEnvValue('SEED_ORG_SLUG'),
  orgName: requireEnvValue('SEED_ORG_NAME'),
  orgDescription: (process.env.SEED_ORG_DESCRIPTION ?? '').trim() || null,
  adminEmail: requireEnvValue('SEED_ADMIN_EMAIL'),
  adminPassword: requireEnvValue('SEED_ADMIN_PASSWORD'),
  adminFirstName: requireEnvValue('SEED_ADMIN_FIRST_NAME'),
  adminLastName: requireEnvValue('SEED_ADMIN_LAST_NAME')
})
  .then(() => {
    console.log('Seed data created');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed to seed database', error);
    process.exit(1);
  });
