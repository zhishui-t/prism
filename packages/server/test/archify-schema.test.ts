/**
 * `readArchifySchema` —— IR 契约的分发口。
 *
 * 存在理由：五类图只有 `workflow` 有生成器，其余四类的 IR 由宿主按 schema 产出。
 * 若这个口子坏掉，宿主就只能回头让用户手写 JSON（R7 声称的「IR 是派生视图」落空）。
 */
import { describe, expect, it } from 'vitest'

import {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_SCHEMA_KEYS,
  readArchifySchema,
} from '../src/graph/archify.js'

describe('readArchifySchema', () => {
  it('五类图都能读到合法 JSON Schema，且 diagram_type 常量自洽', async () => {
    for (const type of ARCHIFY_DIAGRAM_TYPES) {
      const schema = (await readArchifySchema(type)) as {
        $schema?: string
        properties?: { diagram_type?: { const?: string } }
        required?: string[]
      }
      expect(schema.$schema, type).toBeTruthy()
      expect(schema.properties?.diagram_type?.const, type).toBe(type)
      expect(schema.required, type).toContain('meta')
    }
  })

  it('common 可读（各类 IR 会 $ref 引用它的 $defs）', async () => {
    const common = (await readArchifySchema('common')) as { $defs?: Record<string, unknown> }
    expect(common.$defs).toBeTruthy()
    expect(Object.keys(common.$defs ?? {}).length).toBeGreaterThan(0)
  })

  it('未知键报 bad_request，并附允许值', async () => {
    await expect(readArchifySchema('bogus')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(readArchifySchema('bogus')).rejects.toMatchObject({
      details: { allowed: [...ARCHIFY_SCHEMA_KEYS] },
    })
  })

  it('ARCHIFY_SCHEMA_KEYS = 五类图 + common', () => {
    expect([...ARCHIFY_SCHEMA_KEYS]).toEqual([...ARCHIFY_DIAGRAM_TYPES, 'common'])
  })
})
