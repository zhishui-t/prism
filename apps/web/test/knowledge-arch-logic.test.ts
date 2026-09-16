/**
 * v9 F2 架构图入目录树：**纯判据**（node 直测，不牵 React / `api.ts`）。
 *
 * 锁四件事（design-v9 §4 / 审核修订 E-2/E-3/E-5）：
 *  1. 深链形态 `arch-<type>-<name>`——五类型闭集、`name` 逐字保留、非法形态一律回落条目分支；
 *  2. 挂载——`module` 命中目录段挂该目录，空 / 未命中回落**书根**（DFS 首个命中，不跨父猜测）；
 *  3. 计数——`countTree` 把架构图算进子树总数；
 *  4. 过滤——`archHit` 与条目同一轮裁枝，只留图形的目录同样要活；缺省（三参调用）行为不变。
 *
 * 环境：默认 node（沿用 `knowledge-logic.test.ts` 的既有做法）。
 */

import { describe, expect, it } from 'vitest'

import {
  archMatches,
  archSel,
  archVisible,
  buildTree,
  countTree,
  filterTree,
  mountArch,
  parseArchSel,
  ARCH_TYPES,
  type ArchNode,
  type DirNode,
} from '../src/pages/knowledge-logic.ts'

/** 只带 `path` 的条目壳（`buildTree` 的唯一入参要求）。 */
function at(path: string, id = path): { path: string; id: string } {
  return { path, id }
}

/** 架构图节点壳（`preview` / `mtime` 参与右栏渲染，树判据只用 type/name/title/layer/module）。 */
function diagram(type: string, name: string, extra: Partial<ArchNode> = {}): ArchNode {
  return {
    type,
    name,
    preview: `/api/arch/preview/${type}/${name}`,
    mtime: '2026-09-16T08:00:00.000Z',
    ...extra,
  }
}

/** 树形快照（与 `knowledge-logic.test.ts` 的 `shape` 同形，另把 `arch` 段标成 `{…}`）。 */
function shape<T>(node: DirNode<T>): string {
  const own = node.entries.length === 0 ? '' : `[${node.entries.map((e) => (e as { id: string }).id).join(',')}]`
  const arch = node.arch.length === 0 ? '' : `{${node.arch.map((a) => a.name).join(',')}}`
  const kids = node.dirs.map(shape).join(' ')
  return `${node.name}(${countTree(node)})${own}${arch}${kids === '' ? '' : ` ${kids}`}`
}

/** 按段名找子目录（`dirs` 已按段名排序，这里按名取，免得断言依赖兄弟顺序）。 */
function dirNamed<T>(node: DirNode<T>, name: string): DirNode<T> {
  const found = node.dirs.find((d) => d.name === name)
  if (found === undefined) throw new Error(`目录段不存在：${name}`)
  return found
}

describe('parseArchSel · arch- 深链形态（design-v9 E-5）', () => {
  it('闭集与 `ARCHIFY_DIAGRAM_TYPES` **逐元素同序**（对上账的那一份；跨包 import 在 apps/web 测试里解析不到，故写死字面量交叉引用）', () => {
    expect(ARCH_TYPES).toEqual(['architecture', 'sequence', 'lifecycle', 'dataflow', 'workflow'])
  })

  it('五类型各一个正例（`arch-<type>-<name>` 单段 sel）', () => {
    for (const type of ARCH_TYPES) {
      expect(parseArchSel(`arch-${type}-demo.html`)).toEqual({ type, name: 'demo.html' })
    }
  })

  it('`name` 逐字保留：`.` / `_` / `-` 都不切、不去后缀（服务端消毒白名单正是这三类）', () => {
    expect(parseArchSel('arch-sequence-a_b.c-d.html')).toEqual({ type: 'sequence', name: 'a_b.c-d.html' })
    // 名字里再出现类型名也不干扰（只认**首个**类型段，其后全是名字）
    expect(parseArchSel('arch-architecture-arch-workflow.html')).toEqual({
      type: 'architecture',
      name: 'arch-workflow.html',
    })
  })

  it('非法类型 / 缺名字 / 无前缀 → null（回落条目分支，不新增错误面）', () => {
    expect(parseArchSel('arch-gantt-demo.html')).toBeNull() // 类型不在闭集
    expect(parseArchSel('arch-architecture')).toBeNull() // 缺名字（类型后没有 `-`）
    expect(parseArchSel('arch-architecture-')).toBeNull() // 名字为空串
    expect(parseArchSel('arch-')).toBeNull()
    expect(parseArchSel('KB-2f1a')).toBeNull() // 条目 id
    expect(parseArchSel('IDX-9')).toBeNull()
    expect(parseArchSel('')).toBeNull()
  })

  it('`archSel` 与 `parseArchSel` 往返一致（深链写入与解析同一真相源）', () => {
    for (const type of ARCH_TYPES) {
      const item = diagram(type, 'x_1.y.html')
      expect(parseArchSel(archSel(item))).toEqual({ type, name: 'x_1.y.html' })
    }
  })
})

