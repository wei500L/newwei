/**
 * copy-cesium-assets — 把 Cesium 的运行时静态资源复制到 `apps/web/public/cesium/`。
 *
 * Cesium 在运行时需要从同源的 `/cesium/` 下加载 Workers、ThirdParty、Assets、
 * Widgets 四个目录（通过 `window.CESIUM_BASE_URL` / Next 静态目录）。这些资源
 * 体积大且随版本变化，所以不入库（见 `apps/web/.gitignore` 的 `public/cesium/`）。
 *
 * 已复制过且版本一致时跳过，避免每次 dev/build 都重复拷贝。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(scriptDir);
const cesiumRoot = join(webRoot, "node_modules", "cesium");
const sourceRoot = join(cesiumRoot, "Build", "Cesium");
const targetRoot = join(webRoot, "public", "cesium");
const versionFile = join(targetRoot, ".version");

const ASSET_DIRS = ["Workers", "ThirdParty", "Assets", "Widgets"];

function readCesiumVersion() {
  const packageJsonPath = join(cesiumRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `找不到 Cesium 依赖：${packageJsonPath}。请先在仓库根目录运行 pnpm install。`,
    );
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return String(packageJson.version ?? "");
}

function main() {
  const version = readCesiumVersion();
  if (!version) {
    throw new Error(
      `无法从 ${join(cesiumRoot, "package.json")} 读取 Cesium 版本。`,
    );
  }

  if (
    existsSync(versionFile) &&
    readFileSync(versionFile, "utf8").trim() === version
  ) {
    process.stdout.write(
      `[copy-cesium-assets] public/cesium 已是 Cesium ${version}，跳过复制。\n`,
    );
    return;
  }

  if (!existsSync(sourceRoot)) {
    throw new Error(`找不到 Cesium 静态资源目录：${sourceRoot}`);
  }

  mkdirSync(targetRoot, { recursive: true });
  for (const dir of ASSET_DIRS) {
    const from = join(sourceRoot, dir);
    if (!existsSync(from)) {
      throw new Error(`缺少 Cesium 静态资源子目录：${from}`);
    }
    cpSync(from, join(targetRoot, dir), { recursive: true });
  }

  writeFileSync(versionFile, `${version}\n`, "utf8");
  process.stdout.write(
    `[copy-cesium-assets] 已复制 Cesium ${version} 静态资源到 public/cesium/。\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[copy-cesium-assets] 失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
