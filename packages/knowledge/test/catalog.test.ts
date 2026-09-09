import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeService(): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-catalog-'))
  dirs.push(home)
  return new PrismKnowledgeService({ home })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('catalog（全量目录，供星图/下钻）', () => {
  it('返回全量最新版条目（含无连边的孤立条目）；带出入度', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'C-A', title: 'A', type: 'rule', layer: 'global', book: 'b1', content: 'A' })
      await service.deposit({ id: 'C-B', title: 'B', type: 'doc', layer: 'global', book: 'b1', content: 'B [[C-A]]' })
      await service.deposit({ id: 'C-C', title: 'C', type: 'guide', layer: 'global', book: 'b2', content: 'C 孤立' })

      const all = await service.catalog()
      expect(all.map((e) => e.id).sort()).toEqual(['C-A', 'C-B', 'C-C'])
      const a = all.find((e) => e.id === 'C-A')!
      const b = all.find((e) => e.id === 'C-B')!
      expect(a.in_degree).toBe(1)
      expect(b.out_degree).toBe(1)
      // 孤立条目也在目录里（星图要显示未连接的星）
      expect(all.find((e) => e.id === 'C-C')!.in_degree).toBe(0)
    } finally {
      service.close()
    }
  })

  it('按 layer / book 过滤；limit 生效', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'L-1', title: 'L1', type: 'rule', layer: 'global', book: 'bg', content: 'x' })
      await service.deposit({ id: 'L-2', title: 'L2', type: 'rule', layer: 'project', owner: 'p1', book: 'bp', content: 'y' })
      expect((await service.catalog({ layer: 'global' })).map((e) => e.id)).toEqual(['L-1'])
      expect((await service.catalog({ book: 'bp' })).map((e) => e.id)).toEqual(['L-2'])
      expect((await service.catalog({ limit: 1 }))).toHaveLength(1)
    } finally {
      service.close()
    }
  })
})
