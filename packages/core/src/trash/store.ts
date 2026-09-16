import type { Dirent } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { AuditEventInput, AuditLog, TrashTrigger } from '../audit/audit-log.js'
import { TRASH_TRIGGERS } from '../audit/audit-log.js'
import { prismPaths } from '../config/paths.js'
import { PrismError } from '../state/errors.js'
import { isInside } from './is-inside.js'

/**
 * TrashStore — 删除回收站（第九轮 F3，`design-v9.md` §3）。
 *
 * 形态：`<trashDir>/<kind>/<yyyyMMdd-HHmmss>-<消毒名>/`（原文件/目录 + `trash-meta.json` 平铺）。
 * 纯文件系统 + 纯函数，零第三方依赖；目录单元可直视、可手动恢复。
 *
 * 设计代价与对策（R-v9-1「代价自认」）：
 * - 多文件移动非原子 → **pending 定界**：先落 `<unit>.pending/` 再整体 rename 成正式名，
 *   崩溃残留由 purge/sweep 兜底清除；
 * - 跨卷移动 EXDEV → **copy + 递归删除**，软链重建（无权限退化解引用拷贝）；
 * - 同秒同名 → **换后缀，禁止合并进既有单元**（合并会让两次删除互相覆盖）。
 *
 * v9 检视整改（B-1 / B-2 / M-1，`code-review-v9.md` §2）：
 * - **B-1 原子占位**：候选 pending 目录用**非 recursive** `mkdir` 独占创建，`EEXIST` = 名字被
 *   并发调用占走 → 换后缀重试。检查-后-创建不再作为分配依据；回滚只回收**本次**搬入的条目；
 * - **B-2 存活登记**：暂存/占有目录内写 `trash-holder.json`（`{pid, started_at, purpose}`）。
 *   purge/sweep 见**新鲜存活**登记一律跳过（`--all` 也不得绕过）；登记缺失/损坏/超时
 *   才按崩溃残留清理。**有 meta 即正式单元**（与名字后缀无关）；
 * - **M-1 宁可重复不可丢失**：EXDEV「副本已完整落盘、源删除失败」抛
 *   `TrashSourceResidueError`，`put` 据此**转正**单元并报 `trash_source_residue`；
 *   通用回滚禁止销毁承载已成功复制内容的 pending。
 */

/** 单元内固定文件名（snake_case，与 §3 契约一致）。 */
export const TRASH_META_FILE = 'trash-meta.json'

/** 在途占有登记文件名（put 的暂存目录 / restore 的占有目录内）。 */
export const TRASH_HOLDER_FILE = 'trash-holder.json'

/** 登记有效期（30 分钟）：超时的登记视为崩溃残留，不再保护（B-2）。 */
export const TRASH_HOLDER_TIMEOUT_MS = 30 * 60 * 1000

/** 在途登记内容（`TRASH_HOLDER_FILE`）。 */
export interface TrashHolder {
  pid: number
  /** ISO 时刻：超过 `TRASH_HOLDER_TIMEOUT_MS` 即视为腐朽。 */
  started_at: string
  purpose: 'put' | 'restore'
}

/** `PRISM_TRASH_RETENTION_DAYS` 的缺省值与合法上界。 */
export const DEFAULT_TRASH_RETENTION_DAYS = 3
export const MAX_TRASH_RETENTION_DAYS = 3650

const DAY_MS = 86_400_000
/** 与 `packages/server/src/http/routes/arch.ts:144` 同口径的单元名消毒。 */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/
const TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/
/** 暂存/占有态后缀：`<unit>.pending`、`<unit>.restoring-<pid>`。 */
const TRANSIENT_RE = /\.(?:pending|restoring-\d+)$/
/** 单元名后缀重试上限（P1 原子占位冲突时换 `-2`/`-3`…）。 */
const MAX_NAME_ATTEMPTS = 1000

/** 可注入的 rename（仅此一处需要注入即可覆盖 EXDEV 回落路径）。 */
export type TrashRename = (from: string, to: string) => Promise<void>

/** 可注入的删除（**只为测试可确定性复现 M-1**；缺省 = 真 `rm`）。 */
export type TrashRemove = (
  path: string,
  options?: { recursive?: boolean; force?: boolean },
) => Promise<void>

export interface TrashFsLike {
  rename: TrashRename
  rm?: TrashRemove
}

/** 方法内使用的 fs 面（方法级覆盖已与构造期设置合并）。 */
interface TrashFs {
  rename: TrashRename
  rm: TrashRemove
}

/**
 * **内部**错误：EXDEV 回落中「副本已完整落盘、源删除失败」（M-1）。
 *
 * `put` 捕获它后**转正单元**并抛 `PrismError('trash_source_residue')`；绝不走通用回滚
 * ——那会把唯一一份副本连 pending 一起 `rm` 掉。属于模块内部信号，不是对外错误码。
 */
export class TrashSourceResidueError extends Error {
  readonly source: string
  readonly landed: string
  readonly reason: unknown

