import { describe, expect, it } from 'vitest'

import {
  buildTree,
  countTree,
  filterTree,
  isSelMiss,
  selMissDetail,
  resolveBookDeepLink,
  type DirNode,
} from '../src/pages/knowledge-logic.ts'

describe('isSelMiss · 深链未命中判据（M4）', () => {
  it('未选中（sel 空）→ false：走「从左侧选择条目」空态', () => {
    expect(isSelMiss('', false, undefined)).toBe(false)
    expect(isSelMiss('', false, null)).toBe(false)
  })

  it('选中但请求在途 → false：此时 data 还是上一轮的值，不能判未命中', () => {
    expect(isSelMiss('kb-1', true, undefined)).toBe(false)
    expect(isSelMiss('kb-1', true, null)).toBe(false)
    expect(isSelMiss('kb-1', true, { id: 'kb-1' })).toBe(false)
  })

  it('选中 + 已完结 + data null（kbGet 返回 null）→ true', () => {
    expect(isSelMiss('kb-1', false, null)).toBe(true)
  })

  it('选中 + 已完结 + data undefined（useAsync 出错不 setData）→ true', () => {
    // 旧判据 `data === null` 在此恒为 false —— 这就是冷启动未命中深链停在空态、
    // 到不了 notFound pane 的根因；本用例即该回归的红线。
    expect(isSelMiss('kb-1', false, undefined)).toBe(true)
  })

  it('选中 + 已完结 + 有内容 → false', () => {
    expect(isSelMiss('kb-1', false, { id: 'kb-1' })).toBe(false)
    // 边界：空字符串正文也是「取到了」，不算未命中
    expect(isSelMiss('kb-1', false, '')).toBe(false)
  })
})

describe('selMissDetail · notFound pane 的错误原文捎带（复检 MINOR-②）', () => {
  it('无错误（真 not_found 信封路径，error 未置）→ undefined：pane 标题即答案，不加噪音', () => {
    expect(selMissDetail(undefined)).toBeUndefined()
  })

  it('not_found 前缀（api.request 的信封错误原文）→ undefined：属于 pane 语义内的「不存在」', () => {
    expect(selMissDetail('not_found: 知识条目不存在: kb-1')).toBeUndefined()
    // 前缀必须带冒号才认——防「not_found_xxx」这类恰好同头的码误吞
    expect(selMissDetail('not_foundx: 其他')).not.toBeUndefined()
  })

  it('基建错误（500 / 网络断）→ 原文返回：不许被「不存在」标题吞掉', () => {
    expect(selMissDetail('internal: 数据库忙')).toBe('internal: 数据库忙')
    expect(selMissDetail('Failed to fetch')).toBe('Failed to fetch')
  })

  it('空串错误文本 → 原样返回空串（不隐藏，交给渲染层自行取舍）', () => {
    // `''` 不以 `not_found:` 开头，走「展示原文」分支——契约上与实现一致即可
    expect(selMissDetail('')).toBe('')
  })
})

describe('resolveBookDeepLink · ?book= 深链收敛（D-3 / T6）', () => {
  /** 与 `Knowledge.tsx` 的 `books` memo 同序：按 `book › owner` 排。 */
  const books = [
    { layer: 'global', book: 'handbook' },
    { layer: 'project', owner: 'mini-snake', book: 'prism' },
    { layer: 'project', owner: 'prism', book: 'prism' },
    { layer: 'role', owner: 'dev-1', book: 'prism' },
  ]

  it('命中：layer + owner + book 全给（T6 边表的标准形态）→ 该书本身', () => {
    const hit = resolveBookDeepLink(books, { layer: 'role', owner: 'dev-1', book: 'prism' })
    expect(hit).toBe(books[3])
  })

  it('命中：只给 book（TC-KB-12 的 `#/knowledge?book=<书>`）→ 首个匹配', () => {
    expect(resolveBookDeepLink(books, { book: 'handbook' })).toBe(books[0])
  })

  it('多 owner 同名书 + 未带 owner → 取目录首个（不是「全都算命中」）', () => {
    expect(resolveBookDeepLink(books, { book: 'prism' })).toBe(books[1])
  })

  it('给了 owner → 精确定位到那本同名书', () => {
    expect(resolveBookDeepLink(books, { owner: 'prism', book: 'prism' })).toBe(books[2])
  })

  it('不存在 / 层不符 / owner 不符 → undefined（静默忽略参数，与非法 layer 同口径）', () => {
    expect(resolveBookDeepLink(books, { book: 'nope' })).toBeUndefined()
    expect(resolveBookDeepLink(books, { layer: 'global', book: 'prism' })).toBeUndefined()
    expect(resolveBookDeepLink(books, { owner: 'tester', book: 'prism' })).toBeUndefined()
  })

  it('无 book 参数 / 空串 → undefined（普通目录不受影响）', () => {
    expect(resolveBookDeepLink(books, {})).toBeUndefined()
    expect(resolveBookDeepLink(books, { book: '' })).toBeUndefined()
    expect(resolveBookDeepLink(books, { layer: 'project', owner: 'prism', book: '' })).toBeUndefined()
  })

  it('非法 layer 值不参与匹配（与 Knowledge 的 layer 状态回落 `all` 同口径）', () => {
    expect(resolveBookDeepLink(books, { layer: 'bogus', book: 'handbook' })).toBe(books[0])
  })
})

