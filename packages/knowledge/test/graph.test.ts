import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractWikiLinks, PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeService(): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-graph-'))
  dirs.push(home)
  return new PrismKnowledgeService({ home })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('extractWikiLinks（双链抽取，确定性零 LLM）', () => {
  it('识别 [[id]] 与 [[id|显示文本]]；去重保序；忽略空/跨行', () => {
    expect(extractWikiLinks('见 [[A-1]] 和 [[B-2|别名]]，再 [[A-1]]。')).toEqual(['A-1', 'B-2'])
    expect(extractWikiLinks('[[ ]] 空的不算')).toEqual([])
    expect(extractWikiLinks('无链接正文')).toEqual([])
    expect(extractWikiLinks('[[X\nY]] 跨行不算')).toEqual([])
  })
})

describe('知识图谱（单一边表 + 多视图，D8）', () => {
  it('deposit 抽取双链与 overrides → 边表落库；graph 邻域返回节点+边', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'A', title: '规则A', type: 'rule', layer: 'global', book: 'b', content: 'A 正文' })
      await service.deposit({
        id: 'B',
        title: '规则B',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: 'B 引用 [[A]]',
        overrides: ['A'],
      })
      await service.deposit({ id: 'C', title: '规则C', type: 'doc', layer: 'global', book: 'b', content: 'C 引用 [[B]]' })

      // B 的邻域（depth 1）：B→A(references) + B→A(overrides) + C→B
      const view = await service.graph({ id: 'B', depth: 1 })
      expect(view.root).toBe('B')
      expect(view.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C'])
      const rels = view.edges.map((e) => `${e.from_id}->${e.to_id}:${e.relation}`).sort()
      expect(rels).toEqual(['B->A:overrides', 'B->A:references', 'C->B:references'])
      // 度数：A 入度 2、B 出度 2 入度 1
      const a = view.nodes.find((n) => n.id === 'A')
      const b = view.nodes.find((n) => n.id === 'B')
      expect(a?.in_degree).toBe(2)
      expect(b?.out_degree).toBe(2)
      expect(b?.in_degree).toBe(1)
    } finally {
      service.close()
    }
  })

  it('path：C → A 经 B（无向 BFS）；不可达 → null；关系过滤生效', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'A', title: 'A', type: 'rule', layer: 'global', book: 'b', content: 'A' })
      await service.deposit({ id: 'B', title: 'B', type: 'rule', layer: 'global', book: 'b', content: 'B [[A]]' })
      await service.deposit({ id: 'C', title: 'C', type: 'rule', layer: 'global', book: 'b', content: 'C [[B]]' })
      await service.deposit({ id: 'D', title: 'D', type: 'rule', layer: 'global', book: 'b', content: 'D 孤岛' })

      const path = await service.path('C', 'A')
      expect(path?.nodes).toEqual(['C', 'B', 'A'])
      expect(path?.edges).toHaveLength(2)
      expect(await service.path('D', 'A')).toBeNull()
      // 只走 overrides：C→B 是 references，故 A↔B 的 overrides 边不连通 C
      expect(await service.path('C', 'A', ['overrides'])).toBeNull()
    } finally {
      service.close()
    }
  })

  it('概览查询：按度数排序、limit 截断标记；无 id 返回全图视图', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'A', title: 'A', type: 'rule', layer: 'global', book: 'b', content: 'A' })
      await service.deposit({ id: 'B', title: 'B', type: 'rule', layer: 'global', book: 'b', content: 'B [[A]]' })
      await service.deposit({ id: 'C', title: 'C', type: 'rule', layer: 'global', book: 'b', content: 'C [[A]]' })

      const overview = await service.graph()
      expect(overview.nodes[0]?.id).toBe('A') // 度数最高
      expect(overview.edges).toHaveLength(2)

      const limited = await service.graph({ limit: 2 })
      expect(limited.nodes.length).toBeLessThanOrEqual(2)
      expect(limited.truncated).toBe(true)
    } finally {
      service.close()
    }
  })

  it('reindex 重建边表：手工改正文加双链后，边随之出现', async () => {
    const service = makeService()
    try {
      const a = await service.deposit({ id: 'A', title: 'A', type: 'rule', layer: 'global', book: 'b', content: 'A' })
      await service.deposit({ id: 'B', title: 'B', type: 'rule', layer: 'global', book: 'b', content: 'B 无链接' })
      expect((await service.graph()).edges).toHaveLength(0)

      // 手工给 B 加双链
      const bFile = join(service.knowledgeDir, 'global', 'b', '_inbox', 'B', 'v01.md')
      writeFileSync(
        bFile,
        `---\nid: B\nversion: 1\ntitle: B\ntype: rule\nlayer: global\nbook: b\nmodule: ""\nstatus: active\n---\n\nB 现在引用 [[A]]。\n`,
        'utf-8',
      )
      void a
      const report = await service.reindex()
      expect(report.indexed).toBe(2)
      const view = await service.graph({ id: 'B' })
      expect(view.edges.map((e) => `${e.from_id}->${e.to_id}`)).toEqual(['B->A'])
    } finally {
      service.close()
    }
  })

  it('非法关系类型 → bad_request', async () => {
    const service = makeService()
    try {
      await expect(service.graph({ relations: ['bogus' as never] })).rejects.toMatchObject({
        code: 'bad_request',
      })
    } finally {
      service.close()
    }
  })

  it('按书过滤：只返回该书内的节点与边（跨书边被剔除）', async () => {
    const service = makeService()
    try {
      // 书 b1：A ↔ B；书 b2：C，且 C 引用 A（跨书边）
      await service.deposit({ id: 'F-A', title: 'A', type: 'rule', layer: 'global', book: 'b1', content: 'A' })
      await service.deposit({ id: 'F-B', title: 'B', type: 'rule', layer: 'global', book: 'b1', content: 'B [[F-A]]' })
      await service.deposit({ id: 'F-C', title: 'C', type: 'rule', layer: 'global', book: 'b2', content: 'C [[F-A]]' })

      const b1 = await service.graph({ book: 'b1' })
      expect(b1.nodes.map((n) => n.id).sort()).toEqual(['F-A', 'F-B'])
      expect(b1.edges.map((e) => `${e.from_id}->${e.to_id}`)).toEqual(['F-B->F-A'])

      const b2 = await service.graph({ book: 'b2' })
      expect(b2.nodes.map((n) => n.id)).toEqual(['F-C'])
      // 跨书边被剔除（A 不在 b2 内）
      expect(b2.edges).toEqual([])
    } finally {
      service.close()
    }
  })

  it('按模块过滤 + 邻域也不越界', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'M-1', title: 'M1', type: 'rule', layer: 'global', book: 'bm', module: 'm1', content: 'M1' })
      await service.deposit({ id: 'M-2', title: 'M2', type: 'rule', layer: 'global', book: 'bm', module: 'm1', content: 'M2 [[M-1]]' })
      await service.deposit({ id: 'M-3', title: 'M3', type: 'rule', layer: 'global', book: 'bm', module: 'm2', content: 'M3 [[M-2]]' })

      const m1 = await service.graph({ book: 'bm', module: 'm1', depth: 3 })
      expect(m1.nodes.map((n) => n.id).sort()).toEqual(['M-1', 'M-2'])
      // 邻域 depth=3 也不会把 m2 的 M-3 带进来
      expect(m1.nodes.some((n) => n.id === 'M-3')).toBe(false)
    } finally {
      service.close()
    }
  })
})
