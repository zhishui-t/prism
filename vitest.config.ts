import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * workspace 包别名：测试直接跑 src 源码，不依赖 tsc 先 build 出 dist。
 * 运行时（node dist）仍走 package.json exports → dist。
 */
const toSrc = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@prism/core': toSrc('core'),
      '@prism/knowledge': toSrc('knowledge'),
      '@prism/agents': toSrc('agents'),
      '@prism/skills': toSrc('skills'),
      '@prism/server': toSrc('server'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // 单测跑「主流程」口径：关掉向量（与 .agent-team/test-plan-v4.md、test/run-e2e.mjs 一致）。
    // 否则结果依赖本机是否装了 embedding 运行时——装了但没起服务时，doctor 的
    // 「全部通过」断言必然失败，且 ensureEmbeddingServer 会撞 60s 启动锁等待。
    // 向量路径本身由 hybrid / retrieval-quality 用例**注入假 embed** 覆盖，不靠真服务。
    env: { PRISM_EMBEDDING: 'off' },
    // 回收本轮新增的 tmpdir()/prism-* 测试目录（各测试用 mkdtemp 造 home 但不清理，
    // 否则每次全量跑净增数百个，曾累积到 3 万+）。见 test/global-tmp-reaper.ts
    globalSetup: ['./test/global-tmp-reaper.ts'],
  },
})
