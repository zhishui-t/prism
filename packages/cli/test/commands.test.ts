import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKnowledgeService, type KnowledgeService } from '@prism/knowledge'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** 假 graphify：extract 时产出 .graphify 产物（graph.json + manifest + studio/index.html）。 */
async function writeFakeGraphify(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const script = join(dir, 'fake-graphify.mjs')
  await writeFile(
    script,
    `
const args = process.argv.slice(2)
const fs = await import('node:fs')
const path = await import('node:path')
if (args[0] === 'extract') {
  const root = args[1]
  const dir = path.join(root, '.graphify')
  fs.mkdirSync(path.join(dir, 'studio'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ nodes: [{ id: 'a' }], edges: [] }))
  fs.writeFileSync(path.join(dir, 'GRAPH_REPORT.md'), '# report')
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ files: { 'src/index.ts': await hash(path.join(root, 'src', 'index.ts')) } }),
  )
  fs.writeFileSync(path.join(dir, 'studio', 'index.html'), '<html><body>FAKE STUDIO</body></html>')
} else if (args[0] === 'query') {
  process.stdout.write('QUERY-HIT: node a')
} else if (args[0] === 'merge-graphs') {
  const out = args[args.indexOf('--out') + 1]
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ nodes: [{ id: 'a' }], links: [] }))
  process.stdout.write('Merged 2 graphs -> 4 nodes, 2 edges\\n')
} else if (args[0] === 'cluster-only') {
  const dir = args[1]
  const od = path.join(dir, 'graphify-out')
  fs.mkdirSync(od, { recursive: true })
  fs.writeFileSync(path.join(od, 'graph.html'), '<html>merged</html>')
  process.stdout.write('Done - 2 communities.\\n')
}
async function hash(file) {
  return (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
`,
    'utf-8',
  )
  return script
}

