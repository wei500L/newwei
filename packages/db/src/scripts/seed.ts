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

seed()
  .then(() => {
    console.log('Seed data created');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed to seed database', error);
    process.exit(1);
  });
