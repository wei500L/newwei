import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  baseEnvSchema,
  isWeakCredential,
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

      const requiredSecrets: Array<{ key: string; minLength?: number }> = [
        { key: "MYSQL_PASSWORD" },
        { key: "MONGO_ROOT_PASSWORD" },
        { key: "REDIS_PASSWORD" },
        { key: "QDRANT_API_KEY" },
        { key: "ELASTICSEARCH_PASSWORD" },
        { key: "MINIO_ROOT_PASSWORD" },
        { key: "LITELLM_POSTGRES_PASSWORD" },
      ];
      for (const secret of requiredSecrets) {
        const value = readDotenvValue(target.file, secret.key);
        if (isWeakCredential(value, { minLength: secret.minLength })) {
          throw new Error(
            `${secret.key} must be a strong random secret (openssl rand -hex 24); empty and default values such as secret/minioadmin/litellm are rejected`,
          );
        }
      }

      const minioUser = readDotenvValue(target.file, "MINIO_ROOT_USER");
      if (!minioUser || minioUser.trim().length < 3 || minioUser.trim().toLowerCase() === "minioadmin") {
        throw new Error(
          "MINIO_ROOT_USER must be set and must not be the default minioadmin",
        );
      }

      const mongoUri = readDotenvValue(target.file, "MONGO_URI") ?? env.MONGO_URI;
      if (
        !mongoUri ||
        /:(secret|password|changeme|minioadmin)@/i.test(mongoUri)
      ) {
        throw new Error(
          "MONGO_URI must include the generated MONGO_ROOT_PASSWORD (default secrets are rejected)",
        );
      }

      const liteLlmDatabaseUrl = readDotenvValue(
        target.file,
        "LITELLM_DATABASE_URL",
      );
      if (
        !liteLlmDatabaseUrl ||
        /:litellm@/i.test(liteLlmDatabaseUrl)
      ) {
        throw new Error(
          "LITELLM_DATABASE_URL must include a non-default LITELLM_POSTGRES_PASSWORD",
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