  constructor(source: string, landed: string, reason: unknown) {
    super(`源目录残留未清除：${source}（副本已完整落在 ${landed}）`)
    this.name = 'TrashSourceResidueError'
    this.source = source
    this.landed = landed
    this.reason = reason
  }
}

/** `put` 的调用方元信息。 */
export interface TrashPutMeta {
  /** 受管根（rolesDir | teamsDir | skillsDir 之一）；restore 用它给回写目标定界。 */
  managedRoot: string
  trigger: TrashTrigger
  reason?: string
}

/** `trash-meta.json` 的落盘形态（字段冻结，勿随意增删）。 */
export interface TrashUnitMeta {
  original_paths: string[]
  managed_root: string
  deleted_at: string
  trigger: TrashTrigger
  reason?: string
}

/** `list()` 的返回项。`id = '<kind>/<单元目录名>'`，restore/purge 按它寻址。 */
export interface TrashEntry {
  id: string
  kind: string
  name: string
  deletedAt: string
  originalPaths: string[]
  managedRoot?: string
  /** 无 meta / meta 损坏 → true（不可自动 restore，只能 purge 或手工处理）。 */
  broken?: boolean
}

export interface TrashPutResult {
  /** `<kind>/<单元目录名>`，与 `list()` 的 id 同源。 */
  id: string
  unitDir: string
  originalPaths: string[]
}

export interface TrashStoreOptions {
  /** 回收站根目录；默认 `<PRISM_HOME>/trash`（`prismPaths().trashDir`）。 */
  trashDir?: string
  /** 审计单点：传入即写 `trash.put` / `trash.restore` / `trash.purge`。 */
  audit?: AuditLog
  /** 可注入时钟（测试用）。 */
  now?: () => Date
  /** 占有后缀使用的 pid（测试可固定，保证目录名可断言）。 */
  pid?: number
  /** 可注入 fs 面（测试覆盖 EXDEV 回落与 M-1 源删除失败）。 */
  fs?: TrashFsLike
}

/** 方法级依赖覆盖（测试注入；缺省回落构造期设置）。 */
export interface TrashPutDeps {
  now?: () => Date
  fs?: TrashFsLike
}

export interface TrashRestoreOptions {
  /** true 才允许覆盖已存在的目标路径（默认 false → `target_exists`）。 */
  overwrite?: boolean
  /** 触发入口，仅用于审计；默认 `'CLI'`。 */
  trigger?: TrashTrigger
}

export interface TrashPurgeOptions {
  /** 可注入时钟（测试用）。 */
  now?: () => Date
  /** 触发入口，仅用于审计；默认 `'CLI'`。 */
  trigger?: TrashTrigger
}

/** 目录项三态判定结果（`#unitState`）。 */
interface UnitState {
  /** 新鲜存活 holder（在途 put/restore）→ purge/sweep 无条件跳过、list 不收录。 */
  inFlight: boolean
  /** 有效 meta（**有 meta 即正式单元**，与名字后缀无关——m-2）。 */
  meta: TrashUnitMeta | null
  /** 名字带 `.pending` / `.restoring-<pid>` 后缀。 */
  transientName: boolean
}

/**
 * 解析回收站保留天数：合法域为 **1–3650 整数**，越界/非法一律回落 3。
 *
 * **调用时读取**环境变量（不是模块加载期固化），便于测试注入与运行期改配置。
 */
export function resolveTrashRetentionDays(
  raw: string | undefined = process.env['PRISM_TRASH_RETENTION_DAYS'],
): number {
  const text = (raw ?? '').trim()
  if (!/^\d+$/.test(text)) return DEFAULT_TRASH_RETENTION_DAYS
  const days = Number(text)
  return days >= 1 && days <= MAX_TRASH_RETENTION_DAYS ? days : DEFAULT_TRASH_RETENTION_DAYS
}

/** 消毒单元名/kind 段：`[^A-Za-z0-9_.-] → _`（同 `arch.ts:144`）。 */
function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** 单元目录名的时间戳前缀（本地时间，与目录名解析对称）。 */
function formatStamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 从单元目录名解析删除时刻（本地时间 → 毫秒）；解析不出返回 null。 */
function stampMs(name: string): number | null {
  const matched = TIMESTAMP_RE.exec(name)
  if (matched == null) return null
  const [, y, mo, d, h, mi, s] = matched
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
}

