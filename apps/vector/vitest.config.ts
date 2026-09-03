import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // integration/ 差分测试默认包含，但仅在 CI 注入 VECTOR_INTEGRATION=1
    // 时激活（describe.skipIf）——本机/普通单测路径零依赖。
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
