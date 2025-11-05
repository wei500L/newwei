import { existsSync } from "node:fs";
import path from "node:path";
import { baseEnvSchema, loadAndValidateEnv } from "@modular/utils";

const rootEnv = path.resolve(__dirname, "../../.env");
const dockerEnv = path.resolve(__dirname, "../docker/.env");

const targets = [
  { label: "root", file: rootEnv },
  { label: "docker", file: dockerEnv }
];

let hasError = false;

for (const target of targets) {
  if (!existsSync(target.file)) {
    console.warn(`⚠️  Missing ${target.label} env file at ${target.file}`);
    continue;
  }

  try {
    loadAndValidateEnv(baseEnvSchema, {
      dotenvPath: target.file,
      overrideProcessEnv: false
    });
    console.log(`✅ ${target.label} environment configuration looks good.`);
  } catch (error) {
    hasError = true;
    console.error(`❌ ${target.label} environment failed validation`, error);
  }
}

if (hasError) {
  process.exit(1);
}
