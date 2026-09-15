/**
 * studio assets 目录解析回归（B1 打包事故）。
 *
 * 背景：`GET /studio/:project/vendor/vis-network.min.js` 从 Prism 自有 `<发行根>/assets/`
 * 读取本地副本（离线化，D9/B12）。该文件在开发态与打包态的相对层级**都是 5 级**，但落点不同：
 * - 开发态 `packages/server/dist/http/routes/`：上 5 级 = 仓库根；
 * - 打包态 `node_modules/@prism/server/dist/http/routes/`：上 5 级 = `<root>/node_modules`
 *   （package.mjs 把资源放 `<root>/assets/`）→ 写死相对层级会让 vendored 路由 404、代码图谱黑屏。
 *
 * `resolveAssetsDir()` 经 `repoRoot` **向上查找**发行根，两种布局都回到 `<root>/assets`。
 * 测试在**临时目录**里造布局（R5：绝不写真实宿主目录）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveAssetsDir } from '../src/http/routes/studio.js'

/** 造一个假发行布局，返回「studio 模块位置」的 metaUrl 与预期发行根。 */
function fakeLayout(relativeFile: string): { url: string; expectedRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'prism-assets-'))
  mkdirSync(join(root, '3rd'), { recursive: true }) // 发行根特征（repoRoot 判据）
  const abs = join(root, relativeFile)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '// fake', 'utf-8')
  return { url: pathToFileURL(abs).href, expectedRoot: root }
}

describe('studio assets 目录解析（B1 打包事故回归）', () => {
  it('开发态 packages/server/dist/http/routes/ → <root>/assets', () => {
    const { url, expectedRoot } = fakeLayout(join('packages', 'server', 'dist', 'http', 'routes', 'studio.js'))
    expect(resolveAssetsDir(url)).toBe(join(expectedRoot, 'assets'))
  })

  it('打包态 node_modules/@prism/server/dist/http/routes/ → 也回到 <root>/assets', () => {
    const { url, expectedRoot } = fakeLayout(
      join('node_modules', '@prism', 'server', 'dist', 'http', 'routes', 'studio.js'),
    )
    const dir = resolveAssetsDir(url)
    // 写死 5 级相对层级会得到 <root>/node_modules/assets——这才是事故所在
    expect(dir).not.toBe(join(expectedRoot, 'node_modules', 'assets'))
    expect(dir).toBe(join(expectedRoot, 'assets'))
  })
})
