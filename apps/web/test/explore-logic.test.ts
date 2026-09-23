/**
 * v10 F9ui 层级探索的**纯函数**测试（node 环境，不渲染）。
 *
 * 锁五组规则（口径见 `src/pages/explore-logic.ts` 头注）：
 *  1. **路径**——只走网格三层（`symbol` 不在路径里）；压栈 / 回退的边界；
 *  2. **缓存键**——带项目名（换项目不串台），community 层不带 parent 段；
 *  3. **边强度归集**——出/入分开；
 *  4. **分页切片**——只切已取回的数据，负数/NaN 归零；
 *  5. **真分页（v17 B-7）**——页累加 `mergeRollupPage` / 「更多」判据 `moreAvailable` /
 *     409 判定 `isStaleCursorError`。
 *
 * 为什么单开一个文件：这些判据都在 DOM 之下，DOM 测试验的是「接线」，
 * 边界（越界回退、NaN 页宽、同一节点同时有入边和出边）在这里钉最省事。
 */

import { describe, expect, it } from 'vitest'

import type { RollupEdge, RollupResult } from '../src/api.ts'
import {
  EXPLORE_PAGE,
  EXPLORE_ROOT,
  GRID_LEVELS,
  cacheKey,
  currentCrumb,
  drillTarget,
  edgeTotals,
  isStaleCursorError,
  maxEdgeWeight,
  mergeRollupPage,
  moreAvailable,
  pageOf,
  popTo,
  pushCrumb,
  type Crumb,
} from '../src/pages/explore-logic.ts'

function edge(from: string, to: string, weight = 1): RollupEdge {
  return { from, to, weight }
}

describe('F9ui 层与路径：三层是网格，symbol 是出口', () => {
  it('网格层只有 community / dir / file（symbol 不进面包屑）', () => {
    expect(GRID_LEVELS).toEqual(['community', 'dir', 'file'])
  })

  it('drillTarget 逐层下探，symbol 到头（再往下是切到查询态）', () => {
    expect(drillTarget('community')).toBe('dir')
    expect(drillTarget('dir')).toBe('file')
    expect(drillTarget('file')).toBe('symbol')
    expect(drillTarget('symbol')).toBeNull()
  })

  it('压栈：用**节点的合成 id** 当 parent、节点名当面包屑文字', () => {
    const path = pushCrumb([EXPLORE_ROOT], 'community', { id: 'community:1', label: '核心' })
    expect(path).toEqual([
      { level: 'community', parent: null, label: '' },
      { level: 'dir', parent: 'community:1', label: '核心' },
    ])
    const deeper = pushCrumb(path, 'dir', { id: 'dir:src/sub', label: 'src/sub' })
    expect(currentCrumb(deeper)).toEqual({ level: 'file', parent: 'dir:src/sub', label: 'src/sub' })
  })

  it('压栈返回**新数组**，不改入参（React state 判等靠引用）', () => {
    const before: readonly Crumb[] = [EXPLORE_ROOT]
    const after = pushCrumb(before, 'community', { id: 'community:2', label: '工具' })
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
    expect(after).not.toBe(before)
  })

  it('已到最深（symbol 层）压栈是空操作：原数组返回，不造出一条「symbol 的子层」', () => {
    const path: readonly Crumb[] = [{ level: 'symbol', parent: 'file:a.ts', label: 'a.ts' }]
    expect(pushCrumb(path, 'symbol', { id: 'x', label: 'x' })).toBe(path)
  })

  it('回退：点第 index 段回第 index 段（越界夹取，不抛——调用方是用户点击）', () => {
    const path = [
      EXPLORE_ROOT,
      { level: 'dir' as const, parent: 'community:1', label: '核心' },
      { level: 'file' as const, parent: 'dir:src', label: 'src' },
    ]
    expect(popTo(path, 0)).toHaveLength(1)
    expect(popTo(path, 1)).toHaveLength(2)
    // 点末段 = 「回到当前」：长度不变（不是把它自己弹掉）
    expect(popTo(path, 2)).toHaveLength(3)
    expect(popTo(path, -5)).toHaveLength(1)
    expect(popTo(path, 99)).toHaveLength(3)
  })

  it('根面包屑的 label 是空串（渲染时回落 t()，故换语言不会留下旧文案）', () => {
    expect(EXPLORE_ROOT).toEqual({ level: 'community', parent: null, label: '' })
    expect(currentCrumb([])).toBe(EXPLORE_ROOT)
  })
})

describe('F9ui 缓存键：带项目名 + community 层不带 parent 段', () => {
  it('community 层的键不含 parent（它本就不接受 parent）', () => {
    expect(cacheKey('demo', 'community', null)).toBe('demo|community')
  })

  it('其余三层的键含 parent（同一层不同 parent 是两笔数据）', () => {
    expect(cacheKey('demo', 'dir', 'community:1')).toBe('demo|dir|community:1')
    expect(cacheKey('demo', 'file', 'dir:src')).toBe('demo|file|dir:src')
    expect(cacheKey('demo', 'symbol', 'file:a.ts')).toBe('demo|symbol|file:a.ts')
  })

  it('**换项目不串台**：同名社区/路径在两个项目里是不同的键', () => {
    expect(cacheKey('a', 'dir', 'community:1')).not.toBe(cacheKey('b', 'dir', 'community:1'))
  })
})