describe('mountArch · 按 `module` 挂目录段 / 未命中回落书根（E-2）', () => {
  /** 书 = `prism`：`doc › req` 两级 + `api`；锚 = 最后一个 `prism` 段。 */
  const tree = () =>
    buildTree(
      [
        at('K:\\w\\prism\\doc\\a.md', 'doc-a'),
        at('K:\\w\\prism\\doc\\req\\b.md', 'req-b'),
        at('K:\\w\\prism\\api\\c.md', 'api-c'),
      ],
      'prism',
    )

  it('`module` 命中目录段 → 挂该目录；`module` 空 / 未命中 → 书根；同节点内 arch 排在 entries 之后', () => {
    const mounted = mountArch(tree(), [
      diagram('architecture', 'hit.html', { module: 'req', title: 'Hit' }),
      diagram('dataflow', 'root-a.html', { module: '' }),
      diagram('workflow', 'root-b.html', { module: 'nope' }),
    ])

    // 根：两条回落项（空 module / 未命中），`doc › req` 一条
    expect(mounted.arch.map((a) => a.name)).toEqual(['root-a.html', 'root-b.html'])
    const req = dirNamed(dirNamed(mounted, 'doc'), 'req')
    expect(req.arch.map((a) => a.name)).toEqual(['hit.html'])
    // 目录段的直属条目与图形各自成组（渲染层把 arch 排在 entries 之后）
    expect(req.entries.map((e) => e.id)).toEqual(['req-b'])
    // 计数：图算进子树总数（doc 下 = doc-a + req-b + hit.html = 3）
    expect(countTree(dirNamed(mounted, 'doc'))).toBe(3)
    // 根：3 条条目 + 3 张图 = 6
    expect(shape(mounted)).toBe('(6){root-a.html,root-b.html} api(1)[api-c] doc(3)[doc-a] req(2)[req-b]{hit.html}')
  })

  it('同名目录段分属不同父 → 取 DFS 首个命中（不跨父合并、不取全部）', () => {
    const mounted = mountArch(
      buildTree([at('K:\\w\\prism\\doc\\req\\a.md', 'a'), at('K:\\w\\prism\\notes\\req\\b.md', 'b')], 'prism'),
      [diagram('sequence', 's.html', { module: 'req' })],
    )

    // 同层目录按段名排序 ⇒ `doc` 在 `notes` 前，故首个 `req` 是 `doc/req`
    const docReq = dirNamed(dirNamed(mounted, 'doc'), 'req')
    const notesReq = dirNamed(dirNamed(mounted, 'notes'), 'req')
    expect(docReq.arch.map((a) => a.name)).toEqual(['s.html'])
    expect(notesReq.arch).toEqual([])
  })

  it('不可变：不动入参树（同一棵树可反复挂不同清单）', () => {
    const base = tree()
    const mounted = mountArch(base, [diagram('lifecycle', 'l.html', { module: 'doc' })])

    expect(base.arch).toEqual([])
    expect(base.dirs.map((d) => d.arch)).toEqual([[], []])
    expect(dirNamed(mounted, 'doc').arch.map((a) => a.name)).toEqual(['l.html'])
  })
})

