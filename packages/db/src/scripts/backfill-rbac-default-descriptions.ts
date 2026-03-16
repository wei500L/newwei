import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";
import path from "node:path";
import process from "node:process";

import { prisma } from "../client";
import { backfillRbacDefaultDescriptions } from "../rbac-default-description-backfill";

const env = loadAndValidateEnv(
  baseEnvSchema.pick({
    DATABASE_URL: true,
    MYSQL_HOST: true,
    MYSQL_PORT: true,
    MYSQL_USER: true,
    MYSQL_PASSWORD: true,
    MYSQL_DB: true,
  }),
  {
    dotenvPath: path.resolve(process.cwd(), "../../.env"),
    overrideProcessEnv: false,
  },
);

const connectionString = resolveMysqlConnectionString(env);

process.env.DATABASE_URL = connectionString;

backfillRbacDefaultDescriptions(prisma)
  .then(async (result) => {
    console.log(
      [
        "RBAC default descriptions backfilled successfully.",
        `Permissions updated: ${result.updatedPermissions}`,
        `Roles updated: ${result.updatedRoles}`,
      ].join(" "),
    );
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Failed to backfill RBAC default descriptions", error);
    await prisma.$disconnect();
    process.exit(1);
  });
