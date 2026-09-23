/**
 * v10 F5：`POST /api/arch/render` 的 `mode: 'from-graph'` 分支——由**图谱节点 id** 导出时序图。
 *
 * 契约（design-v10 F5，2026-09-17 审核修正后的链路）：
 * - `buildSequenceIr` 的输入是**全图 + rootFile**（relations 是单跳 items，组不出链），
 *   故服务端自组 IR，调用方只给 `project` + 起点**节点 id**；
 * - **寻址用节点 id、不用符号名**（本仓 159/2063 个 label 跨多文件，按名寻根会静默选错）；
 * - 两类生成器抛错都映射 `bad_request`，其中「指定根文件无跨文件 calls 边」是**高频路径**
 *   （本仓 27.6% 节点所在文件无跨文件 calls 边），文案要指向「换起点」；
 * - 产物落**项目源** `<projectRoot>/.prism/arch/sequence/`（**不落全局** `<home>/archify/`）；
 * - 产物名 `sequence-<消毒 id>-<yyyyMMdd-HHmmss>-<短哈希>`：CJK 节点 id 经消毒会逐字换 `_`，
 *   两个不同节点会撞成同名而互相覆盖，靠**原始 id 的短哈希**防撞；
 * - `meta.subtitle` 由生成器恒写「根 = 调用图度数最高的文件」，本分支显式指定 rootFile →
 *   渲染前覆写为实际根文件。
 * - **v17 C-9.2**：响应 **additive** 回填 `subtitle`（= 实际渲染 IR 的 `meta.subtitle`，
 *   经 `irSubtitle` 取；与 MCP `prism_arch_generate` 同一 reader）。既有键一个不动。
 *
 * 全部走临时目录（R5：绝不写真实宿主目录）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmpTag } from '@prism/core'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { ProjectRegistry } from '../src/graph/registry.js'
import { irSubtitle } from '../src/graph/archify.js'
import {
  archRoutes,
  SEQUENCE_NAME_MAX_LENGTH,
  sequenceArtifactName,
} from '../src/http/routes/arch.js'
import type { RouteContext } from '../src/http/router.js'
import { putFile } from './helpers.js'

const dirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix.replace(/-$/, `-${tmpTag()}-`)))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function fakeCtx(body: unknown): RouteContext {
  return {
    params: {},
    query: new URLSearchParams(),
    body: async () => body,
  } as unknown as RouteContext
}

/**
 * 合成图谱（真实形态：边写 `links`）：
 * - `entry → api → store` 跨文件 calls 链；
 * - 两个**纯 CJK id** 节点互相 calls（消毒后同名的场景）；
 * - `lonely` 所在文件**只有 imports 边**（对应「指定根文件无跨文件 calls 边」的高频路径）。
 */
function makeGraph(): unknown {
  return {
    nodes: [
      { id: 'entry', label: 'Entrypoint', source_file: 'proj/src/cli/entry.ts', community: 0 },
      { id: 'api', label: 'routes', source_file: 'proj/src/api/routes.ts', community: 1 },
      { id: 'store', label: 'database', source_file: 'proj/src/store/db.ts', community: 2 },
      { id: '中文甲', label: '中文甲', source_file: 'proj/src/zh/a.ts', community: 3 },
      { id: '中文乙', label: '中文乙', source_file: 'proj/src/zh/b.ts', community: 4 },
      { id: 'lonely', label: '孤点', source_file: 'proj/src/lonely.ts', community: 5 },
    ],
    links: [
      { source: 'entry', target: 'api', relation: 'calls' },
      { source: 'api', target: 'store', relation: 'calls' },
      { source: '中文甲', target: '中文乙', relation: 'calls' },
      // 只有 imports：`lonely` 所在文件在调用图里没有跨文件 calls 边
      { source: 'lonely', target: 'api', relation: 'imports' },
    ],
  }
}

/** 只有 imports、完全没有 calls 的图谱（触发生成器的「图谱没有跨文件 calls 边」）。 */
function makeImportsOnlyGraph(): unknown {
  return {
    nodes: [
      { id: 'a', label: 'a', source_file: 'proj/src/a.ts', community: 0 },
      { id: 'b', label: 'b', source_file: 'proj/src/b.ts', community: 1 },
    ],
    links: [{ source: 'a', target: 'b', relation: 'imports' }],
  }
}

