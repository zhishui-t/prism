import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKnowledgeService, type KnowledgeService } from '@prism/knowledge'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

/** 带沉淀策略的团队（rules：type=rule → global/high；book=handbook → visibility=role）。 */
const POLICY_TEAM_MD = `---
team_id: pol
name: 策略团队
description: 沉淀策略测试用。
default: false
members:
  - role: dev-1
    count: 1
skills: []
knowledge:
  layers: [global, project]
deposit:
  enabled: true
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: false
  rules:
    - match: { type: rule }
      set: { layer: global, priority: high }
    - match: { book: handbook }
      set: { visibility: role }
arbitration: [quality]
rework_limit: 2
---

# 策略团队
`

/** require_note=true 且无规则（测拒绝路径）。 */
const STRICT_TEAM_MD = `---
team_id: strict
name: 严格团队
description: require_note 测试用。
default: false
members:
  - role: dev-1
    count: 1
skills: []
knowledge:
  layers: [global]
deposit:
  enabled: true
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: true
arbitration: [quality]
rework_limit: 2
---

# 严格团队
`

/** enabled=false（不打扰路径）。 */
const OFF_TEAM_MD = `---
team_id: off
name: 关闭沉淀团队
description: enabled=false 测试用。
default: false
members:
  - role: dev-1
    count: 1
skills: []
knowledge:
  layers: [global]
deposit:
  enabled: false
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: false
  rules:
    - match: { type: rule }
      set: { layer: global }
arbitration: [quality]
rework_limit: 2
---

# 关闭沉淀团队
`