describe('countTree / filterTree · 架构图与条目同一轮裁枝', () => {
  const mounted = () =>
    mountArch(
      buildTree([at('K:\\w\\prism\\doc\\a.md', 'doc-a'), at('K:\\w\\prism\\api\\c.md', 'api-c')], 'prism'),
      [
        diagram('architecture', 'hit.html', { module: 'doc', title: 'Hit Chart' }),
        diagram('sequence', 'miss.html', { module: 'api', title: 'Other' }),
      ],
    )
  const noEntry: (e: { id: string }) => boolean = () => false
  const noDir: (name: string) => boolean = () => false

  it('只命中图形（条目全不中）→ 保留该图形所在目录，另一枝剪掉', () => {
    const kept = filterTree(mounted(), noEntry, noDir, (a) => a.name === 'hit.html')

    expect(shape(kept!)).toBe('(1) doc(1){hit.html}')
  })

  it('条目与图形都不命中 → undefined（该书的可见性由裁枝结果决定）', () => {
    expect(filterTree(mounted(), noEntry, noDir, () => false)).toBeUndefined()
  })

  it('目录段名命中 → 整棵子树原样保留（含其下图形，不吃图形自身的命中判据）', () => {
    const kept = filterTree(mounted(), noEntry, (name) => name === 'api', () => false)

    // `api` 整棵原样返回：它的直属条目 `api-c` 与图形 `miss.html` 一并带出（`archHit` 不参与该分支）
    expect(shape(kept!)).toBe('(2) api(2)[api-c]{miss.html}')
  })

  it('缺省 `archHit`（三参调用）→ 图形照旧保留：既有调用点语义零变化', () => {
    const kept = filterTree(mounted(), (e) => e.id === 'doc-a', noDir)

    expect(shape(kept!)).toBe('(3) api(1){miss.html} doc(2)[doc-a]{hit.html}')
  })
})

describe('archMatches / archVisible · 检索与层 chips 的判据（E-3）', () => {
  const item = diagram('architecture', 'order-flow.html', { title: '订单流', module: 'doc' })

  it('检索：name / type / title 任一 contains（小写化）；空检索词恒真', () => {
    expect(archMatches(item, '')).toBe(true)
    expect(archMatches(item, 'ORDER')).toBe(true) // name
    expect(archMatches(item, 'Architecture')).toBe(true) // type
    expect(archMatches(item, '订单')).toBe(true) // title（CJK 不受小写化影响）
    expect(archMatches(item, 'zzz')).toBe(false)
  })

  it('层：无 `layer` 恒可见（任意 chip），有 `layer` 时仅 `all` 或相等可见', () => {
    expect(archVisible(item, '', 'global')).toBe(true) // 无 layer
    expect(archVisible(item, '', 'project')).toBe(true)
    expect(archVisible(item, '', 'role')).toBe(true)

    const scoped = { ...item, layer: 'role' }
    expect(archVisible(scoped, '', 'all')).toBe(true)
    expect(archVisible(scoped, '', 'role')).toBe(true)
    expect(archVisible(scoped, '', 'global')).toBe(false)
  })

  it('检索与层是与关系：命中但层不符 → 不可见', () => {
    const scoped = { ...item, layer: 'role' }
    expect(archVisible(scoped, 'order', 'global')).toBe(false)
    expect(archVisible(scoped, 'order', 'role')).toBe(true)
  })

  // 白盒补测（tester-whitebox，过滤边界）：两个此前零覆盖的边界值。
  it('补测（过滤边界）：纯空白检索词等同空词恒真；layer 为空串的图按「无层」恒可见', () => {
    // archMatches 先 trim：'   ' 与 '' 同判（不因空白词把整树裁没）
    expect(archMatches(item, '   ')).toBe(true)
    // 空串 layer（sidecar 记了空值）不应走「有层仅相等」分支——任意 chip 都可见
    const emptyLayer = { ...item, layer: '' }
    expect(archVisible(emptyLayer, '', 'all')).toBe(true)
    expect(archVisible(emptyLayer, '', 'project')).toBe(true)
    expect(archVisible(emptyLayer, '', 'global')).toBe(true)
    // 空串层 + 检索命中 → 仍可见；检索不命中 → 不可见（与层无关的正常与关系）
    expect(archVisible(emptyLayer, 'order', 'global')).toBe(true)
    expect(archVisible(emptyLayer, 'zzz', 'global')).toBe(false)
  })
})