/**
 * v17 C-9 `symbols` 的输入：6 跳（7 节点）符号链 `s0 → … → s6`（每跳带调用点 file:line），
 * **外加一条 `s0 → s3` 的链外 calls 边**——若 IR 按 file 口径的 `inSet` 构，会多出第 7 条消息。
 */
function makeChainGraph(): unknown {
  const nodes: Array<Record<string, unknown>> = []
  for (let i = 0; i < 7; i += 1) {
    nodes.push({
      id: `s${i}`,
      label: `step${i}`,
      source_file: `proj/src/mod${i}/step${i}.ts`,
      community: i,
    })
  }
  const links: Array<Record<string, unknown>> = []
  for (let i = 0; i + 1 < 7; i += 1) {
    links.push({
      source: `s${i}`,
      target: `s${i + 1}`,
      relation: 'calls',
      source_file: `proj/src/mod${i}/step${i}.ts`,
      source_location: `L${10 + i}`,
    })
  }
  links.push({
    source: 's0',
    target: 's3',
    relation: 'calls',
    source_file: 'proj/src/mod0/step0.ts',
    source_location: 'L99',
  })
  return { nodes, links }
}

/**
 * v17 黑盒 major：`symbols` 模式下「整条链的 id 串」会直接进文件名。真实链上每个符号约
 * 60–80 字符，7 个拼起来 ≈470 字符 → Windows 的完整路径推过 `MAX_PATH`(260) → 导出恒失败。
 * 本图的节点 id 刻意造这么长，用来覆盖「必须截断」的那条路径。
 */
function makeLongSymbolId(index: number): string {
  return `proj/src/mod${index}/very_long_module_name_${index}/handler_with_a_long_symbol_name_${index}_L${100 + index}`
}

function makeLongChainGraph(): unknown {
  const nodes: Array<Record<string, unknown>> = []
  for (let i = 0; i < 7; i += 1) {
    nodes.push({
      id: makeLongSymbolId(i),
      // label 保持短：参与者标签参与布局，长的是 id（正是要触发截断的那一维）
      label: `step${i}`,
      source_file: `proj/src/mod${i}/step${i}.ts`,
      community: i,
    })
  }
  const links: Array<Record<string, unknown>> = []
  for (let i = 0; i + 1 < 7; i += 1) {
    links.push({
      source: makeLongSymbolId(i),
      target: makeLongSymbolId(i + 1),
      relation: 'calls',
      source_file: `proj/src/mod${i}/step${i}.ts`,
      source_location: `L${10 + i}`,
    })
  }
  return { nodes, links }
}

/** 建临时 home + 项目根（含 graph.json）并登记项目，返回项目根。 */
async function makeProject(home: string, name: string, graph: unknown): Promise<string> {
  const root = await tempDir('prism-arch-fg-proj-')
  await putFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify(graph))
  await new ProjectRegistry(home).register(name, root)
  return root
}

function routesFor(home: string): ReturnType<typeof archRoutes> {
  return archRoutes({
    home,
    teamsDir: join(home, 'teams'),
    rolesDir: join(home, 'agents'),
  })
}

interface RenderValue {
  type: string
  project: string
  node: string
  /** 仅 `symbols` 模式出现（v17 C-9，additive） */
  symbols?: string[]
  root: string
  root_file: string
  /** v17 C-9.2（additive）：实际渲染 IR 的 `meta.subtitle`，与 MCP `prism_arch_generate` 同源 */
  subtitle?: string
  name: string
  relative_path: string
  bytes: number
  preview: string
  ir: string
  meta: { ir_hash: string; title?: string }
  source: string
}

interface RenderEnvelope {
  ok: boolean
  value: RenderValue
}

/** 产物名规则：`sequence-<消毒 id>-<yyyyMMdd-HHmmss>-<8 位短哈希>`。 */
function expectedNamePattern(nodeId: string): RegExp {
  const safeId = nodeId.replace(/[^A-Za-z0-9_.-]/g, '_')
  const hash = createHash('sha256').update(nodeId).digest('hex').slice(0, 8)
  return new RegExp(`^sequence-${safeId}-\\d{8}-\\d{6}-${hash}\\.html$`)
}

