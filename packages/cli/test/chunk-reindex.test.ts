/**
 * 存量迁移与 CLI 补齐（v13 §7 / SPEC-5.1–5.3）。
 *
 * 覆盖两条入口：
 * - `prism kb reindex --chunks [--book <b>]`（新）：存量库补段行/段 FTS/段向量；
 * - `prism embedding reindex`（扩展）：兼扫段级缺口——本机 vitest 全局 `PRISM_EMBEDDING=off`
 *   （`vitest.config.ts`），该命令会走「未安装」早退，故其段级口径由**同一实现**的
 *   `backfillChunks` 直调用例覆盖（单点，见 `src/commands/chunk-index.ts`）。
 *
 * 全程临时目录（R5）：home 一律 `mkdtemp`，不碰真实宿主目录、不写 `.git`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService, assembleChunkEmbeddingInput, chunkMarkdown } from '@prism/knowledge'
import type { KnowledgeServiceOptions } from '@prism/knowledge'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'
import { backfillChunks } from '../src/commands/chunk-index.js'

/** 读仓库根下相对路径的文件（测试跑在 `packages/cli/test/`）。 */
function readRepoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')
}

const HOMES: string[] = []
const SERVICES: PrismKnowledgeService[] = []

async function tempHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  HOMES.push(home)
  return home
}

