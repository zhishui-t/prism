/**
 * TrashStore 并发与失败路径回归（v9 检视 B-1 / B-2 / M-1）。
 *
 * 覆盖：
 * - **B-1** 同秒同名并发 `put`：原子占位下双方各得独立单元、绝不合并、载荷零丢失；
 *   同源并发双删至多一胜，败者干净失败、胜者单元完整；
 * - **B-2** `purge` / `sweep` / `purge --all`（retentionDays=0）不得清掉在途占有的
 *   `.pending` / `.restoring-<pid>`（新鲜 `trash-holder.json`）；登记腐朽后才走残留清理；
 * - **m-2** 带暂存后缀但内含有效 meta 的目录按**正式单元**处理（list 收录、purge 按 meta.deleted_at）；
 * - **restore 互斥（m-1/m-3）**：并发同 id 双 restore 一方 `trash_busy`；新鲜登记不 rm；
 *   有 meta 的同名正式单元绝不 rm；
 * - **M-1** EXDEV 回落「拷贝成功、源删除失败」→ 转正 + `trash_source_residue`，副本完整不销毁。
 *
 * 纪律（AGENTS.md R5）：全部临时目录；`TrashStore` 显式传 `trashDir`，`AuditLog` 显式传 `dir`。
 * 并发用例用**固定时钟** + 给 `.pending` 转正 rename 注入抖动，逼出交错（不靠运气）。
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuditLog,
  TRASH_HOLDER_FILE,
  TRASH_HOLDER_TIMEOUT_MS,
  TrashStore,
} from '../src/index.js'
import type { TrashHolder, TrashStoreOptions } from '../src/index.js'

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

/** 在目录内落一份在途登记（模拟另一方 put/restore 的占有）。 */
async function seedHolder(dir: string, holder: Partial<TrashHolder> = {}): Promise<void> {
  const payload: TrashHolder = {
    pid: process.pid,
    started_at: LOCAL_T0.toISOString(),
    purpose: 'restore',
    ...holder,
  }
  await writeFile(join(dir, TRASH_HOLDER_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

/** 改写单元 meta 的 `deleted_at`（模拟「名字时间戳与 meta 不一致」的边界）。 */
async function patchDeletedAt(unitDir: string, deletedAt: Date): Promise<void> {
  const path = join(unitDir, 'trash-meta.json')
  const meta = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
  meta['deleted_at'] = deletedAt.toISOString()
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
}

/** 给 `.pending` 转正 rename 注入抖动：逼出并发交错（非平台相关，跨平台同解）。 */
function jitterOnPending(delayMs = 5): TrashStoreOptions['fs'] {
  return {
    rename: async (from, to) => {
      if (from.endsWith('.pending')) await sleep(delayMs)
      await rename(from, to)
    },
  }
}

/** 造一个带指定 `code` 的 fs 错误（不依赖平台/文件锁）。 */
function throwObject(code: string): never {
  const error = new Error(`${code}: injected`) as NodeJS.ErrnoException
  error.code = code
  throw error
}

/** 只对 `target` 抛 EXDEV（触发 copy 回落）、只对 `stuck` 抛 EPERM（触发 M-1 残差）。 */
function exdevWithStuckSource(target: string, stuck: string): TrashStoreOptions['fs'] {
  const expected = resolve(target)
  const stuckPath = resolve(stuck)
  return {
    rename: async (from, to) => {
      if (resolve(from) === expected) {
        const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      }
      await rename(from, to)
    },
    rm: async (path, options) => {
      if (resolve(path) === stuckPath) {
        const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      await rm(path, options)
    },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prism-trash-conc-'))
  trashDir = join(root, 'trash')
  managedRoot = join(root, 'roles')
  auditDir = join(root, 'audit')
  await mkdir(managedRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('B-1：并发 put 的名字分配', () => {
  it('同秒同名并发双删 × 10 轮：双方各得独立单元、各含自己载荷、源消失、零丢失', async () => {
    const trash = makeStore()
    for (let round = 0; round < 10; round++) {
      const sourceA = join(managedRoot, `a${round}`, 'dev')
      const sourceB = join(managedRoot, `b${round}`, 'dev')
      await writeFileAt(join(sourceA, 'payload.txt'), `A${round}`)
      await writeFileAt(join(sourceB, 'payload.txt'), `B${round}`)

      const first = await trash.put('role', 'dev', [sourceA], { managedRoot, trigger: 'CLI' })
      const second = await trash.put('role', 'dev', [sourceB], { managedRoot, trigger: 'CLI' })
      expect(first.id).not.toBe(second.id)

      // put 的 originalPaths 与入参一一对应：单元内必须是自己那份载荷
      expect(first.originalPaths).toEqual([sourceA])
      expect(second.originalPaths).toEqual([sourceB])
      expect(await readFile(join(first.unitDir, 'dev', 'payload.txt'), 'utf-8')).toBe(`A${round}`)
      expect(await readFile(join(second.unitDir, 'dev', 'payload.txt'), 'utf-8')).toBe(`B${round}`)
      // 源目录确实被搬走，无残目录
      expect(await exists(sourceA)).toBe(false)
      expect(await exists(sourceB)).toBe(false)
      // 每个单元恰好一个子条目（绝不合并进同一单元）
      expect((await readdir(first.unitDir)).sort()).toEqual(['dev', 'trash-meta.json'])
      expect((await readdir(second.unitDir)).sort()).toEqual(['dev', 'trash-meta.json'])
      expect(await trash.list('role')).toHaveLength((round + 1) * 2)
    }
  })

  it('并发 put 采用 Promise.all 且带转正抖动：不共享 pending、双成功', async () => {
    const trash = makeStore({ fs: jitterOnPending() })
    const sourceA = join(managedRoot, 'x', 'dev')
    const sourceB = join(managedRoot, 'y', 'dev')
    await writeFileAt(join(sourceA, 'payload.txt'), 'A')
    await writeFileAt(join(sourceB, 'payload.txt'), 'B')

    const [first, second] = await Promise.all([
      trash.put('role', 'dev', [sourceA], { managedRoot, trigger: 'MCP' }),
      trash.put('role', 'dev', [sourceB], { managedRoot, trigger: 'MCP' }),
    ])

    expect(first.id).not.toBe(second.id)
    expect(new Set([first.id, second.id])).toEqual(
      new Set([`role/${STAMP_T0}-dev`, `role/${STAMP_T0}-dev-2`]),
    )
    expect(await readFile(join(first.unitDir, 'dev', 'payload.txt'), 'utf-8')).toBe('A')
    expect(await readFile(join(second.unitDir, 'dev', 'payload.txt'), 'utf-8')).toBe('B')
    // 无暂存残留：kind 目录下只有两个正式单元
    expect((await readdir(join(trashDir, 'role'))).sort()).toEqual(
      [`${STAMP_T0}-dev`, `${STAMP_T0}-dev-2`].sort(),
    )
  })

  it('同源并发双删：至多一胜，败者干净失败、胜者单元完整且不合并', async () => {
    const trash = makeStore({ fs: jitterOnPending() })
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'payload.txt'), 'ONLY')

    const results = await Promise.allSettled([
      trash.put('role', 'dev', [source], { managedRoot, trigger: 'HTTP' }),
      trash.put('role', 'dev', [source], { managedRoot, trigger: 'HTTP' }),
    ])
    const won = results.filter((item) => item.status === 'fulfilled')
    const lost = results.filter((item) => item.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)

    // 败者：干净失败（源已被胜者搬走 → ENOENT），不得把胜者的 pending 一起删掉
    const reason = (lost[0] as PromiseRejectedResult).reason as NodeJS.ErrnoException
    expect(reason).toBeInstanceOf(Error)
    expect(['ENOENT', 'trash_unit_conflict']).toContain(reason.code ?? '')

    // 胜者：单元完整、载荷在、源消失、且回收站内没有多余残壳
    const unitDir = won[0].value.unitDir
    expect(await exists(source)).toBe(false)
    expect(await readFile(join(unitDir, 'dev', 'payload.txt'), 'utf-8')).toBe('ONLY')
    expect((await readdir(join(trashDir, 'role'))).sort()).toEqual([basename(unitDir)])
    expect((await trash.list('role')).map((entry) => entry.id)).toEqual([
      (won[0].value as { id: string }).id,
    ])
  })
})

describe('B-2：purge / sweep 不得清掉在途占有', () => {
  /** reviewer 复现场景：10 天前的老单元正被 restore 占有（内含 meta + 新鲜 holder）。 */
  async function oldUnitInFlight(): Promise<{ occupied: string; unitName: string }> {
    const source = join(managedRoot, 'old-role')
    await writeFileAt(join(source, 'AGENTS.md'), 'old')
    const oldStore = makeStore({ now: at(new Date(2026, 8, 10, 10, 0, 0)) })
    const unit = await oldStore.put('role', 'old-role', [source], { managedRoot, trigger: 'CLI' })
    const occupied = `${unit.unitDir}.restoring-4242`
    await rename(unit.unitDir, occupied)
    await seedHolder(occupied, { pid: process.pid, purpose: 'restore' })
    return { occupied, unitName: basename(occupied) }
  }

  it('到期单元在途占有：purge(3) 与 purge(0)（--all）均跳过；登记超时后才清', async () => {
    const { occupied, unitName } = await oldUnitInFlight()
    const trash = makeStore()

    expect(await trash.purge(3)).toEqual([])
    expect(await trash.purge(0)).toEqual([])
    expect(await trash.sweep()).toEqual([])
    expect(await exists(occupied)).toBe(true)

    // 登记回拨超时（> TRASH_HOLDER_TIMEOUT_MS）→ 腐朽 → 按正式单元 meta.deleted_at 到期清除
    await seedHolder(occupied, {
      pid: process.pid,
      started_at: new Date(LOCAL_T0.getTime() - TRASH_HOLDER_TIMEOUT_MS - 60_000).toISOString(),
      purpose: 'restore',
    })
    expect(await trash.purge(3)).toEqual([`role/${unitName}`])
    expect(await exists(occupied)).toBe(false)
  })

  it('在途 `.pending`（无 meta）：新鲜登记连 --all 都不清；腐朽后按目录名时间戳清除', async () => {
    const trash = makeStore()
    const pendingDir = join(trashDir, 'role', `${STAMP_T0}-inflight.pending`)
    await mkdir(pendingDir, { recursive: true })
    await seedHolder(pendingDir, { pid: process.pid, purpose: 'put' })

    expect(await trash.purge(0)).toEqual([])
    expect(await exists(pendingDir)).toBe(true)
    // 新鲜登记也不进 list（在途非单元）
    expect(await trash.list('role')).toEqual([])

    await seedHolder(pendingDir, {
      pid: process.pid,
      started_at: new Date(LOCAL_T0.getTime() - TRASH_HOLDER_TIMEOUT_MS - 60_000).toISOString(),
      purpose: 'put',
    })
    // 腐朽：名字时间戳是今天 → 保留期 3 天不清、--all 才清
    expect(await trash.purge(3)).toEqual([])
    expect(await trash.purge(0)).toEqual([`role/${basename(pendingDir)}`])
    expect(await exists(pendingDir)).toBe(false)
  })

  it('死 pid 的登记不算在途（进程已亡 → 走残留清理）', async () => {
    const { occupied, unitName } = await oldUnitInFlight()
    // 换一个几乎不可能存在的 pid：存活判定必须回落到「腐朽」
    await seedHolder(occupied, { pid: 0x7ffffff, purpose: 'restore' })
    expect(await makeStore().purge(3)).toEqual([`role/${unitName}`])
  })

  it('m-2：带暂存后缀但内含有效 meta 的目录按正式单元处理（list 收录 + purge 按 meta.deleted_at）', async () => {
    const audit = new AuditLog({ dir: auditDir })
    const trash = makeStore({ audit })

    // (a) 名字时间戳是今天、meta 是 10 天前 → 按 meta 到期清除，且审计带 paths
    const freshSource = join(managedRoot, 'fresh-name')
    await writeFileAt(join(freshSource, 'a.txt'), 'A')
    const fresh = await trash.put('role', 'fresh-name', [freshSource], {
      managedRoot,
      trigger: 'CLI',
    })
    const oldMetaName = `${basename(fresh.unitDir)}.pending`
    const oldMetaDir = join(trashDir, 'role', oldMetaName)
    await rename(fresh.unitDir, oldMetaDir)
    await patchDeletedAt(oldMetaDir, new Date(2026, 8, 6, 10, 0, 0))

    const listed = await trash.list('role')
    expect(listed.map((entry) => entry.id)).toEqual([`role/${oldMetaName}`])
    expect(listed[0]).toMatchObject({ broken: false, originalPaths: [freshSource] })

    expect(await trash.purge(3)).toEqual([`role/${oldMetaName}`])
    const events = (await audit.query({
      types: ['trash.put', 'trash.purge'],
      order: 'asc',
    })) as unknown as Array<Record<string, unknown>>
    const purgeEvent = events.find((event) => event['type'] === 'trash.purge')
    expect(purgeEvent?.['paths']).toEqual([freshSource])

    // (b) 名字时间戳是 10 天前、meta 是今天 → 按 meta 判**不**到期
    const staleSource = join(managedRoot, 'stale-name')
    await writeFileAt(join(staleSource, 'b.txt'), 'B')
    const oldStore = makeStore({ now: at(new Date(2026, 8, 10, 10, 0, 0)) })
    const stale = await oldStore.put('role', 'stale-name', [staleSource], {
      managedRoot,
      trigger: 'CLI',
    })
    const newMetaDir = join(trashDir, 'role', `${basename(stale.unitDir)}.pending`)
    await rename(stale.unitDir, newMetaDir)
    await patchDeletedAt(newMetaDir, LOCAL_T0)

    expect(await makeStore().purge(3)).toEqual([])
    expect(await exists(newMetaDir)).toBe(true)
    expect(
      (await makeStore().list('role')).map((entry) => entry.id),
    ).toEqual([`role/${basename(newMetaDir)}`])
  })
})

describe('restore 占有互斥（m-1 / m-3）', () => {
  it('并发同 id 双 restore：一方 trash_busy，胜方完成还原且无单元残留', async () => {
    const trash = makeStore()
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'a.txt'), 'A')
    const { id, unitDir } = await trash.put('role', 'dev', [source], {
      managedRoot,
      trigger: 'CLI',
    })

    const results = await Promise.allSettled([trash.restore(id), trash.restore(id)])
    const won = results.filter((item) => item.status === 'fulfilled')
    const lost = results.filter((item) => item.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'trash_busy' })

    expect(await readFile(join(source, 'a.txt'), 'utf-8')).toBe('A')
    expect(await exists(unitDir)).toBe(false)
    expect(await trash.list()).toEqual([])
  })

  it('新鲜登记的在途占有：restore 报 trash_busy 且绝不 rm 占有目录', async () => {
    const trash = makeStore({ pid: 4242 })
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'a.txt'), 'A')
    const { id, unitDir } = await trash.put('role', 'dev', [source], {
      managedRoot,
      trigger: 'CLI',
    })
    const occupied = `${unitDir}.restoring-4242`
    await rename(unitDir, occupied)
    await seedHolder(occupied, { pid: process.pid, purpose: 'restore' })

    await expect(trash.restore(id)).rejects.toMatchObject({ code: 'trash_busy' })
    expect(await exists(occupied)).toBe(true)
    expect(await readFile(join(occupied, 'dev', 'a.txt'), 'utf-8')).toBe('A')

    // 摘掉登记后仍拒绝：按三态判据它是**正式单元**（有 meta 无 holder），绝不 rm（m-3）
    await rm(join(occupied, TRASH_HOLDER_FILE), { force: true })
    await expect(trash.restore(id)).rejects.toMatchObject({ code: 'trash_busy' })
    expect(await exists(occupied)).toBe(true)
    // 但它以自身 id 可正常还原（m-2：后缀名 + 有 meta = 正式单元）
    expect(await trash.restore(`role/${basename(occupied)}`)).toEqual([source])
    expect(await readFile(join(source, 'a.txt'), 'utf-8')).toBe('A')
  })

  it('陈旧占位残壳（无 meta 无登记）被清除后重占，恢复不受影响', async () => {
    const trash = makeStore({ pid: 4242 })
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'a.txt'), 'A')
    const { id, unitDir } = await trash.put('role', 'dev', [source], {
      managedRoot,
      trigger: 'CLI',
    })
    const occupied = `${unitDir}.restoring-4242`
    await mkdir(occupied, { recursive: true })

    expect(await trash.restore(id)).toEqual([source])
    expect(await readFile(join(source, 'a.txt'), 'utf-8')).toBe('A')
    expect(await exists(occupied)).toBe(false)
    expect(await exists(unitDir)).toBe(false)
  })
})

