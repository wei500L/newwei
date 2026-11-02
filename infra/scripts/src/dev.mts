import { existsSync } from "node:fs";
import path from "node:path";

import {
  buildDevPlan,
  readEnvFile,
  resolveRepoRootFromModuleUrl,
  type DevChild,
  type DevMode,
} from "./dev-config";
import { runChildren } from "./dev-process";

const MODES: readonly DevMode[] = ["go", "ais-relay"];

function parseMode(value: string | undefined): DevMode {
  const mode = value ?? "go";
  if (mode !== "go" && mode !== "ais-relay") {
    throw new Error(
      `unknown dev mode ${JSON.stringify(value)}; expected one of ${MODES.join("|")}`,
    );
  }
  return mode;
}

function formatChild(repoRoot: string, child: DevChild): string {
  const relativeCwd = path.relative(repoRoot, child.cwd) || ".";
  const command = [child.command, ...child.args].join(" ");
  return `${child.name}: ${command} (cwd=${relativeCwd}, PORT=${child.env.PORT ?? "<unset>"})`;
}

const args = process.argv.slice(2);
const mode = parseMode(args.find((arg) => !arg.startsWith("--")));
const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);
const envPath = path.join(repoRoot, ".env");
const dryRun = args.includes("--dry-run");

if (!existsSync(envPath)) {
  process.stderr.write(
    `[dev] missing ${envPath}; copy .env.example to .env and fill the required resources/secrets first\n`,
  );
  process.exitCode = 1;
} else {
  try {
    const fileEnv = readEnvFile(envPath);
    const plan = buildDevPlan({
      mode,
      repoRoot,
      fileEnv,
      processEnv: process.env,
    });

    process.stderr.write(`[dev] mode=${mode} env=${envPath}\n`);
    for (const warning of plan.warnings) {
      process.stderr.write(`[dev] warning: ${warning}\n`);
    }
    for (const child of plan.children) {
      process.stderr.write(`[dev] ${formatChild(repoRoot, child)}\n`);
    }

    if (dryRun) {
      process.stderr.write("[dev] dry run: no child process was started\n");
    } else {
      const exitCode = await runChildren(plan.children);
      process.exitCode = exitCode;
    }
  } catch (error) {
    process.stderr.write(
      `[dev] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
