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
  },
})
