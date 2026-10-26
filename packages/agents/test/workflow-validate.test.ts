/**
 * 工作流单元校验测试（workflow-asset.md §4 错误码全表）。
 * 强弱口径：binds 显式声明 → error；承接列编排语义词 → warning 不阻断。
 */
import { describe, expect, it } from 'vitest'

import type { RoleDefinition, WorkflowDefinition } from '../src/types.js'
import { STEP_OWNER_WORDS, validateWorkflow, validateWorkflowUniqueness } from '../src/workflow/validate.js'

function wf(patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflow: 'demo-flow',
    name: '演示',
    level: 'role',
    binds: ['dev'],
    skills: [],
    steps: [
      { order: 1, step: '装载', owner: ['dev'], skills: '', input: '', output: '', done: '', reflow: '' },
    ],
    body: '',
    ...patch,
  }
}

const ROLES: RoleDefinition[] = [
  { name: 'dev', description: '', skills: [], knowledge: { layers: ['global'] }, principle: '', body: '' },
]

const codes = (issues: Array<{ code: string }>): string[] => issues.map((i) => i.code)

describe('validateWorkflow', () => {
  it('合法单元 → ok', () => {
    const r = validateWorkflow(wf(), { roles: ROLES })
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })

  it('结构缺失 → error：id/name/steps/level', () => {
    expect(codes(validateWorkflow(wf({ workflow: '' })).issues)).toContain('workflow_id_required')
    expect(codes(validateWorkflow(wf({ name: '' })).issues)).toContain('workflow_name_required')
    expect(codes(validateWorkflow(wf({ steps: [] })).issues)).toContain('workflow_steps_empty')
    expect(
      validateWorkflow(wf({ level: 'x' as WorkflowDefinition['level'] }), { roles: undefined }).issues.some(
        (i) => i.code === 'workflow_level_invalid',
      ),
    ).toBe(true)
  })

  it('步骤序号重复 → error（「#」列需从 1 连续编号）', () => {
    const r = validateWorkflow(
      wf({
        steps: [
          { order: 1, step: 'a', owner: ['dev'], skills: '', input: '', output: '', done: '', reflow: '' },
          { order: 1, step: 'b', owner: ['dev'], skills: '', input: '', output: '', done: '', reflow: '' },
        ],
      }),
      { roles: ROLES },
    )
    expect(r.ok).toBe(false)
    expect(codes(r.issues)).toContain('workflow_step_order_duplicate')
  })

  it('id 非 kebab → warning 不阻断', () => {
    const r = validateWorkflow(wf({ workflow: 'Demo_Flow' }))
    expect(r.ok).toBe(true)
    expect(codes(r.issues)).toContain('workflow_id_not_kebab')
  })

  it('binds 角色不存在 → error；比对小写不敏感', () => {
    const r = validateWorkflow(wf({ binds: ['Ghost'] }), { roles: ROLES })
    expect(r.ok).toBe(false)
    expect(codes(r.issues)).toContain('workflow_binds_role_unknown')
    // 小写命中 = 已知角色
    expect(validateWorkflow(wf({ binds: ['DEV'] }), { roles: ROLES }).ok).toBe(true)
  })

  it('角色级 binds 为空 → warning（多承接者建议 team 级）；团队级空 binds 不报', () => {
    expect(codes(validateWorkflow(wf({ binds: [] })).issues)).toContain('workflow_binds_empty')
    expect(codes(validateWorkflow(wf({ level: 'team', binds: [] })).issues)).not.toContain('workflow_binds_empty')
  })

  it('承接列：角色命中不报；编排豁免词不报；陌生词 warning', () => {
    const steps: WorkflowDefinition['steps'] = [
      { order: 1, step: 'a', owner: ['dev'], skills: '', input: '', output: '', done: '', reflow: '' },
      { order: 2, step: 'b', owner: [STEP_OWNER_WORDS[0]!], skills: '', input: '', output: '', done: '', reflow: '' },
      { order: 3, step: 'c', owner: ['神秘人'], skills: '', input: '', output: '', done: '', reflow: '' },
    ]
    const r = validateWorkflow(wf({ steps }), { roles: ROLES })
    expect(r.ok).toBe(true)
    const owners = r.issues.filter((i) => i.code === 'workflow_step_owner_unknown')
    expect(owners).toHaveLength(1)
    expect(owners[0]!.message).toContain('神秘人')
  })

  it('skills 未安装 → warning（提供名单时）', () => {
    const r = validateWorkflow(wf({ skills: ['nope'] }), { knownSkills: ['spec-guard'] })
    expect(r.ok).toBe(true)
    expect(codes(r.issues)).toContain('workflow_skill_unknown')
  })

  it('库内 id 重复 → error', () => {
    const r = validateWorkflowUniqueness([wf(), wf({ name: '另一份同 id' })])
    expect(r.ok).toBe(false)
    expect(codes(r.issues)).toContain('workflow_duplicate')
  })
})
