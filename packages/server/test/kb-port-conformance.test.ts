import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { DepositInput } from '../src/kb/port.js'
import { MemoryKb } from './helpers.js'

/**
 * `MemoryKb implements KnowledgeService` 的显式守护（流 A-1 报告 §4.2 的隐型地雷）。
 *
 * 地雷成因：`packages/server/tsconfig.json` 只 `include: ["src"]`，**测试文件从没被
 * `tsc` 看过**；vitest 只转译不做类型检查。于是「桩漏实现端口新方法」一路绿灯，
 * 直到某条测试真的调用它 → 运行时 `xxx is not a function`；桩少返回一个字段
 * （如 `DepositResult.action`）同样只会让断言绕道或变假绿。
 *
 * 两道防线：
 * 1. **编译期**：`tsconfig.testcheck.json`（已串进 `pnpm --filter @prism/server typecheck`）
 *    让 `implements` / `satisfies` 真正生效——漏方法、签名不符、返回类型窄化都是编译错误；
 * 2. **运行期**：本文件从契约真相 `packages/knowledge/src/types.ts` **现场解析**接口成员，
 *    逐个断言桩上是可调用函数。不维护任何镜像清单，端口加方法这里自动跟上。
 */

const TYPES_PATH = fileURLToPath(new URL('../../knowledge/src/types.ts', import.meta.url))

/**
 * 从契约真相里抠出 `interface KnowledgeService` 的方法名（含可选方法 `foo?(`）。
 *
 * 只认「名字后跟 `(`」的行，故内联对象类型里的属性（如 `options?: { hard?: boolean }`
 * 换行时的 `hard?:`）不会被误当成成员。
 */
