/**
 * globe-check-imports — 从 apps/web 里对 `@gev/*` 的引用出发，追踪 GEV vendor
 * 源码的 import 图，确保不会间接碰到 `.vue` 文件或已知的 Vue 强耦合模块。
 *
 * 背景：我们的 Next/webpack 构建不能编译 `.vue` 文件。GEV 的引擎层是纯 JS，
 * 但部分界面/装配模块会通过 import 链把 `.vue` 带进来。这个脚本把这条边界
 * 变成可执行的检查：任何一次从 `@gev/*` 出发的 DFS 一旦到达 `.vue` 或黑名单
 * 模块，就以退出码 1 失败并打印完整链路。
 *
 * 纯 Node，无第三方依赖。CLI：`pnpm --filter @modular/web globe:check-imports`。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";
import { fileURLToPath } from "node:url";

/** 已知会把 `.vue` 带进构建、或与 Vue 外壳强耦合的模块（相对 vendor/src）。 */
export const BLACKLIST = new Set([
  "app/application.js",
  "app/data.js",
  "app/controls.js",
  "ui/composition.js",
  "hud.js",
  "ui/applicationShell.js",
  "main.js",
  "standalone/application.js",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function toPosix(value) {
  return value.split("\\").join("/");
}

function* walkSourceFiles(root) {
  if (!existsSync(root)) {
    return;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        yield full;
      }
    }
  }
}

/** 从源码文本里收集 `from "..."`、`import("...")`、`import "..."` 的说明符。 */
function extractModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function extractGevEntries(appRoots) {
  const entries = new Set();
  for (const appRoot of appRoots) {
    for (const file of walkSourceFiles(appRoot)) {
      let source;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const specifier of extractModuleSpecifiers(source)) {
        if (specifier.startsWith("@gev/")) {
          entries.add(specifier);
        }
      }
    }
  }
  return [...entries];
}

/** 把 `@gev/foo/bar` 解析为 `vendorSrc/foo/bar.js`（无扩展名时补 `.js`）。 */
function resolveGevEntry(specifier, vendorSrc) {
  const withoutPrefix = specifier.slice("@gev/".length);
  const base = resolvePath(vendorSrc, withoutPrefix);
  return extname(base) ? base : `${base}.js`;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 把相对说明符解析为绝对文件路径。非相对说明符（裸包名）不跟随，返回 null。
 */
function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const cleaned = specifier.split("?")[0].split("#")[0];
  const base = resolvePath(dirname(fromFile), cleaned);

  const candidates = [];
  if (extname(base)) {
    candidates.push(base);
  } else {
    candidates.push(
      `${base}.js`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}.json`,
      `${base}.vue`,
      join(base, "index.js"),
      join(base, "index.mjs"),
    );
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  // 即使文件不存在，也能凭扩展名识别出 `.vue` 目标。
  if (cleaned.endsWith(".vue")) {
    return base;
  }
  return null;
}

function displayPath(file, vendorSrc) {
  return toPosix(relative(vendorSrc, file));
}

function traverse(file, chain, context) {
  const display = displayPath(file, context.vendorSrc);

  if (BLACKLIST.has(display)) {
    context.failures.push({
      chain: [...chain],
      reason: `命中黑名单模块：${display}`,
    });
    return true;
  }

  if (display.endsWith(".vue") || file.endsWith(".vue")) {
    context.failures.push({
      chain: [...chain],
      reason: `遍历到 .vue 文件：${display}`,
    });
    return true;
  }

  if (context.stack.has(file)) {
    return false;
  }
  context.stack.add(file);

  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    context.stack.delete(file);
    return false;
  }

  for (const specifier of extractModuleSpecifiers(source)) {
    const resolved = resolveRelative(file, specifier);
    if (resolved === null) {
      continue; // 裸包名不跟随
    }
    const nextChain = [...chain, displayPath(resolved, context.vendorSrc)];
    if (traverse(resolved, nextChain, context)) {
      context.stack.delete(file);
      return true;
    }
  }

  context.stack.delete(file);
  return false;
}

/**
 * 可测试的核心函数。
 *
 * @param {{ appRoots: string[], vendorSrc: string }} options
 * @returns {{ entries: number, failures: Array<{ chain: string[], reason: string }> }}
 */
export function checkGevImports({ appRoots, vendorSrc }) {
  const entries = extractGevEntries(appRoots);
  const failures = [];

  for (const specifier of entries) {
    const entryFile = resolveGevEntry(specifier, vendorSrc);
    const chain = [displayPath(entryFile, vendorSrc)];
    traverse(entryFile, chain, {
      vendorSrc,
      failures,
      stack: new Set(),
    });
  }

  return { entries: entries.length, failures };
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const webRoot = dirname(scriptDir);
  const vendorSrc = resolvePath(webRoot, "../../vendor/gods-eye-view/src");
  const appRoots = ["app", "components", "lib", "hooks"]
    .map((name) => join(webRoot, name))
    .filter((dir) => existsSync(dir));

  const result = checkGevImports({ appRoots, vendorSrc });

  if (result.entries === 0) {
    process.stdout.write("0 entries\n");
  } else {
    process.stdout.write(`${result.entries} entries\n`);
  }

  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      process.stderr.write(
        `[globe:check-imports] ${failure.reason}\n  ${failure.chain.join(" → ")}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "[globe:check-imports] OK：未发现 .vue 或黑名单模块。\n",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
