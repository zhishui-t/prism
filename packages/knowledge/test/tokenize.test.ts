import { describe, expect, it } from 'vitest'

import { bigram, toMatchExpression } from '../src/tokenize.js'

describe('bigram（design §3.4 硬约束：CJK 二元滑窗 + 非 CJK 小写原词）', () => {
  it('两字中文词保持原词', () => {
    expect(bigram('性能')).toBe('性能')
    expect(bigram('日志')).toBe('日志')
    expect(bigram('接口')).toBe('接口')
  })

  it('四字中文词滑窗出三个 bigram', () => {
    expect(bigram('异常处理')).toBe('异常 常处 处理')
    expect(bigram('敏感信息')).toBe('敏感 感信 信息')
    expect(bigram('性能优化指南')).toBe('性能 能优 优化 化指 指南')
  })

  it('非 CJK 小写原词，空格连接', () => {
    expect(bigram('Hello World')).toBe('hello world')
    expect(bigram('DATABASE')).toBe('database')
  })

  it('中英混排', () => {
    expect(bigram('Java性能优化指南')).toBe('java 性能 能优 优化 化指 指南')
    expect(bigram('Java 异常处理')).toBe('java 异常 常处 处理')
  })

  it('CJK 标点切断滑窗且被丢弃', () => {
    // 。(U+3002) 不属 CJK 表意区 → 分隔符
    expect(bigram('性能。优化')).toBe('性能 优化')
    expect(bigram('性能，优化')).toBe('性能 优化')
  })

  it('单字 CJK 保留自身（无二元可取）', () => {
    expect(bigram('性')).toBe('性')
  })

  it('空输入与纯符号输入返回空串', () => {
    expect(bigram('')).toBe('')
    expect(bigram('   ')).toBe('')
    expect(bigram('!!!')).toBe('')
  })

  it('正文与查询两侧对称：同一函数同一结果', () => {
    const text = '统一异常处理器捕获业务异常'
    const query = '异常处理'
    // 查询的每个 bigram 必须都在正文的 bigram 集合中（AND 命中的前提）
    const textTokens = new Set(bigram(text).split(' '))
    for (const token of bigram(query).split(' ')) {
      expect(textTokens.has(token)).toBe(true)
    }
  })
})

describe('toMatchExpression（FTS5 MATCH 表达式）', () => {
  it('逐词双引号包裹（AND 语义）', () => {
    expect(toMatchExpression('性能')).toBe('"性能"')
    expect(toMatchExpression('异常处理')).toBe('"异常" "常处" "处理"')
    expect(toMatchExpression('Java 性能')).toBe('"java" "性能"')
  })

  it('双引号在词内时翻倍转义', () => {
    expect(toMatchExpression('a"b')).toBe('"a""b"')
  })

  it('无效词元返回空串', () => {
    expect(toMatchExpression('!!!')).toBe('')
  })
})
