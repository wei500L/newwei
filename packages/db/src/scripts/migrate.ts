import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { baseEnvSchema, loadAndValidateEnv } from "@modular/utils";
import { z } from "zod";

const schema = baseEnvSchema.extend({
  DATABASE_URL: z.string().optional()
});

const env = loadAndValidateEnv(schema, {
  dotenvPath: path.resolve(process.cwd(), "../../.env"),
  overrideProcessEnv: false
});

const connectionString =
  env.DATABASE_URL ??
  `mysql://${env.MYSQL_USER}:${encodeURIComponent(env.MYSQL_PASSWORD)}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DB}`;

process.env.DATABASE_URL = connectionString;

try {
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: connectionString },
    cwd: path.resolve(process.cwd())
  });
  execSync("pnpm exec prisma generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: connectionString },
    cwd: path.resolve(process.cwd())
  });
  console.log("Prisma migrations deployed successfully");
} catch (error) {
  console.error("Failed to run migrations", error);
  process.exit(1);
}
