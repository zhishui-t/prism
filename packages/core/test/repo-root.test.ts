/**
 * 发行根定位回归（打包事故）。
 *
 * 背景：vendored 三方件（graphify/archify/llama-runtime/anydoc-runtime）的路径曾写死
 * 相对层级 `../../../../3rd`。这在开发态（`packages/<pkg>/dist/`，4 层到根）正确，
 * 但**打包物化后**变成 `node_modules/@prism/<pkg>/dist/`（5 层到根），写死会解析到
 * `node_modules/3rd`——实测导致 tarball 里 doctor 报 anydoc 缺失、graphify 回落 PATH、
 * embedding 不可用。
 *
 * `repoRoot()` 改为**向上查找**含 `3rd/` 或 `packages/` 的目录，两种布局都对。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { repoRoot } from '@prism/core'

/** 在临时目录里造一个假发行布局，返回「某文件位置」的 metaUrl 与预期根。 */
function fakeLayout(relativeFile: string): { url: string; expectedRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'prism-root-'))
  mkdirSync(join(root, '3rd'), { recursive: true }) // 发行根特征
  const abs = join(root, relativeFile)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '// fake', 'utf-8')
  return { url: pathToFileURL(abs).href, expectedRoot: root }
}

describe('repoRoot 向上查找发行根（打包事故回归）', () => {
  it('开发态布局 packages/<pkg>/dist/ → 找到根', () => {
    const { url, expectedRoot } = fakeLayout(join('packages', 'server', 'dist', 'kb', 'embedding.js'))
    expect(repoRoot(url)).toBe(expectedRoot)
  })

  it('打包布局 node_modules/@prism/<pkg>/dist/ → 也找到根（此前解析到 node_modules/3rd）', () => {
    const { url, expectedRoot } = fakeLayout(join('node_modules', '@prism', 'server', 'dist', 'kb', 'embedding.js'))
    const root = repoRoot(url)
    // 写死 4 层会得到 <root>/node_modules——这才是事故所在
    expect(root).not.toBe(join(expectedRoot, 'node_modules'))
    expect(root).toBe(expectedRoot)
    expect(existsSync(join(root!, '3rd'))).toBe(true)
  })

  it('找不到特征目录 → null（调用方回落）', () => {
    const base = mkdtempSync(join(tmpdir(), 'prism-noroot-'))
    const f = join(base, 'a', 'b.js')
    mkdirSync(join(base, 'a'), { recursive: true })
    writeFileSync(f, '// x', 'utf-8')
    expect(repoRoot(pathToFileURL(f).href)).toBeNull()
  })
})
