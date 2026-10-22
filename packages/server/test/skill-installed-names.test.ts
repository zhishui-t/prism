import { symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { installedSkillNames } from '../src/roles/wiring.js'

/**
 * 链入的技能目录按已装认（2026-10-22）：Windows 联接 / POSIX 软链在 Dirent 里报
 * `isSymbolicLink()` 而非目录，曾被 `e.isDirectory()` 滤掉 → `skill_unknown` 误报。
 * 链接类型用 `'junction'`：Windows 免管理员建联接，POSIX 上该参数被忽略、按普通软链创建。
 */
describe('installedSkillNames（链入目录 + 断链 + 散文件）', () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skill-names-'))
    const skillsDir = join(tmp, 'zcode', 'skills')
    await mkdir(join(skillsDir, 'real-skill'), { recursive: true })
    await writeFile(join(skillsDir, 'real-skill', 'SKILL.md'), '---\nname: real-skill\n---\n', 'utf-8')
    await writeFile(join(skillsDir, 'loose-file.md'), 'x', 'utf-8')
    const target = join(tmp, 'shared-skills', 'linked-skill')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), '---\nname: linked-skill\n---\n', 'utf-8')
    symlinkSync(target, join(skillsDir, 'linked-skill'), 'junction')
    symlinkSync(join(tmp, 'gone'), join(skillsDir, 'broken-link'), 'junction')
  })

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('真实目录与链入目录都进名单；散文件与断链不进', async () => {
    const names = await installedSkillNames(join(tmp, 'zcode'))
    expect(new Set(names)).toEqual(new Set(['real-skill', 'linked-skill']))
  })

  it('skills 目录不存在 → undefined（跳过引用校验）', async () => {
    expect(await installedSkillNames(join(tmp, 'no-such-root'))).toBeUndefined()
  })
})
