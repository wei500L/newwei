const { cpSync, existsSync, mkdirSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(packageRoot, "src", "modules", "email", "templates");
const distRoot = path.join(packageRoot, "dist");
const defaultTargetDir = path.join(distRoot, "src", "modules", "email", "templates");

function findEmailServiceOutputDirs(rootDir) {
  const outputDirs = new Set();
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === "email.service.js") {
        outputDirs.add(path.dirname(fullPath));
      }
    }
  }

  return Array.from(outputDirs);
}

if (!existsSync(sourceDir)) {
  console.error(`Email templates directory not found at ${sourceDir}`);
  process.exit(1);
}

const targets = [];

if (existsSync(distRoot)) {
  try {
    if (statSync(distRoot).isDirectory()) {
      const outputDirs = findEmailServiceOutputDirs(distRoot);
      for (const dir of outputDirs) {
        targets.push(path.join(dir, "templates"));
      }
    }
  } catch {
    // ignore
  }
}

if (targets.length === 0) {
  targets.push(defaultTargetDir);
  console.warn(
    `Could not locate compiled email.service.js under ${distRoot}; falling back to ${defaultTargetDir}`
  );
}

for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  console.log(`Copied email templates to ${targetDir}`);
}
