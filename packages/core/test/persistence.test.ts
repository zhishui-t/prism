import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_ENTRIES_TABLE_DDL,
  KNOWLEDGE_V2_ADD_OWNER,
  PrismDatabase,
  PrismPersistence,
  SingleWriterQueue,
} from '../src/index.js'

describe('SingleWriterQueue', () => {
  it('FIFO 串行执行，失败不中断队列', async () => {
    const q = new SingleWriterQueue()
    const order: number[] = []
    const p1 = q.run(async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
      return 'a'
    })
    const p2 = q.run(async () => {
      order.push(2)
      throw new Error('boom')
    })
    const p3 = q.run(async () => {
      order.push(3)
      return 'c'
    })
    await expect(p2).rejects.toThrow('boom')
    await expect(p1).resolves.toBe('a')
    await expect(p3).resolves.toBe('c')
    expect(order).toEqual([1, 2, 3])
    await q.drain()
    expect(q.size).toBe(0)
  })
})

describe('PrismDatabase', () => {
  it('内存库建表 + 迁移版本正确', async () => {
    const db = new PrismDatabase({ path: ':memory:' })
    expect(db.isMemory).toBe(true)
    expect(db.userVersion()).toBe(0)
    db.migrate({ version: 1, statements: [KNOWLEDGE_ENTRIES_TABLE_DDL] })
    expect(db.userVersion()).toBe(1)
    expect(db.tables()).toContain('knowledge_entries')
    const cols = db.columns('knowledge_entries').map((c) => c.name)
    expect(cols).toContain('id')
    expect(cols).toContain('owner') // Z1：owner 显式列（不再依赖 path 反解）
    expect(cols).toContain('risk')
    expect(cols).toContain('is_latest')
    db.close()
  })

  it('Z1 迁移：v1 老库（无 owner 列）补列后数据不丢、owner 可回填', async () => {
    // v1 表结构（不含 owner 列）模拟存量库
    const V1_DDL = KNOWLEDGE_ENTRIES_TABLE_DDL.replace('    owner TEXT,\n', '')
    const db = new PrismDatabase({ path: ':memory:', schema: { version: 1, statements: [V1_DDL] } })
    expect(db.columns('knowledge_entries').map((c) => c.name)).not.toContain('owner')
    await db.run((raw) => {
      raw
        .prepare(
          `INSERT INTO knowledge_entries
           (id, version, is_latest, title, type, layer, book, module, status, risk, confidence, freshness,
            visibility, tags, path, content_hash, overrides, created_at, updated_at)
           VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('K1', 1, '标题', 'rule', 'project', 'b', 'm', 'active', 'low', 0.5, 1.0, 'project', '[]', '/kb/project/owner-x/b/m/K1/v01.md', 'h', '[]', 'now', 'now')
    })
    // 同版本再跑迁移（when 谓词幂等）→ 补 owner 列，既有行 owner 为 NULL
    db.migrate({ version: 1, statements: [KNOWLEDGE_V2_ADD_OWNER] })
    expect(db.columns('knowledge_entries').map((c) => c.name)).toContain('owner')
    const row = await db.run((raw) =>
      raw.prepare('SELECT title, owner FROM knowledge_entries WHERE id = ?').get('K1'),
    )
    expect(row).toEqual({ title: '标题', owner: null }) // 数据不丢；老行 owner 留空，读取时由 path 反解兜底
    // 回填：从 path 第二段补 owner（模拟 reindex/维护脚本）
    await db.run((raw) => raw.prepare("UPDATE knowledge_entries SET owner = 'owner-x' WHERE id = 'K1'").run())
    const backfilled = await db.run((raw) =>
      raw.prepare('SELECT owner FROM knowledge_entries WHERE id = ?').get('K1'),
    )
    expect(backfilled).toEqual({ owner: 'owner-x' })
    db.close()
  })

  it('写操作往返', async () => {
    const db = new PrismDatabase({
      path: ':memory:',
      schema: { version: 1, statements: [KNOWLEDGE_ENTRIES_TABLE_DDL] },
    })
    await db.run((raw) => {
      raw
        .prepare(
          `INSERT INTO knowledge_entries
           (id, version, is_latest, title, type, layer, book, module, status, risk, confidence, freshness,
            visibility, tags, path, content_hash, overrides, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('K1', 1, 1, '标题', 'rule', 'global', 'b', 'm', 'active', 'high', 0.9, 1.0, 'global', '[]', '/p', 'hash', '[]', 'now', 'now')
    })
    const row = await db.run((raw) =>
      raw.prepare('SELECT title, risk FROM knowledge_entries WHERE id = ?').get('K1'),
    )
    expect(row).toEqual({ title: '标题', risk: 'high' })
    db.close()
  })
})

describe('PrismPersistence', () => {
  it('内存模式建 3 个库且表齐全', () => {
    const p = new PrismPersistence({ inMemory: true })
    expect(p.dbs).toHaveLength(3)
    const knowledgeTables = p.knowledge.tables()
    expect(knowledgeTables).toContain('knowledge_entries')
    expect(knowledgeTables).toContain('knowledge_edges')
    expect(knowledgeTables).toContain('book_structures')
    expect(p.tasks.tables()).toContain('tasks')
    expect(p.core.tables()).toContain('team_bindings')
    p.close()
  })
})
