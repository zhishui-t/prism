import { describe, expect, it } from 'vitest'

import {
  FrontmatterError,
  emitScalar,
  parseFrontmatter,
  renderMarkdownFile,
  serializeFrontmatter,
  splitFrontmatter,
} from '../src/frontmatter.js'

describe('frontmatter 独立解析器（design-v3 §3.1.1 十类语法）', () => {
  it('1. 顶层标量（含数字/布尔/null 类型化）', () => {
    const data = parseFrontmatter('team_id: core-dev\nrework_limit: 2\ndefault: true\nnote: null\nratio: 1.5')
    expect(data).toEqual({ team_id: 'core-dev', rework_limit: 2, default: true, note: null, ratio: 1.5 })
  })

  it('2. 引号标量（含冒号/特殊字符；双引号与单引号转义）', () => {
    const data = parseFrontmatter([
      'name: "QA-checker"',
      'description: "适用于：代码审计（: 冒号在内）"',
      "quote: 'it''s ok'",
    ].join('\n'))
    expect(data.name).toBe('QA-checker')
    expect(data.description).toBe('适用于：代码审计（: 冒号在内）')
    expect(data.quote).toBe("it's ok")
  })

  it('3a. 多行折叠 >（续行折为空格；clip 默认保留一个结尾换行）', () => {
    const data = parseFrontmatter('description: >\n  白盒安全审计角色。适用于：漏洞审计。\n  不适用于：性能优化。')
    expect(data.description).toBe('白盒安全审计角色。适用于：漏洞审计。 不适用于：性能优化。\n')
  })

  it('3b. 多行字面 |（保留换行；clip/strip/+ chomping）', () => {
    const clip = parseFrontmatter('text: |\n  a\n  b')
    expect(clip.text).toBe('a\nb\n')
    const strip = parseFrontmatter('text: |-\n  a\n  b')
    expect(strip.text).toBe('a\nb')
    const foldedBlank = parseFrontmatter('text: >\n  a\n\n  b')
    expect(foldedBlank.text).toBe('a\nb\n')
  })

  it('4. flow 数组（含引号项/空数组）', () => {
    const data = parseFrontmatter('layers: [global, role]\nmixed: ["a: b", c]\nempty: []')
    expect(data.layers).toEqual(['global', 'role'])
    expect(data.mixed).toEqual(['a: b', 'c'])
    expect(data.empty).toEqual([])
  })

  it('5. flow 映射（含嵌套 flow）', () => {
    const data = parseFrontmatter('match: { type: rule }\nnested: { a: [1, 2], b: x }')
    expect(data.match).toEqual({ type: 'rule' })
    expect(data.nested).toEqual({ a: [1, 2], b: 'x' })
  })

  it('6. 块式嵌套映射（knowledge: layers/books）', () => {
    const data = parseFrontmatter('knowledge:\n  layers: [global, role]\n  books:\n    - security-redline')
    expect(data.knowledge).toEqual({ layers: ['global', 'role'], books: ['security-redline'] })
  })

  it('7. 块式序列-of-标量（skills:）', () => {
    const data = parseFrontmatter('skills:\n  - taint_trace\n  - payload_generate')
    expect(data.skills).toEqual(['taint_trace', 'payload_generate'])
  })

  it('8. 块式序列-of-映射（members: 多项不被末项覆盖）', () => {
    const data = parseFrontmatter('members:\n  - role: dev-1\n    count: 2\n  - role: tester\n    count: 1')
    expect(data.members).toEqual([
      { role: 'dev-1', count: 2 },
      { role: 'tester', count: 1 },
    ])
  })

  it('9. 两层嵌套映射（deposit:）', () => {
    const data = parseFrontmatter('deposit:\n  enabled: true\n  default_layer: project\n  default_type: pitfall\n  priority: medium\n  require_note: false')
    expect(data.deposit).toEqual({
      enabled: true,
      default_layer: 'project',
      default_type: 'pitfall',
      priority: 'medium',
      require_note: false,
    })
  })

  it('10. 序列-of-映射（规则：match/set）', () => {
    const yaml = [
      'rules:',
      '  - match: { type: rule }',
      '    set: { layer: global, priority: high }',
      '  - match:',
      '      tags:',
      '      - security',
      '    set:',
      '      layer: global',
    ].join('\n')
    const data = parseFrontmatter(yaml)
    expect(data.rules).toEqual([
      { match: { type: 'rule' }, set: { layer: 'global', priority: 'high' } },
      { match: { tags: ['security'] }, set: { layer: 'global' } },
    ])
  })

  it('注释行与行尾注释被忽略；# 在引号内不算注释', () => {
    const data = parseFrontmatter('# 顶部注释\nname: x # 行尾注释\ndesc: "a # b"')
    expect(data).toEqual({ name: 'x', desc: 'a # b' })
  })

  it('同缩进序列（key: 下的 - 项不缩进）也支持', () => {
    const data = parseFrontmatter('skills:\n- a\n- b')
    expect(data.skills).toEqual(['a', 'b'])
  })
})

