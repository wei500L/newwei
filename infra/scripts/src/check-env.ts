import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "../../../packages/utils/src";

const scriptsDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(scriptsDir, "../..");
const dockerDir = path.resolve(scriptsDir, "../docker");

const rootEnv = path.resolve(repoRoot, ".env");
const dockerEnv = path.resolve(dockerDir, ".env");

const targets = [
  { label: "root", file: rootEnv },
  { label: "docker", file: dockerEnv },
];

function readDotenvValue(file: string, key: string): string | undefined {
  const text = readFileSync(file, "utf8");
  let found: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (line.slice(0, eq).trim() === key) {
      found = line.slice(eq + 1).trim();
    }
  }
  return found;
}

let hasError = false;

for (const target of targets) {
  if (!existsSync(target.file)) {
    console.warn(`⚠️  Missing ${target.label} env file at ${target.file}`);
    continue;
  }

  try {
    const env = loadAndValidateEnv(baseEnvSchema, {
      dotenvPath: target.file,
      overrideProcessEnv: false,
    });
    resolveMysqlConnectionString(env);
    // The AIS relay hard-fails at startup without its upstream API key, and
    // `api` depends on a healthy relay in the Docker stack — an empty key
    // therefore bricks the default deployment. baseEnvSchema keeps the key
    // optional for non-relay consumers, so enforce it explicitly here.
    const rawAisstreamKey = env.AISSTREAM_API_KEY;
    if (
      typeof rawAisstreamKey !== "string" ||
      rawAisstreamKey.trim().length === 0
    ) {
      throw new Error(
        "AISSTREAM_API_KEY is required: the ais-relay refuses to start without it and api depends on a healthy relay",
      );
    }
    if (target.label === "docker") {
      const rawLiteLlmMasterKey = readDotenvValue(
        target.file,
        "LITELLM_MASTER_KEY",
      );
      if (
        typeof rawLiteLlmMasterKey !== "string" ||
        rawLiteLlmMasterKey.length === 0
      ) {
        throw new Error(
          "LITELLM_MASTER_KEY is required: the LiteLLM proxy refuses to start without it",
        );
      }
    }
    console.log(`✅ ${target.label} environment configuration looks good.`);
  } catch (error) {
    hasError = true;
    console.error(`❌ ${target.label} environment failed validation`, error);
  }
}

if (hasError) {
  process.exit(1);
}
