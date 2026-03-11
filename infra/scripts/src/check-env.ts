import { existsSync } from "node:fs";
import path from "node:path";
import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";

const scriptsDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(scriptsDir, "../..");
const dockerDir = path.resolve(scriptsDir, "../docker");

const rootEnv = path.resolve(repoRoot, ".env");
const dockerEnv = path.resolve(dockerDir, ".env");

const targets = [
  { label: "root", file: rootEnv },
  { label: "docker", file: dockerEnv },
];

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
    console.log(`✅ ${target.label} environment configuration looks good.`);
  } catch (error) {
    hasError = true;
    console.error(`❌ ${target.label} environment failed validation`, error);
  }
}

if (hasError) {
  process.exit(1);
}
