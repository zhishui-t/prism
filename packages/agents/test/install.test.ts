import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { InstallError, initRole } from '../src/install.js'
import { parseRoleMarkdown } from '../src/role/parse.js'
import { parseTeamMarkdown } from '../src/team/parse.js'
import { activateTeam } from '../src/team/activate.js'

/**
 * 2026-09-11：本文件原测「装配」（`installRoles` / `installTeamDefinitions` / `migrateTeams`
 * 的 §5 冲突策略与渲染往返）。这些函数连同 `role import` / `role install` / `team install`
 * 三个命令已移除——角色/团队就直接住在宿主目录，没有第二份副本可供装配。
 * 现只保留 `initRole`（模板初始化）与 `activateTeam`（installed 判定）两处。
 */

function makeTmp(): string {
  return join(tmpdir(), `prism-agents-install-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

const ROLE_RAW = [
  '---',
  'name: "dev-1"',
  'description: "一般开发：常规功能开发。适用于：功能编码。不适用于：架构攻关（升级 super-dev）。"',
  'color: cyan',
  'model: "custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash"',
  'thoughtLevel: max',
  'injectAgentsMd: true',
  '---',
  '',
  '# 一般开发 dev-1',
  '',
  '## 核心契约',
  '**交付可运行的增量，绝不扩大战场。**',
].join('\n')

const TEAM_RAW = [
  '---',
  'team_id: core-dev',
  'name: 核心研发团队',
  'description: 负责设计、开发、测试与质量收口。',
  'default: false',
  'members:',
  '  - role: dev-1',
  '    count: 2',
  '  - role: tester',
  '    count: 1',
  'skills: []',
  'knowledge:',
  '  layers: [global, project]',
  'deposit:',
  '  enabled: true',
  '  default_layer: project',
  '  default_type: pitfall',
  '  priority: medium',
  '  require_note: true',
  'arbitration: [safety, quality]',
  'rework_limit: 2',
  '---',
  '',
  '## 工作流',
].join('\n')

describe('activateTeam（installed = roles_dir 中存在角色文件）', () => {
  it('roles_dir 即宿主目录：文件存在 → native；缺失 → fallback + definition + hint', async () => {
    const rolesDir = makeTmp()
    mkdirSync(rolesDir, { recursive: true })
    const team = parseTeamMarkdown(TEAM_RAW)
    // dev-1 扁平住在 roles_dir；tester 目录式住在 roles_dir
    writeFileSync(join(rolesDir, 'dev-1.md'), ROLE_RAW)
    mkdirSync(join(rolesDir, 'tester'))
    writeFileSync(
      join(rolesDir, 'tester', 'AGENTS.md'),
      ROLE_RAW.replace('name: "dev-1"', 'name: "tester"').replace('# 一般开发 dev-1', '# 测试 tester'),
    )

    const activation = await activateTeam(team, { rolesDir })
    expect(activation.team_id).toBe('core-dev')
    expect(activation.rework_limit).toBe(2)
    expect(activation.workflow).toEqual(team.workflow)

    const dev1 = activation.members.find((m) => m.role === 'dev-1')
    expect(dev1?.installed).toBe(true)
    expect(dev1?.dispatch).toBe('native')

    const tester = activation.members.find((m) => m.role === 'tester')
    expect(tester?.installed).toBe(true) // 目录式形态也算"存在"
    expect(tester?.dispatch).toBe('native')
    expect(tester?.definition?.name).toBe('tester')

    // 角色受管目录里不存在的成员：fallback + hint
    const ghostTeam = parseTeamMarkdown(TEAM_RAW.replace('- role: tester', '- role: ghost'))
    const ghostActivation = await activateTeam(ghostTeam, { rolesDir })
    const ghost = ghostActivation.members.find((m) => m.role === 'ghost')
    expect(ghost?.installed).toBe(false)
    expect(ghost?.dispatch).toBe('fallback')
    expect(ghost?.definition).toBeUndefined()
    expect(ghost?.hint).toContain('不存在')
  })
})

describe('initRole（模板初始化）', () => {
  it('模板 → roles_dir/<name>.md，{{name}} 替换；frontmatter 合法可解析', async () => {
    const rolesDir = makeTmp()
    const result = await initRole({ name: 'code-reviewer', rolesDir })
    const path = join(rolesDir, 'code-reviewer.md')
    expect(result.written).toEqual([path])
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('name: "code-reviewer"')
    expect(content).not.toContain('{{name}}')
    const role = parseRoleMarkdown(content)
    expect(role.name).toBe('code-reviewer')
    expect(role.principle).toContain('TODO') // 模板原则留 TODO 提示待填（填前由人工/校验把关）
    expect(role.skills).toEqual([]) // 模板缺省空白名单
    expect(role.knowledge.layers).toEqual(['global', 'project'])
  })

  it('已存在 → skipped 不覆盖；--force 覆盖；非 kebab 名 → InstallError', async () => {
    const rolesDir = makeTmp()
    await initRole({ name: 'dev-x', rolesDir })
    const path = join(rolesDir, 'dev-x.md')
    const original = readFileSync(path, 'utf8')
    const again = await initRole({ name: 'dev-x', rolesDir })
    expect(again.written).toHaveLength(0)
    expect(again.skipped).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe(original)

    const forced = await initRole({ name: 'dev-x', rolesDir, force: true, template: '---\nname: "{{name}}"\ndescription: v2\n---\n正文' })
    expect(forced.written).toEqual([path])
    expect(readFileSync(path, 'utf8')).toContain('v2')

    await expect(initRole({ name: 'Dev X', rolesDir })).rejects.toThrow(InstallError)
  })
})
