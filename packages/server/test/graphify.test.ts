import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildGraphArgs,
  defaultGraphPath,
  graphExport,
  GRAPHIFY_EXPORT_FORMATS,
  formatCommand,
  graphAffected,
  graphExplain,
  graphGodNodes,
  graphPath,
  graphSummary,
  resolveGraphifyCommand,
  resolvePythonCommand,
  runGraphify,
} from '../src/graph/graphify.js'

const isWin = process.platform === 'win32'

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `prism-graphify-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 跨平台回归（2026-09-12）：解释器名**不得写死** `python`。
 * Windows 只有 `python`，macOS/Linux 通常只有 `python3`——写死会让 vendored graphify
 * 在其中一侧永远起不来（表现为 graphify_missing 或 spawn ENOENT）。
 */
describe('resolvePythonCommand（跨平台解释器解析）', () => {
  it('PRISM_PYTHON 覆盖优先于平台惯例', () => {
    expect(resolvePythonCommand({ PATH: '', PRISM_PYTHON: '/opt/py/bin/python3.13' })).toBe('/opt/py/bin/python3.13')
  })

  it('空覆盖值不生效（回落平台惯例）', () => {
    expect(resolvePythonCommand({ PATH: '', PRISM_PYTHON: '   ' })).toBe(isWin ? 'python' : 'python3')
  })

  it('PATH 为空 → 平台惯例名（Windows python / POSIX python3）', () => {
    expect(resolvePythonCommand({ PATH: '' })).toBe(isWin ? 'python' : 'python3')
  })

  it('PATH 上只有 python3 → 用 python3（本条正是写死 python 时失败的场景）', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'python3'), isWin ? '@echo off\r\n' : '#!/bin/sh\n', 'utf-8')
    if (!isWin) await chmod(join(dir, 'python3'), 0o755)
    expect(resolvePythonCommand({ PATH: dir })).toBe('python3')
  })

  it('两者都在 PATH 上 → 各平台取各自惯例优先项', async () => {
    const dir = await tempDir()
    for (const name of ['python', 'python3']) {
      await writeFile(join(dir, name), isWin ? '@echo off\r\n' : '#!/bin/sh\n', 'utf-8')
      if (!isWin) await chmod(join(dir, name), 0o755)
    }
    expect(resolvePythonCommand({ PATH: dir })).toBe(isWin ? 'python' : 'python3')
  })

  it('POSIX 上无执行位的同名文件不算命中（会退回次选，而不是选中普通文件）', async () => {
    if (isWin) return
    const dir = await tempDir()
    // 高优先的 python3 存在但**无执行位** → 必须跳过，落到次选 python
    await writeFile(join(dir, 'python3'), 'not executable\n', 'utf-8')
    await writeFile(join(dir, 'python'), '#!/bin/sh\n', 'utf-8')
    await chmod(join(dir, 'python'), 0o755)
    expect(resolvePythonCommand({ PATH: dir })).toBe('python')
  })
})

describe('resolveGraphifyCommand（跨平台可执行体解析）', () => {
  it('GRAPHIFY_BIN 指向 .js → 经 node 调用', async () => {
    const resolved = await resolveGraphifyCommand({ GRAPHIFY_BIN: 'C:/x/graphify-cli.js' })
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.prefixArgs).toEqual(['C:/x/graphify-cli.js'])
    expect(resolved.shell).toBe(false)
  })

  it.skipIf(!isWin)('GRAPHIFY_BIN 指向 .cmd → shell 执行', async () => {
    const resolved = await resolveGraphifyCommand({ GRAPHIFY_BIN: 'C:/x/graphify.cmd' })
    expect(resolved.shell).toBe(true)
  })

  it('PATH 找不到 → graphify_missing（跳过 vendored 子工程）', async () => {
    await expect(
      resolveGraphifyCommand({ PATH: '', PRISM_SKIP_VENDORED: '1' }),
    ).rejects.toMatchObject({ code: 'graphify_missing' })
  })

  it('默认优先仓库内 vendored Python 子工程（<python> -m graphify + PYTHONPATH）', async () => {
    const resolved = await resolveGraphifyCommand({ PATH: '' })
    expect(resolved.shell).toBe(false)
    // 解释器名随平台：Windows `python`、POSIX `python3`（见 resolvePythonCommand）
    expect(resolved.command).toBe(isWin ? 'python' : 'python3')
    expect(resolved.prefixArgs).toEqual(['-m', 'graphify'])
    expect(resolved.env?.['PYTHONPATH']).toContain(join('3rd', 'graphify'))
  })

  it.skipIf(!isWin)('PATH 上找到 graphify.cmd → shell 执行', async () => {
    const dir = await tempDir()
    const cmd = join(dir, 'graphify.cmd')
    await writeFile(cmd, '@echo off\r\necho FAKE-GRAPHIFY\r\n', 'utf-8')
    const resolved = await resolveGraphifyCommand({ PATH: dir, PRISM_SKIP_VENDORED: '1' })
    expect(resolved.shell).toBe(true)
    // resolver 会剥掉 \\?\ 扩展前缀再返回
    expect(resolved.command.toLowerCase()).toBe(cmd.replace(/^\\\\\?\\/, '').toLowerCase())
    await rm(dir, { recursive: true, force: true })
  })
})

describe('runGraphify（错误映射 + 参数钉死）', () => {
  it('成功：stdout 捕获', async () => {
    const dir = await tempDir()
    const script = join(dir, 'fake.mjs')
    await writeFile(script, "process.stdout.write('FAKE-OK extract');\n", 'utf-8')
    const result = await runGraphify(['extract', 'X'], { env: { GRAPHIFY_BIN: script }, timeoutMs: 5000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('FAKE-OK extract')
    await rm(dir, { recursive: true, force: true })
  })

  it('非零退出 → graphify_failed', async () => {
    const dir = await tempDir()
    const script = join(dir, 'fail.mjs')
    await writeFile(script, "process.stderr.write('boom'); process.exit(3);\n", 'utf-8')
    await expect(
      runGraphify(['extract'], { env: { GRAPHIFY_BIN: script }, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'graphify_failed' })
    await rm(dir, { recursive: true, force: true })
  })

  it('超时 → graphify_timeout', async () => {
    const dir = await tempDir()
    const script = join(dir, 'slow.mjs')
    await writeFile(script, 'setTimeout(() => {}, 60_000);\n', 'utf-8')
    await expect(
      runGraphify(['extract'], { env: { GRAPHIFY_BIN: script }, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'graphify_timeout' })
    await rm(dir, { recursive: true, force: true })
  })

  it('buildGraphArgs 钉死零 LLM 参数：全量必带 --code-only（红线 R2 / 裁决 D1）', () => {
    const args = buildGraphArgs('K:/proj')
    expect(args).toEqual([
      ['K:/proj', '--code-only'],
      ['cluster-only', 'K:/proj', '--no-label'],
    ])
    // 显式护栏：全量路径缺 --code-only 时，树内有 doc/paper/image 会让 graphify 调 LLM
    // （无 key 则直接 exit 1）——见 3rd/graphify/graphify/cli.py:3550-3563 / 3642。
    expect(args.flat()).toContain('--code-only')
    // 旧 npm fork 的 flag 不得出现在任何一步（Python 版无 --no-description）
    expect(args.flat()).not.toContain('--no-description')
  })

  it('buildGraphArgs 增量：`update` 不带 --code-only（它只认 --force/--no-cluster），本就零 LLM', () => {
    const args = buildGraphArgs('K:/proj', 'incremental')
    expect(args).toEqual([
      ['update', 'K:/proj'],
      ['cluster-only', 'K:/proj', '--no-label'],
    ])
    expect(args.flat()).not.toContain('--code-only')
  })

  it('formatCommand 对含空格参数加引号', () => {
    const line = formatCommand({ command: 'graphify.cmd', prefixArgs: [], shell: true }, ['extract', 'C:/My Proj'])
    expect(line).toBe('graphify.cmd extract "C:/My Proj"')
  })
})

describe('图谱查询封装（假 CLI 注入，验证参数与结构化解析）', () => {
  const NL = String.fromCharCode(10)

  /** 写一个按 argv 输出预置文本的假 CLI（.mjs，经 node 调用）。 */
  async function fakeCli(outputs: Record<string, string>): Promise<string> {
    const dir = await tempDir()
    const script = join(dir, 'fake.mjs')
    const table = JSON.stringify(outputs)
    await writeFile(
      script,
      `const outs = ${table};${NL}` +
        `const key = process.argv.slice(2).find((a) => a in outs) ?? '';${NL}` +
        `process.stdout.write(outs[key] ?? '');${NL}`,
      'utf-8',
    )
    return script
  }

  it('defaultGraphPath 指向 graphify-out/graph.json', () => {
    expect(defaultGraphPath('K:/proj')).toBe(join('K:/proj', 'graphify-out', 'graph.json'))
  })

  it('path：解析 hops 与 chain；无路径 → found:false', async () => {
    const cli = await fakeCli({
      path: ['Shortest path (2 hops):', '  run() --calls [EXTRACTED]--> handler() --calls [EXTRACTED]--> validate()', ''].join(NL),
    })
    const result = await graphPath('K:/proj', 'run()', 'validate()', { env: { GRAPHIFY_BIN: cli } })
    expect(result.found).toBe(true)
    expect(result.hops).toBe(2)
    expect(result.chain).toEqual(['run()', 'handler()', 'validate()'])

    const none = await fakeCli({ path: "No node matching 'ghost' found." })
    const missing = await graphPath('K:/proj', 'a', 'ghost', { env: { GRAPHIFY_BIN: none } })
    expect(missing.found).toBe(false)
  })

  it('explain：解析字段与连接方向', async () => {
    const cli = await fakeCli({
      explain: [
        'Node: handler()',
        '  ID:        src_app_handler',
        '  Source:    src/app.py L1',
        '  Type:      code',
        '  Community: Community 0',
        '  Degree:    4',
        '',
        'Connections (4):',
        '  <-- util.py [imports] [EXTRACTED] src/util.py:L1',
        '  --> validate() [calls] [EXTRACTED] src/app.py:L2',
        '',
      ].join(NL),
    })
    const result = await graphExplain('K:/proj', 'handler()', { env: { GRAPHIFY_BIN: cli } })
    expect(result.id).toBe('src_app_handler')
    expect(result.type).toBe('code')
    expect(result.community).toBe('Community 0')
    expect(result.degree).toBe(4)
    expect(result.connections).toEqual([
      { direction: 'in', label: 'util.py', relation: 'imports', location: 'src/util.py:L1' },
      { direction: 'out', label: 'validate()', relation: 'calls', location: 'src/app.py:L2' },
    ])
  })

  it('affected：解析 depth 与节点列表', async () => {
    const cli = await fakeCli({
      affected: [
        'Affected nodes for validate()',
        'Relations: calls, imports',
        'Depth: 2',
        '- handler() [calls] src/app.py:L2',
        '- util.py [imports] src/util.py:L1',
        '',
      ].join(NL),
    })
    const result = await graphAffected('K:/proj', 'validate()', { env: { GRAPHIFY_BIN: cli } })
    expect(result.depth).toBe(2)
    expect(result.nodes).toEqual([
      { label: 'handler()', relation: 'calls', location: 'src/app.py:L2' },
      { label: 'util.py', relation: 'imports', location: 'src/util.py:L1' },
    ])
  })

  it('god-nodes：解析 JSON 输出；非法 JSON 仅返回 raw', async () => {
    const cli = await fakeCli({ 'god-nodes': '[{"id":"a","label":"handler()","degree":4}]' })
    const result = await graphGodNodes('K:/proj', { env: { GRAPHIFY_BIN: cli } })
    expect(result.nodes).toEqual([{ id: 'a', label: 'handler()', degree: 4 }])

    const broken = await fakeCli({ 'god-nodes': 'not json' })
    const bad = await graphGodNodes('K:/proj', { env: { GRAPHIFY_BIN: broken } })
    expect(bad.nodes).toEqual([])
    expect(bad.raw).toContain('not json')
  })

  it('summary：读 graph.json 汇总节点/边/社区；缺失 → exists:false', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'graphify-out'), { recursive: true })
    await writeFile(
      join(dir, 'graphify-out', 'graph.json'),
      JSON.stringify({
        nodes: [{ id: 'a', community: 0 }, { id: 'b', community: 1 }, { id: 'c', community: 0 }],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
      }),
      'utf-8',
    )
    const summary = await graphSummary(dir)
    expect(summary).toMatchObject({ exists: true, nodes: 3, edges: 2, communities: 2 })

    const empty = await graphSummary(join(dir, 'nope'))
    expect(empty.exists).toBe(false)
  })

  it('export：obsidian 产出目录 + 文件清单（假 CLI 预置产物）', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'graphify-out', 'obsidian'), { recursive: true })
    await writeFile(join(dir, 'graphify-out', 'obsidian', 'a.md'), '# a', 'utf-8')
    await writeFile(join(dir, 'graphify-out', 'obsidian', 'graph.canvas'), '{}', 'utf-8')
    const cli = await fakeCli({ export: 'Obsidian vault: 2 notes' })
    const result = await graphExport(dir, 'obsidian', { env: { GRAPHIFY_BIN: cli } })
    expect(result.format).toBe('obsidian')
    expect(result.output).toContain('obsidian')
    expect(result.files).toEqual(['a.md', 'graph.canvas'])
  })

  it('export：svg 定位到 graph.svg；未知格式 → bad_request', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'graphify-out'), { recursive: true })
    const cli = await fakeCli({ export: 'graph.svg written' })
    const svg = await graphExport(dir, 'svg', { env: { GRAPHIFY_BIN: cli } })
    expect(svg.output.endsWith('graph.svg')).toBe(true)

    await expect(graphExport(dir, 'bogus' as never)).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('GRAPHIFY_EXPORT_FORMATS 覆盖七种导出', () => {
    expect([...GRAPHIFY_EXPORT_FORMATS]).toEqual([
      'obsidian', 'wiki', 'svg', 'graphml', 'neo4j', 'falkordb', 'callflow-html',
    ])
  })
})