describe('M-1：EXDEV 回落「拷贝成功、源删除失败」保副本', () => {
  it('源 rm 失败 → 转正 + trash_source_residue，单元完整可 list，源残留保留', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'payload.txt'), 'PAYLOAD')
    const audit = new AuditLog({ dir: auditDir })
    const trash = makeStore({ fs: exdevWithStuckSource(source, source), audit })

    const error = (await trash
      .put('role', 'dev', [source], { managedRoot, trigger: 'HTTP' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      )) as { code?: string; message?: string; details?: Record<string, unknown> }
    expect(error).toMatchObject({
      code: 'trash_source_residue',
      details: { id: `role/${STAMP_T0}-dev`, residue_path: resolve(source) },
    })
    // 源残留仍在（本次刻意没删干净），报错消息必须同时指明单元 id 与残留路径
    expect(await exists(source)).toBe(true)
    expect(error.message).toContain(resolve(source))
    expect(error.message).toContain(`role/${STAMP_T0}-dev`)

    // 单元已转正：list 收录、meta 指向源、载荷完整、无 pending 残留
    const listed = await trash.list('role')
    expect(listed.map((entry) => entry.id)).toEqual([`role/${STAMP_T0}-dev`])
    expect(listed[0]).toMatchObject({ broken: false, originalPaths: [source] })
    const unitDir = join(trashDir, 'role', `${STAMP_T0}-dev`)
    expect(await readFile(join(unitDir, 'dev', 'payload.txt'), 'utf-8')).toBe('PAYLOAD')
    expect(await readdir(join(trashDir, 'role'))).toEqual([`${STAMP_T0}-dev`])

    // 审计：转正后照写 trash.put（trigger 与入口一致）
    const events = (await audit.query({
      types: ['trash.put'],
      order: 'asc',
    })) as unknown as Array<Record<string, unknown>>
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ unit_id: `role/${STAMP_T0}-dev`, trigger: 'HTTP' })
    expect(events[0]?.['paths']).toEqual([source])
  })

  it('回滚不得销毁已成功复制的内容（EXDEV 副本是唯一一份时尤其）', async () => {
    const sourceA = join(managedRoot, 'a', 'dev')
    const sourceB = join(managedRoot, 'b', 'dev')
    await writeFileAt(join(sourceA, 'payload.txt'), 'ONLY-COPY')
    await writeFileAt(join(sourceB, 'payload.txt'), 'B')
    const pendingDir = join(trashDir, 'role', `${STAMP_T0}-dev.pending`)

    const trash = makeStore({
      fs: {
        rename: async (from, to) => {
          const path = resolve(from)
          // 第一个条目走 EXDEV 回落 → copy 成功、源被删（副本成为唯一一份）
          if (path === resolve(sourceA)) throwObject('EXDEV')
          // 第二个条目直接失败 → 触发回滚
          if (path === resolve(sourceB)) throwObject('EPERM')
          // 回滚搬回也失败 → 副本只能留在 pending 里
          if (path === resolve(join(pendingDir, 'dev'))) throwObject('EPERM')
          await rename(from, to)
        },
      },
    })

    await expect(
      trash.put('role', 'dev', [sourceA, sourceB], { managedRoot, trigger: 'CLI' }),
    ).rejects.toMatchObject({ code: 'EPERM' })

    // 源已被 copy 阶段删掉、搬回又失败 → 副本必须仍在（旧实现会 rm -rf pending 直接销毁）
    expect(await exists(sourceA)).toBe(false)
    expect(await exists(pendingDir)).toBe(true)
    expect(await readFile(join(pendingDir, 'dev', 'payload.txt'), 'utf-8')).toBe('ONLY-COPY')
  })

  it('转正失败 → 保留 pending 并在错误里给出路径，内容不销毁', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'payload.txt'), 'PAYLOAD')
    const base = exdevWithStuckSource(source, source)
    const trash = makeStore({
      fs: {
        rename: async (from, to) => {
          if (from.endsWith('.pending')) {
            const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
            error.code = 'EPERM'
            throw error
          }
          await base!.rename(from, to)
        },
        rm: base!.rm,
      },
    })

    const pendingDir = join(trashDir, 'role', `${STAMP_T0}-dev.pending`)
    await expect(
      trash.put('role', 'dev', [source], { managedRoot, trigger: 'CLI' }),
    ).rejects.toMatchObject({
      code: 'trash_source_residue',
      details: { pending_dir: pendingDir },
    })

    expect(await exists(pendingDir)).toBe(true)
    expect(await readFile(join(pendingDir, 'dev', 'payload.txt'), 'utf-8')).toBe('PAYLOAD')
    expect(await exists(join(pendingDir, 'trash-meta.json'))).toBe(true)
    expect(await exists(join(trashDir, 'role', `${STAMP_T0}-dev`))).toBe(false)
  })
})

