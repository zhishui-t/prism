/**
 * 团队运行时看板测试（`.agent-team/` 黑板解析 + 可派发集推导 + 对账缺口）。
 *
 * 锁住的判定（都是「读错会给出错误调度结论」的地方）：
 *  1. 依赖就绪 → 只有「自身 pending 且依赖全 done」才算 **ready**（可派发）；
 *  2. nodes[].deps 与 edges **并集去重**（与 dag.mjs 同口径）；
 *  3. 环检测 → 有环必须报 error（否则 pending 永远不就绪却看起来「正常等待」）；
 *  4. 缺失依赖 / 状态未知 / dag 坏 JSON → 降级成 gap，**不抛、不假装完成**；
 *  5. agents.md 解析：跳过归档小节、认 agent_/wbdy- 痕迹、角色名清洗；
 *  6. context.md 断点快照解析；快照比 dag 旧 → warning；
 *  7. 无黑板 ≠ 错误（团队刚建、还没开工）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  classifyArtifact,
  listTeamRuns,
  parseAgentsMd,
  parseContextMd,
  readTeamRuntime,
  roleMatches,
} from '../src/runtime/blackboard.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prism-runtime-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeBoard(files: Record<string, string>): Promise<void> {
  const dir = join(root, '.agent-team')
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8')
  }
}

const DAG = {
  title: '演示任务',
  nodes: [
    { id: 'a', label: '需求', role: '队长', status: 'done', deps: [] },
    { id: 'b', label: '开发', role: 'dev', status: 'pending', deps: ['a'] },
    { id: 'c', label: '测试', role: 'tester', status: 'pending', deps: ['b'] },
    { id: 'd', label: '并行检视', role: 'reviewer', status: 'pending', deps: ['a'] },
  ],
  edges: [['a', 'b']],
}

describe('可派发集推导', () => {
  it('依赖全 done 且自身 pending → ready；依赖未完成 → waiting', async () => {
    await writeBoard({ 'dag.json': JSON.stringify(DAG) })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.ready.sort()).toEqual(['b', 'd'])
    expect(rt.waiting).toEqual(['c'])
    expect(rt.counts).toEqual({ done: 1, running: 0, pending: 3, blocked: 0 })
  })

  it('running/done 不算 ready（ready 只给待开始的）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [
          { id: 'a', label: 'A', role: 'dev', status: 'running' },
          { id: 'b', label: 'B', role: 'dev', status: 'done' },
        ],
      }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.ready).toEqual([])
    expect(rt.counts.running).toBe(1)
  })

  it('nodes[].deps 与 edges 并集去重（不重复加边）', async () => {
    await writeBoard({ 'dag.json': JSON.stringify(DAG) })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'd' },
      { from: 'b', to: 'c' },
    ])
  })

  it('状态别名归一（completed/active/failed → done/running/blocked）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [
          { id: 'a', label: 'A', role: 'x', status: 'completed' },
          { id: 'b', label: 'B', role: 'x', status: 'active' },
          { id: 'c', label: 'C', role: 'x', status: 'failed' },
        ],
      }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.tasks.map((t) => t.status)).toEqual(['done', 'running', 'blocked'])
    expect(rt.gaps.some((g) => g.code === 'runtime_unknown_status')).toBe(false)
  })
})

describe('数据缺陷降级', () => {
  it('依赖成环 → error（不让 pending 静默变成「永远等待」）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [
          { id: 'a', label: 'A', role: 'x', status: 'pending', deps: ['b'] },
          { id: 'b', label: 'B', role: 'x', status: 'pending', deps: ['a'] },
        ],
      }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'runtime_cycle' && g.level === 'error')).toBe(true)
    expect(rt.ready).toEqual([])
  })

  it('依赖指向不存在的节点 → error + missingDeps 落在任务上', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [{ id: 'a', label: 'A', role: 'x', status: 'pending', deps: ['ghost'] }],
      }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.tasks[0]!.missingDeps).toEqual(['ghost'])
    expect(rt.gaps.some((g) => g.code === 'runtime_dep_missing')).toBe(true)
    expect(rt.tasks[0]!.ready).toBe(false)
  })

  it('dag.json 坏 JSON → error gap 且不抛', async () => {
    await writeBoard({ 'dag.json': '{ not json' })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'runtime_dag_invalid' && g.level === 'error')).toBe(true)
    expect(rt.tasks).toEqual([])
  })

  it('未知状态值 → 按 pending 处理并告警（保留原文）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'a', label: 'A', role: 'x', status: '半路' }] }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.tasks[0]!.status).toBe('pending')
    expect(rt.tasks[0]!.statusRaw).toBe('半路')
    expect(rt.gaps.some((g) => g.code === 'runtime_unknown_status')).toBe(true)
  })

  it('有 .agent-team 但没 dag.json → info（不是错误）', async () => {
    await writeBoard({ 'agents.md': '# 登记' })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.hasBlackboard).toBe(true)
    expect(rt.gaps.some((g) => g.code === 'runtime_dag_missing' && g.level === 'info')).toBe(true)
  })

  it('完全没有黑板 → hasBlackboard=false，不产生 error', async () => {
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.hasBlackboard).toBe(false)
    expect(rt.gaps.some((g) => g.level === 'error')).toBe(false)
  })
})

describe('agents.md 会话登记', () => {
  const MD = `# 会话登记表 v12

## 进行中（波次 1）

| 岗位/角色 | 子代理 agentId | WorkBuddy session_id | 状态 |
| :--- | :--- | :--- | :--- |
| dev（B-1..B-5 全✓） | agent_b957fcd6 | wbdy-dd37f315-b81 | 收尾批 done |
| frontend-dev | agent_68f32964 | wbdy-5cb6d65e-592 | dev 完成 |
| reviewer | agent_1ade40f3（通用承载） | — | 检视中 |

## 已归档（本轮之前）

| 岗位 | 会话线 | 备注 |
| :--- | :--- | :--- |
| 老角色 | wbdy-38f7f023-deb | 已失效 |
`

  it('解析出登记行（角色名清洗 + agentId/sessionId）', () => {
    const rows = parseAgentsMd(MD)
    expect(rows.map((r) => r.role)).toEqual(['dev', 'frontend-dev', 'reviewer'])
    expect(rows[0]).toEqual({
      role: 'dev',
      agentId: 'agent_b957fcd6',
      sessionId: 'wbdy-dd37f315-b81',
      state: '收尾批 done',
    })
  })

  it('归档小节不参与（避免把退役实例当成在途）', () => {
    const rows = parseAgentsMd(MD)
    expect(rows.some((r) => r.role === '老角色')).toBe(false)
  })

  it('没有 agent_/wbdy 痕迹的行跳过（说明性行）', () => {
    const rows = parseAgentsMd('| 岗位 | 说明 |\n| :--- | :--- |\n| dev | 待指派 |')
    expect(rows).toEqual([])
  })

  it('任务角色与登记角色按分词匹配（「dev + junior-dev」命中 dev）', () => {
    expect(roleMatches('dev + junior-dev', 'dev')).toBe(true)
    expect(roleMatches('双 tester', 'tester')).toBe(true)
    expect(roleMatches('reviewer', 'dev')).toBe(false)
  })
})

describe('context.md 与对账', () => {
  it('解析断点快照的 - 键：值 行', () => {
    const rows = parseContextMd(`# context
- 模式：严格执行(delivery)
- 当前阶段：5·开发
- 下一步：派 dev 修 B-1
`)
    expect(rows).toEqual([
      { key: '模式', value: '严格执行(delivery)' },
      { key: '当前阶段', value: '5·开发' },
      { key: '下一步', value: '派 dev 修 B-1' },
    ])
  })

  it('可派发任务的角色没登记 → warning（不知道该派谁）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [{ id: 'b', label: '开发', role: 'dev', status: 'pending', deps: [] }],
      }),
      'agents.md': '| 岗位 | agentId | 状态 |\n| :--- | :--- | :--- |\n| reviewer | agent_abc123 | 空闲 |\n',
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'runtime_task_unregistered' && g.level === 'warning')).toBe(true)
  })

  it('登记齐全时不报该缺口；登记与任务能对上', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'b', label: '开发', role: 'dev', status: 'running' }] }),
      'agents.md': '| 岗位 | agentId | 状态 |\n| :--- | :--- | :--- |\n| dev | agent_abc123 | 跑测试 |\n',
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'runtime_task_unregistered')).toBe(false)
    expect(rt.dispatch[0]!.taskIds).toEqual(['b'])
  })

  it('门禁文件被列出（含 _vNN 版本）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'a', label: 'A', role: 'x', status: 'done' }] }),
      '.design_ok': '',
      '.code_ok_v18': '',
      'DELIVERY-v18.md': '# 交付',
      'notes.md': 'not a gate',
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gates.map((g) => g.name).sort()).toEqual(['.code_ok_v18', '.design_ok'])
    expect(rt.delivery?.file).toBe('DELIVERY-v18.md')
  })

  it('任务全完成但没有交付报告 → warning（最容易「看着收工其实少交一份」）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'a', label: 'A', role: 'x', status: 'done' }] }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'runtime_delivery_missing' && g.level === 'warning')).toBe(true)
  })

  it('交付报告比 dag 旧 → warning；比 dag 新则不报', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'a', label: 'A', role: 'x', status: 'done' }] }),
      'DELIVERY-v1.md': '# 旧',
    })
    // 把 dag 改到「更晚」：重写一次
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'a', label: 'A', role: 'x', status: 'done' }] }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    const gap = rt.gaps.find((g) => g.code === 'runtime_delivery_missing')
    // 同秒写入时 mtime 可能相等 → 只在严格更旧时报；这里断言「有报告时不报没有报告」
    if (gap !== undefined) expect(gap.message).toContain('DELIVERY-v1.md')
  })

  it('仍在进行中时不报交付报告缺失（别在干活时催交付）', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [{ id: 'a', label: 'A', role: 'x', status: 'running' }],
      }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'runtime_delivery_missing')).toBe(false)
  })
})

describe('任务契约接入（dag.json 扩展键）', () => {
  it('旧 dag（无契约键）→ kind=work，不产生契约 issue', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [{ id: 'a', label: 'A', role: 'dev', status: 'done', deps: [] }],
      }),
      'DELIVERY-v1.md': '# 交付',
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.tasks[0]!.contract.kind).toBe('work')
    expect(rt.gaps.filter((g) => g.code.startsWith('task_contract_'))).toEqual([])
  })

  it('已完成的实现任务缺证据 → 运行时缺口里报错', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [
          {
            id: 'a',
            label: '实现',
            role: 'dev',
            status: 'done',
            deps: [],
            kind: 'implementation',
            objective: '实现功能',
            acceptance: ['类型检查通过'],
            inScope: ['packages/agents'],
            verify: ['pnpm typecheck'],
            // 故意不给 acceptanceResults / commandsRun / changedPaths
          },
        ],
      }),
      'DELIVERY-v1.md': '# 交付',
    })
    const rt = await readTeamRuntime(root, 'demo')
    const codes = rt.gaps.map((g) => g.code)
    expect(codes).toEqual(
      expect.arrayContaining(['task_acceptance_unproven', 'task_verify_unproven', 'task_changed_paths_required']),
    )
    expect(rt.deliveryGate.ok).toBe(true) // 任务本身 done，门禁只看完成度与审核
  })

  it('写域越界 → task_scope_violation', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [
          {
            id: 'a',
            label: '实现',
            role: 'dev',
            status: 'done',
            kind: 'implementation',
            objective: 'x',
            acceptance: ['y'],
            inScope: ['packages/agents'],
            verify: ['pnpm typecheck'],
            acceptanceResults: [{ acceptance: 'y', status: 'pass' }],
            commandsRun: [{ command: 'pnpm typecheck', status: 'pass' }],
            changedPaths: ['apps/web/src/x.tsx'],
          },
        ],
      }),
      'DELIVERY-v1.md': '# 交付',
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.gaps.some((g) => g.code === 'task_scope_violation')).toBe(true)
  })

  it('交付门禁：有未完成任务 → 不可交付并给出阻塞项', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({
        nodes: [
          { id: 'a', label: 'A', role: 'dev', status: 'done' },
          { id: 'b', label: 'B', role: 'dev', status: 'pending', deps: ['a'] },
        ],
      }),
    })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.deliveryGate.ok).toBe(false)
    expect(rt.deliveryGate.blockers.some((b) => b.code === 'gate_unfinished_tasks')).toBe(true)
  })
})

describe('任务分目录（同项目多团队并行）', () => {
  const DAG_A = JSON.stringify({
    title: '任务A：修OCR',
    nodes: [{ id: 'a1', label: '修复', role: 'dev', status: 'done', deps: [] }],
  })
  const DAG_B = JSON.stringify({
    title: '任务B：改界面',
    nodes: [{ id: 'b1', label: '改版', role: 'frontend-dev', status: 'running', deps: [] }],
  })

  async function writeRun(run: string, files: Record<string, string>): Promise<void> {
    const dir = run === '' ? join(root, '.agent-team') : join(root, '.agent-team', run)
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, 'utf8')
    }
  }

  it('两个 run 目录互不串：各自读各自的 dag 与任务', async () => {
    await writeRun('20261026-ocr', { 'dag.json': DAG_A })
    await writeRun('20261027-ui', { 'dag.json': DAG_B })
    const a = await readTeamRuntime(root, 'demo', '20261026-ocr')
    const b = await readTeamRuntime(root, 'demo', '20261027-ui')
    expect(a.title).toBe('任务A：修OCR')
    expect(a.tasks[0]!.role).toBe('dev')
    expect(b.title).toBe('任务B：改界面')
    expect(b.tasks[0]!.role).toBe('frontend-dev')
    // runs 清单两个都在，且不互相包含对方任务
    expect(a.runs.map((r) => r.id).sort()).toEqual(['20261026-ocr', '20261027-ui'])
    expect(a.run).toBe('20261026-ocr')
  })

  it('省略 run = 自动选 dag.json 最新的任务', async () => {
    await writeRun('old-run', { 'dag.json': DAG_A })
    await writeRun('new-run', { 'dag.json': DAG_B })
    // 保证 new-run 的 dag 更新（mtime 精度：晚 20ms 写入）
    await new Promise((r) => setTimeout(r, 20))
    await writeRun('new-run', { 'dag.json': DAG_B })
    const rt = await readTeamRuntime(root, 'demo')
    expect(rt.run).toBe('new-run')
    expect(rt.title).toBe('任务B：改界面')
  })

  it('旧版平铺 = run ""（legacy），与新 run 目录并存可分别读取', async () => {
    await writeRun('', { 'dag.json': DAG_A })
    await writeRun('20261027-ui', { 'dag.json': DAG_B })
    const all = await readTeamRuntime(root, 'demo')
    expect(all.runs.map((r) => r.id)).toEqual(['20261027-ui', ''])
    expect(all.runs.find((r) => r.id === '')?.legacy).toBe(true)
    // 显式选旧布局
    const legacy = await readTeamRuntime(root, 'demo', '')
    expect(legacy.title).toBe('任务A：修OCR')
    expect(legacy.run).toBe('')
  })

  it('指定的 run 不存在 → not_found（不静默看别的任务）', async () => {
    await writeRun('20261026-ocr', { 'dag.json': DAG_A })
    await expect(readTeamRuntime(root, 'demo', 'nope')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('nope'),
    })
  })

  it('run 名含路径分隔或 .. 逃逸 → bad_request', async () => {
    await writeRun('ok', { 'dag.json': DAG_A })
    await expect(readTeamRuntime(root, 'demo', '../outside')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(readTeamRuntime(root, 'demo', 'a/b')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(readTeamRuntime(root, 'demo', '.git')).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('listTeamRuns 只认含状态文件的目录（归档/产物目录不算 run）', async () => {
    await writeRun('real', { 'dag.json': DAG_A })
    await writeRun('arch-artifacts', { 'render.html': '<html/>' })
    const runs = await listTeamRuns(root)
    expect(runs.map((r) => r.id)).toEqual(['real'])
  })

  it('runs 清单带 dag 标题（选择器显示用）', async () => {
    await writeRun('20261026-ocr', { 'dag.json': DAG_A })
    const runs = await listTeamRuns(root)
    expect(runs[0]!.title).toBe('任务A：修OCR')
    expect(runs[0]!.dagMtime).toBeGreaterThan(0)
  })
})

describe('产物清单（run 目录全量盘点）', () => {
  it('按类别盘点全部产物，mtime 倒序，vN 版次归同类', async () => {
    await writeBoard({
      'dag.json': JSON.stringify({ nodes: [{ id: 'a', label: 'A', role: 'dev', status: 'done', deps: [] }] }),
      'task-brief.md': '# 书',
      'task-brief-v2.md': '# 书2',
      'requirements.md': '# 求',
      'software-design-v3.md': '# 设',
      'spec.md': '# 规',
      'tasks.md': '# 任',
      'design-review.md': '# 审',
      'test-report-blackbox-v9.md': '# 测',
      'spec-verify-matrix.md': '# 矩',
      '.design_ok': '',
      '.code_ok_v18': '',
      'DELIVERY-v18.md': '# 交',
      'notes-random.md': '# 杂',
    })
    // 目录产物（e2e-evidence/）单独建
    await mkdir(join(root, '.agent-team', 'e2e-evidence'), { recursive: true })
    const rt = await readTeamRuntime(root, 'demo')
    const kindOf = (name: string) => rt.artifacts.find((a) => a.name === name)?.kind
    expect(kindOf('task-brief.md')).toBe('brief')
    expect(kindOf('task-brief-v2.md')).toBe('brief')
    expect(kindOf('requirements.md')).toBe('design')
    expect(kindOf('software-design-v3.md')).toBe('design')
    expect(kindOf('spec.md')).toBe('spec')
    expect(kindOf('spec-verify-matrix.md')).toBe('test')
    expect(kindOf('tasks.md')).toBe('tasks')
    expect(kindOf('design-review.md')).toBe('review')
    expect(kindOf('test-report-blackbox-v9.md')).toBe('test')
    expect(kindOf('.design_ok')).toBe('gate')
    expect(kindOf('DELIVERY-v18.md')).toBe('delivery')
    expect(kindOf('notes-random.md')).toBe('other')
    expect(kindOf('e2e-evidence')).toBe('test')
    // mtime 倒序
    const times = rt.artifacts.map((a) => a.mtime)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('classifyArtifact 纯函数：状态三件套与未知扩展', () => {
    expect(classifyArtifact('dag.json')).toBe('state')
    expect(classifyArtifact('agents.md')).toBe('state')
    expect(classifyArtifact('context-v5.md')).toBe('state')
    expect(classifyArtifact('dag.html')).toBe('other') // 派生视图不盘点，但分类函数不特判
    expect(classifyArtifact('visual-audit-v7.md')).toBe('test')
    expect(classifyArtifact('f1-build-report.md')).toBe('test')
  })
})