afterEach(async () => {
  // 先关 SQLite 连接（Windows 下打开的文件不能删），再清理临时目录
  for (const service of SERVICES.splice(0)) service.close()
  for (const home of HOMES.splice(0)) await rm(home, { recursive: true, force: true }).catch(() => undefined)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一节 = 一段（每节 400 余字 > 默认 minChars=120；整篇 < 默认 maxChars=2000 → 不二切）。 */
const SECTION = 400

/** 三节文档：第 3 节含独有词「量子隧穿」（段路命中的定位靶）。 */
function doc(prefix = '甲'): string {
  return (
    `## 甲章\n${prefix.repeat(SECTION)}\n` +
    `## 乙章\n${'乙'.repeat(SECTION)}\n` +
    `## 丙章\n${'丙'.repeat(SECTION)}量子隧穿\n`
  )
}

interface ChunkRow {
  id: number
  seq: number
  heading_path: string
  char_start: number
  char_end: number
  text: string
}

function chunkRows(kb: PrismKnowledgeService, entryId: string): ChunkRow[] {
  return kb.persistence.knowledge.raw
    .prepare(
      'SELECT id, seq, heading_path, char_start, char_end, text FROM kb_chunks WHERE entry_id = ? ORDER BY seq',
    )
    .all(entryId) as unknown as ChunkRow[]
}

function chunkCount(kb: PrismKnowledgeService, entryId: string): number {
  const row = kb.persistence.knowledge.raw
    .prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE entry_id = ?')
    .get(entryId) as { n: number }
  return row.n
}

function vectorCount(kb: PrismKnowledgeService): number {
  const row = kb.persistence.knowledge.raw.prepare('SELECT COUNT(*) AS n FROM kb_chunk_vectors').get() as {
    n: number
  }
  return row.n
}

/** 删除段级三表全部行（模拟 v12 存量库：条目/条目 FTS 在、段级索引全无）。 */
function dropAllChunks(kb: PrismKnowledgeService): void {
  const raw = kb.persistence.knowledge.raw
  raw.exec('DELETE FROM kb_chunk_fts')
  raw.exec('DELETE FROM kb_chunk_vectors')
  raw.exec('DELETE FROM kb_chunks')
}

function makeKb(home: string, extra: Partial<KnowledgeServiceOptions> = {}): PrismKnowledgeService {
  const kb = new PrismKnowledgeService({ home, ...extra })
  SERVICES.push(kb)
  return kb
}

/** 一条「三节」条目（book 可指定）。 */
async function depositDoc(kb: PrismKnowledgeService, id: string, book = 'b1'): Promise<void> {
  await kb.deposit({
    id,
    title: '分段夹具',
    type: 'doc',
    layer: 'global',
    book,
    module: 'm',
    content: doc(),
  })
}

let home: string
let lines: string[]

/** 造一个把输出收进数组的上下文（`--json` 时由 argv 覆盖 ctx.json）。 */
function ctxFor(json = false): CommandContext {
  return {
    ...defaultContext({
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(`[stderr] ${line}`),
    }),
    home,
    json,
  }
}

/** 从输出里取 `{ok, value}` 信封（跳过告警行）。 */
function jsonValue<T>(): T {
  const line = lines.find((l) => l.trimStart().startsWith('{'))
  expect(line, `输出里没有 JSON 信封：\n${lines.join('\n')}`).toBeDefined()
  return (JSON.parse(line!) as { value: T }).value
}

beforeEach(async () => {
  home = await tempHome('prism-cli-chunks-')
  lines = []
})

// ── SPEC-5.1 跳过判据 / 补齐 / --book 过滤 ───────────────────────────────────

describe('SPEC-5.1 kb reindex --chunks', () => {
  it('已切且 hash 未变 → 全跳过；重跑幂等（计数收敛）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    expect(chunkCount(kb, 'K-1')).toBe(3) // deposit 恒写段行（B-2）

    for (const round of [1, 2]) {
      lines = []
      expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)
      const report = jsonValue<Record<string, number>>()
      expect(report, `第 ${round} 轮`).toMatchObject({
        scanned: 1,
        skipped: 1,
        reindexed: 0,
        refilled: 0,
        chunks: 0,
        vectors: 0,
        cleaned: 0,
      })
      expect(report['failed']).toEqual([])
    }
  })

  it('缺段行（v12 存量库）→ 重切补齐；段行与 chunkMarkdown 逐字段一致', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    dropAllChunks(kb)
    expect(chunkCount(kb, 'K-1')).toBe(0)

    lines = []
    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)
    expect(jsonValue()).toMatchObject({ scanned: 1, skipped: 0, reindexed: 1, chunks: 3, vectors: 0, cleaned: 0 })

    const body = (kb.persistence.knowledge.raw
      .prepare("SELECT body FROM kb_fts WHERE rowid = (SELECT rowid FROM knowledge_entries WHERE id = 'K-1')")
      .get() as { body: string }).body
    const expected = chunkMarkdown(body)
    const rows = chunkRows(kb, 'K-1')
    expect(rows.map((r) => [r.seq, r.heading_path, r.char_start, r.char_end, r.text])).toEqual(
      expected.map((c) => [c.seq, c.headingPath, c.charStart, c.charEnd, c.text]),
    )
    // 段 FTS 与段行同源（rowid ≡ kb_chunks.id）
    const orphans = kb.persistence.knowledge.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM kb_chunks c
         WHERE NOT EXISTS (SELECT 1 FROM kb_chunk_fts f WHERE f.rowid = c.id)`,
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)
  })

  it('段行齐、嵌入不可用 → 不阻塞跳过（判据「嵌入不可用 || 向量齐全」）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')

    lines = []
    expect(await runCommand(ctxFor(), ['kb', 'reindex', '--chunks'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('段级索引补齐：扫描 1 条，跳过 1 条，重切 0 条（0 段）')
    expect(output).toContain('未安装 embedding')
    expect(vectorCount(kb)).toBe(0)
  })

  it('--book 过滤只动该书', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1', 'b1')
    await depositDoc(kb, 'K-2', 'b2')
    dropAllChunks(kb)

    lines = []
    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks', '--book', 'b1'])).toBe(0)
    expect(jsonValue()).toMatchObject({ scanned: 1, reindexed: 1, chunks: 3 })
    expect(chunkCount(kb, 'K-1')).toBe(3)
    expect(chunkCount(kb, 'K-2')).toBe(0) // 另一本未动

    lines = []
    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)
    expect(jsonValue()).toMatchObject({ scanned: 2, reindexed: 1, skipped: 1 })
    expect(chunkCount(kb, 'K-2')).toBe(3)
  })

  it('自有型版次文件已消失 → 清理段行（与 service.reindex 的 origin 口径同源）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    const path = (kb.persistence.knowledge.raw
      .prepare("SELECT path FROM knowledge_entries WHERE id = 'K-1' AND is_latest = 1")
      .get() as { path: string }).path
    await unlink(path)

    lines = []
    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)
    expect(jsonValue()).toMatchObject({ scanned: 1, cleaned: 1, reindexed: 0, skipped: 0 })
    expect(chunkCount(kb, 'K-1')).toBe(0)
  })
})

// ── N-6 老库直跑（无段级三表）────────────────────────────────────────────────

describe('N-6 老库直跑：入口先 ensure 三表', () => {
  it('段级三表不存在时 --chunks 不炸，且 ensure 后正常补齐', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    const raw = kb.persistence.knowledge.raw
    raw.exec('DROP TABLE kb_chunk_fts')
    raw.exec('DROP TABLE kb_chunk_vectors')
    raw.exec('DROP TABLE kb_chunks')
    const tableExists = (name: string): boolean =>
      raw.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
    expect(tableExists('kb_chunks')).toBe(false) // 前提：确实是「老库」

    lines = []
    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)
    expect(jsonValue()).toMatchObject({ scanned: 1, reindexed: 1, chunks: 3 })
    expect(tableExists('kb_chunks')).toBe(true)
    expect(chunkCount(kb, 'K-1')).toBe(3)
  })

  it('两条入口都先调 ensureKbChunks（embedding reindex 无法在本机跑通，故静态锁定）', () => {
    // `embedding reindex` 在本机 `PRISM_EMBEDDING=off` 下会早退（未安装），其 N-6 只能静态核；
    // 口径与动态用例等价：ensure 必须出现在任何段级读写之前。
    const kbSrc = readRepoFile('packages/cli/src/commands/kb.ts')
    const embSrc = readRepoFile('packages/cli/src/commands/embedding.ts')
    for (const [name, src] of [
      ['kb.ts', kbSrc],
      ['embedding.ts', embSrc],
    ] as const) {
      const ensureAt = src.indexOf('ensureKbChunks(persistence.knowledge)')
      expect(ensureAt, `${name} 缺 ensureKbChunks`).toBeGreaterThan(0)
      expect(ensureAt, `${name}: ensureKbChunks 必须早于 backfillChunks`).toBeLessThan(
        src.indexOf('backfillChunks({'),
      )
    }
  })

  it('embedding reindex：未安装 embedding → 提示先 install（既有行为保持）', async () => {
    lines = []
    expect(await runCommand(ctxFor(), ['embedding', 'reindex'])).toBe(1)
    expect(lines.join('\n')).toContain('未安装：先跑 prism embedding install')
  })
})

// ── SPEC-5.2 不锁检索 ───────────────────────────────────────────────────────

describe('SPEC-5.2 不锁检索', () => {
  it('补齐完成后检索可用，且响应带段级 hits（heading_path/seq 定位）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    dropAllChunks(kb)

    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)

    const response = await kb.searchWithMeta({ q: '量子隧穿' })
    expect(response.results.map((r) => r.id)).toEqual(['K-1'])
    expect(response.results[0]?.hits).toEqual([
      expect.objectContaining({ seq: 2, heading_path: '丙章' }),
    ])
    expect(response.results[0]?.hits?.[0]?.excerpt).toContain('量子隧穿')
  })

  it('补齐进行中检索不被阻塞（读不进单写队列）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')

    // 段行齐、向量缺 → backfill 会逐条 await 嵌入；此刻并发检索必须立即有结果
    const pending = backfillChunks({
      knowledge: kb.persistence.knowledge,
      chunkOptions: { minChars: 120, maxChars: 2000 },
      embed: async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return new Float32Array([1, 0, 0])
      },
      model: 'test-1d',
    })
    const response = await kb.searchWithMeta({ q: '量子隧穿' })
    expect(response.results.map((r) => r.id)).toEqual(['K-1'])
    const report = await pending
    expect(report.vectors).toBe(3)
  })
})

// ── 段向量补齐（backfillChunks 直调：--chunks 与 embedding reindex 的同一实现）──

describe('段向量缺口补齐（单点实现 backfillChunks）', () => {
  const TITLE = '分段夹具'

  it('段行齐 + 向量缺 → 只补向量（段行 id 不变）；拼装口径 = assembleChunkEmbeddingInput', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    const before = chunkRows(kb, 'K-1')

    const calls: string[] = []
    const report = await backfillChunks({
      knowledge: kb.persistence.knowledge,
      chunkOptions: { minChars: 120, maxChars: 2000 },
      embed: async (text) => {
        calls.push(text)
        return new Float32Array([1, 0, 0])
      },
      model: 'test-1d',
    })
    expect(report).toMatchObject({ scanned: 1, skipped: 0, reindexed: 0, refilled: 1, vectors: 3 })
    expect(vectorCount(kb)).toBe(3)
    // 段行未被重写（id 逐字段不变）
    expect(chunkRows(kb, 'K-1')).toEqual(before)
    // 嵌入输入 = 条目标题\nheadingPath\n段文本（SPEC-1.12 的单点拼装）
    const body = (kb.persistence.knowledge.raw
      .prepare("SELECT body FROM kb_fts WHERE rowid = (SELECT rowid FROM knowledge_entries WHERE id = 'K-1')")
      .get() as { body: string }).body
    expect(calls).toEqual(chunkMarkdown(body).map((chunk) => assembleChunkEmbeddingInput(TITLE, chunk)))
  })

  it('换档后旧模型向量视为缺失 → 重算；同模型二次调用跳过（幂等）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    const embed = async (): Promise<Float32Array> => new Float32Array([1, 0, 0])
    const args = { knowledge: kb.persistence.knowledge, chunkOptions: { minChars: 120, maxChars: 2000 }, embed }

    expect((await backfillChunks({ ...args, model: 'old-1d' })).vectors).toBe(3)
    expect((await backfillChunks({ ...args, model: 'new-2d' })).vectors).toBe(3) // 旧模型不算数
    expect(await backfillChunks({ ...args, model: 'new-2d' })).toMatchObject({
      skipped: 1,
      refilled: 0,
      vectors: 0,
    })
  })

  it('chunkOptions 变更 → 存量段作废重切（设计未言明，由「重切等价」判据覆盖）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    expect(chunkCount(kb, 'K-1')).toBe(3)

    const report = await backfillChunks({
      knowledge: kb.persistence.knowledge,
      chunkOptions: { minChars: 8, maxChars: 60 },
    })
    expect(report).toMatchObject({ reindexed: 1 })
    expect(chunkCount(kb, 'K-1')).toBeGreaterThan(3)
  })

  it('嵌入抛错/返回空 → 记入 failed 清单且不中断（支持重跑）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    const report = await backfillChunks({
      knowledge: kb.persistence.knowledge,
      chunkOptions: { minChars: 120, maxChars: 2000 },
      embed: async (text) => {
        if (text.includes('丙章')) throw new Error('boom')
        return null
      },
      model: 'test-1d',
    })
    expect(report.vectors).toBe(0)
    expect(report.failed.map((f) => f.seq)).toEqual([0, 1, 2]) // 段 seq（可定位到具体段）
    expect(report.failed[0]).toMatchObject({ entry: 'K-1' })
    // 抛错的段（第 3 段，embedText 含「丙章」）与返回空的段分别如实记录
    expect(report.failed.map((f) => f.reason)).toEqual([
      '嵌入不可用（返回空向量）',
      '嵌入不可用（返回空向量）',
      expect.stringContaining('boom'),
    ])
    expect(vectorCount(kb)).toBe(0)
  })
})

// ── SPEC-5.3 红线 + 帮助文案 ─────────────────────────────────────────────────

describe('SPEC-5.3 红线：临时目录 + 帮助文案', () => {
  it('产物只落 --home 指定目录（不写真实宿主目录）', async () => {
    const kb = makeKb(home)
    await depositDoc(kb, 'K-1')
    dropAllChunks(kb)

    expect(await runCommand(ctxFor(true), ['kb', 'reindex', '--chunks'])).toBe(0)
    // 库与知识文件都在临时 home 下
    expect(existsSync(join(home, 'state', 'knowledge.db'))).toBe(true)
    expect(existsSync(join(home, 'knowledge'))).toBe(true)
    // 命令不需要 harness 根，也不接受 --harness-root（不触碰宿主目录）
    expect(chunkCount(kb, 'K-1')).toBe(3)
  })

  it('帮助文案含 --chunks 说明', async () => {
    lines = []
    expect(await runCommand(ctxFor(), ['kb', 'reindex', '--help'])).toBe(0)
    const usage = lines.join('\n')
    expect(usage).toContain('prism kb reindex [--chunks] [--book <b>]')
    expect(usage).toContain('--chunks 只补**段级索引**')
  })
})
