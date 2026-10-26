/**
 * 任务契约测试：机械可判定部分（借鉴 dsh-agent-teams 的质量门禁，只取校验不取调度）。
 *
 * 锁住的判定（每一条都是「叙述说完成、证据不成立」的拦截点）：
 *  1. 结构化任务缺 objective / acceptance / inScope / verify → error；
 *  2. **完成必须有证据**：每条 acceptance 有结果且 pass、每条 verify 有命令记录且 pass；
 *  3. review 只能以 `verdict=pass` 结案；打回必须留 finding；
 *  4. 写域审计：绝对路径 / `..` 逃逸 / 默认排除（.git/.env/密钥）/ outOfScope / 越界 → 违规；
 *  5. 并行可派发任务写域重叠 → warning（会互相踩文件）；
 *  6. 交付门禁：未完成 / 失败 / 审核非 pass → 阻止交付。
 *  7. 旧 dag（无契约键）照样能读，不误报。
 */
import { describe, expect, it } from 'vitest'

import {
  auditChangedPaths,
  detectReadyScopeCollisions,
  evaluateDeliveryGate,
  isDefaultExcluded,
  normalizeRelPath,
  pathInScope,
  validateTaskContract,
  type ContractTaskView,
  type TaskContract,
} from '../src/runtime/task-contract.js'

function contract(patch: Partial<TaskContract> = {}): TaskContract {
  return {
    kind: 'implementation',
    objective: '实现编辑域',
    acceptance: ['类型检查通过'],
    inScope: ['packages/agents'],
    outOfScope: [],
    verify: ['pnpm typecheck'],
    reviewedTaskId: '',
    verdict: '',
    findings: [],
    acceptanceResults: [],
    commandsRun: [],
    changedPaths: [],
    attempt: 1,
    ...patch,
  }
}

function task(patch: Partial<ContractTaskView> & { contract?: Partial<TaskContract> } = {}): ContractTaskView {
  return {
    id: 't1',
    label: '任务一',
    status: 'pending',
    ready: false,
    contract: contract(patch.contract),
    ...patch,
    ...(patch.contract !== undefined ? { contract: contract(patch.contract) } : {}),
  }
}

const codes = (issues: Array<{ code: string }>): string[] => issues.map((i) => i.code)

describe('路径归一与写域匹配', () => {
  it('normalizeRelPath：接受项目内相对路径，拒绝绝对/逃逸', () => {
    expect(normalizeRelPath('packages/agents/src/a.ts')).toBe('packages/agents/src/a.ts')
    expect(normalizeRelPath('./packages//agents/a.ts')).toBe('packages/agents/a.ts')
    expect(normalizeRelPath('packages\\agents\\a.ts')).toBe('packages/agents/a.ts')
    expect(normalizeRelPath('/etc/passwd')).toBeNull()
    expect(normalizeRelPath('C:/Windows/x')).toBeNull()
    expect(normalizeRelPath('~/x')).toBeNull()
    expect(normalizeRelPath('../outside.ts')).toBeNull()
    expect(normalizeRelPath('packages/../../x')).toBeNull()
    expect(normalizeRelPath('')).toBeNull()
  })

  it('pathInScope：整文件相等或目录前缀，不误匹配同前缀的兄弟目录', () => {
    expect(pathInScope('packages/agents/a.ts', 'packages/agents')).toBe(true)
    expect(pathInScope('packages/agents/a.ts', 'packages/agents/a.ts')).toBe(true)
    expect(pathInScope('packages/agents-old/a.ts', 'packages/agents')).toBe(false)
    expect(pathInScope('apps/web/a.tsx', 'packages/agents')).toBe(false)
  })

  it('默认硬排除：.git / node_modules / .env / 密钥', () => {
    expect(isDefaultExcluded('.git/config')).toBe(true)
    expect(isDefaultExcluded('node_modules/x/y.js')).toBe(true)
    expect(isDefaultExcluded('.env')).toBe(true)
    expect(isDefaultExcluded('apps/web/.env.local')).toBe(true)
    expect(isDefaultExcluded('certs/server.pem')).toBe(true)
    expect(isDefaultExcluded('packages/agents/src/a.ts')).toBe(false)
  })

  it('审计：越界 / 被排除 / 未声明写域 都算违规；合规路径通过', () => {
    const ok = auditChangedPaths(['packages/agents/src/a.ts'], ['packages/agents'], [])
    expect(ok.ok).toBe(true)

    const out = auditChangedPaths(
      ['packages/agents/src/a.ts', 'apps/web/x.tsx', '.git/config', '/abs/path'],
      ['packages/agents'],
      [],
    )
    expect(out.ok).toBe(false)
    expect(out.violations.map((v) => v.path)).toEqual(
      expect.arrayContaining(['apps/web/x.tsx', '.git/config', '/abs/path']),
    )

    // outOfScope 优先于 inScope
    const both = auditChangedPaths(['packages/agents/secret.ts'], ['packages/agents'], ['packages/agents/secret.ts'])
    expect(both.ok).toBe(false)

    // 未声明写域 → 无法判定 → 违规（不是放行）
    const noScope = auditChangedPaths(['packages/agents/a.ts'], [], [])
    expect(noScope.ok).toBe(false)
  })
})

