const { cpSync, existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(packageRoot, "src", "modules", "email", "templates");
const targetDir = path.join(packageRoot, "dist", "src", "modules", "email", "templates");

if (!existsSync(sourceDir)) {
  console.error(`Email templates directory not found at ${sourceDir}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.log(`Copied email templates to ${targetDir}`);
