/**
 * 段级存储与写入链（v13 §2 / SPEC-2.1～2.4）。
 *
 * 全部走临时目录（R5）：`new PrismKnowledgeService({ home })` 的 home 由 mkdtemp 造，
 * 绝不碰真实宿主目录。
 *
 * 三条表：kb_chunks（id INTEGER PRIMARY KEY——rowid 别名恒等式的载体）/
 * kb_chunk_fts（rowid ≡ kb_chunks.id）/ kb_chunk_vectors（chunk_id PK）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { chunkMarkdown } from '../src/chunker.js'
import { splitFrontmatter } from '../src/frontmatter.js'
import { ensureKbChunks } from '../src/index-db.js'
import { PrismKnowledgeService } from '../src/service.js'
import { toMatchExpression } from '../src/tokenize.js'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-chunks-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 断言用的确定向量（4 维；不参与检索，只验落库口径）。 */
async function fakeEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(4)
  for (let i = 0; i < text.length; i++) {
    const idx = i % 4
    v[idx] = v[idx]! + (text.charCodeAt(i) % 97)
  }
  v[3] = v[3]! + text.length
  return v
}

interface ChunkRow {
  id: number
  entry_id: string
  version: number
  seq: number
  heading_path: string
  char_start: number
  char_end: number
  text: string
}

function chunksOf(kb: PrismKnowledgeService, entryId: string): ChunkRow[] {
  return kb.persistence.knowledge.raw
    .prepare(
      `SELECT id, entry_id, version, seq, heading_path, char_start, char_end, text
       FROM kb_chunks WHERE entry_id = ? ORDER BY seq`,
    )
    .all(entryId) as unknown as ChunkRow[]
}

