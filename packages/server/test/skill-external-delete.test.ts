/**
 * v10 F3 **服务端**：外部技能删除 + usage 的只读 `external_removable`（全部临时目录，红线 R5）。
 *
 * 口径（契约钉死，逐条锁定）：
 * - `DELETE /api/skills/external/:name`：200 + `{ skills_dir, removed, trash_id }`（**不是 204**：
 *   信封层无 204 通道，`trash_id` 要回给 UI 提示「可恢复」）；
 * - 落点 = `resolveDirsFromHome(home, {rootExplicit:true}).skillsDir`（**与 `/api/skills` /
 *   `installedSkillNames` 同源**）——故本文件用 `prism.yaml` 覆盖 `skills_dir`，并断言
 *   「删在配置目录、绝不落适配器默认根」；
 * - 外部判定按**落点文件**（有 SKILL.md 且无 marker），**不按名字查内置清单**——所以
 *   「人写同名内置」必须可删；
 * - 含 marker → 409 `id_conflict`；无目录 / 无 SKILL.md → 404；非法名 → 400。
 *
 * 实测的 URL 归一化边界（决定了 400 只能用**编码形态**在 HTTP 层验）：
 * `new URL()` 会把**字面** `.` / `..` / `%2E%2E` 当路径段折叠掉（`/external/..` → `/api/skills/`），
 * 请求根本到不了处理函数（实测落到 `GET /api/skills/:name` 的方法不匹配 → 405）。字面形态的
 * 拒绝因此走**白盒**（直接调 `deleteExternalSkillDefinition`）锁定，HTTP 层验 `..%2F..` 这类
 * 解码后才含分隔符的穿越串。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog, TrashStore } from '@prism/core'
import { prismSkillMarker } from '@prism/skills'

import { startServer, type AppHandle } from '../src/app.js'
import { deleteExternalSkillDefinition, resolveExternalSkillTarget } from '../src/roles/index.js'

/** 人写的 SKILL.md（无 Prism marker）。 */
const HANDWRITTEN = '# 规格验证\n\n人写的技能正文。\n'

