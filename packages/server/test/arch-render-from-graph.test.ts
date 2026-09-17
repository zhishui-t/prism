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
 *
 * 全部走临时目录（R5：绝不写真实宿主目录）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { ProjectRegistry } from '../src/graph/registry.js'
import { archRoutes } from '../src/http/routes/arch.js'
import type { RouteContext } from '../src/http/router.js'
import { putFile } from './helpers.js'

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
  root: string
  root_file: string
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
