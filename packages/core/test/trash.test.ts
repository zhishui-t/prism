/**
 * TrashStore（第九轮 F3）单测。
 *
 * 纪律（AGENTS.md R5）：**全部用临时目录**，任何用例都不碰真实 `~/.prism` 或宿主目录；
 * `TrashStore` 显式传 `trashDir`，`AuditLog` 显式传 `dir`。
 *
 * 覆盖：put→list→restore 往返 / 同秒同名不合并 / 穿越防护 / restore 越界拒绝 /
 * 同名冲突与 overwrite / broken 单元 / 到期清除与幂等 / EXDEV 回落（含软链）/
 * 审计三事件 / 保留期回落 / 同单元 basename 冲突。
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuditLog,
  PrismError,
  TrashStore,
  isInside,
  prismPaths,
  resolveTrashRetentionDays,
} from '../src/index.js'
import type { TrashStoreOptions } from '../src/index.js'

/** 固定本地时刻：目录名时间戳与 `deleted_at` 都据此可断言。 */
const LOCAL_T0 = new Date(2026, 8, 16, 10, 0, 0)
const STAMP_T0 = '20260916-100000'
const clock = (): Date => new Date(LOCAL_T0)
const at = (date: Date): (() => Date) => () => new Date(date)

let root: string
let trashDir: string
let managedRoot: string
let auditDir: string

