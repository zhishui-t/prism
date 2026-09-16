// @vitest-environment happy-dom
/**
 * F4 调用链查询四模式：**DOM 行为**回归（happy-dom + 裸 `react-dom/client` + `react.act`，
 * 根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 *
 * 覆盖（task-brief-v8 F4 / design-v8 §2）：
 *  1. 四模式 chips（谁调用它 / 它调用谁 / A→B 调用链 / 改动影响谁）各发对应端点的请求参数；
 *  2. 关系类型切换（默认 `calls,invokes`；「全部关系」= **不传** `relation`）；
 *  3. 结果行渲染：方向箭头（in ← / out →）+ 对端符号 + kind + `file:line` 文本；
 *     截断口径「显示 N / 共 M 条」；
 *  4. 追问联动：点对端符号 → 以 `other`（**id**）重查、查询框联动为 `other_label`、模式与 dir 保持；
 *  5. 多义：渲染 candidates（label + id，不截断 + 限高滚动类），点选 → 以该 id 重查；
 *  6. 错误态与空输入提示；
 *  7. **MIN-3 请求守卫**：在途时第二次提交（Enter / 查询钮）被忽略；查询在途切模式后，
 *     旧 `kind` 的响应后到被弃——只渲染最新一笔（落地序号守卫）。
 *
 * mock 口径：仓库既有 DOM 测试全是 `vi.mock('../src/api.ts')`（整模块替身）；本文件要验
 * 「四模式打到了哪个 URL、带了什么参数」，故 stub 最外层的 `globalThis.fetch`
 * （`vi.stubGlobal`），让 `api.ts` 与页面一起跑真代码——`vi.mock` 会把 URL 拼装也替掉。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setLang, t } from '../src/i18n.ts'
import { CodeGraphPage } from '../src/pages/CodeGraph.tsx'

const PROJECT = { project: 'demo', root: '/tmp/demo' }
const STATUS = {
  project: 'demo',
  root: '/tmp/demo',
  graph_exists: true,
  built_at: '2026-09-16T00:00:00.000Z',
  changed_files: 0,
  total_files: 10,
  stale: false,
}

/** 每个用例铺的桩：路径 → 信封。projects/status 恒有（页面骨架要用）。 */
let payloads: Record<string, unknown> = {}
let requests: URL[] = []
/** `hold()` 挂起中的响应：settle 之前该路径的 fetch 一直悬着（MIN-3 要控制落地顺序）。 */
let pending: Record<string, Promise<unknown>> = {}
let container: HTMLDivElement
let root: Root

function ok(value: unknown): unknown {
  return { ok: true, value }
}

/**
 * 把某路径的响应**挂起**，返回 `settle(envelope)`。用于 MIN-3：不悬着就没法造出
 * 「A 在途 → 切模式 → B 先落地 → A 后到」。一次性（settle 后该路径落回 `payloads`）。
 */
function hold(pathname: string): (envelope: unknown) => void {
  let settle!: (value: unknown) => void
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve
  })
  pending[pathname] = promise
  return (envelope: unknown) => {
    delete pending[pathname]
    settle({ json: async () => envelope })
  }
}

