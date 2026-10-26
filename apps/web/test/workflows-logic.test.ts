/**
 * 工作流相关纯逻辑测试：api-workflow 归一 + 角色表单 workflows 字段往返。
 * 纯值变换，不碰 DOM（node 环境，无 pragma）。
 */
import { describe, expect, it } from 'vitest'

import { normalizeWorkflows } from '../src/api-workflow.ts'
import { buildRoleInput, seedRoleFormValues } from '../src/pages/roles-form-logic.ts'
import type { RoleDefinition } from '../src/api-team.ts'

describe('normalizeWorkflows（三形状兼容）', () => {
  const wf = [{ workflow: 'a', name: 'A', level: 'role', binds: [], skills: [], steps: [], body: '' }]
  it('v1 形状 { workflows, workflows_dir }', () => {
    expect(normalizeWorkflows({ workflows: wf, workflows_dir: '/x' })).toEqual({ workflows: wf, workflowsDir: '/x' })
  })
  it('旧 camel { workflows, workflowsDir }', () => {
    expect(normalizeWorkflows({ workflows: wf, workflowsDir: '/x' })).toEqual({ workflows: wf, workflowsDir: '/x' })
  })
  it('裸数组（历史形状）→ workflowsDir 空串', () => {
    expect(normalizeWorkflows(wf)).toEqual({ workflows: wf, workflowsDir: '' })
  })
})

describe('角色表单 workflows 字段往返', () => {
  const base: RoleDefinition = {
    name: 'dev-1',
    description: 'x',
    skills: [],
    knowledge: { layers: ['global'] },
    principle: '',
    body: '正文',
    workflows: ['dev-red-green', 'sec-audit'],
  }
  it('seed：从定义播种（含 workflows）', () => {
    const seed = seedRoleFormValues('/roles', base)
    expect(seed.workflows).toEqual(['dev-red-green', 'sec-audit'])
  })
  it('seed：无 workflows 字段 → 空数组（不炸）', () => {
    const { workflows, ...bare } = base
    void workflows
    expect(seedRoleFormValues('/roles', bare as RoleDefinition).workflows).toEqual([])
  })
  it('edit：恒发数组（含空数组 = 清空挂载）；new：不发键', () => {
    const seed = seedRoleFormValues('/roles', base)
    const edit = buildRoleInput('edit', { ...seed, workflows: [] })
    expect(edit.workflows).toEqual([])
    const created = buildRoleInput('new', { ...seed, name: 'fresh' })
    expect(created.workflows).toBeUndefined()
  })
})