function makeStore(options: TrashStoreOptions = {}): TrashStore {
  return new TrashStore({ trashDir, now: clock, ...options })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

/** 造一个把 `target` 的 rename 打成 EXDEV 的注入 fs（其余路径走真 rename）。 */
function exdevOn(target: string, onCall?: () => void): TrashStoreOptions['fs'] {
  const expected = resolve(target)
  return {
    rename: async (from, to) => {
      if (from === expected) {
        onCall?.()
        const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      }
      await rename(from, to)
    },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prism-trash-'))
  trashDir = join(root, 'trash')
  managedRoot = join(root, 'roles')
  auditDir = join(root, 'audit')
  await mkdir(managedRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveTrashRetentionDays', () => {
  it('合法域 1–3650 整数；越界/非法回落 3', () => {
    expect(resolveTrashRetentionDays('1')).toBe(1)
    expect(resolveTrashRetentionDays('3')).toBe(3)
    expect(resolveTrashRetentionDays('3650')).toBe(3650)
    expect(resolveTrashRetentionDays(' 7 ')).toBe(7)

    expect(resolveTrashRetentionDays('0')).toBe(3)
    expect(resolveTrashRetentionDays('-1')).toBe(3)
    expect(resolveTrashRetentionDays('3651')).toBe(3)
    expect(resolveTrashRetentionDays('2.5')).toBe(3)
    expect(resolveTrashRetentionDays('abc')).toBe(3)
    expect(resolveTrashRetentionDays('')).toBe(3)
  })

  it('环境变量在**调用时**读取（非模块加载期固化）', () => {
    const previous = process.env['PRISM_TRASH_RETENTION_DAYS']
    try {
      process.env['PRISM_TRASH_RETENTION_DAYS'] = '7'
      expect(resolveTrashRetentionDays()).toBe(7)
      process.env['PRISM_TRASH_RETENTION_DAYS'] = '3651'
      expect(resolveTrashRetentionDays()).toBe(3)
      delete process.env['PRISM_TRASH_RETENTION_DAYS']
      expect(resolveTrashRetentionDays()).toBe(3)
    } finally {
      if (previous === undefined) delete process.env['PRISM_TRASH_RETENTION_DAYS']
      else process.env['PRISM_TRASH_RETENTION_DAYS'] = previous
    }
  })
})

describe('paths.trashDir / isInside', () => {
  it('prismPaths 提供 trashDir，TrashStore 默认取同一位置', () => {
    const previous = process.env['PRISM_HOME']
    // 只构造不写盘；PRISM_HOME 仍重定向到临时目录，绝不让默认值落到真实 ~/.prism
    process.env['PRISM_HOME'] = join(root, 'home')
    try {
      expect(prismPaths().trashDir).toBe(join(root, 'home', 'trash'))
      expect(new TrashStore().trashDir).toBe(join(root, 'home', 'trash'))
    } finally {
      if (previous === undefined) delete process.env['PRISM_HOME']
      else process.env['PRISM_HOME'] = previous
    }
  })

  it('isInside 先折叠 .. 再比前缀', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

describe('TrashStore.put / list / restore', () => {
  it('put→list→restore 往返：整目录搬走、原位置消失、无残目录', async () => {
    const trash = makeStore({ audit: new AuditLog({ dir: auditDir }) })
    const roleDir = join(managedRoot, 'dev')
    await writeFileAt(join(roleDir, 'AGENTS.md'), '# dev\n')

    const result = await trash.put('role', 'dev', [roleDir], { managedRoot, trigger: 'CLI' })
    expect(result.id).toBe(`role/${STAMP_T0}-dev`)
    expect(result.unitDir).toBe(join(trashDir, 'role', `${STAMP_T0}-dev`))
    expect(result.originalPaths).toEqual([roleDir])

    // 原位置消失且无残目录；暂存态不残留
    expect(await exists(roleDir)).toBe(false)
    expect(await readdir(managedRoot)).toEqual([])
    expect(await readdir(join(trashDir, 'role'))).toEqual([`${STAMP_T0}-dev`])

    // 单元内 = 整目录 + meta 平铺
    const unitDir = result.unitDir
    expect(await readFile(join(unitDir, 'dev', 'AGENTS.md'), 'utf-8')).toBe('# dev\n')
    const meta = JSON.parse(await readFile(join(unitDir, 'trash-meta.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(meta['original_paths']).toEqual([roleDir])
    expect(meta['managed_root']).toBe(resolve(managedRoot))
    expect(meta['deleted_at']).toBe(LOCAL_T0.toISOString())
    expect(meta['trigger']).toBe('CLI')

    expect(await trash.list()).toEqual([
      {
        id: result.id,
        kind: 'role',
        name: 'dev',
        deletedAt: LOCAL_T0.toISOString(),
        originalPaths: [roleDir],
        managedRoot: resolve(managedRoot),
        broken: false,
      },
    ])
    // list(kind) 过滤
    expect(await trash.list('team')).toEqual([])

    const restored = await trash.restore(result.id)
    expect(restored).toEqual([roleDir])
    expect(await readFile(join(roleDir, 'AGENTS.md'), 'utf-8')).toBe('# dev\n')
    expect(await exists(unitDir)).toBe(false)
    expect(await trash.list()).toEqual([])
  })

  it('同秒同名两次 put 各自独立单元，绝不合并', async () => {
    const trash = makeStore()
    const firstSource = join(managedRoot, 'dev')
    const secondSource = join(managedRoot, 'dev-next')
    await writeFileAt(join(firstSource, 'x.txt'), 'A')
    await writeFileAt(join(secondSource, 'x.txt'), 'B')

    const first = await trash.put('role', 'dev', [firstSource], { managedRoot, trigger: 'CLI' })
    const second = await trash.put('role', 'dev', [secondSource], { managedRoot, trigger: 'CLI' })

    expect(first.id).toBe(`role/${STAMP_T0}-dev`)
    expect(second.id).toBe(`role/${STAMP_T0}-dev-2`)
    expect((await trash.list('role')).map((unit) => unit.id)).toEqual([
      `role/${STAMP_T0}-dev`,
      `role/${STAMP_T0}-dev-2`,
    ])
    // 两份内容各归其单元，无覆盖
    expect(await readFile(join(first.unitDir, 'dev', 'x.txt'), 'utf-8')).toBe('A')
    expect(await readFile(join(second.unitDir, 'dev-next', 'x.txt'), 'utf-8')).toBe('B')
  })

  it("name / kind 带 ../ 被消毒并定界，回收站外零落点", async () => {
    const trash = makeStore()
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'f.txt'), 'x')

    const result = await trash.put('role', '../../evil', [source], { managedRoot, trigger: 'MCP' })
    expect(result.id).toBe(`role/${STAMP_T0}-.._.._evil`)
    expect(isInside(trashDir, result.unitDir)).toBe(true)
    expect(dirname(result.unitDir)).toBe(join(trashDir, 'role'))

    // kind 走同一消毒 → 不会写出 trashDir 之外
    const escapedKind = await trash.put('ro/le', 'k', [], { managedRoot, trigger: 'MCP' })
    expect(escapedKind.id).toBe(`ro_le/${STAMP_T0}-k`)
    expect(dirname(dirname(escapedKind.unitDir))).toBe(trashDir)

    // 回收站根之外（root 下）没有任何新条目
    expect(await exists(join(root, 'evil'))).toBe(false)
    expect(await exists(join(managedRoot, '..', 'evil'))).toBe(false)
    expect((await readdir(root)).sort()).toEqual(['roles', 'trash'])
  })

  it('restore 拒绝越出 managedRoot 的目标（meta 被篡改）', async () => {
    const trash = makeStore()
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'a.txt'), 'A')
    const { id, unitDir } = await trash.put('role', 'dev', [source], {
      managedRoot,
      trigger: 'CLI',
    })

    const metaPath = join(unitDir, 'trash-meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { original_paths: string[] }
    const outside = join(root, 'outside', 'dev')
    meta.original_paths = [outside]
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')

    await expect(trash.restore(id)).rejects.toMatchObject({ code: 'trash_restore_escape' })
    expect(await exists(outside)).toBe(false)
    // 单元未被消费，仍可列表/手工恢复
    expect(await exists(unitDir)).toBe(true)
    expect(await trash.list()).toHaveLength(1)
  })

  it('restore 同名冲突 → target_exists；overwrite=true 才覆盖', async () => {
    const trash = makeStore()
    const roleDir = join(managedRoot, 'dev')
    await writeFileAt(join(roleDir, 'AGENTS.md'), '新版')
    const { id } = await trash.put('role', 'dev', [roleDir], { managedRoot, trigger: 'CLI' })

    // 原位置又长出同名目录
    await writeFileAt(join(roleDir, 'AGENTS.md'), '占位')
    await expect(trash.restore(id)).rejects.toMatchObject({ code: 'target_exists' })
    expect(await readFile(join(roleDir, 'AGENTS.md'), 'utf-8')).toBe('占位')

    // overwrite=true（Windows 上目录 rename 无法覆盖，须显式先清）
    expect(await trash.restore(id, { overwrite: true })).toEqual([roleDir])
    expect(await readFile(join(roleDir, 'AGENTS.md'), 'utf-8')).toBe('新版')
    expect(await trash.list()).toEqual([])
  })

  it('restore：不存在的 id / 形状非法 → not_found；meta 损坏 → trash_broken', async () => {
    const trash = makeStore()
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'a.txt'), 'A')
    const { id, unitDir } = await trash.put('role', 'dev', [source], {
      managedRoot,
      trigger: 'CLI',
    })

    await expect(trash.restore(`role/20990101-000000-ghost`)).rejects.toBeInstanceOf(PrismError)
    await expect(trash.restore('role/20990101-000000-ghost')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(trash.restore('../../etc/passwd')).rejects.toMatchObject({ code: 'not_found' })
    await expect(trash.restore('role/..')).rejects.toMatchObject({ code: 'not_found' })
    await expect(trash.restore('no-separator')).rejects.toMatchObject({ code: 'not_found' })

    await rm(join(unitDir, 'trash-meta.json'), { force: true })
    await expect(trash.restore(id)).rejects.toMatchObject({ code: 'trash_broken' })
  })

  it('同单元 basename 冲突加后缀；restore 仍按各自原路径精确回位', async () => {
    const trash = makeStore()
    const first = join(managedRoot, 'a', 'dev')
    const second = join(managedRoot, 'b', 'dev')
    await writeFileAt(join(first, 'AGENTS.md'), 'A')
    await writeFileAt(join(second, 'AGENTS.md'), 'B')

    const { id, unitDir } = await trash.put('role', 'dev', [first, second], {
      managedRoot,
      trigger: 'CLI',
    })
    expect((await readdir(unitDir)).sort()).toEqual(['dev', 'dev-2', 'trash-meta.json'])
    expect(await readFile(join(unitDir, 'dev', 'AGENTS.md'), 'utf-8')).toBe('A')
    expect(await readFile(join(unitDir, 'dev-2', 'AGENTS.md'), 'utf-8')).toBe('B')

    expect(await trash.restore(id)).toEqual([first, second])
    expect(await readFile(join(first, 'AGENTS.md'), 'utf-8')).toBe('A')
    expect(await readFile(join(second, 'AGENTS.md'), 'utf-8')).toBe('B')
  })
})

describe('TrashStore.purge / sweep', () => {
  it('purge 只清到期单元；broken 与 .pending 残留按目录名时间戳兜底清除', async () => {
    const oldSource = join(managedRoot, 'old-role')
    await writeFileAt(join(oldSource, 'AGENTS.md'), 'old')
    const oldStore = makeStore({ now: at(new Date(2026, 8, 10, 10, 0, 0)) })
    const old = await oldStore.put('role', 'old-role', [oldSource], {
      managedRoot,
      trigger: 'CLI',
    })

    const freshSource = join(managedRoot, 'fresh-role')
    await writeFileAt(join(freshSource, 'AGENTS.md'), 'fresh')
    const brokenSource = join(managedRoot, 'broken-role')
    await writeFileAt(join(brokenSource, 'AGENTS.md'), 'broken')

    const trash = makeStore()
    const fresh = await trash.put('role', 'fresh-role', [freshSource], {
      managedRoot,
      trigger: 'CLI',
    })
    const broken = await trash.put('role', 'broken-role', [brokenSource], {
      managedRoot,
      trigger: 'CLI',
    })
    await rm(join(broken.unitDir, 'trash-meta.json'), { force: true })

    const listed = await trash.list('role')
    expect(listed).toHaveLength(3)
    const brokenEntry = listed.find((entry) => entry.id === broken.id)
    expect(brokenEntry).toMatchObject({ broken: true, name: 'broken-role', originalPaths: [] })
    // 无 meta → deletedAt 从目录名内时间戳兜底解析
    expect(brokenEntry?.deletedAt).toBe(LOCAL_T0.toISOString())
    expect(listed.find((entry) => entry.id === fresh.id)?.broken).toBe(false)

    // 保留 3 天：10 号那条到期，今天的两条留下
    expect(await trash.purge(3)).toEqual([old.id])
    expect((await trash.list()).map((entry) => entry.id).sort()).toEqual(
      [broken.id, fresh.id].sort(),
    )

    // 崩溃残留：正式名下从未落地过 → 是暂存态，不进 list
    const residueName = '20260910-100000-crash.pending'
    const residue = join(trashDir, 'role', residueName)
    await mkdir(residue, { recursive: true })
    expect((await trash.list('role')).map((entry) => entry.id)).not.toContain(`role/${residueName}`)

    const later = makeStore({ now: at(new Date(2026, 8, 21, 10, 0, 0)) })
    expect((await later.purge(3)).sort()).toEqual(
      [broken.id, fresh.id, `role/${residueName}`].sort(),
    )
    expect(await trash.list()).toEqual([])
    expect(await exists(residue)).toBe(false)
  })

  it('purge 幂等：重复调用不报错，回收站不存在也算成功', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'AGENTS.md'), '# dev\n')
    const trash = makeStore()
    const { id } = await trash.put('role', 'dev', [source], { managedRoot, trigger: 'CLI' })

    expect(await trash.purge(0)).toEqual([id])
    expect(await trash.purge(0)).toEqual([])
    expect(await trash.purge(0)).toEqual([])
    expect(await makeStore({ trashDir: join(root, 'never-created') }).purge(0)).toEqual([])
  })

  it('sweep 等价于 purge(resolveTrashRetentionDays())', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'AGENTS.md'), '# dev\n')
    // 2 天前删除
    const oldStore = makeStore({ now: at(new Date(2026, 8, 14, 10, 0, 0)) })
    const { id } = await oldStore.put('role', 'dev', [source], { managedRoot, trigger: 'CLI' })

    const previous = process.env['PRISM_TRASH_RETENTION_DAYS']
    try {
      // 保留期 5 天 → 不到期
      process.env['PRISM_TRASH_RETENTION_DAYS'] = '5'
      expect(await makeStore().sweep()).toEqual([])
      // 保留期 1 天 → 到期
      process.env['PRISM_TRASH_RETENTION_DAYS'] = '1'
      expect(await makeStore().sweep()).toEqual([id])
      expect(await makeStore().list()).toEqual([])
    } finally {
      if (previous === undefined) delete process.env['PRISM_TRASH_RETENTION_DAYS']
      else process.env['PRISM_TRASH_RETENTION_DAYS'] = previous
    }
  })
})

