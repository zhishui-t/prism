import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseRoleMarkdown, parseTeamMarkdown, renderZcodeRole } from '@prism/agents'

import {
  CORE_DEV_TEAM_MD,
  defaultHarnessRoot,
  loadRole,
  loadRoles,
  loadTeam,
  loadTeams,
  validateRole,
  validateTeam,
  harnessPaths,
} from '../src/roles/index.js'

/**
 * 返工单 B4 后本文件只测 server 侧 glue（wiring）：
 * 解析/校验/渲染/启用的行为细节由 @prism/agents 自己的测试覆盖。
 * 2026-09-11：装配/导入相关 glue（installTeam / installRoles / renderPrismRole / parseRoleFile）已随命令一并移除。
 */

const ZCODE_ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量，绝不扩大战场。"
color: blue
model: "custom:builtin%3Abigmodel:GLM"
thoughtLevel: max
---

# 开发 1

## 核心契约
**交付可运行的增量，绝不扩大战场。**

## 职责
- 写代码
`

const SKILLED_ROLE_MD = `---
name: skilled
description: "带技能白名单的角色：用于 knownSkills 校验。"
skills:
  - taint_trace
knowledge:
  layers: [global]
---

# 技能角色

## 核心契约
**没证据不放行。**
`

const BROKEN_ROLE_MD = `---
name: broken
description: 坏角色：缺原则。
skills: []
knowledge:
  layers: [global]
---