function scalar(kb: PrismKnowledgeService, sql: string, ...params: Array<string | number>): number {
  const row = kb.persistence.knowledge.raw.prepare(sql).get(...params) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

function ftsHits(kb: PrismKnowledgeService, query: string): number {
  return scalar(
    kb,
    'SELECT COUNT(*) AS c FROM kb_chunk_fts WHERE kb_chunk_fts MATCH ?',
    toMatchExpression(query),
  )
}

/** 与 reindex 解析器兼容的最小 frontmatter（只换正文时用）。 */
function frontmatterFor(id: string): string {
  return [
    '---',
    `id: ${id}`,
    'version: 1',
    'title: 重建条目',
    'type: rule',
    'layer: global',
    'book: b',
    'module: m',
    'status: active',
    '---',
  ].join('\n')
}

// ── SPEC-2.1 建表与 rowid 恒等式 ───────────────────────────────────────────────

describe('SPEC-2.1 段级三表：ensure 式幂等建 + rowid 恒等式', () => {
  it('重复 ensure / 重开库均不炸，且不重建（已有段行保留）', async () => {
    const home = makeHome()
    const kb = new PrismKnowledgeService({ home })
    await kb.deposit({
      id: 'C-1',
      title: '条目甲',
      type: 'rule',
      layer: 'global',
      book: 'b',
      content: '## 甲章\n甲甲内容。\n',
    })

    // 二次/三次 ensure：IF NOT EXISTS，幂等（不炸、不重建错）
    expect(() => ensureKbChunks(kb.persistence.knowledge)).not.toThrow()
    expect(() => ensureKbChunks(kb.persistence.knowledge)).not.toThrow()

    const before = chunksOf(kb, 'C-1')
    expect(before.length).toBeGreaterThan(0)
    expect(kb.persistence.knowledge.tables()).toContain('kb_chunks')
    expect(kb.persistence.knowledge.tables()).toContain('kb_chunk_fts')
    expect(kb.persistence.knowledge.tables()).toContain('kb_chunk_vectors')
    kb.close()

    // 重开库（构造器再跑一次 ensure）→ 段行原样保留
    const reopened = new PrismKnowledgeService({ home })
    try {
      expect(chunksOf(reopened, 'C-1')).toEqual(before)
      expect(() => ensureKbChunks(reopened.persistence.knowledge)).not.toThrow()
    } finally {
      reopened.close()
    }
  })

  it('kb_chunks.id ≡ kb_chunk_fts.rowid（双向无孤儿）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      await kb.deposit({
        id: 'C-2',
        title: '条目乙',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '## 一\n一一内容。\n## 二\n二二内容。\n',
      })

      const total = scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunks')
      expect(total).toBeGreaterThan(0)
      // 每个段行都在段 FTS 里有同 rowid 的行
      expect(
        scalar(
          kb,
          'SELECT COUNT(*) AS c FROM kb_chunks c WHERE NOT EXISTS (SELECT 1 FROM kb_chunk_fts f WHERE f.rowid = c.id)',
        ),
      ).toBe(0)
      // 反过来：段 FTS 没有孤儿行
      expect(
        scalar(
          kb,
          'SELECT COUNT(*) AS c FROM kb_chunk_fts WHERE rowid NOT IN (SELECT id FROM kb_chunks)',
        ),
      ).toBe(0)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_fts')).toBe(total)
    } finally {
      kb.close()
    }
  })

  it('段 FTS text 列 = 段原文；seg 含条目标题与 heading_path（标题词在段路可查）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      await kb.deposit({
        id: 'C-3',
        title: '订单服务规范',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '## 幂等设计\n本节描述幂等键的生成规则。\n',
      })

      const rows = chunksOf(kb, 'C-3')
      expect(rows).toHaveLength(1)
      const chunk = rows[0]!
      // text 列是段原文（不含标题行 / 不含路径）
      const ftsRow = kb.persistence.knowledge.raw
        .prepare('SELECT text FROM kb_chunk_fts WHERE rowid = ?')
        .get(chunk.id) as { text: string }
      expect(ftsRow.text).toBe(chunk.text)
      expect(ftsRow.text).not.toContain('幂等设计')
      expect(chunk.heading_path).toBe('幂等设计')

      // S-20：条目标题词可命中该段（走「大标题」拼接路径）
      expect(ftsHits(kb, '订单')).toBe(1)
      expect(ftsHits(kb, '规范')).toBe(1)
      // heading_path 词也可命中（段级标题路径进 seg）
      expect(ftsHits(kb, '幂等')).toBe(1)
      // 段正文词命中
      expect(ftsHits(kb, '生成')).toBe(1)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-2.2 版次策略 + reindex 无条件重建 ─────────────────────────────────────

describe('SPEC-2.2 版次策略：只留最新版', () => {
  it('v2 落库后 v1 的 chunks / 段 FTS / 段向量全删，v2 重写', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: fakeEmbed,
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      await kb.deposit({
        id: 'V-1',
        title: '条目甲',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: `## 版本一\n${'旧版数据'.repeat(10)}\n`,
      })
      expect(chunksOf(kb, 'V-1')[0]?.heading_path).toBe('版本一')
      expect(ftsHits(kb, '旧版')).toBe(1)

      await kb.deposit({
        id: 'V-1',
        title: '条目甲',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: `## 版本二\n${'新版数据'.repeat(10)}\n`,
      })

      const rows = chunksOf(kb, 'V-1')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.version).toBe(2)
      expect(rows[0]?.heading_path).toBe('版本二')
      expect(rows[0]?.text).toContain('新版数据')
      // 库内仅最新版：v1 段行、段 FTS 行、段向量都不复存在
      expect(
        scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunks WHERE entry_id = ? AND version = 1', 'V-1'),
      ).toBe(0)
      expect(ftsHits(kb, '旧版')).toBe(0)
      expect(ftsHits(kb, '新版')).toBe(1)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(1)
    } finally {
      kb.close()
    }
  })
})

