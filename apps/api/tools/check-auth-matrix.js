// 鉴权矩阵与控制器漂移检查（CI 用，纯 Node 无编译依赖）。
//
// 重新生成矩阵到临时位置并与提交的基线比对——无意变更（controller 新增/
// 删除/改路由/改权限装饰器）时退出非零。有意变更时运行：
//   pnpm --filter @modular/api run contract:auth-matrix:generate
// 并提交 tests/contract/auth-matrix.{json,md}。
//
// 检查项：
//   1. 生成器自身 fail-closed（缺权限元数据 → 生成失败 → 本检查失败）。
//   2. JSON 逐字节确定性比对（含排序与 totals）。
"use strict";

const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const apiRoot = join(__dirname, "..");
const baselineJson = join(apiRoot, "tests/contract/auth-matrix.json");
const baselineMd = join(apiRoot, "tests/contract/auth-matrix.md");

function fail(message) {
  console.error(`auth-matrix drift check FAILED: ${message}`);
  process.exit(1);
}

try {
  const baseline = readFileSync(baselineJson, "utf8");
  const baselineMdContent = readFileSync(baselineMd, "utf8");

  // 重新生成：生成脚本写入固定路径（tests/contract/），因此先备份基线，
  // 运行生成，再比对并恢复——工作区不残留变更（比对失败时由 CI 的
  // git diff 兜底显示具体漂移）。
  const backupJson = readFileSync(baselineJson);
  execFileSync("npx", ["tsx", "tools/generate-auth-matrix.ts"], {
    cwd: apiRoot,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "pipe",
  });
  const regenerated = readFileSync(baselineJson, "utf8");
  const regeneratedMd = readFileSync(baselineMd, "utf8");

  if (regenerated !== baseline) {
    // 恢复基线，让 git diff 显示漂移内容。
    writeFileSyncSafe(baselineJson, backupJson);
    // 打印前 40 行差异摘要。
    printDiffSummary("auth-matrix.json", baseline, regenerated);
    fail("tests/contract/auth-matrix.json drifted from controllers; regenerate with `pnpm --filter @modular/api run contract:auth-matrix:generate` and commit, or revert the controller change.");
  }
  if (regeneratedMd !== baselineMdContent) {
    writeFileSyncSafe(baselineJson, backupJson);
    printDiffSummary("auth-matrix.md", baselineMdContent, regeneratedMd);
    fail("tests/contract/auth-matrix.md drifted from controllers; regenerate and commit.");
  }
  // 恢复基线内容（regenerated === baseline 时两者本就相同）。
  writeFileSyncSafe(baselineJson, backupJson);
  const summary = JSON.parse(baseline);
  console.log(
    `auth-matrix drift check passed: ${summary.totals.endpoints} endpoints, ${summary.totals.controllers} controllers (${summary.totals.public} public / ${summary.totals.permissionGated} permission-gated / ${summary.totals.platformAdminInHandler} platform-admin-in-handler)`,
  );
} catch (error) {
  if (error && error.status === 1 && /fail-closed|no permission metadata/i.test(String(error.stdout) + String(error.stderr))) {
    fail("generator fail-closed: endpoints missing permission metadata — add @Permissions/@AllowAuthenticated or mark @Public.");
  }
  fail(error instanceof Error ? error.message : String(error));
}

function writeFileSyncSafe(path, buffer) {
  require("node:fs").writeFileSync(path, buffer);
}

function printDiffSummary(label, before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let shown = 0;
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length) && shown < 40; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      console.error(`  ${label}:${i + 1}`);
      if (beforeLines[i] !== undefined) console.error(`  - ${beforeLines[i].slice(0, 160)}`);
      if (afterLines[i] !== undefined) console.error(`  + ${afterLines[i].slice(0, 160)}`);
      shown++;
    }
  }
}
