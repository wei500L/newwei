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

const MODES: readonly DevMode[] = ["go", "ais-relay", "globe"];

function parseMode(value: string | undefined): DevMode {
  const mode = value ?? "go";
  if (!MODES.includes(mode as DevMode)) {
    throw new Error(
      `unknown dev mode ${JSON.stringify(value)}; expected one of ${MODES.join("|")}`,
    );
  }
  return mode as DevMode;
}

/** Major version of the Node runtime, or null when it cannot be parsed. */
function nodeMajor(version: string): number | null {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * Preflight for the GEV sidecar (`pnpm dev:globe`).
 *
 * Both fixes are the operator's decision, so we report them and refuse to
 * start instead of acting: upgrading Node is environment-wide, and `npm ci`
 * downloads a few hundred MB inside the vendor tree. Never auto-installs.
 */
function preflightGlobe(repoRoot: string): boolean {
  const major = nodeMajor(process.versions.node);
  if (major === null || major < 24) {
    process.stderr.write(
      `[dev] gods-eye-view needs Node.js >= 24, but this process is ${process.versions.node}.\n` +
        "[dev] install Node 24+ (or 26) and re-run `pnpm dev:globe`; nothing was started.\n",
    );
    return false;
  }
  const modulesDir = path.join(
    repoRoot,
    "vendor",
    "gods-eye-view",
    "node_modules",
  );
  if (!existsSync(modulesDir)) {
    process.stderr.write(
      "[dev] vendor/gods-eye-view/node_modules is missing.\n" +
        "[dev] install its dependencies first, then re-run `pnpm dev:globe`:\n" +
        "[dev]   cd vendor/gods-eye-view && npm ci\n",
    );
    return false;
  }
  return true;
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
} else if (mode === "globe" && !preflightGlobe(repoRoot)) {
  // preflightGlobe already explained what to fix; do not start anything.
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