describe('frontmatter 不支持语法 → parse_unsupported（§3.1.1）', () => {
  const cases: Array<[string, RegExp]> = [
    ['anchor: &a value', /锚点|别名|标签/],
    ['alias: *a', /锚点|别名|标签/],
    ['tag: !!str value', /锚点|别名|标签/],
    ['a: 1\n---\nb: 2', /多文档/],
    ['? complex\n: key', /不支持/],
    ['a: >2\n  x', /缩进指示/],
  ]
  for (const [yaml, match] of cases) {
    it(`拒绝：${yaml.split('\n')[0]}`, () => {
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterError)
      try {
        parseFrontmatter(yaml)
      } catch (err) {
        expect((err as FrontmatterError).code).toBe('parse_unsupported')
        expect((err as FrontmatterError).message).toMatch(match)
      }
    })
  }

  it('制表符缩进 → parse_unsupported；结构坏行 → parse_failed', () => {
    expect(() => parseFrontmatter('a:\n\tb: 1')).toThrow(FrontmatterError)
    try {
      parseFrontmatter('a:\n\tb: 1')
    } catch (err) {
      expect((err as FrontmatterError).code).toBe('parse_unsupported')
    }
    expect(() => parseFrontmatter('just text')).toThrow(FrontmatterError)
    try {
      parseFrontmatter('just text')
    } catch (err) {
      expect((err as FrontmatterError).code).toBe('parse_failed')
      expect((err as FrontmatterError).line).toBe(1)
    }
  })

  it('解析失败带行号（team_parse_failed 依赖此能力）', () => {
    try {
      parseFrontmatter('a: 1\nb')
    } catch (err) {
      expect((err as FrontmatterError).line).toBe(2)
    }
  })
})

describe('frontmatter 往返（serialize → parse 等价）', () => {
  it('含冒号/特殊字符的值回写加引号（harness §2.1 引号约束）', () => {
    expect(emitScalar('dev-1')).toBe('dev-1')
    expect(emitScalar('QA-checker')).toBe('QA-checker')
    expect(emitScalar('custom:builtin%3Abigmodel-coding-plan:GLM-5.3')).toBe(
      '"custom:builtin%3Abigmodel-coding-plan:GLM-5.3"',
    )
    expect(emitScalar('适用于：审计')).toBe('"适用于：审计"')
    expect(emitScalar('true')).toBe('"true"') // 看似布尔的字符串必须加引号
    expect(emitScalar('42')).toBe('"42"')
    expect(emitScalar('')).toBe('""')
  })

  it('完整数据往返等价（嵌套映射/序列-of-映射/多行标量）', () => {
    const data = {
      team_id: 'core-dev',
      name: '核心研发团队',
      description: '负责设计、开发：含冒号的描述',
      default: true,
      rework_limit: 2,
      members: [
        { role: 'dev-1', count: 2 },
        { role: 'qa-checker', count: 1 },
      ],
      skills: ['code_review', 'security: audit'],
      knowledge: { layers: ['global', 'project'], books: [] },
      deposit: {
        enabled: true,
        default_layer: 'project',
        rules: [
          { match: { type: 'rule' }, set: { layer: 'global', priority: 'high' } },
          { match: { tags: ['security'] }, set: { layer: 'global' } },
        ],
      },
      arbitration: ['safety', 'requirement'],
      model: 'custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash',
    }
    const round = splitFrontmatter(serializeFrontmatter(data)).data
    expect(round).toEqual(data)
  })

  it('序列化产物是合法的 frontmatter 文件（含嵌套块式结构，人可读）', () => {
    const text = serializeFrontmatter({
      members: [{ role: 'dev-1', count: 2 }],
      deposit: { enabled: true, rules: [{ match: { type: 'rule' }, set: { layer: 'global' } }] },
    })
    expect(text).toBe(
      [
        '---',
        'members:',
        '- role: dev-1',
        '  count: 2',
        'deposit:',
        '  enabled: true',
        '  rules:',
        '  - match:',
        '      type: rule',
        '    set:',
        '      layer: global',
        '---',
        '',
      ].join('\n'),
    )
  })

  it('多行字符串经序列化（JSON 转义）往返等价', () => {
    const data = { note: '第一行\n第二行\n\n第四行' }
    expect(splitFrontmatter(serializeFrontmatter(data)).data).toEqual(data)
  })

  it('splitFrontmatter：拆头/正文；无头返回 null；正文含 --- 主题分隔不受干扰', () => {
    const withFm = splitFrontmatter('---\nname: dev-1\n---\n\n# 正文\n\n---\n')
    expect(withFm.data).toEqual({ name: 'dev-1' })
    expect(withFm.body.startsWith('\n# 正文')).toBe(true)
    const noFm = splitFrontmatter('# 纯正文')
    expect(noFm.data).toBeNull()
    expect(noFm.body).toBe('# 纯正文')
  })

  it('renderMarkdownFile：frontmatter + 正文拼接（正文自带结尾换行）', () => {
    const file = renderMarkdownFile({ name: 'x' }, '# 标题\n正文')
    expect(file.startsWith('---\nname: x\n---\n# 标题\n正文\n')).toBe(true)
  })
})
