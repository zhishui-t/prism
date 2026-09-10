import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PrismDatabase, type DatabaseSchemaStatement } from '../src/index.js'
import {
  DEFAULT_SCHEMAS,
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_V7_ADD_DEPOSITED_BY,
  KNOWLEDGE_V7_ADD_SOURCE,
} from '../src/persistence/schemas.js'

/**
 * knowledge.db v6 → v7 迁移（design-v4 §3.2 / F-E2，流 A1 独家）。
 *
 * v7 给 `knowledge_entries` 补两列 `source` / `deposited_by`（可空 TEXT，JSON 字符串），
 * 走既有 `DatabaseSchemaStatement` 的 `when` 守卫机制（照抄 `KNOWLEDGE_V2_ADD_OWNER` 范式）。
 *
 * 验收（§3.2 + §6）：
 * 1. 造 v6 老库（无两列、有数据）→ 打开后 `user_version=7`、**行数与内容不变**、两列存在且为 NULL；
 * 2. 新库直建即含两列（先 DDL 后 ALTER，`when` 守卫保证幂等）；
 * 3. 已是 v7 的库重复打开不抛错（守卫幂等）。
 */

/** 两条 v7 语句——按**对象标识**从生产语句表中剔除，证明「v6 与 v7 的差集恰好只有这两条」。 */
const V7_STATEMENTS: DatabaseSchemaStatement[] = [
  KNOWLEDGE_V7_ADD_SOURCE,
  KNOWLEDGE_V7_ADD_DEPOSITED_BY,
]

/** v6 语句表 = 生产语句表减去两条 v7 ALTER（其余逐条一致）。 */
const V6_SCHEMA = {
  version: 6,
  statements: DEFAULT_SCHEMAS.knowledge.statements.filter((s) => !V7_STATEMENTS.includes(s)),
}

const INSERT_ROW_SQL = `INSERT INTO knowledge_entries
   (id, version, is_latest, title, type, layer, book, status, visibility, path, content_hash, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

function columnsOf(db: PrismDatabase): string[] {
  return db.columns('knowledge_entries').map((c) => c.name)
}

/** 造一个带两行数据的 v6 库（无 source/deposited_by 列），返回库文件路径。 */
async function makeV6Db(file: string): Promise<void> {
  const old = new PrismDatabase({ path: file, schema: V6_SCHEMA })
  try {
    expect(old.userVersion()).toBe(6)
    // 前置断言：v6 库确实没有这两列（否则本测试失去意义）
    expect(columnsOf(old)).not.toContain('source')
    expect(columnsOf(old)).not.toContain('deposited_by')

    await old.run((raw) => {
      const insert = raw.prepare(INSERT_ROW_SQL)
      insert.run('MIG-1', 1, 0, '第一版', 'rule', 'global', 'mig-book', 'superseded', 'global', '/kb/global/mig-book/MIG-1/v01.md', 'hash-1', 't0', 't0')
      insert.run('MIG-1', 2, 1, '第二版', 'rule', 'global', 'mig-book', 'active', 'global', '/kb/global/mig-book/MIG-1/v02.md', 'hash-2', 't0', 't1')
    })
  } finally {
    old.close()
  }
}

describe('knowledge.db v6 → v7 迁移（补 source / deposited_by）', () => {
  it('v6 老库升级：user_version=7、行数与内容不变、两列存在且为 NULL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-kb-mig-'))
    const file = join(home, 'knowledge.db')
    try {
      await makeV6Db(file)

      // 用**生产 schema** 打开 = 真实升级路径（PrismPersistence 也是这么做的）
      const upgraded = new PrismDatabase({ path: file, schema: DEFAULT_SCHEMAS.knowledge })
      try {
        expect(KNOWLEDGE_SCHEMA_VERSION).toBe(7)
        expect(upgraded.userVersion()).toBe(7)

        const cols = columnsOf(upgraded)
        expect(cols).toContain('source')
        expect(cols).toContain('deposited_by')

        // 行数与内容不变；新列为 NULL
        const rows = await upgraded.run((raw) =>
          raw
            .prepare(
              `SELECT id, version, is_latest, title, status, source, deposited_by
               FROM knowledge_entries ORDER BY version`,
            )
            .all(),
        )
        expect(rows).toHaveLength(2)
        expect(rows[0]).toEqual({
          id: 'MIG-1',
          version: 1,
          is_latest: 0,
          title: '第一版',
          status: 'superseded',
          source: null,
          deposited_by: null,
        })
        expect(rows[1]).toEqual({
          id: 'MIG-1',
          version: 2,
          is_latest: 1,
          title: '第二版',
          status: 'active',
          source: null,
          deposited_by: null,
        })
      } finally {
        upgraded.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('迁移幂等：已是 v7 的库重复打开不抛错，列与版本不变', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-kb-mig2-'))
    const file = join(home, 'knowledge.db')
    try {
      await makeV6Db(file)

      const first = new PrismDatabase({ path: file, schema: DEFAULT_SCHEMAS.knowledge })
      first.close()

      // 第二次打开：userVersion(=7) >= schema.version(=7) → 仍评估 when 谓词（守卫使其幂等）
      const second = new PrismDatabase({ path: file, schema: DEFAULT_SCHEMAS.knowledge })
      try {
        expect(second.userVersion()).toBe(7)
        const cols = columnsOf(second)
        expect(cols).toContain('source')
        expect(cols).toContain('deposited_by')
        // 列不重复（ALTER 未被二次执行；重复 ALTER 会抛错，能走到这里即证明守卫有效）
        expect(cols.filter((c) => c === 'source')).toHaveLength(1)
        expect(cols.filter((c) => c === 'deposited_by')).toHaveLength(1)
        const count = await second.run((raw) =>
          raw.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get(),
        )
        expect(count).toEqual({ n: 2 })
      } finally {
        second.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('新库直建即含两列（先 DDL 后 ALTER，when 守卫使其幂等）', () => {
    const db = new PrismDatabase({ path: ':memory:', schema: DEFAULT_SCHEMAS.knowledge })
    try {
      expect(db.userVersion()).toBe(KNOWLEDGE_SCHEMA_VERSION)
      const cols = columnsOf(db)
      expect(cols).toContain('source')
      expect(cols).toContain('deposited_by')
    } finally {
      db.close()
    }
  })

  it('两列为可空 JSON 文本列，可写入并原样读回（v7 载荷约定）', async () => {
    const db = new PrismDatabase({ path: ':memory:', schema: DEFAULT_SCHEMAS.knowledge })
    try {
      const source = JSON.stringify({ kind: 'task', ref: 'doc.md', origin_task: { task_id: 'T1' } })
      const depositedBy = JSON.stringify({ subject: 'dev-1', team: 'core', at: 't2', task_id: 'T1' })
      await db.run((raw) =>
        raw
          .prepare(
            `INSERT INTO knowledge_entries
             (id, version, is_latest, title, type, layer, book, status, visibility, path, content_hash,
              created_at, updated_at, source, deposited_by)
             VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('JSON-1', 'T', 'doc', 'project', 'b', 'active', 'project', '/p', 'h', 't', 't', source, depositedBy),
      )
      const row = await db.run((raw) =>
        raw.prepare('SELECT source, deposited_by FROM knowledge_entries WHERE id = ?').get('JSON-1'),
      )
      expect(row).toEqual({ source, deposited_by: depositedBy })
      expect(JSON.parse((row as { source: string }).source)).toMatchObject({ kind: 'task' })
    } finally {
      db.close()
    }
  })
})