describe('SPEC-2.2（BLOCKER）reindex 无条件重建三表', () => {
  it('改 body → reindex → char_start / heading_path / text 全部更新（无需嵌入）', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      const bodyV1 = `## 甲章\n${'甲方内容'.repeat(12)}\n### 乙章\n${'乙方内容'.repeat(12)}\n`
      const deposited = await kb.deposit({
        id: 'R-1',
        title: '重建条目',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: bodyV1,
      })

      const before = chunksOf(kb, 'R-1')
      expect(before.map((r) => r.heading_path)).toEqual(['甲章', '甲章 › 乙章'])
      expect(before[0]?.char_start).toBe(0)
      expect(before[1]?.char_start).toBe(bodyV1.indexOf('### 乙章'))
      expect(ftsHits(kb, '甲方')).toBe(1)

      // 模拟「外部改文件」：只换正文，frontmatter 保留
      const bodyV2 = `## 丙章\n${'丙方内容'.repeat(12)}\n### 丁章\n${'丁方内容'.repeat(12)}\n`
      writeFileSync(deposited.path, `${frontmatterFor('R-1')}\n${bodyV2}`, 'utf-8')

      const report = await kb.reindex()
      expect(report.indexed).toBe(1)

      const after = chunksOf(kb, 'R-1')
      expect(after.map((r) => r.heading_path)).toEqual(['丙章', '丙章 › 丁章'])
      expect(after[0]?.char_start).toBe(0)
      expect(after[1]?.char_start).toBe(bodyV2.indexOf('### 丁章'))
      expect(after[after.length - 1]?.char_end).toBe(bodyV2.length)
      expect(after[0]?.text).toContain('丙方内容')
      // 段 FTS 同源更新：旧词不再可查（不得再喂旧文本 / 旧偏移）
      expect(ftsHits(kb, '甲方')).toBe(0)
      expect(ftsHits(kb, '丙方')).toBe(1)
      // 无嵌入装配 → 段向量恒空，但 chunks / 段 FTS 已重建
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(0)
    } finally {
      kb.close()
    }
  })

  it('reindex 清掉「版次文件已消失」的自有型段行，但保留引用型段行', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      const owned = await kb.deposit({
        id: 'OWN-1',
        title: '自有条目',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '## 自有\n自有内容段落。\n',
      })
      await kb.index({
        id: 'IDX-1',
        title: '引用条目',
        layer: 'project',
        owner: 'p',
        book: 'p',
        path: 'D:/proj/README.md',
        source_hash: 'h1',
        content: '## 引用\n引用内容段落。\n',
      })
      expect(chunksOf(kb, 'OWN-1').length).toBeGreaterThan(0)
      expect(chunksOf(kb, 'IDX-1').length).toBeGreaterThan(0)

      // 删掉自有型版次文件 → reindex 后它不再有 entries 行，段行必须一并清掉
      rmSync(join(owned.path, '..'), { recursive: true, force: true })
      await kb.reindex()

      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunks WHERE entry_id = ?', 'OWN-1')).toBe(0)
      expect(chunksOf(kb, 'IDX-1').length).toBeGreaterThan(0)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-2.3 嵌入不可用 ────────────────────────────────────────────────────────

describe('SPEC-2.3 嵌入不可用：段行 + 段 FTS 照写，段向量空', () => {
  it('未装配 embed → kb_chunks / kb_chunk_fts 有行，kb_chunk_vectors 空', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: { minChars: 5, maxChars: 500 },
    })
    try {
      await kb.deposit({
        id: 'N-1',
        title: '无嵌入条目',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '## 一段\n一段正文内容。\n## 二段\n二段正文内容。\n',
      })

      const rows = chunksOf(kb, 'N-1')
      expect(rows.length).toBe(2)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_fts')).toBe(rows.length)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(0)
      // 条目级向量同样未写（对照）
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_vectors')).toBe(0)
    } finally {
      kb.close()
    }
  })

  it('embed 抛错也不阻断：条目仍落库、段行仍恒写', async () => {
    const failing = async (): Promise<Float32Array> => {
      throw new Error('embedding 未就绪')
    }
    const kb = new PrismKnowledgeService({ home: makeHome(), embed: failing })
    try {
      const deposited = await kb.deposit({
        id: 'N-2',
        title: '失败条目',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '## 段\n段正文内容。\n',
      })
      expect(deposited.action).toBe('created')
      expect(chunksOf(kb, 'N-2').length).toBeGreaterThan(0)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(0)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_vectors')).toBe(0)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-2.4 短文档双粒度并存 ─────────────────────────────────────────────────

describe('SPEC-2.4 短文档：恰 1 chunk，且整篇向量与段向量并存', () => {
  it('≤maxChars 无切点 → 1 chunk 覆盖 [0, body.length)；双粒度都写', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: fakeEmbed,
      embeddingModel: 'test-4d',
    })
    try {
      const body = '短文档正文，不足一段上限。'
      await kb.deposit({
        id: 'S-1',
        title: '短条目',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: body,
      })

      const rows = chunksOf(kb, 'S-1')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.seq).toBe(0)
      expect(rows[0]?.heading_path).toBe('')
      expect(rows[0]?.char_start).toBe(0)
      expect(rows[0]?.char_end).toBe(body.length)
      expect(rows[0]?.text).toBe(body)

      // 双粒度并存：整篇 1 行 + 段 1 行
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_vectors WHERE entry_id = ?', 'S-1')).toBe(1)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(1)
      const vecRow = kb.persistence.knowledge.raw
        .prepare('SELECT dim, model FROM kb_chunk_vectors')
        .get() as { dim: number; model: string }
      expect(vecRow.dim).toBe(4)
      expect(vecRow.model).toBe('test-4d')
    } finally {
      kb.close()
    }
  })

  it('多段 doc：seq 连续、区间有序不重叠无缝、段向量逐段一行', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: fakeEmbed,
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      const body = `## 一\n${'一段内容'.repeat(6)}\n## 二\n${'二段内容'.repeat(6)}\n`
      await kb.deposit({
        id: 'M-1',
        title: '多段条目',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: body,
      })

      const rows = chunksOf(kb, 'M-1')
      expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i))
      expect(rows[0]?.char_start).toBe(0)
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]?.char_start).toBe(rows[i - 1]?.char_end)
      }
      expect(rows[rows.length - 1]?.char_end).toBe(body.length)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(rows.length)
    } finally {
      kb.close()
    }
  })
})

