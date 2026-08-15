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