/** 单元目录名的 `name` 部分（剥掉时间戳前缀；无前缀则原样返回）。 */
function unitDisplayName(unitName: string): string {
  return unitName.replace(/^\d{8}-\d{6}-/, '') || unitName
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** 同单元内 basename 去重（不覆盖）：`x` → `x-2` → `x-3`…… */
function uniqueChildName(base: string, used: Set<string>): string {
  if (base === '') return base
  let candidate = base
  let index = 2
  while (used.has(candidate)) {
    candidate = `${base}-${index}`
    index++
  }
  used.add(candidate)
  return candidate
}

/**
 * 搬移一个单元：优先 rename；跨卷（EXDEV）回落「递归 copy + 递归删除」。
 *
 * 除两处外错误原样抛出——静默吞掉会让「文件没搬走但调用方以为删了」：
 * - `EXDEV` → 走 copy 回落；
 * - `EXDEV` 回落时「copy 成功、源删除失败」→ `TrashSourceResidueError`（M-1）：
 *   此时**副本已是完整的一份**，调用方必须转正而不是回滚销毁。
 */
async function movePath(from: string, to: string, fs: TrashFs): Promise<void> {
  try {
    await fs.rename(from, to)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await copyTree(from, to)
  try {
    await fs.rm(from, { recursive: true, force: true })
  } catch (error) {
    throw new TrashSourceResidueError(from, to, error)
  }
}

/** 递归复制，**保留软链**（软链既非 file 也非 dir，漏掉会静默丢条目）。 */
async function copyTree(from: string, to: string): Promise<void> {
  const info = await lstat(from)
  if (info.isSymbolicLink()) {
    await copyLink(from, to)
    return
  }
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from)) {
      await copyTree(join(from, entry), join(to, entry))
    }
    return
  }
  await copyFile(from, to)
}

/**
 * 重建软链；无权限（Windows 建链需开发者模式/管理员）时退化为**解引用拷贝**。
 * 与 `scripts/archive.mjs` 的 `copyLink` 同口径——上游 dylib 版本链就靠这一条。
 */
async function copyLink(from: string, to: string): Promise<void> {
  const target = await readlink(from)
  try {
    await symlink(target, to)
  } catch {
    await copyFile(from, to)
  }
}

