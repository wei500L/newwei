import { parse as parseDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration resolver for the local development launcher.
 *
 * The launcher is intentionally small: it loads the repository-root `.env`,
 * applies the mode-specific API/Socket.IO/port values, then spawns one child
 * process per service. It does not wrap Turbo, run migrations, start Docker or
 * touch any external service. Keeping the resolution pure (no process spawn,
 * no `process.exit`) is what makes the behaviour testable in `apps/web`'s
 * existing Vitest suite.
 *
 * Precedence, highest first:
 *   1. variables already present in the caller's environment (`process.env`);
 *   2. the mode overlay (`api-go-cutover.env.sample` / `legacy-rollback.env.sample`
 *      for the switches, plus the local address/path constants below);
 *   3. the repository-root `.env` file.
 *
 * `.env` is resolved from the repository root derived from this module's URL,
 * never from `process.cwd()`, so `pnpm dev` behaves the same when invoked from
 * any workspace directory.
 */

export type DevMode = "go" | "legacy" | "ais-relay";

export interface DevChild {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DevPlan {
  mode: DevMode;
  children: DevChild[];
  warnings: string[];
}

export interface BuildDevPlanOptions {
  mode: DevMode;
  repoRoot: string;
  fileEnv: Record<string, string>;
  processEnv: Record<string, string | undefined>;
  /** Test seam; production callers let the resolver read the checked-in samples. */
  modeEnv?: Record<string, string>;
}

const EXPECTED_GO_MODE_COUNT = 136;
const DEFAULT_GO_API_PORT = 4020;
const DEFAULT_LEGACY_API_PORT = 4000;
const DEFAULT_VECTOR_PORT = 4010;
const DEFAULT_WEB_PORT = 3000;
const DEFAULT_AIS_PORT = 3004;

/** Accepted fallback values for the two switches that never had a `legacy` value. */
const SHADOW_FALLBACK_SWITCHES = new Set([
  "API_GO_ONBOARDING_MODE",
  "API_GO_USER_SETTINGS_READ_MODE",
]);

const MODE_KEY_PATTERN = /^API_GO_[A-Z0-9_]+_MODE$/;

/** Parse `.env` text with the same parser the rest of the Node tooling uses. */
export function parseEnvText(text: string): Record<string, string> {
  return parseDotenv(text);
}

/** Read and parse one dotenv file. Missing files are left to the caller to report. */
export function readEnvFile(filePath: string): Record<string, string> {
  return parseEnvText(readFileSync(filePath, "utf8"));
}

/** Resolve the repository root from a module URL (never from `process.cwd()`). */
export function resolveRepoRootFromModuleUrl(moduleUrl: string): string {
  return path.resolve(fileURLToPath(new URL("../../../", moduleUrl)));
}

/** Find duplicated keys in a dotenv file; the last assignment would win silently. */
export function findDuplicateEnvKeys(text: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!key) {
      continue;
    }
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }
  return [...duplicates].sort();
}

/** Read the mode switches from the checked-in all-go / legacy rollback samples. */
export function readModeOverlay(
  repoRoot: string,
  mode: Exclude<DevMode, "ais-relay">,
): Record<string, string> {
  const samplePath = path.join(
    repoRoot,
    "infra",
    "docker",
    mode === "go"
      ? "api-go-cutover.env.sample"
      : "legacy-rollback.env.sample",
  );
  const parsed = readEnvFile(samplePath);
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // The all-go sample also carries container hosts and placeholder
    // credentials. Only the execution-ownership switches belong in the local
    // overlay; resources must always come from the caller's `.env`.
    if (MODE_KEY_PATTERN.test(key) || key === "CANARY_PERCENT") {
      overlay[key] = value;
    }
  }
  return overlay;
}

