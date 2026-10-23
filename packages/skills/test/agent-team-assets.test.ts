import { describe, expect, it } from 'vitest'

import { prismSkill } from '../src/builtin/prism.js'

/** Prism Agent Team 手册并入 prism 技能（2026-10-22）：文件型 assets 加载与关键治理条款锁定。 */
describe('prism 技能内置 Prism Agent Team 手册', () => {
  const paths = () => new Set((prismSkill.assets ?? []).map((a) => a.path))

  it('手册与配套件齐全（manual / references×4 / templates×4 / dag.mjs）', () => {
    const p = paths()
    for (const path of [
      'references/agent-team.md',
      'references/agent-team/clarification.md',
      'references/agent-team/roles.md',
      'references/agent-team/exceptions.md',
      'references/agent-team/adding-agents.md',
      'templates/task-brief.md',
      'templates/team-manifest.md',
      'templates/agents.md',
      'templates/delivery-report.md',
      'scripts/dag.mjs',
    ]) {
      expect(p.has(path), `缺 asset: ${path}`).toBe(true)
    }
  })

  it('全部 asset 内容非空', () => {
    for (const asset of prismSkill.assets ?? []) {
      expect(asset.content.trim().length, `asset 为空: ${asset.path}`).toBeGreaterThan(0)
    }
  })

  it('手册含关键治理条款（模式判定/严格执行/分桶/六要素/队长纪律/完成≠关闭/压缩恢复）', () => {
    const manual = prismSkill.assets?.find((a) => a.path === 'references/agent-team.md')?.content ?? ''
    for (const kw of ['执行模式', '严格执行', '按独立性分桶', '任务单六要素', '队长纪律', '完成 ≠ 关闭', '上下文压缩', '断点快照']) {
      expect(manual, `手册缺关键词: ${kw}`).toContain(kw)
    }
  })

  it('description 与正文含组队触发词与手册入口', () => {
    expect(prismSkill.description).toContain('组队')
    expect(prismSkill.description).toContain('Prism Agent Team')
    expect(prismSkill.content).toContain('references/agent-team.md')
  })
})