async function portMethodNames(): Promise<string[]> {
  const src = await readFile(TYPES_PATH, 'utf-8')
  const start = src.indexOf('export interface KnowledgeService {')
  expect(start, `${TYPES_PATH} 里找不到 interface KnowledgeService`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  const names: string[] = []
  for (const raw of src.slice(start, end).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('/') || line.startsWith('*')) continue
    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*\(/.exec(line)
    if (m !== null) names.push(m[1]!)
  }
  return names
}

/** 本轮新增/修复的 4 个方法（F-A1/F-B4），单独列出便于失败时定位。 */
const NEW_METHODS = ['bookStructure', 'generateBookStructure', 'freezeBookStructure', 'listVersions'] as const

/** 直落一条条目（省去每个用例重复写字段）。 */
async function seed(kb: MemoryKb, input: Partial<DepositInput> & { id: string; content: string }): Promise<void> {
  await kb.deposit({
    title: input.id,
    type: 'rule',
    layer: 'global',
    book: 'sb',
    ...input,
  } as DepositInput)
}

describe('KnowledgeService 端口一致性（MemoryKb 桩）', () => {
  it('契约真相里的每个成员在桩上都是可调用方法（防「漏实现 → not a function」）', async () => {
    const names = await portMethodNames()
    // 解析器自检：解析失败会得到空数组，那样「零缺失」也是假绿
    expect(names.length).toBeGreaterThanOrEqual(18)
    expect(names).toEqual(expect.arrayContaining(['deposit', 'search', 'get', 'catalog', 'stats', 'graph', 'path', ...NEW_METHODS]))

    const kb = new MemoryKb() as unknown as Record<string, unknown>
    expect(names.filter((n) => typeof kb[n] !== 'function')).toEqual([])
  })

  it('deposit 返回端口 DepositResult（含 action）：新建 → created，同 id 改内容 → updated', async () => {
    const kb = new MemoryKb()
    const created = await kb.deposit({ id: 'D-1', title: 'T', type: 'rule', layer: 'global', book: 'sb', content: 'v1' })
    expect(created).toMatchObject({ id: 'D-1', version: 1, action: 'created' })
    expect(created.path).toContain('D-1')

    const updated = await kb.deposit({ id: 'D-1', title: 'T', type: 'rule', layer: 'global', book: 'sb', content: 'v2' })
    expect(updated).toMatchObject({ id: 'D-1', version: 2, action: 'updated' })
  })

  it('deposit 与真实服务同口径的 unchanged：正文哈希未变 → 不产生新版次', async () => {
    const kb = new MemoryKb()
    await seed(kb, { id: 'U-1', content: '同一段正文' })
    const again = await kb.deposit({ id: 'U-1', title: 'U-1', type: 'rule', layer: 'global', book: 'sb', content: '同一段正文' })
    expect(again).toMatchObject({ version: 1, action: 'unchanged' })
    expect(await kb.listVersions('U-1')).toHaveLength(1)
  })

  it('listVersions（F-B4）：降序 + 只有最新版 is_latest + source_path 恒为该版次路径；未知 id → 空数组', async () => {
    const kb = new MemoryKb()
    await seed(kb, { id: 'V-1', content: 'v1' })
    await seed(kb, { id: 'V-1', content: 'v2' })

    const versions = await kb.listVersions('V-1')
    expect(versions.map((v) => v.version)).toEqual([2, 1])
    expect(versions.map((v) => v.is_latest)).toEqual([true, false])
    expect(versions.map((v) => v.status)).toEqual(['active', 'superseded'])
    // 自有型条目的 source_path = 版次文件路径（与真实服务一致，不是 null）
    expect(versions[0]!.source_path).toBe('global/sb/V-1/v02.md')
    expect(await kb.listVersions('没有这个条目')).toEqual([])
  })

  it('书结构（F-A1）：未生成 → null；generate 推导 suggested（降序 + _inbox 殿后）且 revision 不涨', async () => {
    const kb = new MemoryKb()
    // 结构不存在 ≠ 空结构：路由/断言若把空对象当「结构存在」就会假绿
    expect(await kb.bookStructure('global', 'sb')).toBeNull()

    await seed(kb, { id: 'B-1', content: 'c1', module: 'core' })
    await seed(kb, { id: 'B-2', content: 'c2', module: 'core' })
    await seed(kb, { id: 'B-3', content: 'c3', module: 'api' })
    await seed(kb, { id: 'B-4', content: 'c4' }) // 不传 module → _inbox

    const gen = await kb.generateBookStructure({ layer: 'global', book: 'sb', confirmed_by: 'dev-2' })
    expect(gen.structure.suggested).toEqual([
      { slug: 'core', entries: 2 },
      { slug: 'api', entries: 1 },
      { slug: '_inbox', entries: 1 },
    ])
    expect(gen.structure).toMatchObject({ layer: 'global', book: 'sb', revision: 0, modules: [], frozen_at: null, confirmed_by: 'dev-2' })
    // 桩不落文件：显式断言「未建模」的返回值，免得被当成「三份文件已生成」
    expect(gen.files).toEqual([])

    // 幂等：只有 freeze 递增 revision
    const again = await kb.generateBookStructure({ layer: 'global', book: 'sb' })
    expect(again.structure.revision).toBe(0)
    expect(again.structure.confirmed_by).toBe('dev-2')
    // 生成后可读回，且换 layer 不串味
    expect((await kb.bookStructure('global', 'sb'))?.suggested).toEqual(gen.structure.suggested)
    expect(await kb.bookStructure('project', 'sb')).toBeNull()
  })

  it('书结构（F-A1）：freeze → revision+1 + frozen_at + modules 取建议（去 _inbox），读回一致', async () => {
    const kb = new MemoryKb()
    await seed(kb, { id: 'F-1', content: 'c1', module: 'core' })
    await seed(kb, { id: 'F-2', content: 'c2', module: 'api' })
    await seed(kb, { id: 'F-3', content: 'c3' })

    const frozen = await kb.freezeBookStructure({ layer: 'global', book: 'sb', confirmed_by: 'dev-2' })
    expect(frozen.revision).toBe(1)
    // core/api 各 1 条 → 条目数平局，按 slug 升序（与真实服务 deriveSuggested 同口径）；
    // `_inbox` 不作为可冻结模块（它是「未归类」桶，不是模块）
    expect(frozen.modules).toEqual(['api', 'core'])
    expect(frozen.frozen_at).not.toBeNull()
    expect(await kb.bookStructure('global', 'sb')).toEqual(frozen)

    // 显式 modules 覆盖 + revision 再递增
    const second = await kb.freezeBookStructure({ layer: 'global', book: 'sb', modules: ['core'], confirmed_by: 'dev-2' })
    expect(second).toMatchObject({ revision: 2, modules: ['core'] })
  })

  it('书结构（F-A1）：空书 freeze → bad_request（与真实服务同口径，防「冻结空书」假绿）', async () => {
    const kb = new MemoryKb()
    await expect(kb.freezeBookStructure({ layer: 'global', book: '空书' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(await kb.bookStructure('global', '空书')).toBeNull()
  })

  /**
   * 本用例是被上面「端口一致性」用例**抓出来的第 5 个漏方法**：`restore` 在端口里是
   * 可选成员，`implements` 不要求它，但 HTTP/MCP 都暴露了 restore 入口——桩上没有它
   * 就是一个「调用即 not a function」的雷。补桩后在此锁死语义。
   */
  it('restore（B1 逆操作）：软删 → 恢复为 active（幂等 false）；不存在 → not_found', async () => {
    const kb = new MemoryKb()
    await seed(kb, { id: 'RS-1', content: 'v1' })
    expect(await kb.restore('RS-1')).toEqual({ id: 'RS-1', restored: false }) // 本就 active

    await kb.remove('RS-1')
    expect((await kb.get('RS-1'))?.status).toBe('deprecated')
    expect(await kb.restore('RS-1')).toEqual({ id: 'RS-1', restored: true })
    expect((await kb.get('RS-1'))?.status).toBe('active')
    expect(await kb.restore('RS-1')).toEqual({ id: 'RS-1', restored: false }) // 幂等
    await expect(kb.restore('没有这个条目')).rejects.toMatchObject({ code: 'not_found' })
  })
})
