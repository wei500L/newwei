import path from "node:path";
import process from "node:process";
import { baseEnvSchema, loadAndValidateEnv } from "@modular/utils";
import { seed } from "../seeds";

loadAndValidateEnv(baseEnvSchema, {
  dotenvPath: path.resolve(process.cwd(), "../../.env"),
  overrideProcessEnv: true
});

seed()
  .then(() => {
    console.log("Seed data created");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to seed database", error);
    process.exit(1);
  });
