import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * agents 包独立测试配置：`pnpm --filter @prism/agents test` 时 vitest 就近取本文件。
 * workspace 依赖（@prism/core）指向 src 源码，不依赖先 build 出 dist。
 * 根目录跑 `pnpm test` 时走根 vitest.config.ts（别名已含 @prism/agents）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@prism/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // 与根配置同口径：单测关向量，结果不依赖本机 embedding 安装态。
    env: { PRISM_EMBEDDING: 'off' },
    // 包级单跑也回收 tmpdir()/prism-*（各测试 mkdtemp 造 home 但不清理）。
    // 用 URL 绝对化，避免依赖 cwd；实现见仓库根 test/global-tmp-reaper.ts
    globalSetup: [fileURLToPath(new URL('../../test/global-tmp-reaper.ts', import.meta.url))],
  },
})
