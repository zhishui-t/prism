import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// 包级测试配置：让 `pnpm --filter @prism/skills test` 在包目录内可独立运行；
// 仓库根 vitest.config.ts（packages/*/test/**）负责全仓一次跑全。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // 与根配置同口径：单测关向量，结果不依赖本机 embedding 安装态。
    env: { PRISM_EMBEDDING: 'off' },
    // 包级单跑也回收 tmpdir()/prism-*（各测试 mkdtemp 造 home 但不清理）。
    globalSetup: [fileURLToPath(new URL('../../test/global-tmp-reaper.ts', import.meta.url))],
  },
})
