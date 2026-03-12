#!/usr/bin/env node

const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const artifactSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
const inputDirs = process.argv.slice(2);

if (inputDirs.length === 0) {
  process.stderr.write(
    '[check-no-source-artifacts] Provide at least one directory to scan.\n',
  );
  process.exit(1);
}

const cwd = process.cwd();
const violations = [];

const visit = (targetPath) => {
  const entries = readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      visit(fullPath);
      continue;
    }

    if (artifactSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
      violations.push(path.relative(cwd, fullPath) || fullPath);
    }
  }
};

for (const inputDir of inputDirs) {
  const fullPath = path.resolve(cwd, inputDir);
  if (!existsSync(fullPath)) continue;
  visit(fullPath);
}

if (violations.length === 0) {
  process.stdout.write('[check-no-source-artifacts] OK\n');
  process.exit(0);
}

process.stderr.write(
  [
    '[check-no-source-artifacts] Found generated artifacts under source directories:',
    ...violations.map((filePath) => `- ${filePath}`),
  ].join('\n') + '\n',
);
process.exit(1);