/** 解析 `trash-meta.json`；缺失/损坏返回 null（调用方据此标 broken）。 */
async function readUnitMeta(unitDir: string): Promise<TrashUnitMeta | null> {
  let raw: string
  try {
    raw = await readFile(join(unitDir, TRASH_META_FILE), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TrashUnitMeta>
    if (!Array.isArray(parsed.original_paths)) return null
    if (typeof parsed.managed_root !== 'string' || parsed.managed_root === '') return null
    if (typeof parsed.deleted_at !== 'string' || parsed.deleted_at === '') return null
    if (!TRASH_TRIGGERS.includes(parsed.trigger as TrashTrigger)) return null
    return {
      original_paths: parsed.original_paths.map((item) => String(item)),
      managed_root: parsed.managed_root,
      deleted_at: parsed.deleted_at,
      trigger: parsed.trigger as TrashTrigger,
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    }
  } catch {
    return null
  }
}

/** 解析在途登记；缺失/损坏（字段类型不对、purpose 越界）返回 null（视为无登记）。 */
async function readHolder(dir: string): Promise<TrashHolder | null> {
  let raw: string
  try {
    raw = await readFile(join(dir, TRASH_HOLDER_FILE), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TrashHolder>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
    if (typeof parsed.started_at !== 'string' || parsed.started_at === '') return null
    if (parsed.purpose !== 'put' && parsed.purpose !== 'restore') return null
    return { pid: parsed.pid, started_at: parsed.started_at, purpose: parsed.purpose }
  } catch {
    return null
  }
}

/**
 * 进程存活判定：`process.kill(pid, 0)` 只发信号 0（探测）。
 * `EPERM` = 进程存在但无权限（**活**）；`ESRCH` = 不存在（**死**）；其余一律按死处理。
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 登记是否「新鲜存活」：pid 活着且未超时。缺失/损坏/超时一律不算在途（B-2）。 */
function holderIsLive(holder: TrashHolder | null, nowMs: number): boolean {
  if (holder == null) return false
  const started = Date.parse(holder.started_at)
  if (Number.isNaN(started)) return false
  if (nowMs - started >= TRASH_HOLDER_TIMEOUT_MS) return false
  return processAlive(holder.pid)
}

/** 写一份在途登记（与 meta 同形的 JSON 落盘）。 */
async function writeHolder(path: string, holder: TrashHolder): Promise<void> {
  await writeFile(path, `${JSON.stringify(holder, null, 2)}\n`, 'utf-8')
}

/** 把 `error` 描述成可嵌进文案的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析 `<kind>/<单元目录名>`。id 来自 CLI/HTTP，按**不可信入参**处理：
 * 两段都必须落在消毒字符集内且非 `.`/`..`，否则一律 `not_found`。
 */
function parseTrashId(id: string): { kind: string; unitName: string } {
  const separator = id.indexOf('/')
  const illegal = (segment: string): boolean =>
    !SEGMENT_RE.test(segment) || segment === '.' || segment === '..'
  if (separator <= 0) {
    throw new PrismError('not_found', `非法回收站 id：${id}`, { id })
  }
  const kind = id.slice(0, separator)
  const unitName = id.slice(separator + 1)
  if (illegal(kind) || illegal(unitName)) {
    throw new PrismError('not_found', `非法回收站 id：${id}`, { id })
  }
  return { kind, unitName }
}

export class TrashStore {
  readonly trashDir: string
  readonly #audit: AuditLog | undefined
  readonly #now: () => Date
  readonly #pid: number
  readonly #rename: TrashRename
  readonly #rm: TrashRemove
  /** 同进程在途 restore 的 id（跨进程由 holder 登记 + 原子 rename 定界）。 */
  readonly #restoring = new Set<string>()

  constructor(options: TrashStoreOptions = {}) {
    this.trashDir = options.trashDir ?? prismPaths().trashDir
    this.#audit = options.audit
    this.#now = options.now ?? (() => new Date())
    this.#pid = options.pid ?? process.pid
    this.#rename = options.fs?.rename ?? rename
    this.#rm = options.fs?.rm ?? rm
  }

  /**
   * 把 `paths[]`（实际落点的绝对路径，整目录或整文件）搬进一个新单元。
   *
   * 顺序：**原子占位** `<unit>.pending/`（非 recursive `mkdir`）→ 写 holder → 逐项搬移
   * → 写 meta → 整体 rename 成正式名 → **撤 holder**（R-1：撤登记必须在转正**之后**）。
   *
   * 失败分三档（M-1 起口径变更）：
   * - 普通失败 → 把**本次**已搬入的条目搬回；pending 只有在本轮**没有任何成功落盘内容**
   *   时才允许清掉（绝不 `rm -rf` 承载副本的目录）；
   * - EXDEV「副本完整、源残留」→ **转正单元** + 写审计 + 抛 `trash_source_residue`；
   * - 转正本身失败 → 保留 pending（**并重写新鲜 holder**，见下）并在错误里给出路径（同样不删）。
   *
   * **崩溃**残留的 `.pending`（无登记/登记超时）由 `purge`/`sweep` 兜底清除；
   * 在途（登记新鲜存活）的目录一律受保护。
   */
  async put(
    kind: string,
    name: string,
    paths: readonly string[],
    meta: TrashPutMeta,
    deps: TrashPutDeps = {},
  ): Promise<TrashPutResult> {
    const now = deps.now ?? this.#now
    const fs = this.#fsOf(deps.fs)
    const safeKind = sanitizeSegment(kind)
    const safeName = sanitizeSegment(name) || 'unit'

    const trashKindDir = join(this.trashDir, safeKind)
    // kind 已消毒，此处是自证式定界（入参形状若被改坏必须立刻炸，而不是写到回收站外）
    if (!isInside(this.trashDir, trashKindDir)) {
      throw new PrismError('trash_path_escape', `回收站单元越出回收站根：${kind}`, {
        kind,
        trashDir: this.trashDir,
      })
    }
    await mkdir(trashKindDir, { recursive: true })

    const { unitName, unitDir, pendingDir } = await this.#reserveUnit(
      trashKindDir,
      `${formatStamp(now())}-${safeName}`,
    )
    const id = `${safeKind}/${unitName}`
    const holderPath = join(pendingDir, TRASH_HOLDER_FILE)
    const moved: Array<{ source: string; landed: string }> = []
    /** 转正失败时置位：保留 pending 原样退出，不走通用回滚（M-1）。 */
    let preservePending = false

    try {
      // 独占占位成功后**先写 holder 再搬条目**：purge/sweep 见到新鲜登记即跳过（B-2）
      await writeHolder(holderPath, {
        pid: this.#pid,
        started_at: now().toISOString(),
        purpose: 'put',
      })

      let residue: { source: string; landed: string } | null = null
      const used = new Set<string>()
      for (const source of paths) {
        const from = resolve(source)
        const landed = join(pendingDir, uniqueChildName(basename(from), used))
        try {
          await movePath(from, landed, fs)
        } catch (error) {
          if (!(error instanceof TrashSourceResidueError)) throw error
          // M-1：副本已完整落在 pending、只是源没删干净 → **停止**搬后续条目，走转正
          residue = { source: error.source, landed: error.landed }
          break
        }
        moved.push({ source: from, landed })
      }

      // 残差条目的副本是完整的 → 与已搬入条目一并写进 meta（宁可重复不可丢失）
      const landedAll = residue == null ? moved : [...moved, residue]
      const unitMeta: TrashUnitMeta = {
        original_paths: landedAll.map((item) => item.source),
        managed_root: resolve(meta.managedRoot),
        deleted_at: now().toISOString(),
        trigger: meta.trigger,
        ...(meta.reason != null ? { reason: meta.reason } : {}),
      }
      await writeFile(
        join(pendingDir, TRASH_META_FILE),
        `${JSON.stringify(unitMeta, null, 2)}\n`,
        'utf-8',
      )
      // R-1：**不在此处撤登记**——转正失败时 pending 会成为唯一完整副本，撤了登记它就成了
      // 「有 meta、无 holder」的形态，purge 会按新鲜 meta 判到期（`--all`/retention 0 直接删）。
      // 撤登记一律后置到转正成功之后。

      if (residue == null) {
        await movePath(pendingDir, unitDir, fs)
        // 转正成功后对新落点撤登记（best-effort）：撤除前的微窗口内正式单元带新鲜 holder，
        // 后果是 purge 跳过它（安全方向）、list 短暂不收录（登记腐朽后自愈），可接受。
        await fs.rm(join(unitDir, TRASH_HOLDER_FILE), { force: true }).catch(() => {})
        await this.#record({
          type: 'trash.put',
          kind: safeKind,
          unit_id: id,
          trigger: meta.trigger,
          paths: landedAll.map((item) => item.source),
        })
        return { id, unitDir, originalPaths: landedAll.map((item) => item.source) }
      }

      try {
        await movePath(pendingDir, unitDir, fs)
      } catch (promoteError) {
        preservePending = true
        // R-1：转正失败 → pending 里是**唯一一份完整副本**。重写新鲜登记使其对 purge/sweep
        // 呈现在途（否则「有 meta 无 holder」会被 `--all` 当到期正式单元清除）。
        await writeHolder(holderPath, {
          pid: this.#pid,
          started_at: now().toISOString(),
          purpose: 'put',
        }).catch(() => {})
        throw new PrismError(
          'trash_source_residue',
          `删除已复制入暂存但单元未能转正：单元 ${id} 的完整副本保留在 ${pendingDir}` +
            `（原因：${describeError(promoteError)}）；原位置仍有残留：${residue.source}` +
            '。请先手工处理该暂存目录（勿直接删除）。',
          {
            id,
            unit_id: id,
            pending_dir: pendingDir,
            residue_path: residue.source,
          },
        )
      }
      // 转正成功（残差路径）：同样对新落点撤登记（best-effort），R-1 后置
      await fs.rm(join(unitDir, TRASH_HOLDER_FILE), { force: true }).catch(() => {})
      await this.#record({
        type: 'trash.put',
        kind: safeKind,
        unit_id: id,
        trigger: meta.trigger,
        paths: landedAll.map((item) => item.source),
      })
      throw new PrismError(
        'trash_source_residue',
        `已删除并移入回收站（单元 ${id}），但原位置仍有残留未清除：${residue.source}` +
          `。内容已完整保存在单元 ${id}（可 list/restore），请手工删除残留。`,
        { id, unit_id: id, residue_path: residue.source },
      )
    } catch (error) {
      if (preservePending || error instanceof TrashSourceResidueError) throw error
      await this.#rollbackPut(moved, pendingDir, fs, error)
      throw error
    }
  }

  /**
   * 列出回收站单元（可选按 kind 过滤），**最新在前**。
   * 在途态与崩溃残留（带暂存后缀且无 meta）不算单元；**带 meta 的即单元**（m-2）。
   */
  async list(kind?: string): Promise<TrashEntry[]> {
    const kinds = kind != null ? [sanitizeSegment(kind)] : await this.#kinds()
    const nowMs = this.#now().getTime()
    const entries: TrashEntry[] = []
    for (const current of kinds) {
      const kindDir = join(this.trashDir, current)
      for (const unitName of await readdir(kindDir).catch(() => [] as string[])) {
        const unitDir = join(kindDir, unitName)
        const state = await this.#unitState(unitDir, unitName, nowMs)
        if (state.inFlight || (state.transientName && state.meta == null)) continue
        const info = await stat(unitDir).catch(() => null)
        if (info == null || !info.isDirectory()) continue
        const parsed = stampMs(unitName)
        entries.push(
          this.#describe(
            current,
            unitName,
            state.meta,
            parsed == null ? info.mtime.toISOString() : new Date(parsed).toISOString(),
          ),
        )
      }
    }
    entries.sort(
      (a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id),
    )
    return entries
  }

  /**
   * 恢复单元到原路径。
   *
   * 先整目录 rename 成 `<unit>.restoring-<pid>` **原子占有**，再逐项搬回——
   * 与 `purge`/`sweep` 的竞态以此定界（同名单元只可能被一方拿到）。
   * 回写目标**只信任 `meta.managed_root` 的定界**：meta 可被篡改，
   * 越界一律拒绝并提示手工恢复（v9.1 C-4）。半程失败会回滚，单元保持完整。
   *
   * 互斥（B-2 / m-1 / m-3）：占位前先在单元目录内写 `purpose:'restore'` 登记再 rename
   * （登记随目录进入占有态，"已占有未登记"的窗口不存在）；已有**新鲜登记**的占有目录
   * 一律 `trash_busy`，有 meta 的（正式单元名）**绝不 rm**；同进程并发同 id 由在途表直接拒绝。
   */
  async restore(id: string, options: TrashRestoreOptions = {}): Promise<string[]> {
    const { kind, unitName } = parseTrashId(id)
    const kindDir = join(this.trashDir, kind)
    const unitDir = join(kindDir, unitName)
    if (!isInside(this.trashDir, unitDir)) {
      throw new PrismError('trash_path_escape', `回收站单元越出回收站根：${id}`, { id })
    }
    if (this.#restoring.has(id)) {
      throw new PrismError('trash_busy', `回收站单元正在恢复中（同进程并发）：${id}`, { id })
    }
    this.#restoring.add(id)
    try {
      return await this.#restoreLocked(id, kind, unitDir, options)
    } finally {
      this.#restoring.delete(id)
    }
  }

  /**
   * 清除**到期**单元（`deleted_at` 早于 `now - retentionDays`），返回被清除的 id 列表。
   *
   * - **幂等**：目录已不在（ENOENT）视为成功；
   * - **在途保护**：内含新鲜存活 holder 的目录**无条件跳过**——`retentionDays=0`
   *   （CLI `--all`）也不得绕过（B-2）；
   * - 顺带清崩溃残留（`.pending` / `.restoring-<pid>`，无 meta 且登记缺失/腐朽）
   *   与 broken 单元，二者按**目录名内时间戳**判到期——正是崩溃残留「无 meta 可依」的兜底；
   * - 每个被清除的单元写一条 `trash.purge` 审计（`unit_id` 需要单元级粒度，
   *   否则多单元一次 purge 的事件无法挂到具体单元）。
   */
  async purge(retentionDays: number = resolveTrashRetentionDays(), options: TrashPurgeOptions = {}): Promise<string[]> {
    const now = options.now ?? this.#now
    const nowMs = now().getTime()
    const cutoff = nowMs - retentionDays * DAY_MS
    const purged: string[] = []
    for (const kind of await this.#kinds()) {
      const kindDir = join(this.trashDir, kind)
      for (const unitName of await readdir(kindDir).catch(() => [] as string[])) {
        const unitDir = join(kindDir, unitName)
        const info = await stat(unitDir).catch(() => null)
        if (info == null) continue
        const state = await this.#unitState(unitDir, unitName, nowMs)
        // 在途（新鲜登记）：purge / sweep / --all 一律不得清（B-2）
        if (state.inFlight) continue
        // 有 meta 即正式单元：按 meta.deleted_at；无 meta 的暂存/未知目录按目录名时间戳
        const meta = state.meta
        const deletedAt = meta == null ? stampMs(unitName) : Date.parse(meta.deleted_at)
        const expiry = deletedAt == null || Number.isNaN(deletedAt) ? stampMs(unitName) : deletedAt
        // 解析不到时间就**不删**（保守：宁可留着也不要误删未知内容）
        if (expiry == null || expiry > cutoff) continue
        await this.#rm(unitDir, { recursive: true, force: true })
        purged.push(`${kind}/${unitName}`)
        await this.#record({
          type: 'trash.purge',
          kind,
          unit_id: `${kind}/${unitName}`,
          trigger: options.trigger ?? 'CLI',
          ...(meta != null ? { paths: meta.original_paths } : {}),
        })
      }
    }
    return purged
  }

  /**
   * `serve` 启动 + 每小时调用的入口：按默认保留期清到期单元与崩溃残留。
   * 定时器归属与关停由 `serve` 命令持有（C-8）；纯 CLI 用户靠 `prism trash purge` 兜底（I-4）。
   */
  async sweep(options: TrashPurgeOptions = {}): Promise<string[]> {
    return this.purge(resolveTrashRetentionDays(), options)
  }

  /** 方法与构造期的 fs 面合并（缺省回落真实 `rename` / `rm`）。 */
  #fsOf(override?: TrashFsLike): TrashFs {
    return {
      rename: override?.rename ?? this.#rename,
      rm: override?.rm ?? this.#rm,
    }
  }

  /**
   * **原子占位**一个单元名（B-1）：候选 `<unit>.pending` 用**非 recursive** `mkdir` 独占创建，
   * `EEXIST` = 名字已被并发调用占走 → 换 `-2`/`-3`…（上限 `MAX_NAME_ATTEMPTS`）重试；
   * 其他错误原样抛。「先检查后创建」不再作为分配依据。
   *
   * `pathExists(unitDir)` 只用于提前避开**已被占用/已转正**的正式名：新单元的创建已由
   * pending 的独占创建串行化，不存在两个调用同时写同名单元的可能。
   */
  async #reserveUnit(
    kindDir: string,
    base: string,
  ): Promise<{ unitName: string; unitDir: string; pendingDir: string }> {
    for (let index = 0; index < MAX_NAME_ATTEMPTS; index++) {
      const unitName = index === 0 ? base : `${base}-${index + 1}`
      const unitDir = join(kindDir, unitName)
      // 单元名穿越防护（v9.1 C-3）：即便消毒被绕过，落点也必须在 kind 目录内
      if (!isInside(kindDir, unitDir)) {
        throw new PrismError('trash_path_escape', `回收站单元越出 kind 目录：${unitName}`, {
          unitName,
        })
      }
      if (await pathExists(unitDir)) continue
      const pendingDir = `${unitDir}.pending`
      try {
        await mkdir(pendingDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      return { unitName, unitDir, pendingDir }
    }
    throw new PrismError('trash_unit_conflict', `同秒同名单元过多，无法分配：${base}`, { base })
  }

  /**
   * 通用回滚：把**本次**已搬入的条目按原路径搬回；回滚自身失败不掩盖原始错误。
   *
   * **绝不销毁承载已成功落盘内容的 pending**（M-1）：只有「这一轮没有任何成功搬入」
   * 或「全部搬回成功且 pending 里只剩登记/meta」才允许清壳；否则保留残壳并把路径
   * 追加到错误消息里（交给人工或 30 分钟后的 purge 兜底）。
   */
  async #rollbackPut(
    moved: ReadonlyArray<{ source: string; landed: string }>,
    pendingDir: string,
    fs: TrashFs,
    error: unknown,
  ): Promise<void> {
    let allReturned = true
    for (const item of [...moved].reverse()) {
      try {
        await movePath(item.landed, item.source, fs)
      } catch {
        allReturned = false
      }
    }
    const leftovers =
      moved.length === 0 || allReturned ? await readdir(pendingDir).catch(() => null) : null
    const holdsPayload =
      leftovers == null ||
      leftovers.some((name) => name !== TRASH_HOLDER_FILE && name !== TRASH_META_FILE)
    if (!holdsPayload) {
      await fs.rm(pendingDir, { recursive: true, force: true }).catch(() => {})
      return
    }
    if (error instanceof Error) {
      error.message +=
        `（部分内容未能搬回原位置，已保留在回收站暂存目录：${pendingDir}；` +
        '请手工搬回或等待其到期后由 purge 清除）'
    }
  }

  /** `restore` 主体（在途表已加锁，见 `restore`）。 */
  async #restoreLocked(
    id: string,
    kind: string,
    unitDir: string,
    options: TrashRestoreOptions,
  ): Promise<string[]> {
    const occupied = `${unitDir}.restoring-${this.#pid}`
    const nowMs = this.#now().getTime()
    // 在途登记（本人/他人的新鲜 holder）：一律 busy，绝不 rm（B-2）
    const live = await this.#liveHolderDir([unitDir, occupied], nowMs)
    if (live != null) {
      throw new PrismError(
        'trash_busy',
        `回收站单元正在被删除/恢复占用（${live}），请稍后重试：${id}`,
        { id, holder_dir: live },
      )
    }

    const meta = await readUnitMeta(unitDir)
    if (meta == null) {
      if (!(await pathExists(unitDir))) {
        // 单元本体不在，但占有名被同名**正式单元**占着（崩溃的 restore 残体等）：
        // 内容其实还在、只是名字被占 → 报 busy 而非 not_found，且绝不 rm（m-3）
        if ((await readUnitMeta(occupied)) != null) {
          throw new PrismError(
            'trash_busy',
            `单元本体不在，占有名被同名正式单元占用（请手工处理）：${occupied}`,
            { id, occupied },
          )
        }
        throw new PrismError('not_found', `回收站单元不存在：${id}`, { id })
      }
      throw new PrismError(
        'trash_broken',
        `回收站单元缺少有效 ${TRASH_META_FILE}，无法自动恢复（请手工处理或 purge）：${id}`,
        { id, unitDir },
      )
    }

    // 目标 = meta 记录的原绝对路径；定界只认受管根。单元内实际文件名按 put 的
    // 去重顺序重放（同单元 basename 冲突时 put 加过 `-2` 后缀）。
    const used = new Set<string>()
    const targets: Array<{ landedName: string; target: string }> = []
    const seen = new Set<string>()
    for (const original of meta.original_paths) {
      const target = resolve(original)
      if (!isInside(meta.managed_root, target)) {
        throw new PrismError(
          'trash_restore_escape',
          `恢复目标越出受管根，拒绝回写（请手工恢复）：${target}`,
          { id, target, managedRoot: meta.managed_root },
        )
      }
      if (seen.has(target)) {
        throw new PrismError('target_exists', `多个待恢复条目指向同一目标：${target}`, {
          id,
          target,
        })
      }
      seen.add(target)
      targets.push({ landedName: uniqueChildName(basename(target), used), target })
    }
    if (!options.overwrite) {
      for (const item of targets) {
        if (await pathExists(item.target)) {
          throw new PrismError(
            'target_exists',
            `恢复目标已存在（overwrite=true 才允许覆盖）：${item.target}`,
            { id, target: item.target },
          )
        }
      }
    }

    await this.#clearStaleOccupation(id, occupied)
    // 先写登记再 rename 占用：rename 是原子的，登记随目录一并进入占有态，
    // 因此不存在「已占有但无登记」的窗口（purge 侧凭登记跳过，B-2）
    await writeHolder(join(unitDir, TRASH_HOLDER_FILE), {
      pid: this.#pid,
      started_at: this.#now().toISOString(),
      purpose: 'restore',
    })
    try {
      await movePath(unitDir, occupied, this.#fsOf())
    } catch (error) {
      await this.#rm(join(unitDir, TRASH_HOLDER_FILE), { force: true }).catch(() => {})
      // 并发占位：他人已把同名单元占有走 → 报 busy；否则原样抛
      if (await pathExists(occupied)) {
        throw new PrismError('trash_busy', `回收站单元刚被他方占有，请稍后重试：${id}`, {
          id,
          occupied,
        })
      }
      throw error
    }

    const done: Array<{ landedName: string; target: string }> = []
    try {
      for (const item of targets) {
        // overwrite=true 是调用方显式要求：先清掉占位目标（rename 在 Windows 上
        // 无法覆盖已存在的目录），再搬回
        if (options.overwrite) await this.#rm(item.target, { recursive: true, force: true })
        await mkdir(dirname(item.target), { recursive: true })
        await movePath(join(occupied, item.landedName), item.target, this.#fsOf())
        done.push(item)
      }
    } catch (error) {
      for (const item of [...done].reverse()) {
        await movePath(item.target, join(occupied, item.landedName), this.#fsOf()).catch(() => {})
      }
      // 归还：先撤登记再还名——否则单元会在 30 分钟内被 purge 跳过、被 list 隐藏
      await this.#rm(join(occupied, TRASH_HOLDER_FILE), { force: true }).catch(() => {})
      await this.#rename(occupied, unitDir).catch(() => {})
      throw error
    }
    // 只剩 trash-meta.json 与登记，随占有目录一并清除
    await this.#rm(occupied, { recursive: true, force: true })

    const restored = targets.map((item) => item.target)
    await this.#record({
      type: 'trash.restore',
      kind,
      unit_id: id,
      trigger: options.trigger ?? 'CLI',
      paths: restored,
    })
    return restored
  }

  /**
   * 处理「占有名已被占」的边界（m-1 / m-3）：
   * - 内含**有效 meta** → 是正式单元（或崩溃的 restore 残体），一律 `trash_busy`，**绝不 rm**；
   * - 其余（无 meta 的暂存残壳）→ 清除后重占。
   */
  async #clearStaleOccupation(id: string, occupied: string): Promise<void> {
    if (!(await pathExists(occupied))) return
    if ((await readUnitMeta(occupied)) != null) {
      throw new PrismError(
        'trash_busy',
        `占有名已被同名正式单元占用，拒绝覆盖（请手工处理）：${occupied}`,
        { id, occupied },
      )
    }
    await this.#rm(occupied, { recursive: true, force: true }).catch(() => {})
  }

  /** 返回第一个内含**新鲜存活**登记的目录（无则 undefined）。 */
  async #liveHolderDir(dirs: readonly string[], nowMs: number): Promise<string | undefined> {
    for (const dir of dirs) {
      if (holderIsLive(await readHolder(dir), nowMs)) return dir
    }
    return undefined
  }

  #describe(
    kind: string,
    unitName: string,
    meta: TrashUnitMeta | null,
    fallbackDeletedAt: string,
  ): TrashEntry {
    const base = { id: `${kind}/${unitName}`, kind, name: unitDisplayName(unitName) }
    if (meta == null) {
      return { ...base, deletedAt: fallbackDeletedAt, originalPaths: [], broken: true }
    }
    return {
      ...base,
      deletedAt: meta.deleted_at,
      originalPaths: meta.original_paths,
      ...(meta.managed_root !== '' ? { managedRoot: meta.managed_root } : {}),
      broken: false,
    }
  }

  /** 现有 kind 目录（只认 put 消毒过的名字，避免把回收站根下的杂物当单元）。 */
  async #kinds(): Promise<string[]> {
    const dirents = await readdir(this.trashDir, { withFileTypes: true }).catch(() => [] as Dirent[])
    return dirents
      .filter((entry) => entry.isDirectory() && SEGMENT_RE.test(entry.name))
      .map((entry) => entry.name)
  }

  /**
   * 目录项**三态**判定（替换旧的「去掉后缀的正式目录是否存在」，后者把在途占有必判成残留）：
   *
   * 1. 内含**新鲜存活** holder → 在途（put/restore 正在写）→ purge/sweep 无条件跳过、list 不收录；
   * 2. 有有效 meta → **正式单元**（与名字后缀无关，m-2）→ 走 meta 口径；
   * 3. 名字带暂存后缀且无 meta → 崩溃残留 → 按目录名时间戳兜底。
   */
  async #unitState(unitDir: string, unitName: string, nowMs: number): Promise<UnitState> {
    const [meta, holder] = await Promise.all([readUnitMeta(unitDir), readHolder(unitDir)])
    return {
      meta,
      transientName: TRANSIENT_RE.test(unitName),
      inFlight: holderIsLive(holder, nowMs),
    }
  }

  async #record(event: AuditEventInput): Promise<void> {
    if (this.#audit == null) return
    await this.#audit.record(event)
  }
}
