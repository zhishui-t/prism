/**
 * v9 F1：架构图**资产归位**（design-v9 §2 / v9.1 修订）——项目源 + 全局源双源。
 *
 * 覆盖点：
 * 1. 落盘路由（HTTP `POST /api/arch/render` 的 project 分支）：未注册拒绝；
 *    root 被删/被挪报 `project_root_missing` 且**不复活目录**；无 project → 落全局；
 * 2. `GET /api/arch/diagrams` 双源扫描：身份键 `(type, name, source, project)`、
 *    服务端构造 `preview`/`ir`、**缺 sidecar 的历史产物仍可见**（title 回落 IR）、过滤两源同口径；
 * 3. `preview`/`ir` 的 `?project=` 限定与**同名歧义拒绝**（不静默择一）。
 *
 * 除「真实渲染一例」外，产物一律手写落盘（比跑 5 次 archify 快得多，且能精确构造
 * 「无 meta」「有 IR 无 meta」这类历史形态）。
 */
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { ProjectRegistry } from '../src/graph/registry.js'
import { createMcpTools } from '../src/mcp/server.js'
import { makeTempDir, putFile } from './helpers.js'

/** 合法架构图 IR（archify 要求显式 pos/size）。 */
const VALID_IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: '归位测试架构' },
  components: [
    { id: 'a', type: 'frontend', label: '前端', pos: [40, 200], size: [140, 68] },
    { id: 'b', type: 'backend', label: '后端', pos: [240, 200], size: [140, 68] },
  ],
  connections: [{ id: 'a-b', from: 'a', to: 'b', label: '调用' }],
}

type Envelope = { ok: boolean; value?: unknown; error?: { code: string; message: string } }

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** sidecar 内容（只为列表字段服务，不必是完整 ArchifyArtifactMeta）。 */
function metaJson(input: {
  type?: string
  name: string
  title?: string
  book?: string
  module?: string
  layer?: string
  owner?: string
}): string {
  return JSON.stringify({
    type: input.type ?? 'architecture',
    name: input.name,
    archify_version: '2.16.0',
    ir_hash: '0'.repeat(16),
    ir_file: input.name.replace(/\.html$/, '.ir.json'),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.book !== undefined ? { book: input.book } : {}),
    ...(input.module !== undefined ? { module: input.module } : {}),
    ...(input.layer !== undefined ? { layer: input.layer } : {}),
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    created_at: '2026-09-16T00:00:00.000Z',
  })
}

