import {
  CORE_PERMISSION_DEFINITIONS,
  DEFAULT_ROLES,
} from "@modular/config";
import { NEWS_INDICATOR_RECOMMENDED_SLUGS } from "@modular/utils";
import { hash as bcryptHash } from "bcrypt";

import { prisma } from "./client";

export interface SeedOptions {
  orgSlug: string;
  orgName: string;
  orgDescription?: string | null;
  adminEmail: string;
  adminPassword: string;
  adminFirstName: string;
  adminLastName: string;
}

const NEWS_INDICATOR_SETTINGS_KEY_PREFIX = "news_indicator_association_settings:";
const PASSWORD_RESET_RATE_LIMIT_FEATURE = "auth.password_reset";

async function seedNewsIndicatorSettings(input: { orgId: string; updatedById?: string | null }) {
  const key = `${NEWS_INDICATOR_SETTINGS_KEY_PREFIX}${input.orgId}`;

  const existing = await prisma.systemSetting.findUnique({ where: { key } });
  const existingValueRaw: unknown = existing?.value ?? null;
  const existingValue =
    existingValueRaw && typeof existingValueRaw === "object" && !Array.isArray(existingValueRaw)
      ? (existingValueRaw as Record<string, unknown>)
      : null;
  const existingSlugs = Array.isArray(existingValue?.indicatorSlugs)
    ? existingValue.indicatorSlugs
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    : [];
  const resolvedSlugs = existingSlugs.length > 0 ? existingSlugs : [...NEWS_INDICATOR_RECOMMENDED_SLUGS];
  const ingestionEnabled = typeof existingValue?.ingestionEnabled === "boolean" ? existingValue.ingestionEnabled : false;

  await prisma.systemSetting.upsert({
    where: { key },
    update: {
      value: {
        ...(existingValue ?? {}),
        enabled: true,
        ingestionEnabled,
        indicatorSlugs: Array.from(new Set(resolvedSlugs))
      },
      description: `News indicator association settings (org=${input.orgId})`,
      ...(input.updatedById ? { updatedById: input.updatedById } : {})
    },
    create: {
      key,
      value: {
        enabled: true,
        ingestionEnabled: false,
        windowDays: 180,
        maxLagDays: 7,
        minSampleSize: 30,
        minAbsCorrelation: 0.2,
        maxPValue: 0.2,
        topEntities: 50,
        topTopics: 50,
        maxAssociationsPerIndicator: 60,
        indicatorSlugs: [...NEWS_INDICATOR_RECOMMENDED_SLUGS],
        backtestTriggerZScore: 2,
        backtestBaselineDays: 30,
        backtestHoldoutDays: 30,
        cacheTtlSeconds: 120
      },
      description: `News indicator association settings (org=${input.orgId})`,
      ...(input.updatedById ? { updatedById: input.updatedById } : {})
    }
  });
}

async function seedPasswordResetRateLimitPolicy(input: {
  updatedById?: string | null;
}) {
  await prisma.rateLimitPolicy.upsert({
    where: { feature: PASSWORD_RESET_RATE_LIMIT_FEATURE },
    update: {},
    create: {
      feature: PASSWORD_RESET_RATE_LIMIT_FEATURE,
      userLimit: 3,
      ipLimit: 10,
      windowSeconds: 900,
      enabled: true,
      description:
        "Password reset requests; user limit applies per normalized email.",
      ...(input.updatedById ? { updatedById: input.updatedById } : {})
    }
  });
}