describe('结构化契约的必填项', () => {
  it('implementation 缺 objective / acceptance / inScope / verify → 四条 error', () => {
    const issues = validateTaskContract(
      task({ contract: { objective: '', acceptance: [], inScope: [], verify: [] } }),
    )
    expect(codes(issues)).toEqual(
      expect.arrayContaining([
        'task_contract_objective_required',
        'task_contract_acceptance_required',
        'task_contract_scope_required',
        'task_contract_verify_required',
      ]),
    )
    expect(issues.every((i) => i.level === 'error')).toBe(true)
  })

  it('review 缺 reviewedTaskId → error', () => {
    const issues = validateTaskContract(task({ contract: { kind: 'review', reviewedTaskId: '' } }))
    expect(codes(issues)).toContain('task_review_target_required')
  })

  it('work（旧形态）不强制结构化字段', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: { kind: 'work', objective: '', acceptance: [], inScope: [], verify: [] },
      }),
    )
    expect(issues).toEqual([])
  })
})

describe('完成必须有证据（核心：拦住「叙述说完成」）', () => {
  it('已完成但验收项没有结果 → error', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: {
          acceptance: ['类型检查通过', '单测全绿'],
          acceptanceResults: [{ acceptance: '类型检查通过', status: 'pass' }],
        },
      }),
    )
    expect(codes(issues)).toContain('task_acceptance_unproven')
  })

  it('已完成但验收项未 pass → error', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: {
          acceptance: ['类型检查通过'],
          acceptanceResults: [{ acceptance: '类型检查通过', status: 'fail' }],
        },
      }),
    )
    expect(codes(issues)).toContain('task_acceptance_failed')
  })

  it('已完成但验证命令没跑 / 未通过 → error', () => {
    const missing = validateTaskContract(
      task({
        status: 'done',
        contract: {
          acceptanceResults: [{ acceptance: '类型检查通过', status: 'pass' }],
          commandsRun: [],
        },
      }),
    )
    expect(codes(missing)).toContain('task_verify_unproven')

    const failed = validateTaskContract(
      task({
        status: 'done',
        contract: {
          acceptanceResults: [{ acceptance: '类型检查通过', status: 'pass' }],
          commandsRun: [{ command: 'pnpm typecheck', status: 'fail' }],
        },
      }),
    )
    expect(codes(failed)).toContain('task_verify_failed')
  })

  it('已完成但没有 changedPaths → error（改了什么说不清）', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: {
          acceptanceResults: [{ acceptance: '类型检查通过', status: 'pass' }],
          commandsRun: [{ command: 'pnpm typecheck', status: 'pass' }],
          changedPaths: [],
        },
      }),
    )
    expect(codes(issues)).toContain('task_changed_paths_required')
  })

  it('证据齐全且写域合规 → 无 issue', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: {
          acceptanceResults: [{ acceptance: '类型检查通过', status: 'pass', evidence: 'exit 0' }],
          commandsRun: [{ command: 'pnpm typecheck', status: 'pass' }],
          changedPaths: ['packages/agents/src/runtime/task-contract.ts'],
        },
      }),
    )
    expect(issues).toEqual([])
  })

  it('未完成的任务不查完成证据（不能提前催）', () => {
    const issues = validateTaskContract(task({ status: 'pending', contract: { acceptanceResults: [], commandsRun: [] } }))
    expect(codes(issues)).not.toContain('task_acceptance_unproven')
  })
})