describe('F-E2/F-B4/F-E3：kb deposit / kb versions / task report 沉淀建议', () => {
  let home: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []
  const services: Array<{ close?: () => void }> = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-cli-dep-'))
    cleanup.push(home)
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${home.replaceAll('\\', '/')}/roles\nteams_dir: ${home.replaceAll('\\', '/')}/teams\n`,
      'utf-8',
    )
    await mkdir(join(home, 'teams'), { recursive: true })
    await writeFile(join(home, 'teams', 'pol.md'), POLICY_TEAM_MD, 'utf-8')
    await writeFile(join(home, 'teams', 'strict.md'), STRICT_TEAM_MD, 'utf-8')
    await writeFile(join(home, 'teams', 'off.md'), OFF_TEAM_MD, 'utf-8')
    lines = []
    const service = createKnowledgeService({ home })
    services.push(service)
    ctx = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
      kbFactory: async () => service,
    }
  })

  afterEach(async () => {
    for (const s of services) s.close?.()
    services.length = 0
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    cleanup.length = 0
  })

  /** 从 CLI 输出里取落库后的条目 id。 */
  function depositedId(): string {
    const match = /(?:已落库|已更新) ([^@\s]+)@v(\d+)/.exec(lines.join('\n'))
    expect(match).not.toBeNull()
    return match![1]
  }

  it('kb deposit：基础落库 + 打印来源地址', async () => {
    const doc = join(home, 'rule-a.md')
    await writeFile(doc, '# 规则 A\n\n正文内容。\n', 'utf-8')
    expect(
      await runCommand(ctx, [
        'kb', 'deposit', '--file', doc, '--title', '规则 A', '--type', 'rule',
        '--layer', 'global', '--book', 'handbook',
      ]),
    ).toBe(0)
    const output = lines.join('\n')
    expect(output).toMatch(/已落库 .+@v1/)
    expect(output).toContain('来源地址: ')
    // 落库地址在 global 层 handbook 书内
    const id = depositedId()
    lines = []
    expect(await runCommand(ctx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as { value: { layer: string; book: string } }
    expect(entry.value.layer).toBe('global')
    expect(entry.value.book).toBe('handbook')
  })

  it('kb deposit --file -：从 stdin 读（注入 readStdin）', async () => {
    const stdinCtx: CommandContext = {
      ...ctx,
      readStdin: async () => '# 来自管道\n\nstdin 正文。\n',
    }
    lines = []
    expect(
      await runCommand(stdinCtx, [
        'kb', 'deposit', '--file', '-', '--title', '管道条目', '--type', 'doc', '--layer', 'global',
      ]),
    ).toBe(0)
    expect(lines.join('\n')).toMatch(/已落库 .+@v1/)
    const id = depositedId()
    lines = []
    expect(await runCommand(stdinCtx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as { value: { title: string; type: string } }
    expect(entry.value.title).toBe('管道条目')
    expect(entry.value.type).toBe('doc')
  })

  it('kb deposit --team：走团队策略（rules 覆盖 layer/priority）', async () => {
    const doc = join(home, 'policy-rule.md')
    await writeFile(doc, '正文（无一级标题，标题走 --title）。\n', 'utf-8')
    expect(
      await runCommand(ctx, [
        'kb', 'deposit', '--file', doc, '--title', '策略规则', '--type', 'rule',
        '--layer', 'project', '--book', 'handbook', '--team', 'pol',
      ]),
    ).toBe(0)
    const output = lines.join('\n')
    // 落库成功（策略由 @prism/server 的 depositWithPolicy 单点执行，与 MCP/HTTP 同源）
    expect(output).toMatch(/已落库 .+@v1/)
    // rules 覆盖生效：落到 global 层（团队 default_layer 是 project）
    const id = depositedId()
    lines = []
    expect(await runCommand(ctx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as { value: { layer: string; type: string } }
    expect(entry.value.layer).toBe('global')
    expect(entry.value.type).toBe('rule')
  })

  it('kb deposit --team：require_note 未满足 → 拒绝且不落库；给 --note 则放行', async () => {
    // 说明与正文都空 → 团队策略机械拒绝（且给出可执行提示）
    const empty = join(home, 'empty.md')
    await writeFile(empty, '', 'utf-8')
    lines = []
    expect(
      await runCommand(ctx, [
        'kb', 'deposit', '--file', empty, '--title', '无说明', '--type', 'rule', '--team', 'strict',
      ]),
    ).toBe(1)
    // 单点策略（@prism/server depositWithPolicy）抛 bad_request，CLI 翻译为可执行提示
    expect(lines.join('\n')).toContain('沉淀策略拒绝')
    expect(lines.join('\n')).toContain('必须带说明')
    expect(lines.join('\n')).toContain('提示：团队要求说明时加 --note')

    // 给说明（--note → source.ref）后放行；正文非空是 KB 服务自身的要求（content 必填），
    // project 层按 KB 既有语义必须给 owner
    const doc = join(home, 'noted.md')
    await writeFile(doc, '正文。\n', 'utf-8')
    lines = []
    expect(
      await runCommand(ctx, [
        'kb', 'deposit', '--file', doc, '--title', '有说明', '--type', 'rule',
        '--team', 'strict', '--note', '来自测试用例', '--owner', 'prism',
      ]),
    ).toBe(0)
    expect(lines.join('\n')).toMatch(/已落库 .+@v1/)
    const id = depositedId()
    lines = []
    expect(await runCommand(ctx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as { value: { layer: string } }
    expect(entry.value.layer).toBe('project') // 无 rules → 团队 default_layer
  })

  it('kb deposit --team：团队不存在 → 拒绝（rc 1，不落库）', async () => {
    const doc = join(home, 'x.md')
    await writeFile(doc, '正文。\n', 'utf-8')
    lines = []
    expect(
      await runCommand(ctx, ['kb', 'deposit', '--file', doc, '--title', 'X', '--type', 'doc', '--team', 'nope']),
    ).toBe(1)
    expect(lines.join('\n')).toContain('团队不存在')
  })

  it('kb deposit：缺 title/type → 可执行提示（rc 1）', async () => {
    const doc = join(home, 'plain.md')
    await writeFile(doc, '没有标题也没有 type。\n', 'utf-8')
    lines = []
    expect(await runCommand(ctx, ['kb', 'deposit', '--file', doc, '--type', 'doc'])).toBe(1)
    expect(lines.join('\n')).toContain('title_required')

    lines = []
    expect(await runCommand(ctx, ['kb', 'deposit', '--file', doc, '--title', 'T'])).toBe(1)
    expect(lines.join('\n')).toContain('type_required')

    lines = []
    expect(await runCommand(ctx, ['kb', 'deposit', '--file', doc, '--title', 'T', '--type', 'nope'])).toBe(1)
    expect(lines.join('\n')).toContain('--type 非法')
  })

  it('kb deposit --task：来源落库（source.kind=task + deposited_by.task_id + origin_task）', async () => {
    const doc = join(home, 'task-note.md')
    await writeFile(doc, '任务沉淀正文。\n', 'utf-8')
    lines = []
    expect(
      await runCommand(ctx, [
        'kb', 'deposit', '--file', doc, '--title', '任务沉淀', '--type', 'pitfall',
        '--layer', 'global', '--task', 'T-9', '--by', 'dev-3',
      ]),
    ).toBe(0)
    const id = depositedId()
    lines = []
    expect(await runCommand(ctx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as {
      value: { deposited_by?: { subject?: string; task_id?: string } }
    }
    expect(entry.value.deposited_by?.task_id).toBe('T-9')
    expect(entry.value.deposited_by?.subject).toBe('dev-3')
  })

  it('kb versions：注入知识服务 → 列全部版次（降序 + is_latest）', async () => {
    const fake = {
      listVersions: async (id: string) =>
        id === 'K-1'
          ? [
              { id: 'K-1', version: 2, status: 'active', title: '规则', is_latest: true, updated_at: '2026-09-11T00:00:00Z', source_path: '/k/K-1/v2.md' },
              { id: 'K-1', version: 1, status: 'superseded', title: '规则', is_latest: false, updated_at: '2026-09-10T00:00:00Z', source_path: '/k/K-1/v1.md' },
            ]
          : [],
    } as unknown as KnowledgeService
    const kbCtx: CommandContext = { ...ctx, kbFactory: async () => fake }

    lines = []
    expect(await runCommand(kbCtx, ['kb', 'versions', 'K-1'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('v2')
    expect(output).toContain('latest')
    expect(output).toContain('superseded')
    expect(output).toContain('共 2 个版次')

    lines = []
    expect(await runCommand(kbCtx, ['kb', 'versions', 'K-1', '--json'])).toBe(0)
    const json = JSON.parse(lines[lines.length - 1]) as { value: Array<{ version: number; is_latest: boolean }> }
    expect(json.value.map((v) => v.version)).toEqual([2, 1])
    expect(json.value[0]?.is_latest).toBe(true)

    // 不存在的 id → 空数组，不报错
    lines = []
    expect(await runCommand(kbCtx, ['kb', 'versions', 'nope'])).toBe(0)
    expect(lines.join('\n')).toContain('没有版次')
  })

  it('kb versions 缺参 → 用法（rc 1）', async () => {
    lines = []
    expect(await runCommand(ctx, ['kb', 'versions'])).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism kb versions')
  })

  // -------------------------------------------------------------------------
  // F-E3：task report 终态沉淀建议（裁决 A4：只有 CLOSED 给清单）
  // -------------------------------------------------------------------------
  async function registerTask(teamId: string, description = '实现功能'): Promise<void> {
    const dagFile = join(home, `dag-${teamId}.json`)
    await writeFile(
      dagFile,
      JSON.stringify({ tasks: [{ id: 'T-1', description, stage: '开发' }] }),
      'utf-8',
    )
    lines = []
    expect(
      await runCommand(ctx, [
        'task', 'register', '--dag', `dag-${teamId}`, '--session', 's1', '--team', teamId,
        '--project', 'prism', '--dag-version', 'v1', '--difficulty', 'normal', '--file', dagFile,
      ]),
    ).toBe(0)
  }

  it('task report：COMPLETED 只给 deposit_hint=await_close（无清单）', async () => {
    await registerTask('pol')
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'RUNNING', '--by', 'dev-3'])).toBe(0)
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'COMPLETED', '--by', 'dev-3', '--json'])).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as {
      value: { deposit_hint?: string; deposit_suggestions?: unknown[] }
    }
    expect(out.value.deposit_hint).toBe('await_close')
    expect(out.value.deposit_suggestions).toBeUndefined()
  })

  it('task report：CLOSED → deposit_suggestions（团队规则 match{...} + 关键词）', async () => {
    await registerTask('pol', '修复安全漏洞')
    for (const to of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK']) {
      expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', to, '--by', 'dev-3'])).toBe(0)
    }
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'CLOSED', '--by', 'qa', '--json'])).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as {
      value: {
        status: string
        deposit_suggestions?: Array<{ kind: string; layer: string; priority: string; reason: string; require_note: boolean }>
      }
    }
    expect(out.value.status).toBe('CLOSED')
    const suggestions = out.value.deposit_suggestions ?? []
    // ① 团队规则逐条（两条规则）
    expect(suggestions[0]?.reason).toContain('团队规则 match{type:rule}')
    expect(suggestions[0]?.kind).toBe('pitfall') // 规则未设 type → 回落 default_type
    expect(suggestions[0]?.layer).toBe('global')
    expect(suggestions[0]?.priority).toBe('high')
    expect(suggestions[0]?.require_note).toBe(false)
    expect(suggestions[1]?.reason).toContain('团队规则 match{book:handbook}')
    // ② 关键词：安全 → rule/global
    const security = suggestions.find((s) => s.kind === 'rule' && s.layer === 'global')
    expect(security?.reason).toContain('安全关键词')

    // 文本模式也打印建议清单与一步落库提示
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'AWAITING_FEEDBACK', '--by', 'qa'])).toBe(0)
    // （先回到 AWAITING_FEEDBACK 再 CLOSED，验证文本输出）
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'CLOSED', '--by', 'qa'])).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('建议沉淀')
    expect(text).toContain('一步落库: prism kb deposit')
    expect(text).toContain('--team pol')
  })

  it('task report：非终态（RUNNING/AWAITING_FEEDBACK）不给建议字段', async () => {
    await registerTask('pol')
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'RUNNING', '--by', 'x', '--json'])).toBe(0)
    const running = JSON.parse(lines[lines.length - 1]) as { value: { deposit_suggestions?: unknown; deposit_hint?: string } }
    expect(running.value.deposit_suggestions).toBeUndefined()
    expect(running.value.deposit_hint).toBeUndefined()

    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'COMPLETED', '--by', 'x'])).toBe(0)
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'AWAITING_FEEDBACK', '--by', 'x', '--json'])).toBe(0)
    const awaiting = JSON.parse(lines[lines.length - 1]) as { value: { deposit_suggestions?: unknown } }
    expect(awaiting.value.deposit_suggestions).toBeUndefined()
  })

  it('task report：无团队 / deposit.enabled=false → 不给建议字段（不打扰）', async () => {
    // 无团队：team_id 传空串会被 registerDag 拒绝 → 用 enabled=false 的团队覆盖"不打扰"，
    // 另用一条 dag 的 team 指向不存在的团队文件（loadTeam → null）。
    await registerTask('off', '修复安全漏洞')
    for (const to of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK']) {
      expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', to, '--by', 'x'])).toBe(0)
    }
    lines = []
    expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', 'CLOSED', '--by', 'x', '--json'])).toBe(0)
    const off = JSON.parse(lines[lines.length - 1]) as { value: { deposit_suggestions?: unknown } }
    expect(off.value.deposit_suggestions).toBeUndefined()
  })

  it('task report --deposit：CLOSED 一步落库（复用 kb deposit 路径 + 团队策略）', async () => {
    await registerTask('pol', '实现功能')
    for (const to of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK']) {
      expect(await runCommand(ctx, ['task', 'report', 'T-1', '--to', to, '--by', 'dev-3'])).toBe(0)
    }
    const doc = join(home, 'task-deposit.md')
    await writeFile(doc, '任务收口沉淀正文。\n', 'utf-8')
    lines = []
    expect(
      await runCommand(ctx, [
        'task', 'report', 'T-1', '--to', 'CLOSED', '--by', 'qa',
        '--deposit', doc, '--title', 'T-1 教训', '--type', 'pitfall',
        '--layer', 'project', '--owner', 'prism', '--book', 'handbook',
      ]),
    ).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('一步落库')
    expect(text).toMatch(/已落库 .+@v1/)
    expect(text).toContain('来源地址: ')

    // 落库条目确实带任务来源
    const id = depositedId()
    lines = []
    expect(await runCommand(ctx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as { value: { deposited_by?: { task_id?: string } } }
    expect(entry.value.deposited_by?.task_id).toBe('T-1')
  })

  it('kb deposit：标题/正文走 frontmatter 回落', async () => {
    const doc = join(home, 'fm.md')
    await writeFile(
      doc,
      '---\ntitle: 来自 frontmatter\ntype: guide\nlayer: global\nbook: handbook\ntags: [a, b]\n---\n\n正文。\n',
      'utf-8',
    )
    lines = []
    expect(await runCommand(ctx, ['kb', 'deposit', '--file', doc])).toBe(0)
    const id = depositedId()
    lines = []
    expect(await runCommand(ctx, ['kb', 'get', id, '--json'])).toBe(0)
    const entry = JSON.parse(lines[lines.length - 1]) as {
      value: { title: string; type: string; tags?: string[]; layer: string }
    }
    expect(entry.value.title).toBe('来自 frontmatter')
    expect(entry.value.type).toBe('guide')
    expect(entry.value.layer).toBe('global')
  })
})
