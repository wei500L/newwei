import { defineConfig } from "vitest/config";

export default defineConfig({
  // 控制器加载测试（tools/scan-routes.test.ts）在 vitest 进程内 require TS
  // 控制器源——vite 的 esbuild transform 需要经 tsconfigRaw 开启装饰器
  // （对齐 tsconfig nest 预设），否则装饰器元数据丢失、扫描器得到 0
  // controller。注意：experimentalDecorators 不是 transform 的直接选项，
  // 必须嵌在 tsconfigRaw.compilerOptions 里。
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    },
  },
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