beforeEach(() => {
  setLang('zh')
  payloads = {}
  requests = []
  pending = {}
  vi.stubGlobal('fetch', (input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    const held = pending[url.pathname]
    if (held !== undefined) return held
    if (url.pathname === '/api/graph/projects') return Promise.resolve({ json: async () => ok([PROJECT]) })
    if (url.pathname === '/api/graph/status') return Promise.resolve({ json: async () => ok(STATUS) })
    const hit = payloads[url.pathname]
    if (hit === undefined) {
      // 未铺桩 = 用例写漏：回一个可识别的错误信封（断言会因缺行/出错而红，不会静默通过）
      return Promise.resolve({
        json: async () => ({ ok: false, error: { code: 'not_stubbed', message: url.pathname } }),
      })
    }
    return Promise.resolve({ json: async () => hit })
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(CodeGraphPage, { sel: 'demo' }))
  })
  // useAsync 的两笔（projects → status）落定
  await act(async () => {})
  await act(async () => {})
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function buttonByText(label: string, scope = container): HTMLButtonElement {
  const hit = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

/** 受控输入：走原生 value setter 改值再派发 `input`（React 的受控值跟踪才认账）。 */
async function fill(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 输入框里按回车（Enter 与查询钮共用 `run()` 这一处提交口）。 */
async function pressEnter(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

/** 受控下拉：`select` 的 value setter 走 HTMLSelectElement 原型。 */
async function choose(target: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function nodeInputs(): HTMLInputElement[] {
  return all('.graph-query-card > .row > input') as HTMLInputElement[]
}

function nodeInput(): HTMLInputElement {
  const hit = nodeInputs()[0]
  if (hit === undefined) throw new Error('查询卡里没有输入框')
  return hit
}

/** 提交钮 = 查询卡输入行里的直接子按钮（模式 chips 在 `.seg` 里，不会被选中）。 */
function submit(): HTMLButtonElement {
  const hit = one<HTMLButtonElement>('.graph-query-card > .row > button')
  if (hit === null) throw new Error('查询卡里没有提交钮')
  return hit
}

function relationSelect(): HTMLSelectElement | null {
  return one<HTMLSelectElement>('.graph-query-card select')
}

function modeChip(label: string): HTMLButtonElement {
  return buttonByText(label, one<HTMLElement>('.graph-query-modes')!)
}

/** 最近一次打到该路径的请求（没打到则返回 undefined）。 */
function lastRequest(pathname: string): URL | undefined {
  return [...requests].reverse().find((u) => u.pathname === pathname)
}

/** 关系项（服务端 `GraphRelationItem`）。 */
function item(other: string, label: string, kind = 'calls', file = 'src/a.ts', line = '52') {
  return { other, other_label: label, kind, file, line }
}

function relations(items: ReturnType<typeof item>[], total = items.length, extra: Record<string, unknown> = {}) {
  return { project: 'demo', node: 'CodeGraphPage', dir: 'in', total, limit: 200, items, ...extra }
}

/** 走一遍「输入 → 查询」，返回最近一次 relations 请求。 */
async function queryRelations(node: string, pathname = '/api/graph/relations'): Promise<URL> {
  await fill(nodeInput(), node)
  await click(submit())
  const hit = lastRequest(pathname)
  if (hit === undefined) throw new Error(`没有打到 ${pathname}`)
  return hit
}

describe('四模式 chips 与端点映射', () => {
  it('四个模式 chip 齐全，默认「谁调用它」+ 关系类型默认 calls,invokes', async () => {
    await render()
    for (const key of ['graph.mode.in', 'graph.mode.out', 'graph.mode.path', 'graph.mode.affected'] as const) {
      expect(buttonByText(t(key), one<HTMLElement>('.graph-query-modes')!).textContent?.trim()).toBe(t(key))
    }
    expect(modeChip(t('graph.mode.in')).getAttribute('aria-pressed')).toBe('true')
    expect(modeChip(t('graph.mode.out')).getAttribute('aria-pressed')).toBe('false')
    expect(relationSelect()?.value).toBe('calls,invokes')
  })

  it('「谁调用它」→ `dir=in` + `relation=calls,invokes` + `node`', async () => {
    payloads['/api/graph/relations'] = ok(relations([item('n#caller', 'caller')]))
    await render()
    const hit = await queryRelations('CodeGraphPage')

    expect(hit.searchParams.get('project')).toBe('demo')
    expect(hit.searchParams.get('node')).toBe('CodeGraphPage')
    expect(hit.searchParams.get('dir')).toBe('in')
    expect(hit.searchParams.get('relation')).toBe('calls,invokes')
  })

  it('切「它调用谁」→ `dir=out`（查询框文本保留）', async () => {
    payloads['/api/graph/relations'] = ok(relations([]))
    await render()
    await fill(nodeInput(), 'CodeGraphPage')
    await click(modeChip(t('graph.mode.out')))
    await click(submit())

    expect(lastRequest('/api/graph/relations')!.searchParams.get('dir')).toBe('out')
    expect(nodeInput().value).toBe('CodeGraphPage')
  })

  it('切「A→B 调用链」→ 出第二个输入框、关系下拉消失，请求走 `/api/graph/path` 带 from/to', async () => {
    payloads['/api/graph/path'] = ok({ project: 'demo', raw: '', hops: 2, chain: ['a', 'm', 'b'], found: true })
    await render()
    expect(nodeInputs()).toHaveLength(1)

    await click(modeChip(t('graph.mode.path')))
    expect(relationSelect()).toBeNull()
    expect(nodeInputs()).toHaveLength(2)

    await fill(nodeInputs()[0]!, 'a')
    await fill(nodeInputs()[1]!, 'b')
    await click(submit())

    const hit = lastRequest('/api/graph/path')
    expect(hit).toBeDefined()
    expect(hit!.searchParams.get('from')).toBe('a')
    expect(hit!.searchParams.get('to')).toBe('b')
    // 结果：链式渲染
    expect(one('.graph-chain')?.textContent).toContain('a')
    expect(container.textContent).toContain(t('graph.path.hops', { n: 2 }))
  })

  it('path 无路径 → 明确的空态文案（不与「链渲染不出来」混为一谈）', async () => {
    payloads['/api/graph/path'] = ok({ project: 'demo', raw: 'No path', hops: null, chain: [], found: false })
    await render()
    await click(modeChip(t('graph.mode.path')))
    await fill(nodeInputs()[0]!, 'a')
    await fill(nodeInputs()[1]!, 'b')
    await click(submit())
    expect(container.textContent).toContain(t('graph.path.none'))
    expect(one('.graph-chain')).toBeNull()
  })

  it('path 找到了但切不出节点链 → 报「链没解析出来」，不谎报「没有路径」', async () => {
    payloads['/api/graph/path'] = ok({ project: 'demo', raw: 'a --> b', hops: 1, chain: [], found: true })
    await render()
    await click(modeChip(t('graph.mode.path')))
    await fill(nodeInputs()[0]!, 'a')
    await fill(nodeInputs()[1]!, 'b')
    await click(submit())
    expect(container.textContent).toContain(t('graph.path.unparsed'))
    expect(container.textContent).not.toContain(t('graph.path.none'))
  })

  it('切「改动影响谁」→ `/api/graph/affected` 带 node', async () => {
    payloads['/api/graph/affected'] = ok({
      project: 'demo',
      raw: '',
      depth: 2,
      nodes: [{ label: 'victim', relation: 'calls', location: 'src/a.ts:52' }],
    })
    await render()
    await click(modeChip(t('graph.mode.affected')))
    await fill(nodeInput(), 'CodeGraphPage')
    await click(submit())

    expect(lastRequest('/api/graph/affected')!.searchParams.get('node')).toBe('CodeGraphPage')
    expect(container.textContent).toContain(t('graph.affected.count', { n: 1 }))
    expect(container.textContent).toContain(t('graph.affected.depth', { n: 2 }))
    expect(one('.graph-rel-peer')?.textContent).toBe('victim')
  })

  it('关系类型切「全部关系」→ **不传** `relation`；切「调用」→ 单值', async () => {
    payloads['/api/graph/relations'] = ok(relations([]))
    await render()
    await fill(nodeInput(), 'CodeGraphPage')

    await choose(relationSelect()!, '')
    await click(submit())
    expect(lastRequest('/api/graph/relations')!.searchParams.has('relation')).toBe(false)

    await choose(relationSelect()!, 'calls')
    await click(submit())
    expect(lastRequest('/api/graph/relations')!.searchParams.get('relation')).toBe('calls')
  })
})

describe('结果行渲染', () => {
  it('入边行：`←` + 对端符号（mono）+ kind + `file:line` 文本；截断给「显示 N / 共 M 条」', async () => {
    payloads['/api/graph/relations'] = ok(
      relations(
        [
          item('n#a', 'alpha', 'calls', 'src/a.ts', '52'),
          item('n#b', 'beta', 'invokes', 'src/b.ts', '9'),
          item('n#c', 'gamma', 'calls', 'src/c.ts', ''),
        ],
        9,
      ),
    )
    await render()
    await queryRelations('CodeGraphPage')

    const rows = all('.query-result .graph-rel-row')
    expect(rows).toHaveLength(3)
    // 方向：dir=in → ←（对端指向当前节点）
    expect(rows[0]!.querySelector('.graph-rel-dir')!.textContent).toBe('\u2190')
    expect(rows[0]!.querySelector('.graph-rel-dir')!.getAttribute('aria-label')).toBe(t('graph.rel.arrowIn'))
    // 对端符号（`.rel-link` = 既有「行内链接钮」类，mono 由它给）+ kind + file:line 是**文本**
    expect(rows[0]!.querySelector('.graph-rel-peer')!.textContent).toBe('alpha')
    expect(rows[0]!.querySelector('.graph-rel-peer')!.className).toContain('rel-link')
    expect(rows[0]!.querySelector('.tag')!.textContent).toBe('calls')
    expect(rows[0]!.querySelector('.graph-rel-loc')!.textContent).toBe('src/a.ts:52')
    // line 空 → 只显示 file（不显示冒号尾巴）
    expect(rows[2]!.querySelector('.graph-rel-loc')!.textContent).toBe('src/c.ts')
    // total 全量 9 > 显示 3
    expect(container.textContent).toContain(t('graph.rel.showing', { shown: 3, total: 9 }))
  })

  it('出边行用 `→`；file 与 line 都空的行**不显示**定位段', async () => {
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'n#root',
      dir: 'out',
      total: 1,
      limit: 200,
      items: [item('n#d', 'delta', 'calls', '', '')],
    })
    await render()
    await click(modeChip(t('graph.mode.out')))
    await fill(nodeInput(), 'root')
    await click(submit())

    const row = one('.query-result .graph-rel-row')!
    expect(row.querySelector('.graph-rel-dir')!.textContent).toBe('\u2192')
    expect(row.querySelector('.graph-rel-dir')!.getAttribute('aria-label')).toBe(t('graph.rel.arrowOut'))
    expect(row.querySelector('.graph-rel-loc')).toBeNull()
    expect(container.textContent).toContain(t('graph.rel.total', { n: 1 }))
  })
})

describe('追问联动（点对端符号 = 以 id 重查）', () => {
  it('点对端 → 请求带 `other` 的 **id**、查询框回填 label、dir 与模式保持不变', async () => {
    payloads['/api/graph/relations'] = ok(relations([item('pkg/a.ts#alpha', 'alpha')]))
    await render()
    await queryRelations('CodeGraphPage')

    // 追问前：第一请求的 node 是查询框原文
    expect(requests.filter((u) => u.pathname === '/api/graph/relations')).toHaveLength(1)

    await click(one('.graph-rel-peer')!)

    const hits = requests.filter((u) => u.pathname === '/api/graph/relations')
    expect(hits).toHaveLength(2)
    expect(hits[1]!.searchParams.get('node')).toBe('pkg/a.ts#alpha') // 寻址一律 id
    expect(hits[1]!.searchParams.get('dir')).toBe('in') // dir 保持
    expect(hits[1]!.searchParams.get('relation')).toBe('calls,invokes') // 关系类型保持
    expect(nodeInput().value).toBe('alpha') // 查询框联动为 label
    expect(modeChip(t('graph.mode.in')).getAttribute('aria-pressed')).toBe('true') // 模式保持
  })

  it('切换 dir 后追问，dir 跟着新模式走', async () => {
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'root',
      dir: 'out',
      total: 1,
      limit: 200,
      items: [item('pkg/b.ts#beta', 'beta')],
    })
    await render()
    await click(modeChip(t('graph.mode.out')))
    await queryRelations('root')
    await click(one('.graph-rel-peer')!)

    const hits = requests.filter((u) => u.pathname === '/api/graph/relations')
    expect(hits[1]!.searchParams.get('dir')).toBe('out')
    expect(hits[1]!.searchParams.get('node')).toBe('pkg/b.ts#beta')
  })
})

describe('多义候选（total:0 + candidates，200 非报错）', () => {
  it('渲染 label + id，且**不截断**（限高滚动交给样式类）', async () => {
    const candidates = Array.from({ length: 120 }, (_, i) => ({ id: `mod${i}#dup`, label: `dup${i}` }))
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'dup',
      dir: 'in',
      total: 0,
      limit: 200,
      items: [],
      candidates,
    })
    await render()
    await queryRelations('dup')

    const list = one('.graph-cand-list')
    expect(list).not.toBeNull()
    expect(list!.querySelectorAll('button')).toHaveLength(120)
    expect(container.textContent).toContain(t('graph.rel.ambiguous', { n: 120 }))
    // 候选行的可读证据：label + id 都在
    expect(list!.querySelector('button')!.textContent).toContain('dup0')
    expect(list!.querySelector('button')!.textContent).toContain('mod0#dup')
    // 多义时不出关系行、也不报错
    expect(all('.graph-rel-row')).toHaveLength(0)
    expect(one('.act-bar.err')).toBeNull()
  })

  it('点候选 → 以该 id 重查（查询框回填 label）', async () => {
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'dup',
      dir: 'in',
      total: 0,
      limit: 200,
      items: [],
      candidates: [
        { id: 'pkg/a.ts#dup', label: 'dup-alpha' },
        { id: 'pkg/b.ts#dup', label: 'dup-beta' },
      ],
    })
    await render()
    await queryRelations('dup')

    await click(all('.graph-cand-list button')[1]!)

    const hits = requests.filter((u) => u.pathname === '/api/graph/relations')
    expect(hits[1]!.searchParams.get('node')).toBe('pkg/b.ts#dup')
    expect(nodeInput().value).toBe('dup-beta')
  })
})

