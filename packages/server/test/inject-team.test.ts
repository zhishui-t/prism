/**
 * 团队约定块注入（team-definition.md §7「注入」——`prism inject --team` 的实现单点）。
 *
 * 锁住的判定（都是「约束到不了宿主会话就白做」的地方）：
 *  1. 注入产物落 `<repo>/AGENTS.md` 的 `prism:team:<id>` 标记块，**含编制表**
 *     （2026-11-02 超编反馈：编制不可见 = 队长派发没有数量约束）；
 *  2. 团队定义改版（count 变）→ 重跑即刷新块内内容，块外手写内容不动；
 *  3. 团队不存在 → not_found（不静默写空块）；适配器契约破坏 → 拒写。
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { injectTeamConvention } from '../src/roles/wiring.js'

let home: string
let teamsDir: string
let repoRoot: string

const TEAM_MD = (count: number): string =>
  [
    '---',
    'team_id: delivery',
    'name: 交付团队',
    'description: 端到端交付。',
    'default: false',
    'members:',
    '  - role: dev-1',
    `    count: ${count}`,
    'skills: []',
    'knowledge:',
    '  layers: [global, project]',
    'deposit:',
    '  enabled: false',
    '  default_layer: project',
    '  default_type: pitfall',
    '  priority: medium',
    '  require_note: true',
    'arbitration: [safety, quality]',
    'rework_limit: 2',
    '---',
    '',
    '# 交付团队',
    '',
    '## 工作流',
    '',
    '| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    '| 1 | 开发 | dev-1 | 串行 | 任务书 | stream-1.md | 自测通过 | 卡死 2 次 → 队长 |',
  ].join('\n')

async function writeTeam(count: number): Promise<void> {
  await writeFile(join(teamsDir, 'delivery.md'), TEAM_MD(count), 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'prism-inject-team-home-'))
  teamsDir = await mkdtemp(join(tmpdir(), 'prism-inject-team-teams-'))
  repoRoot = await mkdtemp(join(tmpdir(), 'prism-inject-team-repo-'))
  await writeTeam(2)
})

afterEach(async () => {
  await Promise.all([rm(home, { recursive: true, force: true }), rm(teamsDir, { recursive: true, force: true }), rm(repoRoot, { recursive: true, force: true })])
})

describe('injectTeamConvention（团队约定块 → <repo>/AGENTS.md）', () => {
  it('注入：落标记块且含编制表（count=2）与工作流；缺文件则创建', async () => {
    const result = await injectTeamConvention({ repoRoot, teamId: 'delivery', teamsDir, home })
    expect(result).toEqual({ path: join(repoRoot, 'AGENTS.md'), teamId: 'delivery', action: 'created' })
    const text = await readFile(join(repoRoot, 'AGENTS.md'), 'utf8')
    expect(text).toContain('<!-- prism:team:delivery:start -->')
    expect(text).toContain('## 编制（同角色并发实例上限）')
    expect(text).toContain('| dev-1 | 2 |')
    expect(text).toContain('同时在场的实例数不得超过上表')
    // 工作流行的 mode 是解析归一后的 serial|parallel（team-definition.md §4.4）
    expect(text).toContain('| 1 | 开发 | dev-1 | serial |')
    expect(text).toContain('safety > quality')
  })

  it('团队定义改版（count 2→3）→ 重跑即刷新；块外手写内容不动', async () => {
    const agentsMd = join(repoRoot, 'AGENTS.md')
    await injectTeamConvention({ repoRoot, teamId: 'delivery', teamsDir, home })
    await writeFile(agentsMd, `# 项目\n\n手写内容不许动。\n\n${await readFile(agentsMd, 'utf8')}`, 'utf8')
    await writeTeam(3)
    const second = await injectTeamConvention({ repoRoot, teamId: 'delivery', teamsDir, home })
    expect(second.action).toBe('updated')
    const text = await readFile(agentsMd, 'utf8')
    expect(text).toContain('| dev-1 | 3 |')
    expect(text).not.toContain('| dev-1 | 2 |')
    expect(text).toContain('手写内容不许动。')
    // 只有一份该团队的块（替换而非追加）
    expect(text.split('<!-- prism:team:delivery:start -->')).toHaveLength(2)
  })

  it('团队不存在 → not_found（不静默写空块）', async () => {
    await expect(injectTeamConvention({ repoRoot, teamId: 'ghost', teamsDir, home })).rejects.toThrow(/团队不存在/)
    // 不留半成品文件
    await expect(readFile(join(repoRoot, 'AGENTS.md'), 'utf8')).rejects.toThrow()
  })

  it('空目录结构：rolesDir 缺省可注入（成员校验只出 warning 不阻断）', async () => {
    const rolesDir = await mkdtemp(join(tmpdir(), 'prism-inject-team-roles-'))
    const result = await injectTeamConvention({ repoRoot, teamId: 'delivery', teamsDir, rolesDir, home })
    expect(result.action).toBe('created')
    await rm(rolesDir, { recursive: true, force: true })
  })
})
