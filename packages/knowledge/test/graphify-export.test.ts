import { describe, expect, it } from 'vitest'

import {
  graphifyExportSummary,
  graphViewFromEntries,
  toGraphifyGraph,
} from '../src/graphify-export.js'
import type { GraphView } from '../src/types.js'

/** 构造一个含悬空引用的图视图（验证导出时丢弃）。 */
function makeView(): GraphView {
  return {
    nodes: [
      {
        id: 'RULE-001',
        title: '禁止吞掉异常',
        type: 'rule',
        layer: 'global',
        book: 'java-standards',
        module: 'exception',
        in_degree: 1,
        out_degree: 1,
      },
      {
        id: 'RULE-002',
        title: '异常必须带上下文',
        type: 'rule',
        layer: 'project',
        owner: 'prism',
        book: 'java-standards',
        module: 'exception',
        in_degree: 1,
        out_degree: 0,
      },
    ],
    edges: [
      {
        from_id: 'RULE-001',
        to_id: 'RULE-002',
        relation: 'references',
        confidence: 'EXTRACTED',
        weight: 1,
        source: '[[双链]]',
        created_at: '2026-09-10T00:00:00.000Z',
      },
      {
        // 悬空引用：to_id 不在节点集
        from_id: 'RULE-001',
        to_id: 'GHOST',
        relation: 'references',
        confidence: 'EXTRACTED',
        weight: 1,
        source: '[[双链]]',
        created_at: '2026-09-10T00:00:00.000Z',
      },
    ],
    truncated: false,
  }
}

describe('toGraphifyGraph（知识图谱 → Graphify graph.json）', () => {
  it('节点带 Prism 归属字段；label 用标题；source_file 可溯源', () => {
    const graph = toGraphifyGraph(makeView())
    expect(graph.directed).toBe(false)
    expect(graph.nodes).toHaveLength(2)
    const a = graph.nodes.find((n) => n.id === 'RULE-001')!
    expect(a.label).toBe('禁止吞掉异常')
    expect(a.file_type).toBe('doc')
    expect(a.type).toBe('rule')
    expect(a.layer).toBe('global')
    expect(a.book).toBe('java-standards')
    expect(a.module).toBe('exception')
    // 溯源地址：层[/owner]/书/模块/ID
    expect(a.source_file).toBe('global/java-standards/exception/RULE-001')
    const b = graph.nodes.find((n) => n.id === 'RULE-002')!
    expect(b.source_file).toBe('project/prism/java-standards/exception/RULE-002')
  })

  it('悬空引用被丢弃（Graphify 要求边两端存在）', () => {
    const graph = toGraphifyGraph(makeView())
    expect(graph.links).toHaveLength(1)
    expect(graph.links[0]).toMatchObject({
      source: 'RULE-001',
      target: 'RULE-002',
      relation: 'references',
      confidence: 'EXTRACTED',
      context: 'wiki_link',
      _origin: 'prism',
    })
    expect(graph.links[0]!.confidence_score).toBe(1.0)
  })

  it('graphifyExportSummary 统计含丢弃计数', () => {
    const summary = graphifyExportSummary(makeView())
    expect(summary).toEqual({ nodes: 2, edges: 1, dropped_edges: 1 })
  })

  it('graphViewFromEntries 从条目+边构造视图（含度数）', () => {
    const view = graphViewFromEntries(
      [
        {
          id: 'A', version: 1, title: 'A', type: 'rule', layer: 'global', book: 'b', module: 'm',
          status: 'active', risk: 'low', confidence: 0.5, tags: [], content: '', path: '/p',
          content_hash: 'h', created_at: '', updated_at: '',
        },
        {
          id: 'B', version: 1, title: 'B', type: 'doc', layer: 'global', book: 'b', module: 'm',
          status: 'active', risk: 'low', confidence: 0.5, tags: [], content: '', path: '/p',
          content_hash: 'h', created_at: '', updated_at: '',
        },
      ],
      [
        {
          from_id: 'A', to_id: 'B', relation: 'references', confidence: 'EXTRACTED',
          weight: 1, source: '[[双链]]', created_at: '',
        },
      ],
    )
    expect(view.nodes).toHaveLength(2)
    expect(view.nodes.find((n) => n.id === 'A')!.out_degree).toBe(1)
    expect(view.nodes.find((n) => n.id === 'B')!.in_degree).toBe(1)
    // 转 Graphify 后边完整
    expect(toGraphifyGraph(view).links).toHaveLength(1)
  })

  it('空图 → 空 nodes/links（不抛错）', () => {
    const graph = toGraphifyGraph({ nodes: [], edges: [], truncated: false })
    expect(graph.nodes).toEqual([])
    expect(graph.links).toEqual([])
  })
})
