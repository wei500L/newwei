/**
 * globe:vendor — 把 gods-eye-view（GEV）上游某个 commit 的源码快照同步进
 * `vendor/gods-eye-view/`。
 *
 * 用法：
 *   pnpm globe:vendor <commit-sha>
 *
 * 行为：
 *   1. 下载 GitHub codeload 的 tar.gz 到系统临时目录里新建的空目录并解压，
 *      **不执行**里面任何脚本。
 *   2. 把解压结果同步到 `vendor/gods-eye-view/`（先清空目标目录，但保留
 *      `UPSTREAM.md`），排除 docs/media、.github、.agents、node_modules 与
 *      .env*（.env.example 除外）。
 *   3. 更新 `UPSTREAM.md` 顶部的「上游 commit」与「导入日期」两行。
 *   4. 输出新增、删除、修改的文件数。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_REPO = "bilawalsidhu/gods-eye-view";
const KEEP_FILES = new Set(["UPSTREAM.md"]);

/** 返回 true 表示该相对路径需要排除。 */
function isExcluded(relativePath: string): boolean {
  const posix = relativePath.split(path.sep).join("/");
  const segments = posix.split("/");
  const name = segments[segments.length - 1] ?? "";

  // 目录级排除（上游根目录下的固定位置）。
  if (
    posix === "docs/media" ||
    posix.startsWith("docs/media/") ||
    posix === ".github" ||
    posix.startsWith(".github/") ||
    posix === ".agents" ||
    posix.startsWith(".agents/")
  ) {
    return true;
  }

  // 任意层级的 node_modules。
  if (segments.includes("node_modules")) {
    return true;
  }

  // .env* 一律排除，但保留 .env.example。
  if (name !== ".env.example" && /^\.env/.test(name)) {
    return true;
  }

  return false;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) {
    return files;
  }
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop() as string;
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return files;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function snapshot(root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const relative of walkFiles(root)) {
    if (KEEP_FILES.has(relative.split(path.sep).join("/"))) {
      continue;
    }
    map.set(relative, hashFile(path.join(root, relative)));
  }
  return map;
}

async function downloadTarball(
  sha: string,
  destination: string,
): Promise<void> {
  const url = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${sha}`;
  const response = await fetch(url, {
    headers: { "user-agent": "modular-monolith-globe-vendor" },
    redirect: "follow",
  });
  if (!response.ok || response.body === null) {
    throw new Error(
      `下载失败：GET ${url} -> HTTP ${response.status} ${response.statusText}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
}

function extractTarball(tarball: string, destination: string): void {
  // 仅解压，不执行压缩包内的任何脚本。
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    tarball,
    "-C",
    destination,
    "--strip-components=1",
  ]);
}

function syncTree(sourceRoot: string, targetRoot: string): void {
  for (const relative of walkFiles(sourceRoot)) {
    const posix = relative.split(path.sep).join("/");
    if (isExcluded(posix)) {
      continue;
    }
    const sourceFile = path.join(sourceRoot, relative);
    const targetFile = path.join(targetRoot, relative);
    mkdirSync(path.dirname(targetFile), { recursive: true });
    copyFileSync(sourceFile, targetFile);
  }
}

function clearTargetExceptKept(targetRoot: string): void {
  if (!existsSync(targetRoot)) {
    return;
  }
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (KEEP_FILES.has(entry.name)) {
      continue;
    }
    rmSync(path.join(targetRoot, entry.name), { recursive: true, force: true });
  }
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function updateUpstreamManifest(manifestPath: string, sha: string): void {
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `# 上游快照说明\n\n- 上游 commit：${sha}\n- 导入日期：${formatDate(new Date())}\n`,
      "utf8",
    );
    return;
  }

  const original = readFileSync(manifestPath, "utf8");
  const lines = original.split(/\r?\n/);
  let commitUpdated = false;
  let dateUpdated = false;
  const next = lines.map((line) => {
    if (/^-\s*上游 commit[:：]/.test(line)) {
      commitUpdated = true;
      return `- 上游 commit：${sha}`;
    }
    if (/^-\s*导入日期[:：]/.test(line)) {
      dateUpdated = true;
      return `- 导入日期：${formatDate(new Date())}`;
    }
    return line;
  });

  if (!commitUpdated) {
    next.unshift(`- 上游 commit：${sha}`);
  }
  if (!dateUpdated) {
    next.unshift(`- 导入日期：${formatDate(new Date())}`);
  }

  writeFileSync(manifestPath, next.join("\n"), "utf8");
}

function resolveRepoRoot(moduleUrl: string): string {
  // infra/scripts/src/globe-vendor.mts -> 仓库根目录
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../..");
}

async function main(): Promise<void> {
  const sha = process.argv[2]?.trim();
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    process.stderr.write(
      "用法：pnpm globe:vendor <commit-sha>（7~40 位十六进制 commit）\n",
    );
    process.exitCode = 2;
    return;
  }

  const repoRoot = resolveRepoRoot(import.meta.url);
  const targetRoot = path.join(repoRoot, "vendor", "gods-eye-view");
  const manifestPath = path.join(targetRoot, "UPSTREAM.md");

  const workRoot = mkdtempSync(path.join(os.tmpdir(), "gev-vendor-"));
  const tarball = path.join(workRoot, "source.tar.gz");
  const extractRoot = path.join(workRoot, "source");

  try {
    process.stderr.write(`[globe:vendor] 下载 ${UPSTREAM_REPO}@${sha}\n`);
    await downloadTarball(sha, tarball);

    process.stderr.write(`[globe:vendor] 解压到临时目录 ${extractRoot}\n`);
    extractTarball(tarball, extractRoot);

    // 同步前先记录旧快照，用于统计新增 / 删除 / 修改。
    const before = snapshot(targetRoot);

    clearTargetExceptKept(targetRoot);
    mkdirSync(targetRoot, { recursive: true });
    syncTree(extractRoot, targetRoot);

    updateUpstreamManifest(manifestPath, sha);

    const after = snapshot(targetRoot);
    let added = 0;
    let deleted = 0;
    let modified = 0;
    for (const [relative, hash] of after) {
      if (!before.has(relative)) {
        added += 1;
      } else if (before.get(relative) !== hash) {
        modified += 1;
      }
    }
    for (const relative of before.keys()) {
      if (!after.has(relative)) {
        deleted += 1;
      }
    }

    process.stdout.write(
      `[globe:vendor] 同步完成：新增 ${added} 个文件，删除 ${deleted} 个，修改 ${modified} 个\n`,
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[globe:vendor] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