describe('错误态与空输入', () => {
  it('空输入 → 提示且**不发请求**', async () => {
    await render()
    await click(submit())
    expect(container.textContent).toContain(t('graph.queryEmpty'))
    expect(requests.filter((u) => u.pathname === '/api/graph/relations')).toHaveLength(0)
  })

  it('path 空终点 → 提示且不发请求', async () => {
    await render()
    await click(modeChip(t('graph.mode.path')))
    await fill(nodeInputs()[0]!, 'a')
    await click(submit())
    expect(container.textContent).toContain(t('graph.path.empty'))
    expect(lastRequest('/api/graph/path')).toBeUndefined()
  })

  it('服务端 404 not_found → `.act-bar.err` 就地显示 `code: message` 原文', async () => {
    payloads['/api/graph/relations'] = {
      ok: false,
      error: { code: 'not_found', message: 'no such node' },
    }
    await render()
    await fill(nodeInput(), 'nope')
    await click(submit())

    const bar = one('.act-bar.err')
    expect(bar).not.toBeNull()
    expect(bar!.textContent).toContain('not_found: no such node')
    expect(one('.query-result')).toBeNull() // 失败时不出结果面板
  })
})

describe('MIN-3 请求守卫：在途忽略 + 落地序号（两处串台）', () => {
  it('在途时再按 Enter、再点查询钮，都不发第二笔；落地后照常渲染', async () => {
    await render()
    const settle = hold('/api/graph/relations')
    await fill(nodeInput(), 'CodeGraphPage')

    await pressEnter(nodeInput())
    await pressEnter(nodeInput()) // 第二笔该被守卫忽略
    await click(submit()) // 查询钮同样走 `run()`，同被挡住（disabled 只是视觉面）
    expect(requests.filter((u) => u.pathname === '/api/graph/relations')).toHaveLength(1)

    // 守卫只挡串台不挡正常查询：这一笔落地后结果照常出现、busy 收口
    await act(async () => {
      settle(ok(relations([item('n#a', 'alpha')])))
    })
    await act(async () => {})
    expect(all('.query-result .graph-rel-row')).toHaveLength(1)
    expect(one('.act-bar.err')).toBeNull()
    expect(container.textContent).not.toContain(t('graph.querying'))
  })

  it('在途切模式 → 旧 kind 响应后到被弃（只渲染新模式的结果）', async () => {
    await render()
    const settleA = hold('/api/graph/relations')
    await fill(nodeInput(), 'slow')
    await pressEnter(nodeInput())
    expect(requests.filter((u) => u.pathname === '/api/graph/relations')).toHaveLength(1)

    // 切模式 = 作废在途 + 归还 busy：提交口不被旧请求锁住（`busy` 卡住会变成「切了模式查不动」）
    await click(modeChip(t('graph.mode.affected')))
    expect(container.textContent).not.toContain(t('graph.querying'))
    expect(submit().disabled).toBe(false)

    const settleB = hold('/api/graph/affected')
    await fill(nodeInput(), 'fast')
    await pressEnter(nodeInput())

    // B 先落地：新模式的结果照常渲染
    await act(async () => {
      settleB(
        ok({
          project: 'demo',
          raw: '',
          depth: 1,
          nodes: [{ label: 'fast-node', relation: 'calls', location: 'src/f.ts:1' }],
        }),
      )
    })
    await act(async () => {})
    expect(container.textContent).toContain(t('graph.affected.count', { n: 1 }))
    expect(container.textContent).toContain('fast-node')
    expect(all('.query-result .graph-rel-row')).toHaveLength(1)

    // A 后到：关系型响应不得画在 affected 模式的 chips 下，也不得覆盖 B
    await act(async () => {
      settleA(ok(relations([item('n#stale', 'stale-caller')])))
    })
    await act(async () => {})
    expect(container.textContent).not.toContain('stale-caller')
    expect(container.textContent).not.toContain(t('graph.rel.ambiguous', { n: 0 }))
    expect(container.textContent).toContain(t('graph.affected.count', { n: 1 }))
    expect(all('.query-result .graph-rel-row')).toHaveLength(1)
    expect(one('.act-bar.err')).toBeNull()
  })
})

/**
 * 多义候选的**滚动上限**（`.graph-cand-list` 的 max-height + overflow-y）不在这里断言：
 * happy-dom 环境里 `import.meta.url` 是 http 形态，`fileURLToPath` 直接抛
 * 「The URL must be of scheme file」——故样式契约单开
 * `graph-query-styles.test.ts`（node 环境，与 `styles-*.test.ts` 同口径）。
 */