/* ── F2 书内目录树（node 直测：不牵 React / api.ts） ─────────────────────────── */

/** 只带 `path` 的条目壳（`buildTree` 的唯一入参要求）。 */
function at(path: string, id = path): { path: string; id: string } {
  return { path, id }
}

/** 树形快照：`目录(计数)[条目…]`，便于一眼看清层级（测试里的可读证据）。 */
function shape<T>(node: DirNode<T>): string {
  const own = node.entries.length === 0 ? '' : `[${node.entries.map((e) => (e as { id: string }).id).join(',')}]`
  const kids = node.dirs.map(shape).join(' ')
  return `${node.name}(${countTree(node)})${own}${kids === '' ? '' : ` ${kids}`}`
}

describe('buildTree · 书内目录树（F2：按 `path` 建真目录树）', () => {
  it('书锚（最后一个等于书名的段）+ 多级嵌套；同层目录按段名排序', () => {
    const tree = buildTree(
      [
        at('K:\\work\\project\\prism\\doc\\requirements\\a.md', 'a'),
        at('K:\\work\\project\\prism\\doc\\design\\b.md', 'b'),
        at('K:\\work\\project\\prism\\AGENTS.md', 'c'),
      ],
      'prism',
    )

    // 锚之前的机器路径（K: › work › project › prism）不进树
    expect(tree.dirs.map((d) => d.name)).toEqual(['doc'])
    expect(tree.dirs[0]?.dirs.map((d) => d.name)).toEqual(['design', 'requirements'])
    expect(shape(tree)).toBe('(3)[c] doc(2) design(1)[b] requirements(1)[a]')
    // key 是段路径（折叠态与 React key 的键），随深度累加
    expect(tree.dirs[0]?.key).toBe('doc')
    expect(tree.dirs[0]?.dirs[0]?.key).toBe('doc/design')
  })

  it('`path` 空 / 无分隔（只有文件名）→ 归顶层，不产生目录段', () => {
    const tree = buildTree([at('', 'empty'), at('README.md', 'plain')], 'prism')

    expect(tree.entries.map((e) => e.id)).toEqual(['empty', 'plain'])
    expect(tree.dirs).toEqual([])
    // 根计数 = 这两条（没有目录可分摊）
    expect(shape(tree)).toBe('(2)[empty,plain]')
  })

  it('自有序条目：`<id>/vNN.md` 是 Prism 的存储尾，不进树；只剩 module 段', () => {
    const tree = buildTree(
      [
        at('C:\\Users\\u\\.prism\\knowledge\\project\\prism\\prism\\architecture\\KB-mt1\\v01.md', 'own-1'),
        at('C:\\Users\\u\\.prism\\knowledge\\project\\prism\\prism\\_inbox\\KB-mt2\\v10.md', 'own-2'),
      ],
      'prism',
    )

    expect(tree.dirs.map((d) => d.name)).toEqual(['_inbox', 'architecture'])
    expect(tree.dirs[1]?.entries.map((e) => e.id)).toEqual(['own-1'])
    // `<id>` 段没有变成目录（否则每条自有序条目都会独占一个 KB-xxxx 目录）
    expect(shape(tree)).toBe('(2) _inbox(1)[own-2] architecture(1)[own-1]')
  })

  it('索引型与自有序混在一本书：两边各自锚定（无目录的根级文件不否决锚）', () => {
    const tree = buildTree(
      [
        at('K:\\work\\project\\mini-snake\\doc\\设计.md', 'idx'),
        at('K:\\work\\project\\mini-snake\\README.md', 'idx-root'),
        at('C:\\Users\\u\\.prism\\knowledge\\project\\mini-snake\\mini-snake\\overview\\KB-x\\v01.md', 'own'),
      ],
      'mini-snake',
    )

    expect(shape(tree)).toBe('(3)[idx-root] doc(1)[idx] overview(1)[own]')
  })

  it('无锚（书自定义名不在任何路径段里）→ 退化为剥「目录公共前缀」', () => {
    const tree = buildTree(
      [at('/srv/data/docs/a.md', 'a'), at('/srv/data/docs/sub/b.md', 'b')],
      'handbook',
    )

    // `a` 落在顶层（公共前缀 `srv/data/docs` 被剥掉），`b` 在唯一的子目录里
    expect(shape(tree)).toBe('(2)[a] sub(1)[b]')
  })

  it('连公共段也没有（盘符不同）→ 原样展示绝对层级（照实，不猜）', () => {
    const tree = buildTree([at('K:\\a\\b.md', 'k'), at('D:\\c\\d.md', 'd')], 'unknown')

    expect(tree.dirs.map((d) => d.name)).toEqual(['D:', 'K:'])
    expect(shape(tree)).toBe('(2) D:(1) c(1)[d] K:(1) a(1)[k]')
  })

  it('空输入 → 空树（不炸）', () => {
    const tree = buildTree([] as Array<{ path: string }>, 'prism')
    expect(tree.dirs).toEqual([])
    expect(tree.entries).toEqual([])
    expect(countTree(tree)).toBe(0)
  })
})

