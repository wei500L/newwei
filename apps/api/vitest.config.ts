import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromApiRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

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
      "@modular/utils": fromApiRoot("../../packages/utils/src/index.ts"),
      "@modular/config": fromApiRoot("../../packages/config/src/index.ts"),
      "@modular/db": fromApiRoot("../../packages/db/src/index.ts"),
      "@modular/mongo": fromApiRoot("../../packages/mongo/src/index.ts"),
      "@modular/vector-client": fromApiRoot("../../packages/vector-client/src/index.ts"),
    },
  },
});
