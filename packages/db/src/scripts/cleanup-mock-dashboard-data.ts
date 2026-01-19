import { baseEnvSchema, loadAndValidateEnv } from '@modular/utils';
import { AlertMetricProvider, PrismaClient } from '@prisma/client';
import path from 'node:path';
import process from 'node:process';

const SEEDED_ALERT_RULE_IDS = [
  'rule-global-conflict-index',
  'rule-market-sentiment',
  'rule-resource-scarcity',
  'rule-supply-chain-stability',
];

async function main() {
  const confirmed = process.argv.includes('--confirm');
  const env = loadAndValidateEnv(baseEnvSchema, {
    dotenvPath: path.resolve(process.cwd(), '../../.env'),
    overrideProcessEnv: true,
  });

  const connectionString =
    process.env.DATABASE_URL ??
    `mysql://${env.MYSQL_USER}:${encodeURIComponent(env.MYSQL_PASSWORD)}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DB}`;

  process.env.DATABASE_URL = connectionString;

  const prisma = new PrismaClient();
  try {
    const mockItems = await prisma.economicDataItem.findMany({
      where: { sourceFunction: 'mock', sourceEndpoint: 'mock' },
      select: { id: true, slug: true },
    });

    const mockItemIds = mockItems.map((item) => item.id);
    const mockSlugs = mockItems.map((item) => item.slug);

    const mockPoints = mockItemIds.length
      ? await prisma.economicDataPoint.count({ where: { itemId: { in: mockItemIds } } })
      : 0;

    const rulesToDelete = await prisma.alertRule.count({
      where: {
        OR: [
          { id: { in: SEEDED_ALERT_RULE_IDS } },
          ...(mockItemIds.length ? [{ dataItemId: { in: mockItemIds } }] : []),
          ...(mockSlugs.length
            ? [
                {
                  metricProvider: AlertMetricProvider.economic_data,
                  metricSlug: { in: mockSlugs },
                },
              ]
            : []),
        ],
      },
    });

    console.log(`[cleanup] Found mock economic items: ${mockItems.length}`);
    console.log(`[cleanup] Found mock economic points: ${mockPoints}`);
    console.log(`[cleanup] Alert rules to delete (seeded or referencing mock items): ${rulesToDelete}`);

    if (!confirmed) {
      console.error(
        [
          '[cleanup] Refusing to run without --confirm.',
          'Re-run with: pnpm --filter db run cleanup:mock-dashboard -- --confirm',
        ].join(' ')
      );
      process.exit(1);
    }

    const deletedSeedRules = await prisma.alertRule.deleteMany({
      where: { id: { in: SEEDED_ALERT_RULE_IDS } },
    });

    const deletedRulesByDataItem = mockItemIds.length
      ? await prisma.alertRule.deleteMany({
          where: { dataItemId: { in: mockItemIds } },
        })
      : { count: 0 };

    const deletedRulesByMetricSlug = mockSlugs.length
      ? await prisma.alertRule.deleteMany({
          where: {
            metricProvider: AlertMetricProvider.economic_data,
            metricSlug: { in: mockSlugs },
          },
        })
      : { count: 0 };

    const deletedMockItems = mockItemIds.length
      ? await prisma.economicDataItem.deleteMany({
          where: { id: { in: mockItemIds } },
        })
      : { count: 0 };

    console.log(`[cleanup] Deleted alert rules (seeded): ${deletedSeedRules.count}`);
    console.log(`[cleanup] Deleted alert rules (dataItemId): ${deletedRulesByDataItem.count}`);
    console.log(`[cleanup] Deleted alert rules (metricSlug): ${deletedRulesByMetricSlug.count}`);
    console.log(`[cleanup] Deleted mock economic items: ${deletedMockItems.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[cleanup] Failed to cleanup mock dashboard data', error);
  process.exit(1);
});

