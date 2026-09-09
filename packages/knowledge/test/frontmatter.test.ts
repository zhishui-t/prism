import { describe, expect, it } from 'vitest'

import {
  parseFrontmatter,
  renderMarkdownFile,
  serializeFrontmatter,
  splitFrontmatter,
} from '../src/frontmatter.js'

describe('frontmatter 解析/序列化（零依赖 YAML 子集）', () => {
  it('序列化 → 解析往返保持值等价', () => {
    const data = {
      id: 'JAVA-01-002',
      version: 2,
      title: '禁止吞掉异常',
      type: 'rule',
      layer: 'global',
      book: 'java-standards',
      module: 'exception-handling',
      status: 'active',
      risk: 'high',
      confidence: 0.9,
      freshness: 1.0,
      visibility: 'global',
      tags: ['java', 'exception'],
      created: '2026-09-08T10:00:00.000Z',
      updated: '2026-09-08T10:00:00.000Z',
      overrides: [] as string[],
      supersedes: null,
      source: { kind: 'import', ref: '阿里Java规范.pdf#p12' },
      deposited_by: { subject: 'dev-1', team: 'team-a' },
    }
    const yaml = serializeFrontmatter(data)
    const parsed = parseFrontmatter(yaml)
    expect(parsed).toEqual(data)
  })

  it('含 CJK/引号/换行的字符串安全往返', () => {
    const data = { title: '他说: "性能即正义"\n第二行', score: 3 }
    const parsed = parseFrontmatter(serializeFrontmatter(data))
    expect(parsed).toEqual(data)
  })

  it('renderMarkdownFile + splitFrontmatter 正文无损往返', () => {
    const content = '# 标题\n\n正文第一段，含「性能」关键词。\n'
    const file = renderMarkdownFile({ id: 'KB-1', version: 1 }, content)
    const { data, body } = splitFrontmatter(file)
    expect(data).toEqual({ id: 'KB-1', version: 1 })
    expect(body).toBe(content)
  })

  it('无 frontmatter 的文件 data 为 null', () => {
    const { data, body } = splitFrontmatter('# 纯正文\n没有头\n')
    expect(data).toBeNull()
    expect(body).toBe('# 纯正文\n没有头\n')
  })

  it('容忍块式序列与注释行', () => {
    const parsed = parseFrontmatter('# 注释\nid: KB-2\ntags:\n  - a\n  - b\n')
    expect(parsed.id).toBe('KB-2')
    expect(parsed.tags).toEqual(['a', 'b'])
  })

  it('CRLF 归一化（正文换行归一为 LF）', () => {
    const file = '---\r\nid: KB-3\r\n---\r\nbody\r\n'
    const { data, body } = splitFrontmatter(file)
    expect(data).toEqual({ id: 'KB-3' })
    expect(body).toBe('body\n')
  })

  it('数字/布尔/null 标量', () => {
    const parsed = parseFrontmatter('n: 42\nf: 1.5\nok: true\nno: false\nx: null\ntilde: ~')
    expect(parsed).toEqual({ n: 42, f: 1.5, ok: true, no: false, x: null, tilde: null })
  })
})
