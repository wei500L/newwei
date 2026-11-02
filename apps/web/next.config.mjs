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

// ---------------------------------------------------------------------------
// GEV 旁车（gods-eye-view sidecar）代理
// ---------------------------------------------------------------------------
// 这份前缀清单来自 GEV 源码扫描：浏览器端代码用相对路径请求 GEV 自己的 Vite
// 服务端（一个持有各家 API 密钥的数据代理）。这里把它们经 Next rewrites 转发到
// 独立运行的旁车，避免在 web 进程里保存任何 GEV 服务端密钥。
//
// `setup`、`openai`、`gemini`、`realtime` 故意不转发：
//   - /api/setup   —— 密钥设置入口，绝不能对浏览器暴露；
//   - /api/openai、/api/gemini、/api/realtime —— 语音 / LLM 通道，不属数据代理范畴。
//
// 升级 vendor/gods-eye-view 后必须用下面的命令重新核对清单：
//   grep -rhoE "['\`\"]/api/[a-zA-Z0-9_-]+" vendor/gods-eye-view/src | sort -u
const GLOBE_API_PREFIXES = [
  "google",
  "transit",
  "route",
  "tomtom",
  "terrain",
  "vessels",
  "cctv",
  "weather",
  "ghostmaps",
  "geocode",
  "fire-perimeters",
  "radio",
  "overpass",
  "military-installations",
  "military",
  "mapillary",
  "gbfs",
  "flights",
  "celestrak",
  "wind",
  "weather-effects",
  "regional-brief",
  "map",
  "local-receivers",
  "launches",
  "gnss-integrity",
  "firms",
  "cyclones",
  "adsbdb",
];
const GLOBE_STATIC_PREFIXES = ["models", "events", "scene-assets"];
const globeSidecarUrl =
  process.env.GLOBE_SIDECAR_URL ?? "http://127.0.0.1:4173";

// `:path*` 匹配零个或多个路径段，因此 `/api/flights/:path*` 同样匹配不带子路径的
// `/api/flights`（静态资源前缀的 `/:p/:path*` 也匹配挂载根）。
const globeRewrites = [
  ...GLOBE_API_PREFIXES.map((p) => ({
    source: `/api/${p}/:path*`,
    destination: `${globeSidecarUrl}/api/${p}/:path*`,
  })),
  ...GLOBE_STATIC_PREFIXES.map((p) => ({
    source: `/${p}/:path*`,
    destination: `${globeSidecarUrl}/${p}/:path*`,
  })),
];

// 合并可能已存在的 rewrites，而不是覆盖它。
const existingRewrites = nextConfig.rewrites;
nextConfig.rewrites = async () => {
  const existing =
    typeof existingRewrites === "function"
      ? await existingRewrites()
      : (existingRewrites ?? []);
  if (Array.isArray(existing)) {
    return [...existing, ...globeRewrites];
  }
  return {
    beforeFiles: [...(existing.beforeFiles ?? [])],
    afterFiles: [...(existing.afterFiles ?? []), ...globeRewrites],
    fallback: [...(existing.fallback ?? [])],
  };
};

export default nextConfig;
