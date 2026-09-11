import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { mergeGraphArgs, mergeGraphs } from '../src/graph/graphify.js'
import { mergedGraphDir, mergeProjectGraphs } from '../src/graph/merge.js'
import { makeTempDir, putFile } from './helpers.js'

const NL = String.fromCharCode(10)
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

/**
 * 假 graphify CLI（v5 F-C2 用）：
 * - 把每次调用的 argv 追加进 `FAKE_ARGV_LOG`（断言「合并路径不触发语义层」）；
 * - `merge-graphs` → 按 `--out` 写文件 + 打印汇总行；
 * - `cluster-only` → 在 `<dir>/graphify-out/` 造 graph.html（对齐实测落点）；
 * - **任何其它命令（尤其 `extract`）一律 exit 3**，让调用链显式失败。
 */
async function writeFakeGraphify(): Promise<string> {
  const dir = await tempDir('prism-merge-fake-')
  const script = join(dir, 'fake-graphify.mjs')
  await writeFile(
    script,
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
      "import { dirname, join } from 'node:path'",
      'const argv = process.argv.slice(2)',
      "const log = process.env.FAKE_ARGV_LOG",
      "if (log) appendFileSync(log, JSON.stringify(argv) + '\\n')",
      "if (argv[0] === 'merge-graphs') {",
      "  const out = argv[argv.indexOf('--out') + 1]",
      '  mkdirSync(dirname(out), { recursive: true })',
      "  writeFileSync(out, JSON.stringify({ nodes: [{ id: 'a' }], links: [] }))",
      "  process.stdout.write(process.env.FAKE_MERGE_NO_SUMMARY === '1' ? 'merged ok' + '\\n' : 'Merged 2 graphs -> 4 nodes, 2 edges' + '\\n')",
      "} else if (argv[0] === 'cluster-only') {",
      '  const dir = argv[1]',
      "  const od = join(dir, 'graphify-out')",
      '  mkdirSync(od, { recursive: true })',
      "  writeFileSync(join(od, 'graph.html'), '<html>merged</html>')",
      "  writeFileSync(join(od, 'graph.json'), JSON.stringify({ nodes: [{ id: 'a', community: 0 }], links: [] }))",
      "  process.stdout.write('Done - 2 communities.' + '\\n')",
      '} else {',
      "  process.stdout.write('UNEXPECTED-COMMAND: ' + argv.join(' ') + '\\n')",
      '  process.exit(3)',
      '}',
      '',
    ].join(NL),
    'utf-8',
  )
  return script
}

/** 造一个「已建图」的项目根（只写存在性所需的 graph.json，假 CLI 不读内容）。 */
async function makeProject(name: string): Promise<string> {
  const root = await tempDir(`prism-merge-${name}-`)
  await mkdir(join(root, 'graphify-out'), { recursive: true })
  await writeFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }), 'utf-8')
  return root
}

async function readCalls(logPath: string): Promise<string[][]> {
  const raw = await readFile(logPath, 'utf-8')
  return raw
    .split(NL)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[])
}

describe('mergeGraphArgs / mergeGraphs（参数钉死，v5 F-C2）', () => {
  it('mergeGraphArgs：<2 输入 → bad_request（不启动子进程）；≥2 → merge-graphs + 显式 --out', () => {
    expect(() => mergeGraphArgs(['only-one.json'], 'out.json')).toThrowError(/至少需要 2 个/)
    try {
      mergeGraphArgs([], 'out.json')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('bad_request')
    }
    expect(mergeGraphArgs(['a.json', 'b.json'], 'M/merged-graph.json')).toEqual([
      'merge-graphs',
      'a.json',
      'b.json',
      '--out',
      'M/merged-graph.json',
    ])
  })

  it('mergeGraphs：解析汇总行；解析不到则 nodes/edges 为 null（不猜）', async () => {
    const cli = await writeFakeGraphify()
    const out = join(await tempDir('prism-merge-out-'), 'merged-graph.json')

    const ok = await mergeGraphs(['a.json', 'b.json'], out, { env: { GRAPHIFY_BIN: cli } })
    expect(ok.nodes).toBe(4)
    expect(ok.edges).toBe(2)
    expect(ok.graphPath).toBe(out)
    expect(existsSync(out)).toBe(true)

    const vague = await mergeGraphs(['a.json', 'b.json'], out, {
      env: { GRAPHIFY_BIN: cli, FAKE_MERGE_NO_SUMMARY: '1' },
    })
    expect(vague.nodes).toBeNull()
    expect(vague.edges).toBeNull()
  })
})

