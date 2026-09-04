import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
    clearMocks: true,
    env: {
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:4000/api",
      NEXT_PUBLIC_GRAPHQL_APQ_ENABLED: "true",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: [
        "app/(auth)/login/page.tsx",
        "app/(app)/admin/ops/news-sources/news-sources-content.tsx",
        "components/settings/email-settings-panel.tsx",
        "app/(app)/components/page-container.tsx",
        "app/(app)/components/nav-mode.ts",
        "app/(app)/components/action-rail-routing.ts",
        "app/(app)/components/navigation-model.ts",
        "app/(app)/components/top-nav-density.ts",
        // FE-批3：URL 状态与数据边界原语（FE-01 / DataStateBoundary）
        "lib/url-state-codec.ts",
        "hooks/use-url-state.ts",
        "components/data-state-boundary.tsx",
        // FE-批3：Alert Center 领域模块（FE-03 include 扩充）
        "app/(app)/alerts/alert-center.tsx",
        "app/(app)/alerts/alert-center-url-state.ts",
        "app/(app)/alerts/hooks/use-alert-center-url-state.ts",
        "app/(app)/alerts/alert-chart-options.ts",
        "app/(app)/alerts/evidence-utils.tsx",
        "app/(app)/alerts/economic-anomaly-evidence.tsx",
        "app/(app)/alerts/entity-sentiment-evidence.tsx",
        "app/(app)/alerts/entity-association-evidence.tsx",
        "app/(app)/alerts/realtime-signal-evidence.tsx",
      ],
      exclude: ["**/*.test.{ts,tsx}", "**/graphql/generated.ts"],
      thresholds: {
        lines: 35,
        functions: 3,
        statements: 35,
        branches: 30,
      },
    },
  },
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "components"),
      "@/app": path.resolve(__dirname, "app"),
      "@/lib": path.resolve(__dirname, "lib"),
      "@/graphql": path.resolve(__dirname, "graphql"),
      "@/hooks": path.resolve(__dirname, "hooks"),
      "@/store": path.resolve(__dirname, "store"),
      "@/test": path.resolve(__dirname, "test"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});