export const seed = async ({
  orgSlug,
  orgName,
  orgDescription = null,
  adminEmail,
  adminPassword,
  adminFirstName,
  adminLastName
}: SeedOptions) => {
  const normalizedOrgSlug = orgSlug.trim();
  const normalizedOrgName = orgName.trim();
  const normalizedAdminEmail = adminEmail.trim().toLowerCase();
  const normalizedAdminPassword = adminPassword.trim();
  const normalizedAdminFirstName = adminFirstName.trim();
  const normalizedAdminLastName = adminLastName.trim();

  if (!normalizedOrgSlug) {
    throw new Error("Seed requires orgSlug");
  }

  if (!normalizedOrgName) {
    throw new Error("Seed requires orgName");
  }

  if (!normalizedAdminEmail) {
    throw new Error("Seed requires adminEmail");
  }

  if (!normalizedAdminPassword.trim()) {
    throw new Error("Seed requires adminPassword");
  }

  if (!normalizedAdminFirstName) {
    throw new Error("Seed requires adminFirstName");
  }

  if (!normalizedAdminLastName) {
    throw new Error("Seed requires adminLastName");
  }

  const org = await prisma.org.upsert({
    where: { slug: normalizedOrgSlug },
    update: {},
    create: {
      name: normalizedOrgName,
      slug: normalizedOrgSlug,
      description: orgDescription,
      isActive: true
    }
  });

  await Promise.all(
    CORE_PERMISSION_DEFINITIONS.map((permission) =>
      prisma.permission.upsert({
        where: { name: permission.name },
        update: {},
        create: {
          name: permission.name,
          description: permission.description,
        },
      })
    ),
  );

  for (const roleDef of DEFAULT_ROLES) {
    const role = await prisma.role.upsert({
      where: {
        orgId_name: {
          orgId: org.id,
          name: roleDef.name
        }
      },
      update: {
        isSystem: roleDef.isSystem ?? false
      },
      create: {
        name: roleDef.name,
        description: roleDef.description,
        orgId: org.id,
        isSystem: roleDef.isSystem ?? false
      }
    });

    const permissions = await prisma.permission.findMany({
      where: { name: { in: [...roleDef.permissions] } }
    });

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id
          }
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id
        }
      });
    }
  }

  const passwordHash = await bcryptHash(normalizedAdminPassword, 10);
  const adminUser = await prisma.user.upsert({
    where: { email: normalizedAdminEmail },
    update: {
      passwordHash,
      firstName: normalizedAdminFirstName,
      lastName: normalizedAdminLastName,
      isActive: true,
      emailVerified: new Date()
    },
    create: {
      email: normalizedAdminEmail,
      passwordHash,
      firstName: normalizedAdminFirstName,
      lastName: normalizedAdminLastName,
      isActive: true,
      emailVerified: new Date()
    }
  });

  const adminRole = await prisma.role.findFirstOrThrow({
    where: { orgId: org.id, name: "admin" }
  });

  await prisma.membership.upsert({
    where: {
      userId_orgId: {
        userId: adminUser.id,
        orgId: org.id
      }
    },
    update: {
      roleId: adminRole.id
    },
    create: {
      userId: adminUser.id,
      orgId: org.id,
      roleId: adminRole.id
    }
  });

  await prisma.membershipRole.upsert({
    where: {
      membershipId_roleId: {
        membershipId: (
          await prisma.membership.findUniqueOrThrow({
            where: {
              userId_orgId: {
                userId: adminUser.id,
                orgId: org.id
              }
            }
          })
        ).id,
        roleId: adminRole.id
      }
    },
    update: {},
    create: {
      membershipId: (
        await prisma.membership.findUniqueOrThrow({
          where: {
            userId_orgId: {
              userId: adminUser.id,
              orgId: org.id
            }
          }
        })
      ).id,
      orgId: org.id,
      roleId: adminRole.id
    }
  });

  await prisma.globalRoleAssignment.upsert({
    where: {
      userId_role: {
        userId: adminUser.id,
        role: "platform_admin"
      }
    },
    update: {},
    create: {
      userId: adminUser.id,
      role: "platform_admin"
    }
  });

  await seedNewsIndicatorSettings({ orgId: org.id, updatedById: adminUser.id });
  await seedPasswordResetRateLimitPolicy({ updatedById: adminUser.id });

  return org;
};

if (require.main === module) {
  seed({
    orgSlug: process.env.SEED_ORG_SLUG ?? "",
    orgName: process.env.SEED_ORG_NAME ?? "",
    orgDescription: process.env.SEED_ORG_DESCRIPTION ?? null,
    adminEmail: process.env.SEED_ADMIN_EMAIL ?? "",
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? "",
    adminFirstName: process.env.SEED_ADMIN_FIRST_NAME ?? "",
    adminLastName: process.env.SEED_ADMIN_LAST_NAME ?? ""
  })
    .then((org) => {
      console.log("Seed data ready for org", org.slug);
      return prisma.$disconnect();
    })
    .catch(async (error) => {
      console.error(error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
