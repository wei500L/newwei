import { resolve } from "node:path";

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

export default nextConfig;