// ===== 1. 落盘路由 =====
describe('arch 落盘路由（project → 项目 .prism/arch；无 project → 全局）', () => {
  let app: AppHandle
  let base: string
  let home: string
  let root: string

  beforeAll(async () => {
    home = await makeTempDir('prism-arch-place-')
    root = await makeTempDir('prism-arch-place-proj-')
    // 项目源只要求「已注册 + root 是目录」；本用例走真实渲染，故不预置 graph.json
    await new ProjectRegistry(home).register('demo', root)
    app = await startServer({ home, kb: undefined as never, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  it('未注册项目 → 404 not_found（绝不接受任意路径）', async () => {
    const res = await post(base, '/api/arch/render', {
      type: 'architecture',
      ir: VALID_IR,
      name: 'ghost',
      project: 'not-registered',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as Envelope
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('not_found')
  })

  it('project 派生 → 落 <root>/.prism/arch/<type>/ 三件套；preview 带 ?project=', async () => {
    const res = await post(base, '/api/arch/render', {
      type: 'architecture',
      ir: VALID_IR,
      name: 'proj-demo',
      project: 'demo',
      book: 'java-standards',
      module: 'exception',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      value: { name: string; preview: string; source: string; project?: string; bytes: number }
    }
    expect(body.value.source).toBe('project')
    expect(body.value.project).toBe('demo')
    expect(body.value.bytes).toBeGreaterThan(100_000)
    // preview 由服务端构造，带 project 限定（前端不拼路径）
    expect(body.value.preview).toBe('/api/arch/preview/architecture/proj-demo.html?project=demo')

    const dir = join(root, '.prism', 'arch', 'architecture')
    expect(existsSync(join(dir, 'proj-demo.html'))).toBe(true)
    expect(existsSync(join(dir, 'proj-demo.ir.json'))).toBe(true)
    expect(existsSync(join(dir, 'proj-demo.meta.json'))).toBe(true)

    const preview = await fetch(`${base}${body.value.preview}`)
    expect(preview.status).toBe(200)
    expect(await preview.text()).toContain('<script')
  })

  it('无 project 的裸 render → 全局 <home>/archify/（现状不变）', async () => {
    const res = await post(base, '/api/arch/render', {
      type: 'architecture',
      ir: VALID_IR,
      name: 'global-only',
    })
    const body = (await res.json()) as { value: { source: string; preview: string } }
    expect(body.value.source).toBe('global')
    expect(body.value.preview).toBe('/api/arch/preview/architecture/global-only.html')
    expect(existsSync(join(home, 'archify', 'architecture', 'global-only.html'))).toBe(true)
  })

  it('root 已被删除 → project_root_missing，且**不 mkdir 复活**该目录（v9.1 B-1）', async () => {
    const goneRoot = await makeTempDir('prism-arch-gone-')
    const home2 = await makeTempDir('prism-arch-gone-home-')
    await new ProjectRegistry(home2).register('gone', goneRoot)
    await rm(goneRoot, { recursive: true, force: true })
    const app2 = await startServer({ home: home2, kb: undefined as never, port: 0 })
    try {
      const base2 = `http://127.0.0.1:${app2.port}`
      const res = await post(base2, '/api/arch/render', {
        type: 'architecture',
        ir: VALID_IR,
        name: 'x',
        project: 'gone',
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Envelope
      expect(body.error?.code).toBe('project_root_missing')
      // 关键护栏：整条路径都不存在（含 .prism）——复活目录会把用户的删除操作静默撤销
      expect(existsSync(goneRoot)).toBe(false)
      expect(existsSync(join(goneRoot, '.prism'))).toBe(false)
    } finally {
      await app2.close()
    }
  })
})

// ===== 2 + 3. 双源扫描 / preview·ir 限定 =====
describe('GET /api/arch/diagrams 双源 + preview/ir 的 project 限定', () => {
  let app: AppHandle
  let base: string
  let home: string
  let rootA: string
  let rootB: string

  const projectArch = (root: string): string => join(root, '.prism', 'arch', 'architecture')
  const globalArch = (): string => join(home, 'archify', 'architecture')

  async function fetchDiagrams(query = ''): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${base}/api/arch/diagrams${query}`)
    const body = (await res.json()) as { ok: boolean; value: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    return body.value
  }

  beforeAll(async () => {
    home = await makeTempDir('prism-arch-dual-')
    rootA = await makeTempDir('prism-arch-dual-a-')
    rootB = await makeTempDir('prism-arch-dual-b-')
    const registry = new ProjectRegistry(home)
    await registry.register('demo-a', rootA)
    await registry.register('demo-b', rootB)

    // 同名 dual.html：全局一份 + 项目 A 一份（默认产物名=图类型，故这是**默认路径**而非边缘）
    await putFile(join(globalArch(), 'dual.html'), '<html>global</html>')
    await putFile(
      join(globalArch(), 'dual.meta.json'),
      metaJson({ name: 'dual.html', title: '全局双源', book: 'java-standards', module: 'exception' }),
    )
    await putFile(join(projectArch(rootA), 'dual.html'), '<html>project-a</html>')
    await putFile(
      join(projectArch(rootA), 'dual.meta.json'),
      metaJson({ name: 'dual.html', title: '项目A双源', book: 'java-standards', module: 'exception' }),
    )
    // 历史产物（MCP 链路旧行为）：只有 HTML，既无 sidecar 也无 IR —— 必须仍可见
    await putFile(join(projectArch(rootA), 'legacy.html'), '<html>legacy</html>')
    // 有 IR 无 sidecar：title 从 IR meta.title 回落
    await putFile(join(projectArch(rootA), 'legacy-ir.html'), '<html>legacy-ir</html>')
    await putFile(
      join(projectArch(rootA), 'legacy-ir.ir.json'),
      JSON.stringify({ ...VALID_IR, meta: { title: 'IR 里的标题' } }),
    )
    // 全局无作用域产物：`module=''`（只看待归类）时两源应同口径命中
    await putFile(join(globalArch(), 'unbook.html'), '<html>unbook</html>')

    app = await startServer({ home, kb: undefined as never, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  it('双源各出一条，身份键 (type,name,source,project) 与 preview/ir 均正确', async () => {
    const dual = (await fetchDiagrams()).filter((d) => d['name'] === 'dual.html')
    expect(dual).toHaveLength(2)

    const global = dual.find((d) => d['source'] === 'global')
    const project = dual.find((d) => d['source'] === 'project')
    expect(global).toMatchObject({
      type: 'architecture',
      name: 'dual.html',
      source: 'global',
      title: '全局双源',
      has_ir: false,
      preview: '/api/arch/preview/architecture/dual.html',
      ir: '/api/arch/ir/architecture/dual.html',
    })
    expect(global?.['project']).toBeUndefined()
    expect(project).toMatchObject({
      type: 'architecture',
      name: 'dual.html',
      source: 'project',
      project: 'demo-a',
      title: '项目A双源',
      book: 'java-standards',
      module: 'exception',
      archify_version: '2.16.0',
      has_ir: false,
      preview: '/api/arch/preview/architecture/dual.html?project=demo-a',
      ir: '/api/arch/ir/architecture/dual.html?project=demo-a',
    })
    // 项目源 URL 直接可用（带 project 限定）
    expect((await fetch(`${base}${project!['preview'] as string}`)).status).toBe(200)
    // 全局源这条 URL 与项目源同名 → 未限定必然歧义（设计如此：默认名=图类型使同名是默认路径，
    // 歧义要显式拒绝而不是让预览随机指向另一张图）。无同名冲突的全局条目 URL 照样可用：
    const unbook = (await fetchDiagrams()).find((d) => d['name'] === 'unbook.html')!
    expect(unbook['source']).toBe('global')
    expect(unbook['preview']).toBe('/api/arch/preview/architecture/unbook.html')
    expect((await fetch(`${base}${unbook['preview'] as string}`)).status).toBe(200)
  })

  it('缺 sidecar 的历史产物仍可见（绝不因缺 meta 隐藏条目，v9.1 A-3）', async () => {
    const legacy = (await fetchDiagrams()).find((d) => d['name'] === 'legacy.html')
    expect(legacy).toBeDefined()
    expect(legacy).toMatchObject({ source: 'project', project: 'demo-a', has_ir: false })
    expect(legacy?.['title']).toBeUndefined()
    // 时间取文件 stat（下发了 mtime 且可解析）
    expect(Number.isNaN(Date.parse(String(legacy?.['mtime'])))).toBe(false)
    expect(legacy?.['bytes']).toBeGreaterThan(0)
  })

  it('sidecar 缺 title 但有 IR → title 回落 IR meta.title', async () => {
    const item = (await fetchDiagrams()).find((d) => d['name'] === 'legacy-ir.html')
    expect(item?.['title']).toBe('IR 里的标题')
    expect(item?.['has_ir']).toBe(true)
  })

  it('过滤参数两源同口径（book/module）', async () => {
    const byBook = await fetchDiagrams('?book=java-standards&module=exception')
    expect(byBook.map((d) => `${String(d['source'])}/${String(d['name'])}`).sort()).toEqual([
      'global/dual.html',
      'project/dual.html',
    ])
    // module='' = 只看待归类：两源里无 module 的条目都命中
    const inbox = await fetchDiagrams('?module=')
    const names = inbox.map((d) => d['name'])
    expect(names).toContain('unbook.html') // 全局源
    expect(names).toContain('legacy.html') // 项目源
    expect(names).not.toContain('dual.html')
  })

  it('preview：?project= 只在该项目源内解析（项目内不存在 → 404，不回落全局）', async () => {
    // 存在：demo-a 源内有 dual.html
    const okRes = await fetch(`${base}/api/arch/preview/architecture/dual.html?project=demo-a`)
    expect(okRes.status).toBe(200)
    expect(await okRes.text()).toContain('project-a')

    // demo-b 源内没有 dual.html → 404（**不回落全局**那份）
    const miss = await fetch(`${base}/api/arch/preview/architecture/dual.html?project=demo-b`)
    expect(miss.status).toBe(404)
    const body = (await miss.json()) as Envelope
    expect(body.error?.code).toBe('not_found')
  })

  it('preview：未给 ?project= 且同名命中多源 → 400 歧义拒绝（不静默择一）', async () => {
    const res = await fetch(`${base}/api/arch/preview/architecture/dual.html`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as Envelope
    expect(body.error?.code).toBe('bad_request')
    expect(body.error?.message).toContain('多个来源')
  })

  it('ir：同口径（限定命中 200、限定不存在 404、未限定歧义 400）', async () => {
    const limited = await fetch(`${base}/api/arch/ir/architecture/legacy-ir.html?project=demo-a`)
    expect(limited.status).toBe(200)
    const limitedBody = (await limited.json()) as {
      ok: boolean
      value: { source: string; project?: string; ir: { meta: { title: string } } }
    }
    expect(limitedBody.value.source).toBe('project')
    expect(limitedBody.value.project).toBe('demo-a')
    expect(limitedBody.value.ir.meta.title).toBe('IR 里的标题')

    expect((await fetch(`${base}/api/arch/ir/architecture/legacy-ir.html?project=demo-b`)).status).toBe(404)
    expect((await fetch(`${base}/api/arch/ir/architecture/dual.html`)).status).toBe(400)
    // 限定到项目源（该项目源内确实有 dual.html + 无 IR）→ 200
    const scoped = await fetch(`${base}/api/arch/ir/architecture/dual.html?project=demo-a`)
    expect(scoped.status).toBe(200)
    expect(((await scoped.json()) as { value: { ir: unknown } }).value.ir).toBeNull()
  })

  it('preview 防穿越仍生效（双源改造未放松）', async () => {
    expect(
      (await fetch(`${base}/api/arch/preview/architecture/..%2F..%2Fetc%2Fpasswd`)).status,
    ).toBeGreaterThanOrEqual(400)
    expect((await fetch(`${base}/api/arch/preview/bogus/x.html`)).status).toBe(400)
    expect((await fetch(`${base}/api/arch/preview/architecture/nope.html?project=demo-a`)).status).toBe(404)
  })
})

// ===== 4. MCP prism_arch_generate =====
describe('MCP prism_arch_generate：book/module sidecar + 项目落点', () => {
  /** 3 个目录角色 + 跨文件 calls 边（architecture 生成器的最小可用输入）。 */
  function makeGraph(): unknown {
    return {
      nodes: [
        { id: 'cli', label: 'entry', source_file: 'proj/src/cli/entry.ts', community: 0 },
        { id: 'api', label: 'routes', source_file: 'proj/src/api/routes.ts', community: 1 },
        { id: 'store', label: 'db', source_file: 'proj/src/store/db.ts', community: 2 },
      ],
      links: [
        { source: 'cli', target: 'api', relation: 'calls' },
        { source: 'api', target: 'store', relation: 'calls' },
      ],
    }
  }

  it('project 类型落项目 .prism/arch/，book/module 写进 sidecar（v9.1 E-1 订正旧注释）', async () => {
    const home = await makeTempDir('prism-arch-mcp-place-')
    const root = await makeTempDir('prism-arch-mcp-place-root-')
    await putFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify(makeGraph()))
    await new ProjectRegistry(home).register('demo', root)
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')!
      const result = (await tool.call({
        type: 'architecture',
        project: 'demo',
        book: 'java-standards',
        module: 'exception',
      })) as { html: string; source: string; project?: string; book?: string }

      const dir = join(root, '.prism', 'arch', 'architecture')
      expect(result.source).toBe('project')
      expect(result.project).toBe('demo')
      expect(result.html.startsWith(dir)).toBe(true)
      expect(existsSync(join(dir, 'demo.html'))).toBe(true)
      // sidecar 真的落盘了（旧行为不写）
      const meta = JSON.parse(
        await readFile(join(dir, 'demo.meta.json'), 'utf-8'),
      ) as {
        book?: string
        module?: string
        archify_version: string
      }
      expect(meta.book).toBe('java-standards')
      expect(meta.module).toBe('exception')
      expect(meta.archify_version).toBe('2.16.0')
    } finally {
      tools.close()
    }
  })

  it('lifecycle（无 project）仍落全局 <home>/archify/ 并写 sidecar', async () => {
    const home = await makeTempDir('prism-arch-mcp-global-')
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')!
      const result = (await tool.call({ type: 'lifecycle' })) as { html: string; source: string }
      expect(result.source).toBe('global')
      expect(result.html.startsWith(join(home, 'archify', 'lifecycle'))).toBe(true)
      expect(existsSync(join(home, 'archify', 'lifecycle', 'task-state-machine.meta.json'))).toBe(true)
    } finally {
      tools.close()
    }
  })

  it('out 完全接管：给了 out 就不落项目目录', async () => {
    const home = await makeTempDir('prism-arch-mcp-out-')
    const root = await makeTempDir('prism-arch-mcp-out-root-')
    const outDir = await makeTempDir('prism-arch-mcp-out-dst-')
    await putFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify(makeGraph()))
    await new ProjectRegistry(home).register('demo', root)
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')!
      const out = join(outDir, 'custom.html')
      const result = (await tool.call({ type: 'architecture', project: 'demo', out })) as { html: string }
      // renderDiagram 内部 resolve() 归一化路径（Windows 上 / → \），故比归一化后的值
      expect(result.html).toBe(resolve(out))
      expect(existsSync(out)).toBe(true)
      expect(existsSync(join(root, '.prism', 'arch', 'architecture', 'demo.html'))).toBe(false)
    } finally {
      tools.close()
    }
  })

  // 白盒补测（tester-whitebox，v9.1 §2「给 out 时……产物与 sidecar 随 out 落」）：
  // 上一条只断言 HTML 落 out、项目目录零落点；sidecar/IR 是否随 out 同目录落此前无锁定。
  it('补测（out 接管的 sidecar 契约）：IR 与 sidecar 随 out 落同目录', async () => {
    const home = await makeTempDir('prism-arch-mcp-out-meta-')
    const root = await makeTempDir('prism-arch-mcp-out-meta-root-')
    const outDir = await makeTempDir('prism-arch-mcp-out-meta-dst-')
    await putFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify(makeGraph()))
    await new ProjectRegistry(home).register('demo', root)
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')!
      const out = join(outDir, 'scoped.html')
      const result = (await tool.call({ type: 'architecture', project: 'demo', out })) as {
        html: string
        ir: string
      }
      expect(result.ir).toBe(resolve(join(outDir, 'scoped.ir.json')))
      expect(existsSync(join(outDir, 'scoped.html'))).toBe(true)
      expect(existsSync(join(outDir, 'scoped.ir.json'))).toBe(true)
      // sidecar 随 out 落（design-v9 §2：out 完全接管 = 产物与 sidecar 随 out）
      expect(existsSync(join(outDir, 'scoped.meta.json'))).toBe(true)
      // 项目内零落点（不因给了 project 而另落一份）
      expect(existsSync(join(root, '.prism'))).toBe(false)
    } finally {
      tools.close()
    }
  })

  it('项目 root 被删 → project_root_missing（不复活目录，v9.1 B-1）', async () => {
    const home = await makeTempDir('prism-arch-mcp-gone-')
    const root = await makeTempDir('prism-arch-mcp-gone-root-')
    await rm(root, { recursive: true, force: true })
    await new ProjectRegistry(home).register('gone', root)
    const tools = createMcpTools({ home })
    try {
      const tool = tools.find((item) => item.name === 'prism_arch_generate')!
      await expect(tool.call({ type: 'architecture', project: 'gone' })).rejects.toMatchObject({
        code: 'project_root_missing',
      })
      expect(existsSync(root)).toBe(false)
      expect(existsSync(join(root, '.prism'))).toBe(false)
    } finally {
      tools.close()
    }
  })
})
