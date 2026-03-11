import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import { seed } from "../seeds";

const env = loadAndValidateEnv(
  baseEnvSchema
    .pick({
      DATABASE_URL: true,
      MYSQL_HOST: true,
      MYSQL_PORT: true,
      MYSQL_USER: true,
      MYSQL_PASSWORD: true,
      MYSQL_DB: true,
    })
    .extend({
      SEED_ORG_SLUG: z.string().min(1),
      SEED_ORG_NAME: z.string().min(1),
      SEED_ORG_DESCRIPTION: z.string().optional(),
      SEED_ADMIN_EMAIL: z.string().email(),
      SEED_ADMIN_PASSWORD: z.string().min(1),
      SEED_ADMIN_FIRST_NAME: z.string().min(1),
      SEED_ADMIN_LAST_NAME: z.string().min(1),
    }),
  {
    dotenvPath: path.resolve(process.cwd(), "../../.env"),
    overrideProcessEnv: false,
  },
);

const connectionString = resolveMysqlConnectionString(env);

process.env.DATABASE_URL = connectionString;

seed({
  orgSlug: env.SEED_ORG_SLUG,
  orgName: env.SEED_ORG_NAME,
  orgDescription: (env.SEED_ORG_DESCRIPTION ?? "").trim() || null,
  adminEmail: env.SEED_ADMIN_EMAIL,
  adminPassword: env.SEED_ADMIN_PASSWORD,
  adminFirstName: env.SEED_ADMIN_FIRST_NAME,
  adminLastName: env.SEED_ADMIN_LAST_NAME,
})
  .then(() => {
    console.log("Seed data created");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to seed database", error);
    process.exit(1);
  });