describe('TrashStore 跨卷（EXDEV）回落', () => {
  it('rename 抛 EXDEV → copy+rm 成功，目录结构与内容完整、源消失', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'AGENTS.md'), '# dev\n')
    await writeFileAt(join(source, 'nested', 'deep', 'note.txt'), 'deep')

    let exdevCalls = 0
    const trash = makeStore({ fs: exdevOn(source, () => (exdevCalls += 1)) })
    const { id, unitDir } = await trash.put('role', 'dev', [source], {
      managedRoot,
      trigger: 'HTTP',
    })

    expect(exdevCalls).toBe(1)
    expect(id).toBe(`role/${STAMP_T0}-dev`)
    expect(await exists(source)).toBe(false)
    expect(await readFile(join(unitDir, 'dev', 'AGENTS.md'), 'utf-8')).toBe('# dev\n')
    expect(await readFile(join(unitDir, 'dev', 'nested', 'deep', 'note.txt'), 'utf-8')).toBe('deep')
    expect((await readdir(join(unitDir, 'dev'))).sort()).toEqual(['AGENTS.md', 'nested'])

    // 回落产物同样可 restore 回原位置
    expect(await trash.restore(id)).toEqual([source])
    expect(await readFile(join(source, 'nested', 'deep', 'note.txt'), 'utf-8')).toBe('deep')
  })

  it('EXDEV 回落保留软链（本机/本目录建不了链则跳过）', async (ctx) => {
    const source = join(managedRoot, 'linked')
    await writeFileAt(join(source, 'real.txt'), 'real')
    let canLink = true
    try {
      await symlink('real.txt', join(source, 'alias.txt'))
    } catch {
      canLink = false
    }
    if (!canLink) {
      // 判「能不能建链」而非「什么平台」——Windows 开了开发者模式/管理员照样可测
      ctx.skip()
      return
    }

    const trash = makeStore({ fs: exdevOn(source) })
    const { unitDir } = await trash.put('role', 'linked', [source], {
      managedRoot,
      trigger: 'CLI',
    })

    const linkPath = join(unitDir, 'linked', 'alias.txt')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    // 软链建失败时会退化解引用拷贝，两种形态都要能读到内容
    expect(await readFile(linkPath, 'utf-8')).toBe('real')
  })
})