// ── 删除面 ────────────────────────────────────────────────────────────────────

describe('remove：硬删清三表，软删保留段行', () => {
  it('remove(hard:true) 段行 / 段 FTS / 段向量全清', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: fakeEmbed,
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      await kb.deposit({
        id: 'D-1',
        title: '待硬删',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: `## 段甲\n${'甲内容'.repeat(6)}\n## 段乙\n${'乙内容'.repeat(6)}\n`,
      })
      expect(chunksOf(kb, 'D-1').length).toBe(2)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(2)

      const result = await kb.remove('D-1', { hard: true })
      expect(result.mode).toBe('hard')

      expect(chunksOf(kb, 'D-1')).toHaveLength(0)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunks')).toBe(0)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_fts')).toBe(0)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_vectors')).toBe(0)
    } finally {
      kb.close()
    }
  })

  it('软删不动段级索引（restore 后仍可用）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      await kb.deposit({
        id: 'D-2',
        title: '软删条目',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '## 段\n软删正文内容。\n',
      })
      const before = chunksOf(kb, 'D-2')
      expect(before.length).toBeGreaterThan(0)

      const result = await kb.remove('D-2')
      expect(result.mode).toBe('soft')
      expect(chunksOf(kb, 'D-2')).toEqual(before)
      expect(scalar(kb, 'SELECT COUNT(*) AS c FROM kb_chunk_fts')).toBe(before.length)
    } finally {
      kb.close()
    }
  })
})

