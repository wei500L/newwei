import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tools/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      "@modular/utils": "../../packages/utils/src/index.ts",
      "@modular/config": "../../packages/config/src/index.ts",
      "@modular/db": "../../packages/db/src/index.ts",
      "@modular/mongo": "../../packages/mongo/src/index.ts",
      "@modular/vector-client": "../../packages/vector-client/src/index.ts",
    },
  },
});