describe('TrashStore 审计（单点写）', () => {
  it('put / restore / purge 各写一条，字段齐全', async () => {
    const audit = new AuditLog({ dir: auditDir })
    const trash = makeStore({ audit })

    const first = join(managedRoot, 'dev')
    await writeFileAt(join(first, 'AGENTS.md'), '# dev\n')
    const putResult = await trash.put('role', 'dev', [first], { managedRoot, trigger: 'MCP' })
    await trash.restore(putResult.id, { trigger: 'HTTP' })

    const second = join(managedRoot, 'qa')
    await writeFileAt(join(second, 'AGENTS.md'), '# qa\n')
    const secondResult = await trash.put('role', 'qa', [second], { managedRoot, trigger: 'CLI' })
    await trash.purge(0, { trigger: 'CLI' })

    const events = await audit.query({
      types: ['trash.put', 'trash.restore', 'trash.purge'],
      order: 'asc',
    })
    expect(events.map((event) => event.type)).toEqual([
      'trash.put',
      'trash.restore',
      'trash.put',
      'trash.purge',
    ])

    const [firstPut, restore, , purge] = events as unknown as Array<Record<string, unknown>>
    expect(firstPut).toMatchObject({
      kind: 'role',
      unit_id: putResult.id,
      trigger: 'MCP',
    })
    expect(firstPut?.['paths']).toEqual([first])
    expect(restore).toMatchObject({ kind: 'role', unit_id: putResult.id, trigger: 'HTTP' })
    expect(restore?.['paths']).toEqual([first])
    expect(purge).toMatchObject({ kind: 'role', unit_id: secondResult.id, trigger: 'CLI' })
    expect(purge?.['paths']).toEqual([second])
    expect(await trash.list()).toEqual([])
  })
})