describe('v10 F5：POST /api/arch/render mode=from-graph（按节点 id 导出时序图）', () => {
  it('成功：落项目源 + 产物名含短哈希 + preview/relative_path 可指 + IR subtitle 覆写为实际根文件', async () => {
    const home = await tempDir('prism-arch-fg-home-')
    const root = await makeProject(home, 'demo', makeGraph())
    const routes = routesFor(home)

    const envelope = (await routes.render(
      fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', node: 'entry' }),
    )) as RenderEnvelope

    expect(envelope.ok).toBe(true)
    const value = envelope.value
    expect(value.type).toBe('sequence')
    expect(value.project).toBe('demo')
    expect(value.node).toBe('entry')
    expect(value.root_file).toBe('proj/src/cli/entry.ts')
    expect(value.source).toBe('project')
    expect(value.root).toBe(root)
    expect(value.name).toMatch(expectedNamePattern('entry'))
    expect(value.preview).toBe(`/api/arch/preview/sequence/${value.name}?project=demo`)
    expect(value.relative_path).toBe(`.prism/arch/sequence/${value.name}`)
    expect(value.bytes).toBeGreaterThan(10_000)

    // 产物三件套落**项目源**
    const htmlPath = join(root, '.prism', 'arch', 'sequence', value.name)
    expect(existsSync(htmlPath)).toBe(true)
    expect(existsSync(htmlPath.replace(/\.html$/i, '.ir.json'))).toBe(true)
    expect(existsSync(htmlPath.replace(/\.html$/i, '.meta.json'))).toBe(true)
    // **不落全局** archify 目录（避免 arch 页双源列表堆积无归属产物）
    expect(existsSync(join(home, 'archify', 'sequence'))).toBe(false)

    // IR subtitle：生成器恒写「根 = 调用图度数最高的文件」，显式 rootFile 时必须被覆写
    const ir = JSON.parse(await readFile(htmlPath.replace(/\.html$/i, '.ir.json'), 'utf-8')) as {
      meta: { subtitle: string; title: string }
      participants: unknown[]
    }
    expect(ir.meta.subtitle).toContain('proj/src/cli/entry.ts')
    expect(ir.meta.subtitle).not.toContain('度数最高')
    expect(ir.participants.length).toBeGreaterThanOrEqual(2)
    expect(value.meta.title).toBe('demo · Entrypoint 调用链')
  }, 120_000)

  it('CJK 节点 id：连续导出两个不同节点 → 文件名不同（短哈希防消毒同名覆盖）', async () => {
    const home = await tempDir('prism-arch-fg-cjk-')
    const root = await makeProject(home, 'demo', makeGraph())
    const routes = routesFor(home)

    const first = (await routes.render(
      fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', node: '中文甲' }),
    )) as RenderEnvelope
    const second = (await routes.render(
      fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', node: '中文乙' }),
    )) as RenderEnvelope

    // 消毒后 id 段相同（全是 `_`），仅短哈希不同 —— 这正是短哈希存在的理由
    expect(first.value.name).toMatch(expectedNamePattern('中文甲'))
    expect(second.value.name).toMatch(expectedNamePattern('中文乙'))
    expect(first.value.name).not.toBe(second.value.name)
    expect(existsSync(join(root, '.prism', 'arch', 'sequence', first.value.name))).toBe(true)
    expect(existsSync(join(root, '.prism', 'arch', 'sequence', second.value.name))).toBe(true)
  }, 180_000)

  /**
   * v17 C-9（SPEC-C9.1）：`symbols` = 链上节点 id（`/api/graph/path` 的 `chain[].id`）→
   * IR 按**相邻对**构。6 跳 = 7 参与者 + **6 条消息**；链外的 calls 边（fixture 里的
   * `s0 → s3`）一条都不许进图。
   */
  it('v17 C-9 symbols：6 跳 → 7 参与者 + 6 条相邻对消息（链外边不进图）', async () => {
    const home = await tempDir('prism-arch-fg-sym-')
    const root = await makeProject(home, 'demo', makeChainGraph())
    const routes = routesFor(home)
    const symbols = ['s0', 's1', 's2', 's3', 's4', 's5', 's6']

    const envelope = (await routes.render(
      fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', symbols }),
    )) as RenderEnvelope

    expect(envelope.ok).toBe(true)
    const value = envelope.value
    // 链首回显进既有 `node` 字段；`symbols` 是 symbols 模式特有的 additive 回显
    expect(value.node).toBe('s0')
    expect(value.symbols).toEqual(symbols)
    expect(value.root_file).toBe('proj/src/mod0/step0.ts')
    expect(value.source).toBe('project')

    const irPath = join(root, '.prism', 'arch', 'sequence', value.name).replace(/\.html$/i, '.ir.json')
    const ir = JSON.parse(await readFile(irPath, 'utf-8')) as {
      participants: Array<{ id: string; label: string }>
      messages: Array<{ from: string; to: string }>
      meta: { subtitle: string }
    }
    expect(ir.participants).toHaveLength(7)
    expect(ir.participants.map((participant) => participant.label)).toEqual([
      'step0', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6',
    ])
    expect(ir.messages).toHaveLength(6)
    for (let i = 0; i < 6; i += 1) {
      expect(ir.messages[i]!.from).toBe(ir.participants[i]!.id)
      expect(ir.messages[i]!.to).toBe(ir.participants[i + 1]!.id)
    }
    // 链外边 s0 → s3 不在消息里
    expect(ir.messages.map((message) => `${message.from}>${message.to}`)).not.toContain(
      `${ir.participants[0]!.id}>${ir.participants[3]!.id}`,
    )
    // subtitle 由生成器按符号链口径自陈（本分支不覆写），含「N 跳被略去」的标注位
    expect(ir.meta.subtitle).toContain('符号链导出（7 参与者 / 6 条相邻对消息）')
    // C-9.2：响应回填的 subtitle 与磁盘 IR **逐字一致**（同一 reader，不是各自拼一遍）
    expect(value.subtitle).toBe(irSubtitle(ir))
    expect(value.subtitle ?? '').toContain('符号链导出（7 参与者 / 6 条相邻对消息）')
  }, 120_000)

  /**
   * v17 黑盒 major（Windows MAX_PATH）：7 个长符号（每个 id ≈78 字符）的链 → 产物名必须被
   * **钳制**到安全长度，导出**成功**——修复前整串 id 直接进名（≈470 字符），完整路径推过
   * 260 → 导出恒失败（`ENAMETOOLONG`/写不进）。本用例不依赖真跑 Windows，构造即覆盖。
   */
  it('v17 黑盒 major：7 个长符号链 → 产物名被钳制，导出成功且三件套可读', async () => {
    const home = await tempDir('prism-arch-fg-long-')
    const root = await makeProject(home, 'demo', makeLongChainGraph())
    const routes = routesFor(home)
    const symbols = Array.from({ length: 7 }, (_, i) => makeLongSymbolId(i))

    const envelope = (await routes.render(
      fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', symbols }),
    )) as RenderEnvelope

    expect(envelope.ok).toBe(true)
    const value = envelope.value
    // 名字总长 ≤ 安全上限；「段」≤ 80（`sequence-` 前缀 + 两段后缀之外全是段）
    expect(value.name.length).toBeLessThanOrEqual(SEQUENCE_NAME_MAX_LENGTH)
    expect(value.name).toMatch(/^sequence-[A-Za-z0-9_.-]{1,80}-\d{8}-\d{6}-[0-9a-f]{8}\.html$/)

    // 产物 + IR + sidecar 三件套真落盘可读
    const htmlPath = join(root, '.prism', 'arch', 'sequence', value.name)
    expect(existsSync(htmlPath)).toBe(true)
    const irPath = htmlPath.replace(/\.html$/i, '.ir.json')
    const metaPath = htmlPath.replace(/\.html$/i, '.meta.json')
    expect(existsSync(irPath)).toBe(true)
    expect(existsSync(metaPath)).toBe(true)
    expect(value.relative_path).toBe(`.prism/arch/sequence/${value.name}`)

    const ir = JSON.parse(await readFile(irPath, 'utf-8')) as {
      participants: Array<{ label: string }>
      messages: Array<{ from: string; to: string }>
    }
    expect(ir.participants).toHaveLength(7)
    expect(ir.messages).toHaveLength(6)
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { name: string; ir_file: string }
    expect(meta.name).toBe(value.name)
    expect(meta.ir_file).toBe(`${value.name.replace(/\.html$/i, '')}.ir.json`)
  }, 120_000)

  it('v17 C-9：node 与 symbols 互斥 → bad_request（不静默择一）', async () => {
    const home = await tempDir('prism-arch-fg-mutex-')
    await makeProject(home, 'demo', makeChainGraph())
    const routes = routesFor(home)

    await expect(
      routes.render(
        fakeCtx({
          mode: 'from-graph',
          type: 'sequence',
          project: 'demo',
          node: 's0',
          symbols: ['s0', 's1'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('互斥') })
  })

  it('v17 C-9：symbols 链首不在图内 → bad_request（提示用 chain[].id）', async () => {
    const home = await tempDir('prism-arch-fg-sym-miss-')
    await makeProject(home, 'demo', makeChainGraph())
    const routes = routesFor(home)

    await expect(
      routes.render(
        fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', symbols: ['ghost', 's1'] }),
      ),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('图谱中没有节点 id: ghost'),
    })
  })

  it('节点 id 不存在 → bad_request（提示用 other，不要用符号名）', async () => {
    const home = await tempDir('prism-arch-fg-miss-')
    await makeProject(home, 'demo', makeGraph())
    const routes = routesFor(home)

    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', node: 'Entrypoint' })),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('图谱中没有节点 id') })
  })

  it('命中节点缺 source_file → bad_request（无法定位根文件；白盒边界，id 解析过了但建不了链）', async () => {
    const home = await tempDir('prism-arch-fg-nosrc-')
    await makeProject(home, 'demo', {
      nodes: [
        { id: 'bare', label: '裸点' }, // 无 source_file：id 能命中，rootFile 无从取
        { id: 'a', label: 'a', source_file: 'proj/src/a.ts' },
      ],
      links: [{ source: 'a', target: 'bare', relation: 'calls' }],
    })
    const routes = routesFor(home)

    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', node: 'bare' })),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('没有 source_file') })
  })

  it('起点所在文件无跨文件 calls 边（高频路径）→ bad_request，文案指向换起点', async () => {
    const home = await tempDir('prism-arch-fg-norootedge-')
    await makeProject(home, 'demo', makeGraph())
    const routes = routesFor(home)

    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo', node: 'lonely' })),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/指定的根文件没有跨文件调用边[\s\S]*换一个起点/),
    })
    // 拒画时不留半成品（渲染前抛错）
    expect(existsSync(join(home, 'archify', 'sequence'))).toBe(false)
  })

  it('全图无跨文件 calls 边 → bad_request，文案改为本入口**可执行**的指引', async () => {
    const home = await tempDir('prism-arch-fg-nocalls-')
    await makeProject(home, 'nocalls', makeImportsOnlyGraph())
    const routes = routesFor(home)

    const err = await routes
      .render(fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'nocalls', node: 'a' }))
      .then(
        () => null,
        (error: unknown) => error as { code: string; message: string },
      )
    expect(err?.code).toBe('bad_request')
    // 保留生成器原文的判别词（web 的 `sequenceExportErrorKey` 按「calls 边」分派，别改）
    expect(err?.message).toContain('图谱没有跨文件 calls 边')
    // 可行动指引：重建图 / 换起点符号
    expect(err?.message).toMatch(/prism graph build/)
    expect(err?.message).toContain('起点符号')
    // graph-ir 原文的「改用 architecture/dataflow」在本入口不可执行（mode=from-graph 只支持
    // sequence），照做只会再吃一个 400 —— 派修 P2-2 后必须不再出现
    expect(err?.message).not.toContain('architecture/dataflow')
  })

  it('参数守卫：非 sequence / 未知 mode / 缺 project / 缺 node → bad_request', async () => {
    const home = await tempDir('prism-arch-fg-guard-')
    await makeProject(home, 'demo', makeGraph())
    const routes = routesFor(home)

    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'architecture', project: 'demo', node: 'entry' })),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('只支持 type=sequence') })

    await expect(
      routes.render(fakeCtx({ mode: 'from-nowhere', type: 'sequence', ir: {} })),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('未知 mode') })

    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'sequence', node: 'entry' })),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('缺少 project') })

    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'demo' })),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('缺少 node') })

    // 未注册项目 → not_found（沿用 resolveArchPlacement 语义，不回落全局）
    await expect(
      routes.render(fakeCtx({ mode: 'from-graph', type: 'sequence', project: 'no-such', node: 'entry' })),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('自备 ir 的既有路径不受影响（无 mode 时仍要求 ir）', async () => {
    const home = await tempDir('prism-arch-fg-legacy-')
    await makeProject(home, 'demo', makeGraph())
    const routes = routesFor(home)

    await expect(routes.render(fakeCtx({ type: 'sequence' }))).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('缺少 ir'),
    })
  })

  it('HTTP 层：成功 200 信封；错误 400 信封（UI 实际看到的状态码/形状）', async () => {
    const home = await tempDir('prism-arch-fg-http-')
    const root = await makeProject(home, 'demo', makeGraph())
    let app: AppHandle | undefined
    try {
      app = await startServer({ home, kb: undefined as never, port: 0 })
      const base = `http://127.0.0.1:${app.port}`
      const post = (body: unknown) =>
        fetch(`${base}/api/arch/render`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      const res = await post({ mode: 'from-graph', type: 'sequence', project: 'demo', node: 'entry' })
      expect(res.status).toBe(200)
      const ok1 = (await res.json()) as RenderEnvelope
      expect(ok1.ok).toBe(true)
      expect(Object.keys(ok1.value).sort()).toEqual([
        'bytes',
        'ir',
        'meta',
        'name',
        'node',
        'preview',
        'project',
        'relative_path',
        'root',
        'root_file',
        'source',
        'subtitle',
        'type',
      ])
      expect(existsSync(join(root, '.prism', 'arch', 'sequence', ok1.value.name))).toBe(true)
      // preview 真能取到产物（新标签打开的那条 URL）
      const preview = await fetch(`${base}${ok1.value.preview}`)
      expect(preview.status).toBe(200)
      expect(preview.headers.get('content-type')).toContain('text/html')

      const bad = await post({ mode: 'from-graph', type: 'sequence', project: 'demo', node: 'nope' })
      expect(bad.status).toBe(400)
      const err = (await bad.json()) as { ok: boolean; error: { code: string; message: string } }
      expect(err.ok).toBe(false)
      expect(err.error.code).toBe('bad_request')
      expect(err.error.message).toContain('图谱中没有节点 id')
    } finally {
      // Windows：不 close 会留下 SQLite 句柄，临时目录删不掉
      await app?.close()
    }
  }, 180_000)
})

