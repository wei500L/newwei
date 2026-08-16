const { readFileSync } = require("node:fs");
const path = require("node:path");

const scriptsDir = __dirname;
const dockerDir = path.resolve(scriptsDir, "../../docker");

const targets = [
  path.join(dockerDir, "docker-compose.yml"),
  path.join(dockerDir, "crawl4ai.Dockerfile"),
  path.join(dockerDir, ".env.sample"),
];

const forbidden = [
  {
    pattern: /minio\/minio:latest\b/,
    message: "minio/minio must be pinned by version+digest, not :latest",
  },
  {
    pattern: /minio\/mc:latest\b/,
    message: "minio/mc must be pinned by version+digest, not :latest",
  },
  {
    pattern: /unclecode\/crawl4ai:0(?:["'\s]|$)/,
    message: "unclecode/crawl4ai must be pinned to a specific version digest, not :0",
  },
];

let failed = false;
for (const file of targets) {
  const text = readFileSync(file, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      failed = true;
      process.stderr.write(`${path.relative(path.resolve(scriptsDir, "../.."), file)}: ${rule.message}\n`);
    }
  }
}

if (failed) {
  process.exit(1);
}

process.stdout.write("Compose image defaults are pinned.\n");
