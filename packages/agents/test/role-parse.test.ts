import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRoleRegistry } from '../src/registry.js'
import { RoleParseError, extractPrinciple, parseRoleMarkdown } from '../src/role/parse.js'
import { renderZcodeRole } from '../src/role/render.js'

/**
 * 本机真实角色目录（只读导入验证；F07 验收命令的数据源）。
 * QA v4 修复 D-3：原为硬编码 `C:/Users/10042/.zcode/agents`（换机/换用户即静默跳过，
 * 覆盖度无声下降，且属 R6「不硬编码宿主路径」的灰区）→ 改由 `os.homedir()` 推导。
 */
const REAL_AGENTS_DIR = join(homedir(), '.zcode', 'agents')
const REAL_ROLE_NAMES = ['dev-1', 'dev-2', 'dev-3', 'qa-checker', 'researcher', 'reviewer', 'super-dev', 'tester', 'writer']

function makeTmp(): string {
  return join(tmpdir(), `prism-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

const BASIC_ROLE = [
  '---',
  'name: "dev-1"',
  'description: "一般开发：前期探索与常规开发。适用于：功能编码。不适用于：架构攻关。"',
  'color: cyan',
  'model: "custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash"',
  'thoughtLevel: max',
  'injectAgentsMd: true',
  '---',
  '',
  '# 一般开发 dev-1',
  '',
  '## 核心契约',
  '**交付可运行的增量，绝不扩大战场。**',
  '',
  '这条契约裁决你的一切日常冲突。',
  '',
  '## 职责',
  '- 前期探索',
  '',
  '## 边界（禁止）',
  '- 不做任务书之外的功能',
].join('\n')

describe('角色解析（ZCode 既有格式）', () => {
  it('解析 frontmatter 全字段 + 正文与核心契约节', () => {
    const role = parseRoleMarkdown(BASIC_ROLE, { sourcePath: 'C:/x/dev-1.md' })
    expect(role.name).toBe('dev-1')
    expect(role.description).toContain('适用于：功能编码')
    expect(role.color).toBe('cyan')
    expect(role.model).toBe('custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash')
    expect(role.thoughtLevel).toBe('max')
    expect(role.injectAgentsMd).toBe(true)
    // 导入缺省（role-definition §5）：补 skills 空白名单 + knowledge 默认两层
    expect(role.skills).toEqual([])
    expect(role.knowledge).toEqual({ layers: ['global', 'project'] })
    expect(role.principle).toBe('**交付可运行的增量，绝不扩大战场。**\n\n这条契约裁决你的一切日常冲突。')
    expect(role.body).toContain('## 职责')
    expect(role.body).toContain('## 边界（禁止）')
    expect(role.sourcePath).toBe('C:/x/dev-1.md')
  })

  it('兼容「## 核心第一原则」节名（导入容错）', () => {
    const role = parseRoleMarkdown('---\nname: a\ndescription: b\n---\n\n## 核心第一原则\n**原则本体。**\n')
    expect(role.principle).toBe('**原则本体。**')
  })

  it('缺失 frontmatter → RoleParseError(no_frontmatter)', () => {
    expect(() => parseRoleMarkdown('# 纯正文，无 frontmatter')).toThrow(RoleParseError)
    try {
      parseRoleMarkdown('# 纯正文')
    } catch (err) {
      expect((err as RoleParseError).code).toBe('no_frontmatter')
    }
  })

  it('frontmatter 不支持语法 → RoleParseError(parse_unsupported)', () => {
    expect(() => parseRoleMarkdown('---\nname: &anchor x\n---\n')).toThrow(RoleParseError)
    try {
      parseRoleMarkdown('---\nname: &anchor x\n---\n')
    } catch (err) {
      expect((err as RoleParseError).code).toBe('parse_unsupported')
    }
  })

  it('skills/knowledge 显式声明被解析（块式序列 + 嵌套映射）', () => {
    const raw = [
      '---',
      'name: security-auditor',
      'description: >',
      '  白盒安全审计角色。适用于：漏洞审计。',
      'color: red',
      'skills:',
      '  - taint_trace',
      '  - cve_query',
      'knowledge:',
      '  layers: [global, role]',
      '  books: [security-redline]',
      '---',
      '',
      '## 核心契约',
      '**存疑即阻断。**',
    ].join('\n')
    const role = parseRoleMarkdown(raw)
    expect(role.skills).toEqual(['taint_trace', 'cve_query'])
    expect(role.knowledge).toEqual({ layers: ['global', 'role'], books: ['security-redline'] })
    expect(role.principle).toBe('**存疑即阻断。**')
  })

  it('extractPrinciple：两种节名都认，缺失返回空串', () => {
    expect(extractPrinciple('## 核心契约\n**A**')).toBe('**A**')
    expect(extractPrinciple('## 核心第一原则\n**B**')).toBe('**B**')
    expect(extractPrinciple('## 职责\n- x')).toBe('')
  })
})

describe('角色渲染 → 再解析往返（含真实格式）', () => {
  it('render → parse 数据等价；frontmatter 只含 ZCode 白名单字段；叠加层注入正文', () => {
    const role = parseRoleMarkdown(BASIC_ROLE)
    const rendered = renderZcodeRole(role)
    const fmBlock = rendered.slice(4, rendered.indexOf('\n---', 4))
    const fmKeys = fmBlock.split('\n').map((l) => l.split(':')[0])
    expect(fmKeys.every((k) => ['name', 'description', 'color', 'model', 'thoughtLevel', 'injectAgentsMd'].includes(k))).toBe(true)
    // Prism 叠加层放正文（harness §4.2），不污染 frontmatter
    expect(rendered).toContain('## 知识绑定')
    expect(rendered).toContain('- layers: global, project')
    const reparsed = parseRoleMarkdown(rendered)
    expect(reparsed.name).toBe(role.name)
    expect(reparsed.description).toBe(role.description)
    expect(reparsed.color).toBe(role.color)
    expect(reparsed.model).toBe(role.model)
    expect(reparsed.thoughtLevel).toBe(role.thoughtLevel)
    expect(reparsed.injectAgentsMd).toBe(role.injectAgentsMd)
    expect(reparsed.principle).toBe(role.principle)
    expect(reparsed.skills).toEqual(role.skills)
    expect(reparsed.knowledge).toEqual(role.knowledge)
    expect(reparsed.body.startsWith(role.body)).toBe(true) // 叠加层追加在正文之后
  })

  it('skills 白名单注入「能力（Skill 白名单）」节并可回收（ZCode 产物再导入）', () => {
    const raw = `${BASIC_ROLE}\n`
    const role = parseRoleMarkdown(raw)
    const withSkills = { ...role, skills: ['code_review', 'run_tests'] }
    const round = parseRoleMarkdown(renderZcodeRole(withSkills))
    expect(round.skills).toEqual(['code_review', 'run_tests'])
    expect(renderZcodeRole(withSkills)).toContain('## 能力（Skill 白名单）')
  })
})

describe('本机 9 个真实角色（C:/Users/10042/.zcode/agents，只读）', () => {
  const dirExists = existsSync(REAL_AGENTS_DIR)

  beforeEach(() => {
    if (!dirExists) console.warn(`[skip-assert] 本机角色目录不存在：${REAL_AGENTS_DIR}`)
  })

  it('目录存在且恰有 9 个角色 .md 文件', () => {
    if (!dirExists) return
    const files = readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith('.md')).sort()
    expect(files).toHaveLength(9)
  })

  it('9 个角色全部解析成功：name/description/核心契约/正文齐全', () => {
    if (!dirExists) return
    const parsed: string[] = []
    for (const file of readdirSync(REAL_AGENTS_DIR).sort()) {
      if (!file.endsWith('.md')) continue
      const raw = readFileSync(join(REAL_AGENTS_DIR, file), 'utf8')
      const role = parseRoleMarkdown(raw, { sourcePath: join(REAL_AGENTS_DIR, file) })
      expect(role.name.trim(), `${file} 的 name 不应为空`).not.toBe('')
      expect(role.description.trim(), `${file} 的 description 不应为空`).not.toBe('')
      expect(role.principle.trim(), `${file} 缺核心契约正文`).not.toBe('')
      expect(role.body.trim(), `${file} 正文不应为空`).not.toBe('')
      parsed.push(file.replace(/\.md$/, ''))
    }
    for (const expected of REAL_ROLE_NAMES) {
      expect(parsed, `缺少角色 ${expected}`).toContain(expected)
    }
  })

  it('9 个角色渲染 → 再解析往返数据等价（P2 往返要求）', () => {
    if (!dirExists) return
    for (const file of readdirSync(REAL_AGENTS_DIR).sort()) {
      if (!file.endsWith('.md')) continue
      const role = parseRoleMarkdown(readFileSync(join(REAL_AGENTS_DIR, file), 'utf8'))
      const round = parseRoleMarkdown(renderZcodeRole(role))
      expect(round.name, file).toBe(role.name)
      expect(round.description, file).toBe(role.description)
      expect(round.model, file).toBe(role.model)
      expect(round.thoughtLevel, file).toBe(role.thoughtLevel)
      expect(round.injectAgentsMd, file).toBe(role.injectAgentsMd)
      expect(round.principle, file).toBe(role.principle)
      expect(round.skills, file).toEqual(role.skills)
      expect(round.knowledge, file).toEqual(role.knowledge)
      expect(round.body.startsWith(role.body), `${file} 正文应保留（叠加层追加其后）`).toBe(true)
    }
  })
})

describe('角色注册表（importFromDir：双形态 + issues + 重名 + 容错）', () => {
  let dir = ''
  beforeEach(() => {
    dir = makeTmp()
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => {
    // 临时目录留给系统清理，不在测试中删除以避免 Windows 句柄问题
  })

  it('扁平 <name>.md 与目录式 <name>/AGENTS.md 都能导入；issues 挂载；坏文件不中断', async () => {
    writeFileSync(join(dir, 'dev-1.md'), BASIC_ROLE)
    mkdirSync(join(dir, 'writer'))
    writeFileSync(
      join(dir, 'writer', 'AGENTS.md'),
      '---\nname: writer\ndescription: "写手：产出交付物。"\n---\n\n## 核心契约\n**一遍读懂。**\n',
    )
    writeFileSync(join(dir, 'broken.md'), '---\nname: &anchor x\n---\n')
    writeFileSync(join(dir, 'nofm.md'), '# 没有 frontmatter')

    const registry = createRoleRegistry()
    const { roles, failures } = await registry.importFromDirDetailed(dir)

    expect(roles.map((r) => r.name).sort()).toEqual(['dev-1', 'writer'])
    const writer = registry.get('writer')
    expect(writer?.principle).toBe('**一遍读懂。**')
    // 导入缺省下仅携带 warning 级 issue（skills 空白名单），无 error
    expect(writer?.issues?.every((i) => i.level === 'warning')).toBe(true)
    // dev-1：skills 空 → 仅 warning，ok 保持 true
    const dev1 = registry.get('dev-1')
    expect(dev1?.issues?.every((i) => i.level === 'warning')).toBe(true)
    expect(failures.map((f) => f.code).sort()).toEqual(['no_frontmatter', 'parse_unsupported'])
  })

  it('角色库重名：后到者标注 role_duplicate 且不入库（§4.1 唯一性）', async () => {
    writeFileSync(join(dir, 'a.md'), BASIC_ROLE)
    writeFileSync(join(dir, 'b.md'), BASIC_ROLE) // name 同为 dev-1
    const registry = createRoleRegistry()
    const { roles, failures } = await registry.importFromDirDetailed(dir)
    expect(roles.map((r) => r.name).filter((n) => n === 'dev-1')).toHaveLength(1)
    expect(failures.some((f) => f.code === 'role_duplicate')).toBe(true)
  })
})
