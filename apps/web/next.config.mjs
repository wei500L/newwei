import { resolve } from "node:path";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));
const gevSrc = resolvePath(webRoot, "../../vendor/gods-eye-view/src");

try {
  process.loadEnvFile(resolve(process.cwd(), "../../.env"));
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}

const onDemandMaxInactiveAgeMs = Number(
  process.env.NEXT_ON_DEMAND_MAX_INACTIVE_AGE_MS ?? 15 * 60 * 1000,
);
const onDemandPagesBufferLength = Number(
  process.env.NEXT_ON_DEMAND_PAGES_BUFFER_LENGTH ?? 60,
);
const skipBuildQualityChecks =
  process.env.NEXT_BUILD_SKIP_QUALITY_CHECKS === "true";

const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  eslint: {
    ignoreDuringBuilds: skipBuildQualityChecks,
  },
  typescript: {
    ignoreBuildErrors: skipBuildQualityChecks,
  },
  onDemandEntries: {
    maxInactiveAge: Number.isFinite(onDemandMaxInactiveAgeMs)
      ? onDemandMaxInactiveAgeMs
      : 15 * 60 * 1000,
    pagesBufferLength: Number.isFinite(onDemandPagesBufferLength)
      ? onDemandPagesBufferLength
      : 60,
  },
};

// 允许编译 apps/web 目录之外的 vendor 源码（GEV 快照）。
nextConfig.experimental = {
  ...(nextConfig.experimental ?? {}),
  externalDir: true,
};

// 把 @gev/* 指到 vendor 源码；vendor 里的裸 import（cesium、pinia…）从
// apps/web/node_modules 解析，保证 Cesium 只有一份实例。
const existingWebpack = nextConfig.webpack;

nextConfig.webpack = (config, context) => {
  const { isServer } = context;

  config.resolve.alias = {
    ...(config.resolve.alias ?? {}),
    "@gev": gevSrc,
  };
  config.resolve.modules = [
    ...(config.resolve.modules ?? ["node_modules"]),
    resolvePath(webRoot, "node_modules"),
  ];
  config.module.unknownContextCritical = false; // Cesium 的已知 webpack 警告
  config.ignoreWarnings = [
    ...(config.ignoreWarnings ?? []),
    { module: /vendor[\\/]gods-eye-view/ },
    { module: /node_modules[\\/]cesium/ },
  ];
  if (isServer) {
    // GEV 只在客户端运行；万一被服务端引用，直接构建失败，比运行时报 window
    // 未定义更早暴露。使用方必须通过 next/dynamic({ ssr: false }) 加载。
    config.resolve.alias["@gev"] = false;
  }

  return typeof existingWebpack === "function"
    ? existingWebpack(config, context)
    : config;
};

export default nextConfig;
