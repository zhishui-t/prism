/**
 * v15 B-4（SPEC-4.1）：MCP `prism_skill_rm`——外部技能删除的**第三面**（HTTP/MCP/CLI 三面对称）。
 *
 * 口径与 HTTP `DELETE /api/skills/external/:name` **逐字同源**（复用域单点
 * `deleteExternalSkillDefinition`，仅 `trigger` 不同）：
 * - `skills_dir` **必填**（与 `prism_role_rm` / `prism_team_rm` 同参形态，防误写真实宿主）；
 * - 外部技能（有 `SKILL.md` 且无 Prism marker）→ 整目录进回收站（`kind=skill`）+ `trash_id`；
 * - Prism 产物（含 marker）→ `id_conflict`（指路卸载）；不存在 / 无 `SKILL.md` → `not_found`；
 * - 非法名 → `bad_request`。
 *
 * 全部临时目录（红线 R5），零真实宿主污染。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog, TrashStore } from '@prism/core'
import { prismSkillMarker } from '@prism/skills'

import { createMcpTools, handleRpcRequest, type JsonRpcResponse, type McpTool } from '../src/mcp/server.js'

/** 人写的 SKILL.md（无 Prism marker）。 */
const HANDWRITTEN = '# 规格验证\n\n人写的技能正文。\n'

function rpc(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> } {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
}

function textOf(response: JsonRpcResponse | null): string {
  const content = (response?.result as { content?: Array<{ text?: string }> } | undefined)?.content
  return content?.[0]?.text ?? ''
}

describe('v15 B-4：MCP prism_skill_rm（外部技能进回收站）', () => {
  let tmp: string
  let home: string
  let skillsDir: string
  let tools: McpTool[]

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-mcp-skillrm-'))
    home = join(tmp, 'home')
    skillsDir = join(tmp, 'managed-skills')
    await mkdir(home, { recursive: true })
    // skills_dir 覆盖：确认显式参数即落点（绝不复用默认宿主目录）
    await writeFile(
      join(home, 'prism.yaml'),
      `skills_dir: ${skillsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    tools = createMcpTools({ home, harnessRoot: join(tmp, 'zcode') })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const call = async (name: string, args: Record<string, unknown>): Promise<JsonRpcResponse | null> =>
    await handleRpcRequest(rpc(1, 'tools/call', { name, arguments: args }), tools)

  const trashStore = (): TrashStore => new TrashStore({ trashDir: join(home, 'trash') })

  async function writeSkill(name: string, content: string = HANDWRITTEN): Promise<void> {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, 'SKILL.md'), content, 'utf-8')
  }

  it('工具已注册（prism_skill_rm 出现在 tools/list）', () => {
    expect(tools.map((t) => t.name)).toContain('prism_skill_rm')
  })

  it('缺 skills_dir → isError（写路径绝不回落默认宿主目录），且不动盘', async () => {
    await writeSkill('spec-verify')
    const res = await call('prism_skill_rm', { name: 'spec-verify' })
    expect((res?.result as { isError: boolean }).isError).toBe(true)
    expect(textOf(res)).toContain('[bad_request]')
    expect(textOf(res)).toContain('skills_dir_required')
    expect(existsSync(join(skillsDir, 'spec-verify', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('缺 name → isError', async () => {
    const res = await call('prism_skill_rm', { skills_dir: skillsDir })
    expect((res?.result as { isError: boolean }).isError).toBe(true)
    expect(textOf(res)).toContain('name')
  })

  it('成功：整目录进回收站 + {skills_dir, removed, trash_id} + 审计 trigger=MCP', async () => {
    await mkdir(join(skillsDir, 'spec-verify', 'references'), { recursive: true })
    await writeFile(join(skillsDir, 'spec-verify', 'SKILL.md'), HANDWRITTEN, 'utf-8')
    await writeFile(join(skillsDir, 'spec-verify', 'references', 'a.md'), '# 附带\n', 'utf-8')

    const res = await call('prism_skill_rm', { name: 'spec-verify', skills_dir: skillsDir })
    expect((res?.result as { isError: boolean }).isError).toBe(false)
    const value = JSON.parse(textOf(res)) as { skills_dir: string; removed: string[]; trash_id: string }
    expect(value.skills_dir.replaceAll('\\', '/')).toBe(skillsDir.replaceAll('\\', '/'))
    expect(value.removed).toEqual([join(skillsDir, 'spec-verify')])
    expect(value.trash_id).toMatch(/^skill\//)

    expect(existsSync(join(skillsDir, 'spec-verify'))).toBe(false)
    expect(existsSync(skillsDir)).toBe(true)

    const unit = (await trashStore().list('skill')).find((u) => u.id === value.trash_id)
    expect(unit).toMatchObject({
      kind: 'skill',
      name: 'spec-verify',
      originalPaths: [join(skillsDir, 'spec-verify')],
      managedRoot: skillsDir,
    })

    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'skill', unit_id: value.trash_id, trigger: 'MCP' })
  })

  it('Prism 产物（SKILL.md 含 marker）→ isError id_conflict（指路卸载），不动盘', async () => {
    await writeSkill(
      'prism-made',
      `---\nname: prism-made\ndescription: "Prism 装的"\n---\n${prismSkillMarker('prism-made')}\n\n# 正文\n`,
    )
    const res = await call('prism_skill_rm', { name: 'prism-made', skills_dir: skillsDir })
    expect((res?.result as { isError: boolean }).isError).toBe(true)
    expect(textOf(res)).toContain('[id_conflict]')
    expect(textOf(res)).toContain('uninstall')
    expect(existsSync(join(skillsDir, 'prism-made', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('目录不存在 → not_found；目录存在但无 SKILL.md → not_found', async () => {
    const absent = await call('prism_skill_rm', { name: 'no-such', skills_dir: skillsDir })
    expect((absent?.result as { isError: boolean }).isError).toBe(true)
    expect(textOf(absent)).toContain('[not_found]')

    await mkdir(join(skillsDir, 'bare-dir'), { recursive: true })
    await writeFile(join(skillsDir, 'bare-dir', 'notes.md'), '# 不是技能\n', 'utf-8')
    const bare = await call('prism_skill_rm', { name: 'bare-dir', skills_dir: skillsDir })
    expect((bare?.result as { isError: boolean }).isError).toBe(true)
    expect(textOf(bare)).toContain('[not_found]')
    expect(textOf(bare)).toContain('SKILL.md')
    expect(existsSync(join(skillsDir, 'bare-dir', 'notes.md'))).toBe(true)
  })

  it('非法名（穿越 / 分隔符）→ bad_request，受管目录不受影响', async () => {
    await writeSkill('keep-me')
    for (const bad of ['..', 'a/b', 'a\\b']) {
      const res = await call('prism_skill_rm', { name: bad, skills_dir: skillsDir })
      expect((res?.result as { isError: boolean }).isError, `${JSON.stringify(bad)} 应 isError`).toBe(true)
      expect(textOf(res)).toContain('[bad_request]')
    }
    expect(existsSync(join(skillsDir, 'keep-me', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })
})
