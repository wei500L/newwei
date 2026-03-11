import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
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

try {
  execSync("pnpm exec prisma generate --schema prisma/schema.prisma", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: connectionString },
    cwd: path.resolve(process.cwd()),
  });
  ensureWorkspacePrismaClient();
  console.log("Prisma client generated and ready");
} catch (error) {
  console.error("Failed to generate Prisma client", error);
  process.exit(1);
}

function ensureWorkspacePrismaClient() {
  const dbPackageDir = process.cwd();
  const workspaceRoot = path.resolve(dbPackageDir, "../..");

  const workspacePrismaDir = path.resolve(
    workspaceRoot,
    "node_modules/.prisma",
  );
  const candidatePrismaDirs = new Set<string>([
    path.resolve(dbPackageDir, "node_modules/.prisma"),
    resolvePrismaDirNearClient(workspaceRoot),
    path.resolve(workspaceRoot, "node_modules/.pnpm/node_modules/.prisma"),
    workspacePrismaDir,
  ]);

  let sourcePrismaDir: string | undefined;
  for (const candidate of candidatePrismaDirs) {
    if (candidate && hasPrismaClient(candidate)) {
      sourcePrismaDir = candidate;
      break;
    }
  }

  if (!sourcePrismaDir) {
    throw new Error(
      [
        "Prisma client generation did not produce expected output.",
        `Checked workspace: ${workspacePrismaDir}`,
        ...Array.from(candidatePrismaDirs)
          .filter(Boolean)
          .map((candidate) => `Checked candidate: ${candidate}`),
      ].join("\n"),
    );
  }

  if (sourcePrismaDir !== workspacePrismaDir) {
    rmSync(workspacePrismaDir, { recursive: true, force: true });
    mkdirSync(path.dirname(workspacePrismaDir), { recursive: true });
    cpSync(sourcePrismaDir, workspacePrismaDir, {
      recursive: true,
      dereference: true,
    });
  }

  if (!hasPrismaClient(workspacePrismaDir)) {
    throw new Error(
      [
        "Failed to place Prisma client in workspace node_modules.",
        `Source: ${sourcePrismaDir}`,
        `Target: ${workspacePrismaDir}`,
      ].join("\n"),
    );
  }
}

function hasPrismaClient(prismaDir: string): boolean {
  return (
    existsSync(path.resolve(prismaDir, "client", "default.js")) ||
    existsSync(path.resolve(prismaDir, "client", "default.cjs")) ||
    existsSync(path.resolve(prismaDir, "client", "default", "index.js")) ||
    existsSync(path.resolve(prismaDir, "client", "default", "index.cjs")) ||
    existsSync(path.resolve(prismaDir, "client", "default.mjs")) ||
    existsSync(path.resolve(prismaDir, "client", "index.mjs")) ||
    existsSync(path.resolve(prismaDir, "client", "index.js")) ||
    existsSync(path.resolve(prismaDir, "client", "index.cjs"))
  );
}

function resolvePrismaDirNearClient(workspaceRoot: string): string {
  try {
    const nodeRequire = createRequire(
      path.resolve(workspaceRoot, "package.json"),
    );
    const prismaClientPkgJson = nodeRequire.resolve(
      "@prisma/client/package.json",
      {
        paths: [workspaceRoot, process.cwd()],
      },
    );

    const prismaClientDir = path.dirname(prismaClientPkgJson);
    const prismaClientNodeModulesDir = path.resolve(prismaClientDir, "../..");
    return path.resolve(prismaClientNodeModulesDir, ".prisma");
  } catch {
    return "";
  }
}
