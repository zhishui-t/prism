/**
 * 五类派生图 —— **真实 archify 门禁**（这里能调到 vendored 渲染器）。
 *
 * `packages/agents/test/arch-ir.test.ts` 只测纯函数语义与「渲染器口径不变量」；
 * 本文件是**最终裁判**：把生成器产出的 IR 交给真实 `validateDiagram`
 * （schema + 布局双校验），过了才算数。之所以必须两边都测：
 * - 单测里那些「口径常量」是抄来的，抄错了只有真渲染器能发现；
 * - 真渲染器的判定又依赖几何，纯函数测试无法覆盖。
 */
import { resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { buildArchitectureIr, buildDataflowIr, buildSequenceIr, buildTaskLifecycleIr, type CodeGraph } from '@prism/agents'
import { createMcpTools } from '../src/mcp/server.js'
import { ProjectRegistry } from '../src/graph/registry.js'
import { renderDiagram, validateDiagram } from '../src/graph/archify.js'
import { makeTempDir, putFile } from './helpers.js'

/**
 * 合成图谱：4 个目录角色 + 一个层里 6 个模块（触发 yOffset 叠排）+ 跨文件 calls 边。
 * 刻意造得「难」：真实仓库上踩过的坑（穿节点、标签压节点、层塌缩、文本超宽）
 * 在小图上也能复现。
 */
function makeGraph(): CodeGraph {
  const nodes: Array<Record<string, unknown>> = [
    { id: 'cli', label: 'entrypoint', source_file: 'proj/src/cli/entrypoint.ts', community: 0 },
    { id: 'api', label: 'routes', source_file: 'proj/src/api/routes.ts', community: 1 },
    { id: 'api2', label: 'handler', source_file: 'proj/src/api/a_very_long_route_descriptor_handler.ts', community: 1 },
    { id: 'store', label: 'database', source_file: 'proj/src/store/database.ts', community: 2 },
  ]
  for (let i = 0; i < 6; i += 1) {
    nodes.push({
      id: `dom${i}`,
      label: `service${i}`,
      source_file: `proj/src/domain/mod${i}/service.ts`,
      community: 10 + i,
    })
  }
  const edges: Array<Record<string, unknown>> = [
    { source: 'cli', target: 'api', relation: 'calls' },
    { source: 'api', target: 'api2', relation: 'calls' },
    { source: 'api2', target: 'dom0', relation: 'calls' },
    { source: 'api', target: 'dom1', relation: 'calls' },
    { source: 'api', target: 'dom2', relation: 'imports' },
    { source: 'dom0', target: 'store', relation: 'calls' },
    { source: 'dom1', target: 'store', relation: 'imports' },
    { source: 'dom2', target: 'store', relation: 'imports' },
    { source: 'dom3', target: 'store', relation: 'imports' },
    { source: 'dom0', target: 'dom1', relation: 'imports' },
  ]
  return { nodes: nodes as never, links: edges as never }
}

describe('五类图：真实 archify 校验 + 渲染', () => {
  const outDirs: string[] = []

  afterAll(async () => {
    // 临时目录由 globalSetup 的 reaper 统一回收，这里只需保证句柄已释放（无）
    void outDirs
  })

  it('architecture 派生 IR 通过真渲染器校验', async () => {
    const ir = buildArchitectureIr(makeGraph(), { title: '合成架构' })
    const result = await validateDiagram('architecture', ir)
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('sequence 派生 IR 通过真渲染器校验', async () => {
    const ir = buildSequenceIr(makeGraph(), { title: '合成时序' })
    const result = await validateDiagram('sequence', ir)
    expect(result.problems).toEqual([])
  })

  it('dataflow 派生 IR 通过真渲染器校验（含 yOffset 叠排）', async () => {
    const ir = buildDataflowIr(makeGraph(), { title: '合成流向' })
    const result = await validateDiagram('dataflow', ir)
    expect(result.problems).toEqual([])
  })

  it('lifecycle 派生 IR 通过真渲染器校验（36 条转移全保留）', async () => {
    const ir = buildTaskLifecycleIr()
    const result = await validateDiagram('lifecycle', ir)
    expect(result.problems).toEqual([])
    expect(ir.transitions).toHaveLength(36)
  })

  it('renderDiagram 落盘自包含 HTML，bytes 是真实字节数', async () => {
    const dir = await makeTempDir('prism-arch-render-')
    outDirs.push(dir)
    const out = `${dir}/lifecycle.html`
    const result = await renderDiagram('lifecycle', buildTaskLifecycleIr(), out)
    // renderDiagram 内部 resolve() 归一化路径，Windows 上会把 / 变 \，故比对归一化后的值
    expect(result.htmlPath).toBe(resolve(out))
    expect(result.bytes).toBeGreaterThan(10_000)
  })
})

describe('MCP：prism_arch_generate', () => {
  it('lifecycle 无需项目即可生成；缺 project 时明确报错', async () => {
    const home = await makeTempDir('prism-arch-mcp-')
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')
      expect(tool).toBeDefined()

      const life = (await tool!.call({ type: 'lifecycle' })) as { html: string; ir: string; bytes: number }
      expect(life.html.startsWith(home)).toBe(true)
      expect(life.bytes).toBeGreaterThan(10_000)

      await expect(tool!.call({ type: 'architecture' })).rejects.toThrow(/需要 \{ project \}/)
      await expect(tool!.call({ type: 'nope' })).rejects.toThrow(/type 必须是/)
    } finally {
      // Windows：不 close 会留下 SQLite 句柄，临时目录删不掉
      tools.close()
    }
  })

  it('architecture：注册项目 + graph.json → 生成成功；图缺 calls 边时拒画', async () => {
    const home = await makeTempDir('prism-arch-mcp-proj-')
    const root = await makeTempDir('prism-arch-proj-')
    await putFile(`${root}/graphify-out/graph.json`, JSON.stringify(makeGraph()))
    const registry = new ProjectRegistry(home)
    await registry.register('demo', root)
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')!
      for (const type of ['architecture', 'sequence', 'dataflow'] as const) {
        const result = (await tool.call({ type, project: 'demo' })) as { html: string; subtitle?: string }
        expect(result.html).toContain(`${type}`)
      }
      // 只有 imports、没有 calls 的图谱 → sequence 必须报错而不是造图
      await putFile(
        `${root}/graphify-out/graph.json`,
        JSON.stringify({
          nodes: [
            { id: 'a', label: 'a', source_file: 'proj/src/api/a.ts', community: 0 },
            { id: 'b', label: 'b', source_file: 'proj/src/domain/b.ts', community: 1 },
          ],
          links: [{ source: 'a', target: 'b', relation: 'imports' }],
        }),
      )
      await expect(tool.call({ type: 'sequence', project: 'demo' })).rejects.toThrow(/跨文件 calls 边/)
    } finally {
      tools.close()
    }
  })

  it('工具名唯一（防重复注册）', async () => {
    const home = await makeTempDir('prism-arch-mcp-names-')
    const tools = createMcpTools({ home })
    try {
      const names = tools.map((item) => item.name)
      expect(new Set(names).size).toBe(names.length)
      expect(names).toContain('prism_arch_generate')
    } finally {
      tools.close()
    }
  })
})
