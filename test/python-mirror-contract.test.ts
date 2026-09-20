/**
 * M6 镜像契约：全仓 Python 解释器解析有**三处刻意镜像**——
 *
 *   1. `scripts/python.mjs` → `resolvePython()`（**规范源**：npm scripts 侧，不进发行包）
 *   2. `packages/server/src/graph/graphify.ts` → `resolvePythonCommand()`（TS 侧）
 *   3. `3rd/ocr/ocr_tool.mjs` → `resolvePython()`（v14 新增第三处）
 *
 * `scripts/` 不进发行包、TS 侧无法导入，所以镜像不可免——但历史上正因无测试锁定而漂移过。
 * 本文件读三份源码**文本**做交叉校验（同 `packages/server/test/embedding-models.test.ts`
 * 防脚本漂移的手法），一次断言三处同构；**任一处改了判据而另两处没跟，这里必须红**。
 *
 * 只改 `resolvePython*` 的实现风格（如换行/变脸）不该触发红：本测试锁的是「判据内容」，
 * 不是格式——所以断言用的是能容错变量名大小写的正则。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

interface Source {
  name: string
  text: string
}

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

/** 三处镜像源（规范源在前）。 */
const SOURCES: Source[] = [
  { name: 'scripts/python.mjs', text: read('../scripts/python.mjs') },
  {
    name: 'packages/server/src/graph/graphify.ts',
    text: read('../packages/server/src/graph/graphify.ts'),
  },
  { name: '3rd/ocr/ocr_tool.mjs', text: read('../3rd/ocr/ocr_tool.mjs') },
]

const CANONICAL = SOURCES[0].name

/** 返回**不匹配** pattern 的源名（空数组 = 三处同构）。 */
function drifted(pattern: RegExp, sources: Source[] = SOURCES): string[] {
  return sources.filter((s) => !pattern.test(s.text)).map((s) => s.name)
}

/** 断言：给定的 sources 都命中同一段判据文本；失败时点名漂了的源。 */
function expectSameShape(pattern: RegExp, what: string, sources: Source[] = SOURCES): void {
  const bad = drifted(pattern, sources)
  expect(
    bad,
    `${what} —— 与规范源（${CANONICAL}）**不同构**的源：${bad.join('、') || '（无）'}`,
  ).toEqual([])
}

// --- 判据文本（正则容错 `IS_WINDOWS` / `isWindows` 两种变量名大小写） --------------------

/** `PRISM_PYTHON` 显式覆盖。 */
const RE_OVERRIDE = /PRISM_PYTHON/

/** 候选**优先顺序**：Windows 认 `python`，POSIX 认 `python3`。 */
const RE_ORDER = /(?:IS_WINDOWS|isWindows) \? \['python', 'python3'\] : \['python3', 'python'\]/

/** 探不到任何可执行体时的**回落默认名**。 */
const RE_FALLBACK = /(?:IS_WINDOWS|isWindows) \? 'python' : 'python3'/

/** PATH 探测时的可执行后缀（Windows 补 `.exe`）。 */
const RE_SUFFIX = /(?:IS_WINDOWS|isWindows) \? \['\.exe', ''\] : \[''\]/

describe('M6 镜像契约 · Python 解释器解析三处同构', () => {
  it('a. 三处都实现 PRISM_PYTHON 显式覆盖', () => {
    expectSameShape(RE_OVERRIDE, 'PRISM_PYTHON 覆盖逻辑')
    // 覆盖值必须真被消费（不能只是注释里提了一嘴）
    for (const s of SOURCES) {
      expect(s.text, `${s.name} 里的 PRISM_PYTHON 不在 env 取值表达式中`).toMatch(
        /env\.PRISM_PYTHON/,
      )
    }
  })

  it('b. 候选顺序同构：Windows 先 python、POSIX 先 python3', () => {
    expectSameShape(RE_ORDER, '解释器候选顺序')
  })

  it('c. 回落默认名同构：Windows python / POSIX python3', () => {
    expectSameShape(RE_FALLBACK, '探不到时的回落默认名')
  })

  it('d. 后缀探测同构（仅 scripts/python.mjs 与 3rd/ocr/ocr_tool.mjs）', () => {
    // graphify.ts 的 EXECUTABLE_SUFFIXES 是 `['.cmd', '.exe', '']`：那是给 graphify
    // **可执行体**（可能是 .cmd）用的，解释器名不带后缀，故**不对它断言这条**。
    const two = SOURCES.filter((s) => s.name !== 'packages/server/src/graph/graphify.ts')
    expect(two).toHaveLength(2)
    expectSameShape(RE_SUFFIX, 'PATH 探测后缀', two)
  })
})

describe('M6 镜像契约 · 文档登记', () => {
  const DOCS: Source[] = [
    { name: 'AGENTS.md', text: read('../AGENTS.md') },
    { name: 'doc/requirements/cross-platform.md', text: read('../doc/requirements/cross-platform.md') },
  ]

  /** 登记里必须同时出现的三个文件名。 */
  const MIRROR_FILES = ['scripts/python.mjs', 'graphify.ts', 'ocr_tool.mjs']

  it('e. AGENTS.md 与 cross-platform.md 都登记了三处镜像文件名', () => {
    for (const doc of DOCS) {
      const missing = MIRROR_FILES.filter((f) => !doc.text.includes(f))
      expect(missing, `${doc.name} 的 Python 镜像登记缺：${missing.join('、')}`).toEqual([])
    }
  })

  it('e2. 两份文档均未遗漏「另两处」口径（三处镜像的同步义务写进了正文）', () => {
    for (const doc of DOCS) {
      expect(doc.text, `${doc.name} 未写明「改一处必须同步另两处」`).toContain('另两处')
    }
  })
})
