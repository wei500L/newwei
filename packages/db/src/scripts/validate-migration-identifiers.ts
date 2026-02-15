import path from 'node:path';
import process from 'node:process';

import { assertMigrationIdentifiersWithinLimit } from './migration-identifier-validator';

try {
  assertMigrationIdentifiersWithinLimit({
    migrationsDir: path.resolve(process.cwd(), 'prisma/migrations'),
    maxLength: 64
  });
  console.log('[validate:migration-identifiers] OK');
} catch (error) {
  console.error('[validate:migration-identifiers] Failed');
  console.error(error);
  process.exit(1);
}