describe('buildTree · 边界补测（tester-whitebox v8：同名目录 / 空目录 / 条目序 / 同名锚）', () => {
  it('同名目录在不同父下：各自成节点，不跨父合并', () => {
    const tree = buildTree(
      [at('K:\\w\\prism\\doc\\req\\a.md', 'a'), at('K:\\w\\prism\\notes\\req\\b.md', 'b')],
      'prism',
    )

    expect(tree.dirs.map((d) => d.name)).toEqual(['doc', 'notes'])
    // 两个 `req` 分属不同父：名字相同但 key 不同（折叠态互不联动），条目各归各父
    expect(tree.dirs[0]?.dirs[0]?.key).toBe('doc/req')
    expect(tree.dirs[1]?.dirs[0]?.key).toBe('notes/req')
    expect(tree.dirs[0]?.dirs[0]?.entries.map((e) => e.id)).toEqual(['a'])
    expect(tree.dirs[1]?.dirs[0]?.entries.map((e) => e.id)).toEqual(['b'])
  })

  it('同一父下同名目录段合并为单节点（同目录多条目 → 一个节点持全部条目，不重不漏）', () => {
    const tree = buildTree(
      [
        at('K:\\w\\prism\\doc\\a.md', 'a'),
        at('K:\\w\\prism\\doc\\sub\\b.md', 'b'),
        at('K:\\w\\prism\\doc\\c.md', 'c'),
      ],
      'prism',
    )

    expect(tree.dirs).toHaveLength(1)
    const doc = tree.dirs[0]!
    expect(doc.entries.map((e) => e.id)).toEqual(['a', 'c'])
    expect(doc.dirs.map((d) => d.name)).toEqual(['sub'])
    expect(countTree(doc)).toBe(3)
  })

  it('「空目录」边界：中间节点可以零直属条目（只当通道），但不会凭空长出无来源的空叶子', () => {
    const tree = buildTree([at('K:\\w\\prism\\a\\b\\x.md', 'x')], 'prism')

    // `a` 无直属条目、只是 `b` 的通道；每个目录节点都来自某条目的 path 段
    expect(shape(tree)).toBe('(1) a(1) b(1)[x]')
    expect(tree.dirs[0]?.entries).toEqual([])
    // 不存在「0 条目且 0 子目录」的死叶子
    const deadLeaves: string[] = []
    const walk = (n: DirNode<{ path: string; id: string }>): void => {
      if (n.dirs.length === 0 && n.entries.length === 0 && n.name !== '') deadLeaves.push(n.key)
      n.dirs.forEach(walk)
    }
    walk(tree)
    expect(deadLeaves).toEqual([])
  })

  it('条目保持入参顺序（catalog 的 updated_at DESC 契约），目录排序不扰动条目序', () => {
    const tree = buildTree(
      [at('K:\\w\\prism\\doc\\z.md', 'newest'), at('K:\\w\\prism\\doc\\a.md', 'oldest')],
      'prism',
    )

    // 目录按段名排序，但**条目**数组 = 入参顺序（`sortDirs` 只排 `dirs`）
    expect(tree.dirs[0]?.entries.map((e) => e.id)).toEqual(['newest', 'oldest'])
  })

  it('三层嵌套（design §6.2「>2 级」的代码侧对账；真实仓库实测归黑盒批）：层级与计数逐级可辨', () => {
    const tree = buildTree(
      [
        at('K:\\w\\prism\\doc\\requirements\\notes\\a.md', 'a'),
        at('K:\\w\\prism\\doc\\requirements\\b.md', 'b'),
      ],
      'prism',
    )

    const doc = tree.dirs[0]!
    const req = doc.dirs[0]!
    expect([doc.name, req.name, req.dirs[0]?.name]).toEqual(['doc', 'requirements', 'notes'])
    // key 随深度累加；计数含全部后代（doc(2) = b + notes/a）
    expect(req.dirs[0]?.key).toBe('doc/requirements/notes')
    expect(countTree(doc)).toBe(2)
    expect(countTree(req)).toBe(2)
  })

  it('与书同名的子目录：锚取 `lastIndexOf` 多剥一层，条目升到顶层（NIT-16 已记录现行为；下轮改 knowledgeDir 前缀锚时本测试是同步点）', () => {
    const tree = buildTree([at('K:\\w\\prism\\prism\\inner.md', 'inner')], 'prism')

    // 最内层 `prism`（用户目录）被当成锚剥掉 → 条目落顶层、不产生 `prism` 目录
    expect(tree.dirs).toEqual([])
    expect(tree.entries.map((e) => e.id)).toEqual(['inner'])
  })
})