describe('R-1：转正失败的 preservePending 态不得被 purge 当正式单元清除', () => {
  /**
   * 注入 fs：EXDEV（触发 copy 回落）+ 源 rm EPERM（产生残差）+ pending 转正 rename EPERM
   * （触发 preservePending）。转正那次**不能抛 EXDEV**——抛 EXDEV 会走 copy 回落而非保留态。
   */
  function stuckPutFs(source: string): TrashStoreOptions['fs'] {
    const sourcePath = resolve(source)
    return {
      rename: async (from, to) => {
        if (resolve(from) === sourcePath) throwObject('EXDEV')
        if (from.endsWith('.pending')) throwObject('EPERM')
        await rename(from, to)
      },
      rm: async (path, options) => {
        if (resolve(path) === sourcePath) throwObject('EPERM')
        await rm(path, options)
      },
    }
  }

  it('put 报 trash_source_residue；purge(0)/(3) 后 pending 仍在且内容完整、holder 新鲜；腐朽后才清', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'payload.txt'), 'PAYLOAD')
    const trash = makeStore({ fs: stuckPutFs(source) })
    const pendingDir = join(trashDir, 'role', `${STAMP_T0}-dev.pending`)

    const error = (await trash
      .put('role', 'dev', [source], { managedRoot, trigger: 'CLI' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      )) as { code?: string; message?: string; details?: Record<string, unknown> }
    expect(error).toMatchObject({
      code: 'trash_source_residue',
      details: { pending_dir: pendingDir },
    })

    // R-1 核心：保留态是**在途**（有 meta 且 holder 新鲜），正式单元的到期判定不得落到它头上
    expect(await trash.purge(0)).toEqual([])
    expect(await trash.purge(3)).toEqual([])
    expect(await exists(pendingDir)).toBe(true)
    expect(await readFile(join(pendingDir, 'dev', 'payload.txt'), 'utf-8')).toBe('PAYLOAD')
    expect(await exists(join(pendingDir, 'trash-meta.json'))).toBe(true)

    // 唯一完整副本必须仍受新鲜登记保护（purge 见登记即跳过）
    const holder = JSON.parse(
      await readFile(join(pendingDir, TRASH_HOLDER_FILE), 'utf-8'),
    ) as TrashHolder
    expect(holder).toEqual({
      pid: process.pid,
      started_at: LOCAL_T0.toISOString(),
      purpose: 'put',
    })

    // 登记腐朽（时钟前拨超时）→ 残留兜底仍在：按 meta.deleted_at 到期，--all 可清
    const rotted = at(new Date(LOCAL_T0.getTime() + TRASH_HOLDER_TIMEOUT_MS + 60_000))
    expect(await trash.purge(0, { now: rotted })).toEqual([`role/${basename(pendingDir)}`])
    expect(await exists(pendingDir)).toBe(false)
  })

  it('转正成功的单元不留 holder（撤登记已后置，不得把正式单元锁成不可清）', async () => {
    const source = join(managedRoot, 'dev')
    await writeFileAt(join(source, 'payload.txt'), 'PAYLOAD')
    const trash = makeStore({ fs: exdevWithStuckSource(source, source) })

    await expect(
      trash.put('role', 'dev', [source], { managedRoot, trigger: 'CLI' }),
    ).rejects.toMatchObject({ code: 'trash_source_residue' })

    const unitDir = join(trashDir, 'role', `${STAMP_T0}-dev`)
    expect(await exists(join(unitDir, TRASH_HOLDER_FILE))).toBe(false)
    // 无登记 + meta 是今天 → 默认保留期不动，--all 才是它的清除口径
    expect(await trash.purge(3)).toEqual([])
    expect(await trash.purge(0)).toEqual([`role/${STAMP_T0}-dev`])
  })
})