/**
 * v17 黑盒 major：产物名的**长度钳制**是纯函数行为，这里直接钉（无需真跑 Windows）。
 * 三条不变式：① 长公共前缀的不同链截断后仍互异；② 短 id 走原路径、形态与既有断言一致；
 * ③ CJK 长 id（消毒后成串 `_`）同样受钳制，且靠**原始 id** 的短哈希保区分。
 */
describe('sequenceArtifactName：长度钳制（v17 黑盒 major）', () => {
  it('长公共前缀的两条不同链 → 段被截到 80，尾部短哈希兜底不撞名', () => {
    // 200 字符的公共前缀 + 仅尾部不同的两条链（>80，必然走截断）；分隔符用 `>`（同 symbols
    // 拼接口径，消毒后是 `_`，不会在段里引入 `-`，便于下面按 `-` 切段断言）
    const common = 'proj/src/a/'.padEnd(200, 'x')
    const chainA = `${common}>tailA`
    const chainB = `${common}>tailB`

    const nameA = sequenceArtifactName(chainA)
    const nameB = sequenceArtifactName(chainB)

    // 段形态：71 字符可见头 + `_` + 8 位截断哈希（共 80）
    const segA = nameA.split('-')[1]!
    expect(segA).toMatch(/^[A-Za-z0-9_.]{71}_[0-9a-f]{8}$/)
    expect(segA).toHaveLength(80)
    // 名字互异（截断后差异只剩尾部短哈希 —— 这正是它存在的理由）
    expect(nameA).not.toBe(nameB)
    // 两条名字仍共享很长的前缀（可见头相同）→ 证明差异确实来自截断后的兜底哈希
    let shared = 0
    while (shared < nameA.length && nameA[shared] === nameB[shared]) shared += 1
    expect(shared).toBeGreaterThanOrEqual(9 + 71)
    expect(nameA.length).toBeLessThanOrEqual(SEQUENCE_NAME_MAX_LENGTH)
    expect(nameB.length).toBeLessThanOrEqual(SEQUENCE_NAME_MAX_LENGTH)
  })

  it('短 id 走原路径：形态与既有断言一致（钳制逻辑不碰它）', () => {
    const name = sequenceArtifactName('entry')
    // `expectedNamePattern` 带 `.html` 后缀（路由产物名），纯函数名不含它 → 补上再比
    expect(`${name}.html`).toMatch(expectedNamePattern('entry'))
    expect(name.startsWith('sequence-entry-')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(SEQUENCE_NAME_MAX_LENGTH)
  })

  it('CJK 长 id（消毒后成串 `_`）也受钳制，原始 id 的短哈希仍保区分', () => {
    const a = sequenceArtifactName('中'.repeat(120))
    const b = sequenceArtifactName(`${'中'.repeat(119)}文`)
    expect(a.length).toBeLessThanOrEqual(SEQUENCE_NAME_MAX_LENGTH)
    expect(b.length).toBeLessThanOrEqual(SEQUENCE_NAME_MAX_LENGTH)
    // 消毒后两者同为全 `_` 串 → 靠**原始 id** 的结尾短哈希区分（既有语义，未被截断逻辑破坏）
    expect(a).not.toBe(b)
  })
})