# 坏角色
`

async function seedRoles(home: string, files: Record<string, string>): Promise<string> {
  const rolesDir = join(home, 'roles')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(rolesDir, name), { recursive: true })
    await writeFile(join(rolesDir, name, 'AGENTS.md'), content, 'utf-8')
  }
  return rolesDir
}

describe('glue：loadRoles/loadRole（agents registry + issues 挂载，P9）', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-glue-roles-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('目录式加载：issues 挂载（valid → 仅 skills_empty warning；broken → principle_missing error）、按名排序、坏文件跳过', async () => {
    const rolesDir = await seedRoles(tmp, { 'dev-1': ZCODE_ROLE_MD, broken: BROKEN_ROLE_MD })
    await mkdir(join(rolesDir, 'no-fm'), { recursive: true })
    await writeFile(join(rolesDir, 'no-fm', 'AGENTS.md'), '# 无 frontmatter\n', 'utf-8')

    const roles = await loadRoles(rolesDir)
    expect(roles.map((r) => r.name)).toEqual(['broken', 'dev-1'])
    const broken = roles.find((r) => r.name === 'broken')
    expect(broken?.issues?.some((i) => i.code === 'principle_missing' && i.level === 'error')).toBe(true)
    expect(broken?.issues?.some((i) => i.code === 'skills_empty' && i.level === 'warning')).toBe(true)
    const dev1 = roles.find((r) => r.name === 'dev-1')
    expect(dev1?.issues).toEqual([{ level: 'warning', code: 'skills_empty', message: expect.any(String) }])
    expect(dev1?.knowledge.layers).toEqual(['global', 'project']) // agents 导入缺省
  })

  it('扁平文件形态（agents registry 双形态）+ knownSkills 追加 skill_unknown', async () => {
    const dir = join(tmp, 'flat')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'skilled.md'), SKILLED_ROLE_MD, 'utf-8')
    const roles = await loadRoles(dir, { knownSkills: ['prism'] })
    expect(roles.map((r) => r.name)).toEqual(['skilled'])
    expect(roles[0].issues?.some((i) => i.code === 'skill_unknown')).toBe(true)
  })

  it('loadRole：单个加载带 issues；不存在 → null；目录缺失 → []', async () => {
    const rolesDir = await seedRoles(tmp, { skilled: SKILLED_ROLE_MD })
    const one = await loadRole(rolesDir, 'skilled', { knownSkills: ['prism'] })
    expect(one?.name).toBe('skilled')
    expect(one?.principle).toContain('没证据不放行')
    expect(one?.issues?.some((i) => i.code === 'skill_unknown')).toBe(true)
    expect(await loadRole(rolesDir, 'nope')).toBeNull()
    expect(await loadRoles(join(tmp, 'missing'))).toEqual([])
  })
})

describe('glue：loadTeams/loadTeam（agents 解析 + validateTeam 补 issues）', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-glue-teams-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('团队 issues：成员缺角色 → member_role_unknown error；knownSkills → skill_unknown warning；workflow 解析（实例记号语义）', async () => {
    const rolesDir = await seedRoles(tmp, { 'dev-1': ZCODE_ROLE_MD })
    const teamsDir = join(tmp, 'teams')
    await mkdir(join(teamsDir, 'core-dev'), { recursive: true })
    await writeFile(join(teamsDir, 'core-dev', 'AGENTS.md'), CORE_DEV_TEAM_MD, 'utf-8')

    const teams = await loadTeams(teamsDir, { rolesDir })
    expect(teams.map((t) => t.team_id)).toEqual(['core-dev'])
    expect(teams[0].issues?.some((i) => i.code === 'member_role_unknown' && i.level === 'error')).toBe(true)
    // agents parseRoleCell：` + ` 分隔多角色（`/` 才是实例记号）；队长 豁免
    expect(teams[0].workflow[0].roles).toEqual(['dev-1', 'dev-2'])
    expect(teams[0].workflow[1].roles).toEqual(['队长'])
    expect(teams[0].workflow[3].mode).toBe('parallel')
    expect(teams[0].deposit.rules).toEqual([
      { match: { type: 'rule' }, set: { layer: 'global', priority: 'high' } },
      { match: { tags: ['security'] }, set: { layer: 'global', priority: 'high' } },
    ])

    // 成员收敛为 dev-1（在角色库）；workflow 仍引用其余成员 → 除 workflow_role_unknown 外全为 warning
    // （装了 prism，code_review 未装 → skill_unknown warning）
    const library = await loadRoles(rolesDir)
    const miniRaw = CORE_DEV_TEAM_MD.replace(
      /members:\n(?: {2}- role: .*\n {4}count: \d+\n)+/,
      'members:\n  - role: dev-1\n    count: 1\n',
    )
    await mkdir(join(teamsDir, 'mini'), { recursive: true })
    await writeFile(join(teamsDir, 'mini', 'AGENTS.md'), miniRaw, 'utf-8')
    const okTeam = await loadTeam(teamsDir, 'mini', { roles: library, knownSkills: ['prism'] })
    expect(okTeam?.issues?.every((i) => i.level === 'warning' || i.code === 'workflow_role_unknown')).toBe(true)
    expect(
      okTeam?.issues?.some((i) => i.level === 'warning' && i.code === 'skill_unknown' && i.message.includes('code_review')),
    ).toBe(true)
    expect(await loadTeam(teamsDir, 'nope')).toBeNull()
  })

  it('validateTeam/validateRole 透传（agents）', () => {
    const team = parseTeamMarkdown(CORE_DEV_TEAM_MD)
    const role = parseRoleMarkdown(ZCODE_ROLE_MD)
    expect(validateRole(role, { dirname: 'dev-1' }).ok).toBe(true)
    expect(validateTeam({ ...team, members: [] }, { roles: [role] }).issues.some((i) => i.code === 'members_empty')).toBe(true)
  })
})

describe('glue：renderZcodeRole / harnessPaths', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-glue-misc-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('renderZcodeRole（agents）：引号约束 + 末尾 marker + 叠加节', () => {
    const role = parseRoleMarkdown(ZCODE_ROLE_MD)
    const content = renderZcodeRole(role, { model: 'custom:x' })
    expect(content).toContain('name: dev-1\n')
    expect(content).toContain(`description: "${role.description}"`)
    expect(content).toContain('model: "custom:x"')
    expect(content).toContain('thoughtLevel: max')
    expect(content).toContain('generated by prism (role: dev-1)')
    expect(content.trimEnd().endsWith('-->')).toBe(true)
  })

  it('harnessPaths：路径约定取自 agents 适配器 + config 附加；defaultHarnessRoot 可被 PRISM_HARNESS_ROOT 覆盖', () => {
    const zcode = harnessPaths(join(tmp, 'zcode'))
    expect(zcode.agentsDir).toBe(join(tmp, 'zcode', 'agents'))
    expect(zcode.teamDir).toBe(join(tmp, 'zcode', 'teams'))
    expect(zcode.skillsDir).toBe(join(tmp, 'zcode', 'skills'))
    expect(zcode.configFile).toBe(join(tmp, 'zcode', 'cli', 'config.json'))
    expect(typeof defaultHarnessRoot()).toBe('string')
  })
})