describe('F9ui 边强度归集：出/入分开，且同一条边记两端', () => {
  it('一条 community:1 → community:2 的边：1 记出、2 记入', () => {
    const totals = edgeTotals([edge('community:1', 'community:2', 2)])
    expect(totals.get('community:1')).toEqual({ in: 0, out: 1 })
    expect(totals.get('community:2')).toEqual({ in: 1, out: 0 })
  })

  it('同一节点同时有入边和出边时两侧各自累加（不被覆盖）', () => {
    const totals = edgeTotals([
      edge('a', 'b'),
      edge('c', 'a'),
      edge('a', 'd'),
    ])
    expect(totals.get('a')).toEqual({ in: 1, out: 2 })
  })

  it('边条数按**边**计（同一对端点两条边 = 2），不看边自带的 weight 值', () => {
    const totals = edgeTotals([edge('a', 'b', 9), edge('a', 'b', 7)])
    expect(totals.get('a')).toEqual({ in: 0, out: 2 })
    expect(totals.get('b')).toEqual({ in: 2, out: 0 })
  })

  it('没有边的层（symbol 层恒如此）→ 空表；maxEdgeWeight → 0', () => {
    expect(edgeTotals([]).size).toBe(0)
    expect(maxEdgeWeight([])).toBe(0)
  })

  it('maxEdgeWeight 取逐边 weight 的最大值（卡片上那把尺子）', () => {
    expect(maxEdgeWeight([edge('a', 'b', 1), edge('c', 'd', 5), edge('e', 'f', 3)])).toBe(5)
  })
})

describe('F9ui 客户端分页：只切已取回的数据', () => {
  const items = Array.from({ length: 130 }, (_, i) => i)

  it('一屏 EXPLORE_PAGE 条；点一次「更多」翻一倍（纯切片，切的是已取回的条数）', () => {
    expect(EXPLORE_PAGE).toBeGreaterThan(0)
    expect(pageOf(items, EXPLORE_PAGE)).toHaveLength(EXPLORE_PAGE)
    expect(pageOf(items, EXPLORE_PAGE * 2)).toHaveLength(EXPLORE_PAGE * 2)
  })

  it('超出全长按全长（不多切出 undefined）', () => {
    expect(pageOf(items, 10_000)).toHaveLength(items.length)
  })

  it('非法页宽归零（负数 / NaN 都不抛，也不回退成「全部」）', () => {
    expect(pageOf(items, -3)).toEqual([])
    expect(pageOf(items, Number.NaN)).toEqual([])
    expect(pageOf(items, 2.7)).toHaveLength(2)
  })
})

describe('v17 B-7 真分页：页累加 / 「更多」判据 / 409 判定', () => {
  function layer(over: Partial<RollupResult> = {}): RollupResult {
    return { level: 'community', parent: null, total: 2, truncated: false, nodes: [], edges: [], ...over }
  }

  it('mergeRollupPage：节点与边拼接，元信息以**新页**为准（新页无 cursor = 到底了）', () => {
    const prev = layer({
      total: 503,
      truncated: true,
      next_cursor: 'cur-1',
      nodes: [{ id: 'a', label: 'A', kind: 'community', symbol_count: 2 }],
      // 首页看不见跨页边（对端还没入页）
      edges: [],
    })
    const next = layer({
      total: 503,
      truncated: true,
      nodes: [{ id: 'b', label: 'B', kind: 'community', symbol_count: 1 }],
      // 次页补齐的跨页边（new ↔ already-paged）——恰好一条，拼接后不重
      edges: [{ from: 'a', to: 'b', weight: 1 }],
    })
    const merged = mergeRollupPage(prev, next)
    expect(merged.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(merged.edges).toEqual([{ from: 'a', to: 'b', weight: 1 }])
    expect(merged.total).toBe(503)
    // 新页没有 next_cursor → 合并后也不该有（旧游标被覆盖，不是保留）
    expect('next_cursor' in merged).toBe(false)
  })

  it('mergeRollupPage 不改入参（返回新对象）', () => {
    const prev = layer({ nodes: [{ id: 'a', label: 'A', kind: 'community', symbol_count: 1 }] })
    const next = layer({ nodes: [{ id: 'b', label: 'B', kind: 'community', symbol_count: 1 }] })
    const merged = mergeRollupPage(prev, next)
    expect(prev.nodes).toHaveLength(1)
    expect(merged).not.toBe(prev)
  })

  it('moreAvailable：本地有余量 → 可更多；翻完且无下一页 → 不可更多', () => {
    // 本地还有 40 条没显示（loaded 100 > shown 60）——即使没有 cursor 也还能「更多」
    expect(moreAvailable(100, 60, undefined)).toBe(true)
    // 本地翻完（loaded 60 = shown 60）但有下一页游标 → 可更多（会发请求）
    expect(moreAvailable(60, 60, 'cur')).toBe(true)
    // 本地翻完且无下一页 → 按钮该消失
    expect(moreAvailable(60, 60, undefined)).toBe(false)
    // shown 超过 loaded（异常输入）也不该报「可更多」
    expect(moreAvailable(10, 60, undefined)).toBe(false)
  })

  it('isStaleCursorError：只认 `stale_cursor:` 前缀（不误伤别的错误码）', () => {
    expect(isStaleCursorError('stale_cursor: 图谱已重建，翻页游标失效：请回首页重新查询')).toBe(true)
    expect(isStaleCursorError('stale_write: 陈旧写')).toBe(false)
    expect(isStaleCursorError('not_found: nope')).toBe(false)
    expect(isStaleCursorError('图谱已重建')).toBe(false)
  })
})
