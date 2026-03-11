import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { assertMigrationIdentifiersWithinLimit } from "./migration-identifier-validator";

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

const workingDir = path.resolve(process.cwd());
const execEnv = { ...process.env, DATABASE_URL: connectionString };
const schemaArgs = ["--schema", "prisma/schema.prisma"];
const requestedAutoResolveFailedMigrations = ["1", "true"].includes(
  (process.env.PRISMA_AUTO_RESOLVE_FAILED_MIGRATIONS ?? "").toLowerCase(),
);
const autoResolveFailedMigrations =
  requestedAutoResolveFailedMigrations &&
  (process.env.NODE_ENV ?? "").toLowerCase() !== "production";

if (requestedAutoResolveFailedMigrations && !autoResolveFailedMigrations) {
  console.warn(
    "[migrate] PRISMA_AUTO_RESOLVE_FAILED_MIGRATIONS is enabled but NODE_ENV=production; skipping auto-resolve.",
  );
}

try {
  assertMigrationIdentifiersWithinLimit({
    migrationsDir: path.resolve(workingDir, "prisma/migrations"),
    maxLength: 64,
  });
  runPrismaMigrateDeploy({
    workingDir,
    execEnv,
    schemaArgs,
    autoResolveFailedMigrations,
  });
  runCommand("pnpm", ["run", "prisma:generate"], { workingDir, execEnv });
  console.log("Prisma migrations deployed successfully");
} catch (error) {
  console.error("Failed to run migrations", error);
  process.exit(1);
}

interface RunOptions {
  workingDir: string;
  execEnv: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.workingDir,
    env: options.execEnv,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  return {
    status: result.status ?? 1,
    stdout,
    stderr,
  };
}

function runPrismaMigrateDeploy(input: {
  workingDir: string;
  execEnv: NodeJS.ProcessEnv;
  schemaArgs: string[];
  autoResolveFailedMigrations: boolean;
}): void {
  const firstAttempt = runCommand(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", ...input.schemaArgs],
    {
      workingDir: input.workingDir,
      execEnv: input.execEnv,
    },
  );

  if (firstAttempt.status === 0) return;

  if (!input.autoResolveFailedMigrations) {
    throw new Error("Prisma migrate deploy failed.");
  }

  const combinedOutput = `${firstAttempt.stdout}\n${firstAttempt.stderr}`;
  if (!combinedOutput.includes("Error: P3009")) {
    throw new Error("Prisma migrate deploy failed.");
  }

  const failedMigrations = extractMigrationNames(combinedOutput);
  if (failedMigrations.length === 0) {
    throw new Error(
      "Prisma migrate deploy failed with P3009, but failed migration names could not be detected.",
    );
  }

  console.warn(
    [
      "[migrate] Detected failed migration records in database (P3009).",
      "Attempting to mark them as rolled back (dev-only behavior).",
      `Migrations: ${failedMigrations.join(", ")}`,
      "Set PRISMA_AUTO_RESOLVE_FAILED_MIGRATIONS=false to disable.",
    ].join(" "),
  );

  for (const migrationName of failedMigrations) {
    const resolveResult = runCommand(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "resolve",
        "--rolled-back",
        migrationName,
        ...input.schemaArgs,
      ],
      { workingDir: input.workingDir, execEnv: input.execEnv },
    );
    if (resolveResult.status !== 0) {
      throw new Error(
        `Failed to mark migration as rolled back: ${migrationName}`,
      );
    }
  }

  console.warn(
    "[migrate] Re-running prisma migrate deploy after auto-resolve...",
  );
  const secondAttempt = runCommand(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", ...input.schemaArgs],
    {
      workingDir: input.workingDir,
      execEnv: input.execEnv,
    },
  );

  if (secondAttempt.status !== 0) {
    throw new Error(
      "Prisma migrate deploy failed after auto-resolving failed migrations.",
    );
  }
}

function extractMigrationNames(output: string): string[] {
  const migrations = new Set<string>();
  const patterns = [
    /The `([^`]+)` migration started/g,
    /Migration name:\s*([^\s]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const migrationName = match[1];
      if (migrationName) {
        migrations.add(migrationName);
      }
    }
  }

  return Array.from(migrations);
}