describe('filterTree · 目录内收敛（保留命中条目的祖先目录）', () => {
  const tree = buildTree(
    [
      at('K:\\work\\project\\prism\\doc\\a.md', 'doc-a'),
      at('K:\\work\\project\\prism\\doc\\req\\b.md', 'req-b'),
      at('K:\\work\\project\\prism\\api\\c.md', 'api-c'),
    ],
    'prism',
  )
  const hitOne = (ids: string[]) => (e: { id: string }) => ids.includes(e.id)
  const dirHitNone = () => false

  it('条目命中 → 保留其祖先目录，未命中的枝剪掉', () => {
    const kept = filterTree(tree, hitOne(['req-b']), dirHitNone)
    expect(shape(kept!)).toBe('(1) doc(1) req(1)[req-b]')
  })

  it('目录段名命中 → 该目录整棵子树原样保留', () => {
    const kept = filterTree(tree, hitOne([]), (name) => name === 'doc')
    expect(shape(kept!)).toBe('(2) doc(2)[doc-a] req(1)[req-b]')
  })

  it('全不命中 → undefined（该书的可见性由裁枝结果决定）', () => {
    expect(filterTree(tree, hitOne([]), dirHitNone)).toBeUndefined()
  })

  it('根节点（name 为空串）不参与目录名命中：`dirHit` 只认空串时不会把整棵留下', () => {
    // 若根节点也走 `dirHit`，`name.includes('')` 这类「空检索词恒真」的判据会直接命中根、
    // 整棵原样返回 —— 目录内的本地收敛就彻底失效了。本用例是该分支的回归红线：
    // 只认空串的 `dirHit` 命中不到任何**子**目录（子目录名非空），故结果为 undefined。
    expect(filterTree(tree, hitOne([]), (name) => name === '')).toBeUndefined()
  })

  it('所有子目录段都命中 → 整棵保留（含各目录自己的条目）', () => {
    const kept = filterTree(tree, hitOne([]), () => true)
    // `doc` 命中后整棵原样返回（连它的直接条目 `doc-a` 一起带出）——这是「整棵保留」的字面效果
    expect(shape(kept!)).toBe('(3) api(1)[api-c] doc(2)[doc-a] req(1)[req-b]')
  })
})