// ── chunkOptions 贯通（SPEC-1.13 wiring 的前提）────────────────────────────────

describe('chunkOptions 透传', () => {
  it('注入的 maxChars / minChars 生效；不注入则 2000/120 默认', async () => {
    const body = `${'甲'.repeat(300)}\n\n${'乙'.repeat(300)}\n`

    const small = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: { maxChars: 200, minChars: 50 },
    })
    const wide = new PrismKnowledgeService({ home: makeHome() })
    try {
      await small.deposit({
        id: 'O-1',
        title: 'T',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: body,
      })
      await wide.deposit({
        id: 'O-1',
        title: 'T',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: body,
      })

      const smallRows = chunksOf(small, 'O-1')
      const wideRows = chunksOf(wide, 'O-1')
      expect(smallRows.length).toBeGreaterThan(wideRows.length)
      expect(wideRows).toHaveLength(1)
      for (const row of smallRows) expect(row.text.length).toBeLessThanOrEqual(220)
    } finally {
      small.close()
      wide.close()
    }
  })
})

// ── 坐标系护栏（检视 v13 m-2 的后端侧锁定，tester-whitebox 补测）───────────────
//
// splitFrontmatter 把 body 的 CRLF 归一为 LF，而 web 解析层按原串计偏移——两套坐标
// 不同系（types.ts SearchHit 注释已立「永久禁止偏移上线」护栏）。本用例把后端侧的
// 内部一致性钉死：reindex 后段行坐标 **必须** 等于「归一化 body 重切」的结果，
// 且 seq/heading_path/text 在 LF↔CRLF 两种行尾下逐字段稳定（seq 寻址不歪）。

describe('坐标系护栏（m-2）：CRLF 版次文件 reindex 后段行 = 归一化 body 重切', () => {
  it('CRLF+FM 文件经 reindex：段行与 chunkMarkdown(splitFrontmatter(raw).body) 逐字段一致；seq 寻址跨行尾风格稳定', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      const deposited = await kb.deposit({
        id: 'CRLF-1',
        title: '行尾护栏',
        type: 'rule',
        layer: 'global',
        book: 'b',
        content: '占位正文，让首版落库成立。\n',
      })

      // 模拟外部编辑器产出 CRLF 文件（frontmatter + 正文全 CRLF）
      const bodyLines = ['## 丙章', '丙方内容。'.repeat(6), '', '### 丁章', '丁方内容。'.repeat(6), '']
      const crlf = (s: string): string => s.replace(/\n/g, '\r\n')
      writeFileSync(deposited.path, `${crlf(frontmatterFor('CRLF-1'))}\r\n${crlf(bodyLines.join('\n'))}`, 'utf-8')

      const report = await kb.reindex()
      expect(report.indexed).toBe(1)

      // 后端真相：DB 段行坐标 = 归一化（CRLF→LF）body 的重切结果，逐字段含偏移
      const { body: normalized } = splitFrontmatter(readFileSync(deposited.path, 'utf-8'))
      const expected = chunkMarkdown(normalized, { minChars: 10, maxChars: 500 })
      const rows = chunksOf(kb, 'CRLF-1')
      expect(rows.map((r) => [r.seq, r.heading_path, r.text, r.char_start, r.char_end])).toEqual(
        expected.map((c) => [c.seq, c.headingPath, c.text, c.charStart, c.charEnd]),
      )

      // wire 面只用 seq 寻址：LF 变体重切的 seq/heading_path/text 与 CRLF 库行逐字段一致
      const lfChunks = chunkMarkdown(bodyLines.join('\n'), { minChars: 10, maxChars: 500 })
      expect(rows.map((r) => [r.seq, r.heading_path, r.text])).toEqual(
        lfChunks.map((c) => [c.seq, c.headingPath, c.text]),
      )
    } finally {
      kb.close()
    }
  })
})
