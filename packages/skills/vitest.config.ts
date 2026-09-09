import { defineConfig } from 'vitest/config'

// 包级测试配置：让 `pnpm --filter @prism/skills test` 在包目录内可独立运行；
// 仓库根 vitest.config.ts（packages/*/test/**）负责全仓一次跑全。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