function readPositivePort(
  env: Record<string, string>,
  key: string,
  fallback: number,
): string {
  const raw = (env[key] ?? "").trim();
  if (!raw) {
    return String(fallback);
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(
      `${key} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Rebuild `DATABASE_URL` from `MYSQL_*` when it is empty, matching the
 * established Nest/Prisma host-side contract. The Go binary itself does not
 * derive it, so `pnpm dev` performs the same derivation before spawning
 * `api-go`. Every MySQL field is required (including the password): an
 * incomplete set is left empty and Go fails its own startup validation rather
 * than receiving a fabricated connection string.
 */
export function deriveDatabaseUrl(env: Record<string, string>): string {
  const explicit = (env.DATABASE_URL ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const host = (env.MYSQL_HOST ?? "").trim();
  const user = (env.MYSQL_USER ?? "").trim();
  const password = env.MYSQL_PASSWORD ?? "";
  const database = (env.MYSQL_DB ?? "").trim();
  const port = (env.MYSQL_PORT ?? "").trim() || "3306";
  if (
    !host ||
    !user ||
    !password ||
    !database ||
    !/^[1-9][0-9]*$/u.test(port)
  ) {
    return "";
  }
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

function mergeEnvironment(
  fileEnv: Record<string, string>,
  modeEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileEnv)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(modeEnv)) {
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  return merged;
}

function countBusinessModes(switches: Record<string, string>): number {
  return Object.keys(switches).filter(
    (key) => MODE_KEY_PATTERN.test(key) && key !== "API_GO_LEGACY_FALLBACK_MODE",
  ).length;
}

function buildSwitchOverlay(
  mode: Exclude<DevMode, "ais-relay">,
  repoRoot: string,
  provided?: Record<string, string>,
): Record<string, string> {
  const switches = provided ?? readModeOverlay(repoRoot, mode);
  const count = countBusinessModes(switches);
  if (count !== EXPECTED_GO_MODE_COUNT) {
    throw new Error(
      `mode overlay for ${mode} has ${count} business API_GO_*_MODE entries, expected ${EXPECTED_GO_MODE_COUNT}`,
    );
  }
  if (mode === "go") {
    for (const [key, value] of Object.entries(switches)) {
      if (key === "API_GO_LEGACY_FALLBACK_MODE") {
        if (value !== "reject") {
          throw new Error(
            "API_GO_LEGACY_FALLBACK_MODE must be reject for the Go chain",
          );
        }
        continue;
      }
      if (MODE_KEY_PATTERN.test(key) && value !== "go") {
        throw new Error(
          `${key} must be go in api-go-cutover.env.sample`,
        );
      }
    }
    if ((switches.CANARY_PERCENT ?? "0") !== "0") {
      throw new Error("CANARY_PERCENT must be 0 for the Go chain");
    }
  } else {
    for (const [key, value] of Object.entries(switches)) {
      if (
        !MODE_KEY_PATTERN.test(key) ||
        key === "API_GO_LEGACY_FALLBACK_MODE"
      ) {
        continue;
      }
      const expected = SHADOW_FALLBACK_SWITCHES.has(key) ? "shadow" : "legacy";
      if (value !== expected) {
        throw new Error(
          `${key} must be ${expected} in legacy-rollback.env.sample`,
        );
      }
    }
    if (switches.API_GO_LEGACY_FALLBACK_MODE !== "proxy") {
      throw new Error(
        "API_GO_LEGACY_FALLBACK_MODE must be proxy for the legacy chain",
      );
    }
  }
  return switches;
}

interface ServicePorts {
  api: string;
  vector: string;
  ais: string;
  web: string;
}

function buildAddressOverlay(
  mode: Exclude<DevMode, "ais-relay">,
  ports: ServicePorts,
): Record<string, string> {
  const apiBase = `http://localhost:${ports.api}`;
  return {
    API_BASE_URL: apiBase,
    NEXT_PUBLIC_API_BASE_URL: `${apiBase}/api`,
    NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH:
      mode === "go" ? "/socket.io-notifications" : "/socket.io",
    NEXT_PUBLIC_REALTIME_SOCKET_PATH:
      mode === "go" ? "/socket.io-realtime" : "/socket.io",
    VECTOR_SERVICE_BASE_URL: `http://localhost:${ports.vector}`,
    REALTIME_SIGNALS_AIS_BASE_URL: `http://localhost:${ports.ais}`,
    NEXTAUTH_URL: `http://localhost:${ports.web}`,
    CORS_ORIGIN: `http://localhost:${ports.web}`,
  };
}

/**
 * Build the child-process plan for one local chain.
 *
 * `go` starts api-go + vector-go + web; `legacy` starts the three NestJS/Node
 * backends + web; `ais-relay` starts only the Go relay. Each child receives its
 * own `PORT`, so the API, vector and Web processes never share one global value.
 */
export function buildDevPlan(options: BuildDevPlanOptions): DevPlan {
  const { mode, repoRoot, fileEnv, processEnv } = options;
  const warnings: string[] = [];

  if (mode === "ais-relay") {
    const merged = mergeEnvironment(fileEnv, {}, processEnv);
    const port = readPositivePort(merged, "AIS_RELAY_PORT", DEFAULT_AIS_PORT);
    if (!(merged.AISSTREAM_API_KEY ?? "").trim()) {
      warnings.push(
        "AISSTREAM_API_KEY is empty; the Go AIS relay will fail to start",
      );
    }
    return {
      mode,
      warnings,
      children: [
        {
          name: "ais-relay",
          cwd: path.join(repoRoot, "apps", "api-go"),
          command: "go",
          args: ["run", "./cmd/ais-relay"],
          env: { ...merged, PORT: port },
        },
      ],
    };
  }

  const switches = buildSwitchOverlay(mode, repoRoot, options.modeEnv);
  const mergedSwitches = mergeEnvironment(fileEnv, switches, processEnv);
  const webPort = readPositivePort(
    mergedSwitches,
    "DEV_WEB_PORT",
    DEFAULT_WEB_PORT,
  );
  const vectorPort = readPositivePort(
    mergedSwitches,
    "DEV_VECTOR_PORT",
    DEFAULT_VECTOR_PORT,
  );
  const aisPort = readPositivePort(
    mergedSwitches,
    "AIS_RELAY_PORT",
    DEFAULT_AIS_PORT,
  );
  const apiPort = readPositivePort(
    mergedSwitches,
    mode === "go" ? "DEV_GO_API_PORT" : "DEV_LEGACY_API_PORT",
    mode === "go" ? DEFAULT_GO_API_PORT : DEFAULT_LEGACY_API_PORT,
  );
  const addresses = buildAddressOverlay(mode, {
    api: apiPort,
    vector: vectorPort,
    ais: aisPort,
    web: webPort,
  });
  const merged = mergeEnvironment(
    mergedSwitches,
    addresses,
    processEnv,
  );

  const requiredResources = [
    "JWT_SECRET",
    "MONGO_URI",
    "REDIS_HOST",
    "SYSTEM_SETTINGS_ENCRYPTION_KEY",
    "NEXTAUTH_SECRET",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "CRAWL4AI_BASE_URL",
    "VECTOR_INTERNAL_TOKEN",
  ];
  const missingResources = requiredResources.filter(
    (key) => !(merged[key] ?? "").trim(),
  );
  if (missingResources.length > 0) {
    warnings.push(
      `missing required local resources: ${missingResources.join(", ")}`,
    );
  }
  if (!(merged.DATABASE_URL ?? "").trim() && !deriveDatabaseUrl(merged)) {
    warnings.push(
      "DATABASE_URL is empty and MYSQL_* is incomplete; the API will fail its own startup validation",
    );
  }

  const sharedCwd = repoRoot;
  const web: DevChild = {
    name: "web",
    cwd: path.join(repoRoot, "apps", "web"),
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["run", "dev", "--", "--port", webPort],
    env: { ...merged, PORT: webPort },
  };

  if (mode === "go") {
    const apiEnv: Record<string, string> = { ...merged, PORT: apiPort };
    if (!(merged.DATABASE_URL ?? "").trim()) {
      const derived = deriveDatabaseUrl(merged);
      if (derived) {
        apiEnv.DATABASE_URL = derived;
      }
    }
    return {
      mode,
      warnings,
      children: [
        {
          name: "api-go",
          cwd: path.join(sharedCwd, "apps", "api-go"),
          command: "go",
          args: ["run", "./cmd/api"],
          env: apiEnv,
        },
        {
          name: "vector-go",
          cwd: path.join(sharedCwd, "apps", "vector-go"),
          command: "go",
          args: ["run", "."],
          env: { ...merged, PORT: vectorPort },
        },
        web,
      ],
    };
  }

  return {
    mode,
    warnings,
    children: [
      {
        name: "api",
        cwd: path.join(sharedCwd, "apps", "api"),
        command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        args: ["run", "dev"],
        env: { ...merged, PORT: apiPort },
      },
      {
        name: "vector",
        cwd: path.join(sharedCwd, "apps", "vector"),
        command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        args: ["run", "dev"],
        env: { ...merged, PORT: vectorPort },
      },
      {
        name: "ais-relay",
        cwd: path.join(sharedCwd, "apps", "ais-relay"),
        command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        args: ["run", "dev"],
        env: { ...merged, PORT: aisPort },
      },
      web,
    ],
  };
}
