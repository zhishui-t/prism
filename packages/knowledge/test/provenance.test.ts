/**
 * F-E2（knowledge 侧）：`source` / `deposited_by` 两列（v7）的落库与读回。
 *
 * 覆盖：deposit 写两列（§3.2 载荷约定）→ get/search 返回 `deposited_by`；
 * index 写 `{"kind":"import"}`；未提供 → NULL（向后兼容）；
 * **reindex 后两列仍在**（frontmatter 为真相——否则自有型重建后恒空）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeService(): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-prov-'))
  dirs.push(home)
  return new PrismKnowledgeService({ home })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Columns {
  source: string | null
  deposited_by: string | null
}

function columnsOf(kb: PrismKnowledgeService, id: string): Columns {
  return kb.persistence.knowledge.raw
    .prepare('SELECT source, deposited_by FROM knowledge_entries WHERE id = ? AND is_latest = 1')
    .get(id) as Columns
}

describe('沉淀来源落库（F-E2：v7 source / deposited_by 两列）', () => {
  it('deposit 按 §3.2 载荷写两列；get/search 返回 deposited_by', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'PROV-1',
        title: '任务沉淀',
        type: 'rule',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '任务沉淀正文。',
        source: { kind: 'task', ref: 'T-9' },
        deposited_by: { subject: 'dev-1', team: 'ds-liangzi', task_id: 'T-9' },
      })

      const cols = columnsOf(kb, 'PROV-1')
      // source = {...input.source, origin_task?}（此处无 origin_task）
      expect(JSON.parse(cols.source!)).toEqual({ kind: 'task', ref: 'T-9' })
      // deposited_by = {...input.deposited_by, at}
      const by = JSON.parse(cols.deposited_by!) as Record<string, unknown>
      expect(by).toMatchObject({ subject: 'dev-1', team: 'ds-liangzi', task_id: 'T-9' })
      expect(typeof by['at']).toBe('string')

      expect((await kb.get('PROV-1'))?.deposited_by).toMatchObject({
        subject: 'dev-1',
        team: 'ds-liangzi',
        task_id: 'T-9',
      })
      const [hit] = await kb.search({ q: '任务沉淀' })
      expect(hit?.deposited_by?.subject).toBe('dev-1')
      expect(hit?.deposited_by?.task_id).toBe('T-9')
    } finally {
      kb.close()
    }
  })

  it('origin_task 一并落 source 列（§3.2：kind/ref + 任务来源），且 reindex 后嵌套结构不丢', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'PROV-2',
        title: '带任务来源',
        type: 'pitfall',
        layer: 'project',
        owner: 'p1',
        book: 'b',
        content: '带任务来源正文。',
        source: { kind: 'task' },
        origin_task: { task_id: 'T-1', dag_id: 'D-1', stage: 'dev', role: 'developer-1' },
      })
      const expected = {
        kind: 'task',
        origin_task: { task_id: 'T-1', dag_id: 'D-1', stage: 'dev', role: 'developer-1' },
      }
      expect(JSON.parse(columnsOf(kb, 'PROV-2').source!)).toEqual(expected)

      // 嵌套 flow map 必须能被 frontmatter 解析器读回（否则 reindex 后 origin_task 丢）
      kb.persistence.knowledge.raw
        .prepare('UPDATE knowledge_entries SET source = NULL WHERE id = ?')
        .run('PROV-2')
      await kb.reindex()
      expect(JSON.parse(columnsOf(kb, 'PROV-2').source!)).toEqual(expected)
    } finally {
      kb.close()
    }
  })

  it('未提供 source/deposited_by → 两列 NULL，读侧 undefined（老行为不回归）', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'PROV-3',
        title: '无来源',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: '无来源正文。',
      })
      const cols = columnsOf(kb, 'PROV-3')
      expect(cols.source).toBeNull()
      expect(cols.deposited_by).toBeNull()
      expect((await kb.get('PROV-3'))?.deposited_by).toBeUndefined()
      expect((await kb.search({ q: '无来源' }))[0]?.deposited_by).toBeUndefined()
    } finally {
      kb.close()
    }
  })

  it('index（引用型）写 source={"kind":"import"}，deposited_by 为 NULL', async () => {
    const kb = makeService()
    try {
      await kb.index({
        id: 'PROV-4',
        title: '项目文档',
        layer: 'project',
        owner: 'p1',
        book: 'b',
        path: 'D:/proj/README.md',
        source_hash: 'h1',
        content: '项目文档正文。',
      })
      const cols = columnsOf(kb, 'PROV-4')
      expect(JSON.parse(cols.source!)).toEqual({ kind: 'import' })
      expect(cols.deposited_by).toBeNull()

      // 源变了 → 走 UPDATE 分支，仍写 source
      await kb.index({
        id: 'PROV-4',
        title: '项目文档',
        layer: 'project',
        owner: 'p1',
        book: 'b',
        path: 'D:/proj/README.md',
        source_hash: 'h2',
        content: '项目文档正文（改）。',
      })
      expect(JSON.parse(columnsOf(kb, 'PROV-4').source!)).toEqual({ kind: 'import' })
    } finally {
      kb.close()
    }
  })

  it('reindex 后两列仍在（frontmatter 为真相，DB 两列不因重建而丢）', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'PROV-5',
        title: '重扫留痕',
        type: 'rule',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '重扫留痕正文。',
        source: { kind: 'agent', ref: 'host-1' },
        deposited_by: { subject: 'dev-2', team: 't1', task_id: 'T-2' },
      })
      const before = columnsOf(kb, 'PROV-5')

      // 手工清空两列，模拟「reindex 不解析两列」会造成的后果
      kb.persistence.knowledge.raw
        .prepare('UPDATE knowledge_entries SET source = NULL, deposited_by = NULL WHERE id = ?')
        .run('PROV-5')
      expect(columnsOf(kb, 'PROV-5').source).toBeNull()

      const report = await kb.reindex()
      expect(report.indexed).toBe(1)

      const after = columnsOf(kb, 'PROV-5')
      expect(JSON.parse(after.source!)).toEqual({ kind: 'agent', ref: 'host-1' })
      expect(JSON.parse(after.deposited_by!)).toEqual(JSON.parse(before.deposited_by!))
      expect((await kb.get('PROV-5'))?.deposited_by?.subject).toBe('dev-2')
    } finally {
      kb.close()
    }
  })

  /**
   * v5 / A-1：读面 `provenance`（两列合并视图，**不叫 source**——`SearchResult.source`
   * 已是「来源地址」字符串）。裁决见 `.agent-team/debts-v5.md` A-1。
   */
  it('A-1：provenance 合并 source+deposited_by；task_id 取 origin_task 优先', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'PROV-6',
        title: '读面来源',
        type: 'rule',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '读面来源正文。',
        source: { kind: 'task', ref: 'T-9' },
        origin_task: { task_id: 'T-1', dag_id: 'D-1' },
        deposited_by: { subject: 'dev-1', team: 'ds-liangzi', task_id: 'T-9' },
      })

      const entry = await kb.get('PROV-6')
      expect(entry?.provenance).toEqual({
        kind: 'task',
        ref: 'T-9',
        task_id: 'T-1', // origin_task 更权威 → 覆盖 deposited_by.task_id(T-9)
        subject: 'dev-1',
        team: 'ds-liangzi',
        at: expect.any(String),
      })
      // 既有读面字段不回归
      expect(entry?.deposited_by?.subject).toBe('dev-1')

      const [hit] = await kb.search({ q: '读面来源' })
      expect(hit?.provenance).toEqual(entry?.provenance)
      // 地址串仍是 `source`（两条语义并存、互不覆盖）
      expect(typeof hit?.source).toBe('string')
      expect(hit?.source).toContain('global/b/m/PROV-6@v')
    } finally {
      kb.close()
    }
  })

  it('A-1：index（引用型）→ provenance.kind=import；无来源 → 不设 provenance', async () => {
    const kb = makeService()
    try {
      await kb.index({
        id: 'PROV-7',
        title: '引用文档',
        layer: 'project',
        owner: 'p1',
        book: 'b',
        path: 'D:/proj/readme.md',
        source_hash: 'h1',
        content: '引用文档正文。',
      })
      expect((await kb.get('PROV-7'))?.provenance).toEqual({ kind: 'import' })

      await kb.deposit({
        id: 'PROV-8',
        title: '无来源读面',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: '无来源读面正文。',
      })
      const bare = await kb.get('PROV-8')
      expect(bare?.provenance).toBeUndefined()
      expect((await kb.search({ q: '无来源读面' }))[0]?.provenance).toBeUndefined()
    } finally {
      kb.close()
    }
  })

  it('A-1：reindex 后 provenance 仍在（两列为真相，DB 清空亦重建）', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'PROV-9',
        title: '重扫读面',
        type: 'rule',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '重扫读面正文。',
        source: { kind: 'manual', ref: '人手写的' },
        deposited_by: { subject: 'dev-2', team: 't1' },
      })
      const before = (await kb.get('PROV-9'))?.provenance

      // 模拟「reindex 不解析两列」会造成的后果
      kb.persistence.knowledge.raw
        .prepare('UPDATE knowledge_entries SET source = NULL, deposited_by = NULL WHERE id = ?')
        .run('PROV-9')
      expect((await kb.get('PROV-9'))?.provenance).toBeUndefined()

      const report = await kb.reindex()
      expect(report.indexed).toBe(1)
      expect((await kb.get('PROV-9'))?.provenance).toEqual(before)
      expect((await kb.get('PROV-9'))?.provenance).toMatchObject({ kind: 'manual', ref: '人手写的', subject: 'dev-2', team: 't1' })
    } finally {
      kb.close()
    }
  })
})
