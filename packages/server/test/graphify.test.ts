import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildGraphArgs,
  defaultGraphPath,
  formatCommand,
  graphAffected,
  graphExplain,
  graphGodNodes,
  graphPath,
  graphSummary,
  resolveGraphifyCommand,
  runGraphify,
} from '../src/graph/graphify.js'

const isWin = process.platform === 'win32'

async function tempDir(): Promise<string> {
  return await mkdir(join(tmpdir(), `prism-graphify-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
    recursive: true,
  })
}

describe('resolveGraphifyCommand（Windows .cmd 处理）', () => {
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

  it('默认优先仓库内 vendored Python 子工程（python -m graphify + PYTHONPATH）', async () => {
    const resolved = await resolveGraphifyCommand({ PATH: '' })
    expect(resolved.shell).toBe(false)
    expect(resolved.command).toBe('python')
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

  it('buildGraphArgs 钉死零 token 参数（Python 版两步，禁 LLM 富化）', () => {
    const args = buildGraphArgs('K:/proj')
    expect(args).toEqual([
      ['K:/proj'],
      ['cluster-only', 'K:/proj', '--no-label'],
    ])
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
})
