import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ARCHIFY_DIAGRAM_TYPES,
  renderDiagram,
  resolveArchifyCommand,
  validateDiagram,
  vendoredArchifyEntry,
} from '../src/graph/archify.js'

const dirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 合法的最小架构图 IR（archify 要求显式 pos/size）。 */
const VALID_IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: '测试架构' },
  components: [
    { id: 'a', type: 'frontend', label: '前端', pos: [40, 200], size: [140, 68] },
    { id: 'b', type: 'backend', label: '后端', pos: [240, 200], size: [140, 68] },
  ],
  connections: [{ id: 'a-b', from: 'a', to: 'b', label: '调用' }],
}

describe('Archify 子工程解析（3rd/archify，vendored）', () => {
  it('vendoredArchifyEntry 指向 3rd/archify/bin/archify.mjs 且文件存在', () => {
    const entry = vendoredArchifyEntry()
    expect(entry).toContain(join('3rd', 'archify', 'bin', 'archify.mjs'))
    expect(existsSync(entry)).toBe(true)
  })

  it('resolveArchifyCommand：默认走 vendored（node + bin/archify.mjs）', async () => {
    const command = await resolveArchifyCommand({})
    expect(command.shell).toBe(false)
    expect(command.prefixArgs[0]).toBe(vendoredArchifyEntry())
  })

  it('ARCHIFY_BIN 覆盖优先（测试可注入假实现）', async () => {
    const command = await resolveArchifyCommand({ ARCHIFY_BIN: '/tmp/fake-archify.mjs' })
    expect(command.prefixArgs).toEqual(['/tmp/fake-archify.mjs'])
  })

  it('五类图枚举齐全', () => {
    expect([...ARCHIFY_DIAGRAM_TYPES]).toEqual([
      'architecture',
      'sequence',
      'lifecycle',
      'dataflow',
      'workflow',
    ])
  })
})

describe('Archify validate / render（真实调用 vendored CLI）', () => {
  it('合法 IR → validate ok；渲染产出自包含 HTML（无外部 http src）', async () => {
    const validation = await validateDiagram('architecture', VALID_IR)
    expect(validation.ok).toBe(true)
    expect(validation.problems).toHaveLength(0)

    const dir = await tempDir('prism-arch-render-')
    const out = join(dir, 'a.html')
    const result = await renderDiagram('architecture', VALID_IR, out)
    expect(result.htmlPath).toBe(out)
    expect(existsSync(out)).toBe(true)
    const html = await readFile(out, 'utf-8')
    expect(html.length).toBeGreaterThan(100_000) // 自包含模板体积
    expect(/<script/i.test(html)).toBe(true)
    // 自包含：不应有外部 http(s) 资源引用
    expect(/src=["']https?:\/\//i.test(html)).toBe(false)
  })

  it('非法 IR（缺 pos）→ validate 不通过，render 拒绝（archify_validation_failed）', async () => {
    const bad = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '坏图' },
      components: [{ id: 'a', type: 'frontend', label: '前端' }],
      connections: [],
    }
    const validation = await validateDiagram('architecture', bad)
    expect(validation.ok).toBe(false)
    expect(validation.problems.length).toBeGreaterThan(0)

    const dir = await tempDir('prism-arch-bad-')
    await expect(renderDiagram('architecture', bad, join(dir, 'bad.html'))).rejects.toMatchObject({
      code: 'archify_validation_failed',
    })
  })

  it('非法图类型 → bad_request（不落到 CLI）', async () => {
    await expect(validateDiagram('bogus', VALID_IR)).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('ARCHIFY_BIN 指向不存在文件 → validate 返回 not ok（CLI 起不来）', async () => {
    const dir = await tempDir('prism-arch-missing-')
    const result = await validateDiagram('architecture', VALID_IR, {
      env: { ARCHIFY_BIN: join(dir, 'nope.mjs') },
    })
    // CLI 无法启动时非零退出 → 校验判为不通过（而非抛错，便于上层统一按 ok 处理）
    expect(result.ok).toBe(false)
  })
})

describe('Archify 五类图（用 vendored 官方示例验证 IR 规格对齐）', () => {
  /** 官方示例文件名 → 图类型（3rd/archify/examples）。 */
  const OFFICIAL: Array<{ type: string; file: string }> = [
    { type: 'architecture', file: 'web-app.architecture.json' },
    { type: 'sequence', file: 'async-job-roundtrip.sequence.json' },
    { type: 'lifecycle', file: 'agent-run.lifecycle.json' },
    { type: 'dataflow', file: 'event-stream.dataflow.json' },
    { type: 'workflow', file: 'incident-response.workflow.json' },
  ]

  const examplesDir = (): string =>
    join(dirname(vendoredArchifyEntry()), '..', 'examples')

  it.each(OFFICIAL)('$type：官方示例 validate 通过', async ({ type, file }) => {
    const ir = JSON.parse(await readFile(join(examplesDir(), file), 'utf-8')) as unknown
    const validation = await validateDiagram(type, ir)
    expect(
      validation.ok,
      `${type} 官方示例校验失败: ${validation.problems.map((p) => p.message).join('; ')}`,
    ).toBe(true)
  })

  it('五类图各渲染一次均产出自包含 HTML', async () => {
    const dir = await tempDir('prism-arch-all-')
    for (const { type, file } of OFFICIAL) {
      const ir = JSON.parse(await readFile(join(examplesDir(), file), 'utf-8')) as unknown
      const out = join(dir, `${type}.html`)
      await renderDiagram(type, ir, out)
      expect(existsSync(out), `${type} 未产出 HTML`).toBe(true)
    }
  }, 120_000)
})