describe('review 结论口径', () => {
  it('review 以 completed 结案但 verdict≠pass → error', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: { kind: 'review', reviewedTaskId: 't0', verdict: 'needs_revision', findings: [{ severity: 'high', text: 'x' }] },
      }),
    )
    expect(codes(issues)).toContain('task_review_not_pass')
  })

  it('打回但没有任何 finding → error', () => {
    const issues = validateTaskContract(
      task({
        status: 'failed',
        contract: { kind: 'review', reviewedTaskId: 't0', verdict: 'reject', findings: [] },
      }),
    )
    expect(codes(issues)).toContain('task_review_findings_required')
  })

  it('review pass 且有 finding（非阻塞项）→ 合法', () => {
    const issues = validateTaskContract(
      task({
        status: 'done',
        contract: { kind: 'review', reviewedTaskId: 't0', verdict: 'pass', findings: [{ severity: 'nit', text: '措辞' }] },
      }),
    )
    expect(issues.filter((i) => i.level === 'error')).toEqual([])
  })
})

describe('并行写域冲突', () => {
  it('两个可派发任务写域重叠 → warning', () => {
    const issues = detectReadyScopeCollisions([
      task({ id: 'a', label: 'A', ready: true, contract: { inScope: ['packages/agents'] } }),
      task({ id: 'b', label: 'B', ready: true, contract: { inScope: ['packages/agents/src'] } }),
    ])
    expect(codes(issues)).toContain('task_scope_collision')
    expect(issues[0]!.level).toBe('warning')
  })

  it('写域不重叠 / 有一个未就绪 → 不报', () => {
    expect(
      detectReadyScopeCollisions([
        task({ id: 'a', ready: true, contract: { inScope: ['packages/agents'] } }),
        task({ id: 'b', ready: true, contract: { inScope: ['packages/server'] } }),
      ]),
    ).toEqual([])
    expect(
      detectReadyScopeCollisions([
        task({ id: 'a', ready: true, contract: { inScope: ['packages/agents'] } }),
        task({ id: 'b', ready: false, contract: { inScope: ['packages/agents'] } }),
      ]),
    ).toEqual([])
  })
})

describe('交付门禁', () => {
  it('全部完成且审核 pass → 通过', () => {
    const gate = evaluateDeliveryGate([
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'done', contract: { kind: 'review', reviewedTaskId: 'a', verdict: 'pass' } }),
    ])
    expect(gate.ok).toBe(true)
    expect(gate.blockers).toEqual([])
  })

  it('有未完成任务 / 失败任务 / 审核非 pass → 阻止交付', () => {
    const gate = evaluateDeliveryGate([
      task({ id: 'a', status: 'pending' }),
      task({ id: 'b', status: 'failed' }),
      task({ id: 'c', status: 'done', contract: { kind: 'review', reviewedTaskId: 'a', verdict: 'reject' } }),
    ])
    expect(gate.ok).toBe(false)
    expect(codes(gate.blockers)).toEqual(
      expect.arrayContaining(['gate_unfinished_tasks', 'gate_failed_tasks', 'gate_review_not_pass']),
    )
  })
})