describe('mergeProjectGraphs（落点 / D2 护栏 / 零 LLM 路径）', () => {
  it('产物落 <PRISM_HOME>/graphify-merged，渲染 graph.html，且项目根零污染 + 命令序列不触发语义层', async () => {
    const cli = await writeFakeGraphify()
    const logPath = join(await tempDir('prism-merge-log-'), 'argv.log')
    const home = await tempDir('prism-merge-home-')
    const projA = await makeProject('a')
    const projB = await makeProject('b')

    const result = await mergeProjectGraphs(
      [
        { project: 'A', root: projA },
        { project: 'B', root: projB },
      ],
      { home, env: { GRAPHIFY_BIN: cli, FAKE_ARGV_LOG: logPath } },
    )

    // 落点：PRISM_HOME 之下，且不在任何项目根内（裁决 D2）
    expect(result.outDir).toBe(mergedGraphDir(home))
    expect(result.outDir).toBe(join(home, 'graphify-merged'))
    for (const root of [projA, projB]) {
      const base = resolve(root)
      const abs = resolve(result.outDir)
      expect(abs === base || abs.startsWith(base + sep)).toBe(false)
    }
    expect(result.graphPath).toBe(join(result.outDir, 'merged-graph.json'))
    expect(result.htmlPath).toBe(join(result.outDir, 'graphify-out', 'graph.html'))
    expect(result.htmlExists).toBe(true)
    expect(existsSync(result.htmlPath!)).toBe(true)
    expect(result.nodes).toBe(4)
    expect(result.edges).toBe(2)

    // 项目根零污染：不写 merged-graph.json，也不产出新 graph.html
    expect(existsSync(join(projA, 'merged-graph.json'))).toBe(false)
    expect(existsSync(join(projB, 'merged-graph.json'))).toBe(false)
    expect(existsSync(join(projA, 'graphify-out', 'graph.html'))).toBe(false)
    expect(existsSync(join(projB, 'graphify-out', 'graph.html'))).toBe(false)

    // 零 LLM 路径：只调 merge-graphs 与 cluster-only --no-label，绝不出现 extract/LLM 相关 flag
    const calls = await readCalls(logPath)
    expect(calls).toEqual([
      [
        'merge-graphs',
        join(projA, 'graphify-out', 'graph.json'),
        join(projB, 'graphify-out', 'graph.json'),
        '--out',
        join(result.outDir, 'merged-graph.json'),
      ],
      ['cluster-only', result.outDir, '--graph', join(result.outDir, 'merged-graph.json'), '--no-label'],
    ])
    const flat = calls.flat()
    for (const forbidden of ['extract', '--backend', '--dedup-llm', '--code-only']) {
      expect(flat).not.toContain(forbidden)
    }
  })

  it('D2 护栏：显式 outDir 落在某个项目根内 → bad_request', async () => {
    const projA = await makeProject('a')
    const projB = await makeProject('b')
    await expect(
      mergeProjectGraphs(
        [
          { project: 'A', root: projA },
          { project: 'B', root: projB },
        ],
        { home: await tempDir('prism-merge-d2-home-'), outDir: join(projA, 'prism-merged') },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' })
    // 护栏在落盘前生效：不得留下目录
    expect(existsSync(join(projA, 'prism-merged'))).toBe(false)
  })

  it('未建图的项目 → graph_not_found（带可执行提示）；<2 项目 → bad_request', async () => {
    const projA = await makeProject('a')
    const bare = await tempDir('prism-merge-bare-')
    const home = await tempDir('prism-merge-nf-home-')
    await expect(
      mergeProjectGraphs(
        [
          { project: 'A', root: projA },
          { project: 'B', root: bare },
        ],
        { home },
      ),
    ).rejects.toMatchObject({ code: 'graph_not_found' })

    await expect(mergeProjectGraphs([{ project: 'A', root: projA }], { home })).rejects.toMatchObject({
      code: 'bad_request',
    })
  })

  it('skipRender：只合并不渲染（htmlPath 为 null，不跑 cluster-only）', async () => {
    const cli = await writeFakeGraphify()
    const logPath = join(await tempDir('prism-merge-log2-'), 'argv.log')
    const projA = await makeProject('a')
    const projB = await makeProject('b')
    const outDir = await tempDir('prism-merge-out2-')

    const result = await mergeProjectGraphs(
      [
        { project: 'A', root: projA },
        { project: 'B', root: projB },
      ],
      {
        home: await tempDir('prism-merge-skip-home-'),
        outDir,
        skipRender: true,
        env: { GRAPHIFY_BIN: cli, FAKE_ARGV_LOG: logPath },
      },
    )
    expect(result.htmlPath).toBeNull()
    expect(result.htmlExists).toBe(false)
    expect((await readCalls(logPath)).length).toBe(1)
    expect((await readCalls(logPath))[0]![0]).toBe('merge-graphs')
  })
})

describe('POST /api/graph/merge（HTTP 面，v5 F-C2）', () => {
  let app: AppHandle
  let base: string
  let home: string
  let projA: string
  let projB: string

  /** 路由信封（成功/失败两态；value 形状由调用方断言） */
  interface MergeEnvelope {
    ok?: boolean
    value?: unknown
    error?: { code: string }
  }

  const post = async (path: string, body: unknown): Promise<{ status: number; json: MergeEnvelope }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as MergeEnvelope }
  }

  afterEach(async () => {
    await app.close()
  })

  it('合并两个已建图项目 → ok + 产物落 PRISM_HOME（不在项目根）；参数错误按错误码返回', async () => {
    const cli = await writeFakeGraphify()
    home = await makeTempDir('prism-merge-http-home-')
    projA = await makeTempDir('prism-merge-http-a-')
    projB = await makeTempDir('prism-merge-http-b-')
    await putFile(join(projA, 'graphify-out', 'graph.json'), '{}')
    await putFile(join(projB, 'graphify-out', 'graph.json'), '{}')
    app = await startServer({
      home,
      port: 0,
      buildRunner: async () => {}, // 只为把项目登记进注册表，不真建图
      graphifyEnv: { GRAPHIFY_BIN: cli },
    })
    base = `http://127.0.0.1:${app.port}`

    for (const [project, root] of [
      ['A', projA],
      ['B', projB],
    ] as const) {
      const res = await post('/api/graph/build', { project, root })
      expect(res.json.ok).toBe(true)
    }

    const merged = await post('/api/graph/merge', { projects: ['A', 'B'] })
    expect(merged.json.ok).toBe(true)
    const value = merged.json.value as {
      outDir: string
      graphPath: string
      htmlPath: string
      htmlExists: boolean
      nodes: number
      edges: number
      projects: string[]
    }
    expect(value.projects).toEqual(['A', 'B'])
    expect(value.outDir).toBe(join(home, 'graphify-merged'))
    expect(value.htmlExists).toBe(true)
    expect(existsSync(value.htmlPath)).toBe(true)
    expect(value.nodes).toBe(4)
    expect(value.edges).toBe(2)
    for (const root of [projA, projB]) {
      const b = resolve(root)
      const a = resolve(value.outDir)
      expect(a === b || a.startsWith(b + sep)).toBe(false)
      expect(existsSync(join(root, 'merged-graph.json'))).toBe(false)
    }

    // <2 项目 / 未注册项目 / out_dir 落项目根（D2）
    const tooFew = await post('/api/graph/merge', { projects: ['A'] })
    expect(tooFew.json.error?.code).toBe('bad_request')
    const ghost = await post('/api/graph/merge', { projects: ['A', 'ghost'] })
    expect(ghost.json.error?.code).toBe('not_found')
    const inside = await post('/api/graph/merge', { projects: ['A', 'B'], out_dir: join(projA, 'x') })
    expect(inside.json.error?.code).toBe('bad_request')
    expect(existsSync(join(projA, 'x'))).toBe(false)
  })
})