describe('v10 F3：DELETE /api/skills/external/:name（外部技能进回收站）', () => {
  let tmp: string
  let home: string
  let harnessRoot: string
  let skillsDir: string
  let app: AppHandle
  let base: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skill-ext-'))
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    skillsDir = join(tmp, 'managed-skills')
    await mkdir(home, { recursive: true })
    // skills_dir 覆盖：验证「删除落点 = 配置解析后的目录」，而不是适配器默认根
    await writeFile(join(home, 'prism.yaml'), `skills_dir: ${skillsDir.replaceAll('\\', '/')}\n`, 'utf-8')
    app = await startServer({ home, harnessRoot, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterEach(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const send = (method: string, path: string, payload?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })

  const trashStore = (): TrashStore => new TrashStore({ trashDir: join(home, 'trash') })

  /** 路径比较用的归一：prism.yaml 里的值按**原样**返回（`/` 分隔），`removed` 走 `resolve` 是平台分隔符。 */
  const norm = (path: string): string => path.replaceAll('\\', '/')

  /** 在受管目录里造一个人写的技能（可选附带子目录/子文件）。 */
  async function writeSkill(name: string, content: string = HANDWRITTEN): Promise<void> {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, 'SKILL.md'), content, 'utf-8')
  }

  /** `/api/skills/usage` 里某一行。 */
  async function usageRow(name: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/api/skills/usage`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { value: Array<Record<string, unknown>> }
    const found = body.value.find((row) => row['name'] === name)
    expect(found, `usage 应有 ${name}`).toBeDefined()
    return found as Record<string, unknown>
  }

  it('成功：整目录进回收站（子文件随迁）+ 200 {skills_dir, removed, trash_id} + 审计 trigger=HTTP', async () => {
    await mkdir(join(skillsDir, 'spec-verify', 'references'), { recursive: true })
    await writeFile(join(skillsDir, 'spec-verify', 'SKILL.md'), HANDWRITTEN, 'utf-8')
    await writeFile(join(skillsDir, 'spec-verify', 'references', 'a.md'), '# 附带\n', 'utf-8')

    const res = await send('DELETE', '/api/skills/external/spec-verify')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      value: { skills_dir: string; removed: string[]; trash_id: string }
    }
    // 响应体形状冻结：恰好这三个键
    expect(Object.keys(body.value).sort()).toEqual(['removed', 'skills_dir', 'trash_id'])
    expect(norm(body.value.skills_dir)).toBe(norm(skillsDir))
    expect(body.value.removed).toEqual([join(skillsDir, 'spec-verify')])
    expect(body.value.trash_id).toMatch(/^skill\//)

    // 原位置整目录搬净（不留半目录），受管根本身保留
    expect(existsSync(join(skillsDir, 'spec-verify'))).toBe(false)
    expect(existsSync(skillsDir)).toBe(true)

    const unit = (await trashStore().list('skill')).find((u) => u.id === body.value.trash_id)
    expect(unit).toMatchObject({
      kind: 'skill',
      name: 'spec-verify',
      originalPaths: [join(skillsDir, 'spec-verify')],
      managedRoot: skillsDir,
      broken: false,
    })

    // 子文件随迁（references/ 一起走）
    const unitDir = join(home, 'trash', 'skill', body.value.trash_id.split('/')[1]!)
    expect(await readFile(join(unitDir, 'spec-verify', 'references', 'a.md'), 'utf-8')).toBe('# 附带\n')

    // 审计：kind=skill + trigger=HTTP
    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'skill', unit_id: body.value.trash_id, trigger: 'HTTP' })

    // managedRoot 正确的实证：restore 不报 trash_restore_escape（误传 PRISM_HOME 会恒报）
    const restored = await trashStore().restore(body.value.trash_id)
    expect(restored).toEqual([join(skillsDir, 'spec-verify')])
    expect(existsSync(join(skillsDir, 'spec-verify', 'SKILL.md'))).toBe(true)
  })

  it('Prism 产物（SKILL.md 含 marker）→ 409 id_conflict，不动盘、不入回收站', async () => {
    await writeSkill(
      'prism-made',
      `---\nname: prism-made\ndescription: "Prism 装的"\n---\n${prismSkillMarker('prism-made')}\n\n# 正文\n`,
    )

    const res = await send('DELETE', '/api/skills/external/prism-made')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('id_conflict')
    expect(body.error.message).toContain('uninstall')

    expect(existsSync(join(skillsDir, 'prism-made', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('目录不存在 → 404；目录存在但无 SKILL.md → 404（非技能目录不可删）', async () => {
    const absent = await send('DELETE', '/api/skills/external/no-such-skill')
    expect(absent.status).toBe(404)
    expect(((await absent.json()) as { error: { code: string } }).error.code).toBe('not_found')

    await mkdir(join(skillsDir, 'not-a-skill'), { recursive: true })
    await writeFile(join(skillsDir, 'not-a-skill', 'notes.md'), '# 不是技能\n', 'utf-8')
    const bare = await send('DELETE', '/api/skills/external/not-a-skill')
    expect(bare.status).toBe(404)
    const bareBody = (await bare.json()) as { error: { code: string; message: string } }
    expect(bareBody.error.code).toBe('not_found')
    expect(bareBody.error.message).toContain('SKILL.md')

    // 两个都没被搬走
    expect(existsSync(join(skillsDir, 'not-a-skill', 'notes.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('人写同名内置技能（复制内置后改写、无 marker）可删', async () => {
    // 内置清单当前只有一个 `prism`；这里落一份**无 marker** 的同名技能 = 用户改写版
    await writeSkill('prism')

    const res = await send('DELETE', '/api/skills/external/prism')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { value: { removed: string[]; trash_id: string } }
    expect(body.value.removed).toEqual([join(skillsDir, 'prism')])
    expect(existsSync(join(skillsDir, 'prism'))).toBe(false)
    expect((await trashStore().list('skill')).map((u) => u.id)).toEqual([body.value.trash_id])
  })

  it('name 消毒（HTTP 可达的编码形态）：穿越串 / 分隔符 / 空白 → 400 bad_request', async () => {
    await writeSkill('keep-me')

    // 这些编码在 `new URL()` 里**不会**被当路径段折叠，解码后含 `/`、`\` 或为空 → 必到 400
    const cases = ['a%2Fb', '..%2F..', 'a%5Cb', '.%2F.', '%20', '%2E%2F%2E']
    for (const name of cases) {
      const res = await send('DELETE', `/api/skills/external/${name}`)
      expect(res.status, `${name} 应 400`).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request')
    }

    // 受管目录与既有技能都没被碰
    expect(existsSync(join(skillsDir, 'keep-me', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('name 消毒（白盒）：`.` / `..` / 空串 / 纯空白 → bad_request；根自身被拒', async () => {
    const store = trashStore()
    for (const bad of ['.', '..', '', '   ']) {
      await expect(deleteExternalSkillDefinition(bad, skillsDir, store, 'HTTP')).rejects.toMatchObject({
        code: 'bad_request',
      })
    }
    // 解析层同样拒绝，且**不会**把 name 拼成受管根自身（isInside 会放行根自身，必须另断言）
    expect(() => resolveExternalSkillTarget('..', skillsDir)).toThrow(/invalid_skill_name/)
    expect(() => resolveExternalSkillTarget('a/b', skillsDir)).toThrow(/invalid_skill_name/)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('name 消毒（白盒·第二道根保护）：win32 盘符形态 `C:` / `C:..` → 400；POSIX 下是普通名 → 404；两平台都无副作用', async () => {
    // 上面所有非法名都被**第一道**检查（形态：空串/`.`/`..`/分隔符）拦下；能到达**第二道**
    // 根保护（`target === root || !isInside`，is-inside.ts:19 放行根自身的那处补偿）的输入
    // 只有 win32 盘符相对形态——code-review-v10 §3 交叉验证实测的 6 类形态，此处锁进回归：
    // - win32：`resolve(root,'C:')` 落到 C 盘某处（≠根内）→ `!isInside` → 400；
    // - POSIX：盘符只是普通文件名字符 → 根内不存在的目录 → 404（无副作用，非 400）。
    await writeSkill('keep-me')
    const store = trashStore()
    for (const form of ['C:', 'C:..']) {
      await expect(deleteExternalSkillDefinition(form, skillsDir, store, 'HTTP')).rejects.toMatchObject({
        code: process.platform === 'win32' ? 'bad_request' : 'not_found',
      })
    }
    expect(existsSync(join(skillsDir, 'keep-me', 'SKILL.md'))).toBe(true)
    expect(await store.list('skill')).toEqual([])
  })

  it('HTTP 层的字面 `.` / `..` / 空段：被 URL 归一化挡住（非 200），且不删任何东西', async () => {
    await writeSkill('keep-me')
    // 实测：`/external/.` → `/external/`（3 段 → 落到 GET /api/skills/:name 的方法不匹配 → 405）；
    // `/external/..` → `/api/skills/`；`/external/` → 同上。都不是 200，也不产生副作用。
    for (const path of ['/api/skills/external/.', '/api/skills/external/..', '/api/skills/external/']) {
      const res = await send('DELETE', path)
      expect(res.status, `${path} 不应 200`).not.toBe(200)
    }
    expect(existsSync(join(skillsDir, 'keep-me', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('同源：/api/skills 的 skills_dir = prism.yaml 配置目录；删除落配置目录，不落适配器默认根', async () => {
    await writeSkill('spec-verify')

    const listRes = await fetch(`${base}/api/skills`)
    const listBody = (await listRes.json()) as { value: { skills_dir: string } }
    expect(norm(listBody.value.skills_dir)).toBe(norm(skillsDir))

    const res = await send('DELETE', '/api/skills/external/spec-verify')
    expect(res.status).toBe(200)
    expect(norm(((await res.json()) as { value: { skills_dir: string } }).value.skills_dir)).toBe(norm(skillsDir))
    // 适配器默认根下不产生任何东西（若误用 harnessPaths().skillsDir，删除会落向这里）
    expect(existsSync(join(harnessRoot, 'skills'))).toBe(false)
  })

  it('usage：external_removable = 有 SKILL.md 且无 marker（人写同名内置 true；未落盘/无 SKILL.md false）', async () => {
    await writeSkill('prism') // 人写的同名内置 = 可删
    await writeSkill('spec-verify')
    await mkdir(join(skillsDir, 'bare-dir'), { recursive: true }) // 有目录无 SKILL.md

    expect((await usageRow('prism')).external_removable).toBe(true)
    expect((await usageRow('prism')).builtin).toBe(true)
    expect((await usageRow('spec-verify')).external_removable).toBe(true)
    expect((await usageRow('bare-dir')).external_removable).toBe(false)
    // 只读字段：不是 `undefined` 缺键，而是显式 false
    expect('external_removable' in (await usageRow('bare-dir'))).toBe(true)
  })

  it('usage：Prism 产物（HTTP 装内置到受管目录）→ external_removable=false', async () => {
    const installed = await send('POST', '/api/skills/install', { skills_dir: skillsDir, names: ['prism'] })
    expect(installed.status).toBe(200)

    expect((await usageRow('prism')).external_removable).toBe(false)
    // 卸载通道仍在：Prism 产物走 uninstall（删外部技能的入口对它 409）
    const res = await send('DELETE', '/api/skills/external/prism')
    expect(res.status).toBe(409)
  })
})