describe('CLI 命令（注入真实知识服务 / 假 graphify）', () => {
  let home: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []
  const services: Array<{ close?: () => void }> = []

  beforeEach(async () => {
    home = await tempDir('prism-cli-home-')
    lines = []
    ctx = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
    }
  })

  afterEach(async () => {
    // 先关 SQLite 连接（Windows 下打开的文件不能删），再清理临时目录
    for (const service of services) {
      service.close?.()
    }
    services.length = 0
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    cleanup.length = 0
  })

  /** 真实知识服务（登记关闭钩子）。 */
  function makeKb(kbHome: string): () => Promise<KnowledgeService> {
    const service = createKnowledgeService({ home: kbHome })
    services.push(service)
    return async () => service
  }

  it('init：建骨架 + 幂等 + --force（--harness-root 指临时目录，绝不写真实 ~/.zcode）', async () => {
    const harnessRoot = await tempDir('prism-cli-zcode-')
    cleanup.push(harnessRoot)
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot])).toBe(0)
    expect(existsSync(join(home, 'state'))).toBe(true)
    expect(existsSync(join(home, 'knowledge'))).toBe(true)
    expect(existsSync(join(home, 'config.json'))).toBe(true)

    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot])).toBe(0)
    expect(lines.join('\n')).toContain('幂等跳过')

    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--force'])).toBe(0)
    expect(lines.join('\n')).toContain('已写配置')
  })

  // QA v4 修复 D-4：`doctor` 真实探测 vendored graphify(Python) + anydoc，实测在并发负载下
  // 曾撞 `testTimeout: 20_000`（20037ms，超限 37ms）→ 全量门禁假红。该用例是**负载敏感型**，
  // 单独放宽到 60s（不改产品代码、不改断言；裸 20s 并不代表被测行为有问题）。
  it('doctor：graphifyEnv 注入假 bin → 全部通过', { timeout: 60_000 }, async () => {
    await runCommand(ctx, ['init'])
    const fakeBin = await writeFakeGraphify(await tempDir('prism-cli-bin2-'))
    cleanup.push(join(fakeBin, '..'))
    const withEnv: CommandContext = { ...ctx, graphifyEnv: { GRAPHIFY_BIN: fakeBin } }
    lines = []
    const code = await runCommand(withEnv, ['doctor', '--port', '0'])
    const output = lines.join('\n')
    expect(code).toBe(0)
    expect(output).toContain('ok  node_version')
    expect(output).toContain('ok  graphify')
    expect(output).toContain('全部通过')
  })

  it('kb import → kb search 命中两字词「性能」', async () => {
    const mdHome = await tempDir('prism-cli-kb-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = {
      ...ctx,
      home: mdHome,
      kbFactory: makeKb(mdHome),
    }
    const doc = join(mdHome, 'perf.md')
    await writeFile(doc, '# 性能优化守则\n\n遇到性能问题先量化再做优化。', 'utf-8')
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'import', doc, '--layer', 'global', '--book', 'handbook'])).toBe(0)
    expect(lines.join('\n')).toMatch(/已落库 .+@v1/)

    lines = []
    expect(await runCommand(kbCtx, ['kb', 'search', '性能'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('性能优化守则')
    expect(output).toContain('global/handbook')
    expect(output).toContain('共 1 条')
  })

  it('kb graph / kb path：双链建边 → 邻域与最短路径（知识图谱）', async () => {
    const mdHome = await tempDir('prism-cli-graph-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = { ...ctx, home: mdHome, kbFactory: makeKb(mdHome) }
    const a = join(mdHome, 'a.md')
    const b = join(mdHome, 'b.md')
    // 双链以 [[id]] 指向条目 id（design §4）
    await writeFile(a, '---\nid: GRAPH-A\ntitle: 规则A\ntype: doc\nlayer: global\nbook: handbook\nmodule: m\n---\n\nA 正文。\n', 'utf-8')
    await writeFile(b, '---\nid: GRAPH-B\ntitle: 规则B\ntype: doc\nlayer: global\nbook: handbook\nmodule: m\n---\n\nB 引用 [[GRAPH-A]]，另有悬空 [[NOPE]]。\n', 'utf-8')
    expect(await runCommand(kbCtx, ['kb', 'import', a])).toBe(0)
    expect(await runCommand(kbCtx, ['kb', 'import', b])).toBe(0)

    // 概览：节点只含存在的条目；悬空引用保留在边上（前端可据此标断链）
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'graph', '--json'])).toBe(0)
    const view = JSON.parse(lines[lines.length - 1]) as {
      value: {
        nodes: Array<{ id: string }>
        edges: Array<{ from_id: string; to_id: string; relation: string }>
      }
    }
    expect(view.value.nodes.map((n) => n.id).sort()).toEqual(['GRAPH-A', 'GRAPH-B'])
    // 概览以「条目节点」为准：悬空引用 NOPE 不是条目，故其边不出现在概览子图里
    // （悬空边仍在边表中，邻域查询可见——见下一段断言）
    const rels = view.value.edges.map((e) => `${e.from_id}->${e.to_id}:${e.relation}`).sort()
    expect(rels).toEqual(['GRAPH-B->GRAPH-A:references'])

    // 邻域（含悬空边）
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'graph', 'GRAPH-B'])).toBe(0)
    expect(lines.join('\n')).toContain('GRAPH-B --references--> GRAPH-A')

    // 路径
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'path', 'GRAPH-B', 'GRAPH-A'])).toBe(0)
    expect(lines[0]).toBe('GRAPH-B → GRAPH-A')

    // 不可达
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'path', 'GRAPH-A', 'ghost'])).toBe(1)
    expect(lines.join('\n')).toContain('无路径')
  })

  it('task 台账：register → list → graph → report → stats（被动记录）', async () => {
    const tHome = await tempDir('prism-cli-task-')
    cleanup.push(tHome)
    const tCtx: CommandContext = { ...ctx, home: tHome }
    const dagFile = join(tHome, 'dag.json')
    await writeFile(
      dagFile,
      JSON.stringify({
        tasks: [
          { id: 'T-1', description: '探索' },
          { id: 'T-2', description: '设计', depends_on: ['T-1'] },
          { id: 'T-3', description: '开发', depends_on: ['T-2'] },
        ],
      }),
      'utf-8',
    )

    // 登记
    lines = []
    expect(
      await runCommand(tCtx, [
        'task', 'register', '--dag', 'dag-cli', '--session', 's1', '--team', 'core-dev',
        '--project', 'prism', '--dag-version', 'v1', '--difficulty', 'normal', '--file', dagFile,
      ]),
    ).toBe(0)
    expect(lines.join('\n')).toContain('3 任务 / 2 边')

    // 列表
    lines = []
    expect(await runCommand(tCtx, ['task', 'list', '--dag', 'dag-cli'])).toBe(0)
    expect(lines.join('\n')).toContain('T-1')

    // 依赖图
    lines = []
    expect(await runCommand(tCtx, ['task', 'graph', 'dag-cli'])).toBe(0)
    expect(lines.join('\n')).toContain('← T-1')

    // 回报（合法）
    lines = []
    expect(await runCommand(tCtx, ['task', 'report', 'T-1', '--to', 'RUNNING', '--by', 'dev-1'])).toBe(0)
    expect(lines.join('\n')).toContain('RUNNING')

    // 回报（非法转移 → rc 1）
    lines = []
    expect(await runCommand(tCtx, ['task', 'report', 'T-2', '--to', 'COMPLETED', '--by', 'x'])).toBe(1)
    expect(lines.join('\n')).toContain('invalid_status_transition')

    // 统计
    lines = []
    expect(await runCommand(tCtx, ['task', 'stats'])).toBe(0)
    expect(lines.join('\n')).toContain('任务 3 个')
  })

  it('kb enrich：直付摘要 → 落 SUMMARY 条目（工作队列已移除）', async () => {
    const eHome = await tempDir('prism-cli-enrich-')
    cleanup.push(eHome)
    const eCtx: CommandContext = { ...ctx, home: eHome, kbFactory: makeKb(eHome) }

    lines = []
    const code = await runCommand(eCtx, [
      'kb', 'enrich', 'summarize',
      '--payload', '{"entry_id":"K-1","book":"b"}',
      '--result', '{"summary":"摘要内容"}',
      '--by', 'cli-test',
      '--json',
    ])
    expect(code).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as { value: { kind: string; action: string; detail: string } }
    expect(out.value.kind).toBe('summarize')
    expect(out.value.action).toBe('created')
    expect(out.value.detail).toContain('SUMMARY-K-1')
  })

  it('kb convert：纯文本直读，--json 返回 status=text', async () => {
    const cHome = await tempDir('prism-cli-convert-')
    cleanup.push(cHome)
    const cCtx: CommandContext = { ...ctx, home: cHome }
    const file = join(cHome, 'note.md')
    await writeFile(file, '# 标题\n\n正文内容。', 'utf-8')

    lines = []
    expect(await runCommand(cCtx, ['kb', 'convert', file, '--json'])).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as { value: { status: string; markdown: string } }
    expect(out.value.status).toBe('text')
    expect(out.value.markdown).toContain('正文内容')
  })

  it('kb reindex：手工改文件后重建索引 → 新标题可检索（Z2）', async () => {
    const mdHome = await tempDir('prism-cli-reindex-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = { ...ctx, home: mdHome, kbFactory: makeKb(mdHome) }
    const doc = join(mdHome, 'r.md')
    await writeFile(doc, '# 旧标题\n\n正文内容。', 'utf-8')
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'import', doc, '--layer', 'global', '--book', 'handbook'])).toBe(0)
    // 手工改标题（DB 索引未变）
    const versionFile = join(mdHome, 'knowledge', 'global', 'handbook', '_inbox')
    const { readdirSync } = await import('node:fs')
    const id = readdirSync(versionFile)[0]!
    await writeFile(
      join(versionFile, id, 'v01.md'),
      `---\nid: ${id}\nversion: 1\ntitle: 新标题\ntype: doc\nlayer: global\nbook: handbook\nmodule: ""\nstatus: active\n---\n\n正文内容。\n`,
      'utf-8',
    )
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'reindex'])).toBe(0)
    expect(lines.join('\n')).toContain('已重建索引')
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'search', '新标题'])).toBe(0)
    expect(lines.join('\n')).toContain('新标题')
  })

  it('kb import project 层缺 owner → 报错退出 1', async () => {
    const mdHome = await tempDir('prism-cli-kb2-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = {
      ...ctx,
      home: mdHome,
      kbFactory: makeKb(mdHome),
    }
    const doc = join(mdHome, 'x.md')
    await writeFile(doc, '# 标题\n\n内容', 'utf-8')
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'import', doc, '--layer', 'project'])).toBe(1)
    expect(lines.join('\n')).toContain('owner')
  })

  it('graph build（假执行体）→ status → query 缺图谱报错', async () => {
    const projectRoot = await tempDir('prism-cli-proj-')
    cleanup.push(projectRoot)
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export const a = 1\n', 'utf-8')

    lines = []
    const buildCtx: CommandContext = {
      ...ctx,
      buildRunner: async (_p, root, log) => {
        log(`fake-build ${root}`)
      },
    }
    const code = await runCommand(buildCtx, ['graph', 'build', projectRoot, '--name', 'demo'])
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('建图完成: demo')

    lines = []
    expect(await runCommand(ctx, ['graph', 'status', 'demo'])).toBe(0)
    expect(lines.join('\n')).toContain('项目: demo')

    lines = []
    expect(await runCommand(ctx, ['graph', 'query', 'a', '--project', 'demo'])).toBe(1)
    expect(lines.join('\n')).toContain('graph_not_found')
  })

  it('graph merge：<2 名字 / 未注册项目报错；合并产物落 --out-dir 且不污染项目根', async () => {
    const projA = await tempDir('prism-cli-mA-')
    const projB = await tempDir('prism-cli-mB-')
    cleanup.push(projA, projB)
    for (const root of [projA, projB]) {
      await mkdir(join(root, 'graphify-out'), { recursive: true })
      await writeFile(
        join(root, 'graphify-out', 'graph.json'),
        JSON.stringify({ nodes: [], links: [] }),
        'utf-8',
      )
    }
    // 注册表（<home>/graph/projects.json，registry.ts 的落盘结构）
    await mkdir(join(home, 'graph'), { recursive: true })
    await writeFile(
      join(home, 'graph', 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: {
          A: { root: projA, built_at: null },
          B: { root: projB, built_at: null },
        },
      }),
      'utf-8',
    )
    const fakeBin = await writeFakeGraphify(await tempDir('prism-cli-fakeg-'))
    const mergeCtx: CommandContext = { ...ctx, graphifyEnv: { GRAPHIFY_BIN: fakeBin } }

    lines = []
    expect(await runCommand(mergeCtx, ['graph', 'merge', 'A'])).toBe(1)
    expect(lines.join('\n')).toContain('至少 2 个已建图项目')

    lines = []
    expect(await runCommand(mergeCtx, ['graph', 'merge', 'A', 'nope'])).toBe(1)
    expect(lines.join('\n')).toContain('项目未注册: nope')

    const outDir = await tempDir('prism-cli-mout-')
    cleanup.push(outDir)
    lines = []
    expect(await runCommand(mergeCtx, ['graph', 'merge', 'A', 'B', '--out-dir', outDir])).toBe(0)
    expect(lines.join('\n')).toContain('已合并 2 个项目图谱: A + B')
    expect(lines.join('\n')).toContain('4 节点 / 2 边')
    // 产物落 outDir，项目根零污染
    expect(existsSync(join(outDir, 'graphify-out', 'graph.html'))).toBe(true)
    expect(existsSync(join(projA, 'merged-graph.json'))).toBe(false)
    expect(existsSync(join(projA, 'prism-merged'))).toBe(false)
    expect(existsSync(join(projB, 'graphify-out', 'graph.html'))).toBe(false)
  })

  it('graph merge 不带 --out-dir → 产物落注入的 home（<home>/graphify-merged），绝不回落真实宿主目录', async () => {
    const projA = await tempDir('prism-cli-nhA-')
    const projB = await tempDir('prism-cli-nhB-')
    cleanup.push(projA, projB)
    for (const root of [projA, projB]) {
      await mkdir(join(root, 'graphify-out'), { recursive: true })
      await writeFile(
        join(root, 'graphify-out', 'graph.json'),
        JSON.stringify({ nodes: [], links: [] }),
        'utf-8',
      )
    }
    await mkdir(join(home, 'graph'), { recursive: true })
    await writeFile(
      join(home, 'graph', 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: {
          A: { root: projA, built_at: null },
          B: { root: projB, built_at: null },
        },
      }),
      'utf-8',
    )
    const fakeBin = await writeFakeGraphify(await tempDir('prism-cli-fakeg2-'))
    const mergeCtx: CommandContext = { ...ctx, graphifyEnv: { GRAPHIFY_BIN: fakeBin } }

    lines = []
    expect(await runCommand(mergeCtx, ['graph', 'merge', 'A', 'B'])).toBe(0)

    // 缺省落点 = 注入 home 之下（home 必填，Q-4：不存在「缺参 → ~/.prism」的路径）
    const expectedOut = join(home, 'graphify-merged')
    expect(lines.join('\n')).toContain(expectedOut)
    expect(existsSync(join(expectedOut, 'merged-graph.json'))).toBe(true)
    expect(existsSync(join(expectedOut, 'graphify-out', 'graph.html'))).toBe(true)

    // A/B 项目根零新文件（既无合并产物目录，也无渲染出的 graph.html）
    for (const root of [projA, projB]) {
      expect(existsSync(join(root, 'graphify-merged'))).toBe(false)
      expect(existsSync(join(root, 'merged-graph.json'))).toBe(false)
      expect(existsSync(join(root, 'graphify-out', 'graph.html'))).toBe(false)
    }
  })

  it('--version 输出版本；未知命令退出 1', async () => {
    lines = []
    expect(await runCommand(ctx, ['--version'])).toBe(0)
    expect(lines.join('\n')).toMatch(/^prism \d+\.\d+\.\d+/)

    lines = []
    expect(await runCommand(ctx, ['nope'])).toBe(1)
    expect(lines.join('\n')).toContain('未知命令')
  })

  it('kb import 带 frontmatter → id/book/module/type/tags 生效，正文不含 frontmatter', async () => {
    const mdHome = await tempDir('prism-cli-kbfm-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = { ...ctx, home: mdHome, kbFactory: makeKb(mdHome) }
    const doc = join(mdHome, 'sample.md')
    await writeFile(
      doc,
      '---\nid: PERF-001\ntitle: 循环内禁止数据库查询\ntype: rule\nlayer: global\nbook: perf-standards\nmodule: db-access\ntags: [性能, 数据库]\n---\n\n# 循环内禁止数据库查询\n\nN+1 问题影响性能。\n',
      'utf-8',
    )
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'import', doc])).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('已落库 PERF-001@v1')
    expect(out).toContain('perf-standards')
    expect(out).toContain('db-access')

    lines = []
    expect(await runCommand(kbCtx, ['kb', 'get', 'PERF-001'])).toBe(0)
    const entry = JSON.parse(lines[0]) as {
      title: string
      type: string
      book: string
      module: string
      tags: string[]
      content: string
    }
    expect(entry.title).toBe('循环内禁止数据库查询')
    expect(entry.type).toBe('rule')
    expect(entry.book).toBe('perf-standards')
    expect(entry.module).toBe('db-access')
    expect(entry.tags).toEqual(['性能', '数据库'])
    expect(entry.content).not.toContain('book: perf-standards')
    expect(entry.content).toContain('N+1')
  })

  it('kb import 命令行 --book/--module 显式覆盖 frontmatter', async () => {
    const mdHome = await tempDir('prism-cli-kbfm2-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = { ...ctx, home: mdHome, kbFactory: makeKb(mdHome) }
    const doc = join(mdHome, 'ov.md')
    await writeFile(doc, '---\nid: OV-001\ntitle: 覆盖测试\nlayer: global\nbook: fm-book\nmodule: fm-module\n---\n\n正文。\n', 'utf-8')
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'import', doc, '--book', 'cli-book', '--module', 'cli-module'])).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('已落库 OV-001@v1')
    expect(out).toContain('cli-book')
    expect(out).toContain('cli-module')
    expect(out).not.toContain('fm-book')
  })

  it('kb import 无 frontmatter → 回落现有行为（title 取 H1，book 默认 inbox，id 自动生成）', async () => {
    const mdHome = await tempDir('prism-cli-kbfm3-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = { ...ctx, home: mdHome, kbFactory: makeKb(mdHome) }
    const doc = join(mdHome, 'plain.md')
    await writeFile(doc, '# 纯正文标题\n\n没有 frontmatter 的文件。\n', 'utf-8')
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'import', doc, '--layer', 'global'])).toBe(0)
    const out = lines.join('\n')
    expect(out).toMatch(/已落库 KB-.+@v1/)
    expect(out).toContain('inbox')

    lines = []
    await runCommand(kbCtx, ['kb', 'search', '纯正文标题'])
    expect(lines.join('\n')).toContain('纯正文标题')
  })

  it('kb search --json 输出信封', async () => {
    const mdHome = await tempDir('prism-cli-kb3-')
    cleanup.push(mdHome)
    const kbCtx: CommandContext = {
      ...ctx,
      home: mdHome,
      kbFactory: makeKb(mdHome),
    }
    const doc = join(mdHome, 'n.md')
    await writeFile(doc, '# 异常处理规范\n\n统一异常处理。', 'utf-8')
    await runCommand(kbCtx, ['kb', 'import', doc, '--layer', 'global', '--book', 'b'])
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'search', '异常处理', '--json'])).toBe(0)
    const envelope = JSON.parse(lines[0]) as { ok: boolean; value: unknown[] }
    expect(envelope.ok).toBe(true)
    expect(envelope.value).toHaveLength(1)
  })
})
