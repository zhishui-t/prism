#!/usr/bin/env node
/**
 * 裸 CJK 守卫（零依赖，开发工具）：`src/**` 里除字典外不得出现中文字面量。
 *
 * 规则（design-brief-v7-a.md §6.1）：
 * - 扫描字符串字面量与 JSX 文本中的 CJK；**注释不算**（注释是给维护者看的）。
 * - `src/i18n.ts` 是字典本体，整体豁免（ZH 值就是中文）。
 * - 知识正文 / 角色·团队定义 / SKILL.md 是**数据**，不经过本脚本（它们是运行时数据，不在源码里）。
 *
 * 用法：node apps/web/scripts/check-hardcoded-cjk.mjs
 * 退出码：0 = 零命中；1 = 有命中。
 *
 * 已接入 `apps/web/package.json` 的 `prebuild`（清零后挂上，2026-09-16）：`pnpm build` /
 * `pnpm -r build` / `pnpm --filter @prism/web build` 都会先跑本脚本，命中即构建失败。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
/** 豁免：字典本体 */
const ALLOW = new Set(['i18n.ts'])

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

/**
 * 极简词法扫描：把「代码态 / 注释 / 字符串 / 正则 / 模板」分开，只报代码与字符串里的 CJK。
 * 注释与正则里的中文**不算违规**（注释是给维护者看的）。
 *
 * ⚠ 模板串的嵌套必须用**栈**而不是单个 depth 计数：`` `a${b ? `c${d}` : ''}` ``
 * 里内层反引号会把单计数清零，之后整段代码被误判成模板文本，
 * 于是**注释里的中文被当违规报出**（实测 `api.ts` 的 `kbGet` 就是这种形状）。
 */
function scan(text) {
  const hits = []
  // 花括号栈：'tpl' 待闭合反引号的模板串 / 'sub' `${` 的替换体 / 'obj' 普通 `{`
  const stack = []
  const hitLines = new Set() // 同一行只报一次
  let i = 0
  let line = 1
  let state = 'code' // code | line | block | regex | sq | dq | tpl
  let prevSignificant = '' // 判定正则字面量的上一个有效字符

  /**
   * 记一行命中。**只记账，不移动游标**——若在此处跳到行尾，会跳掉同行后面的闭合符
   * （实测 `if (mode === '串行' …)` 就因此漏掉收尾的 `'`，整个文件从此被当成字符串扫描）。
   */
  const record = () => {
    if (hitLines.has(line)) return
    hitLines.add(line)
    const start = Math.max(0, text.lastIndexOf('\n', i - 1) + 1)
    const end = text.indexOf('\n', i)
    hits.push({ line, snippet: text.slice(start, end === -1 ? undefined : end).trim() })
  }

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '\n') line++

    if (state === 'line') {
      if (ch === '\n') state = 'code'
      i++
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue }
      i++
      continue
    }
    if (state === 'regex') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') { // 字符类里 `/` 不结束正则
        let j = i + 1
        while (j < text.length && text[j] !== ']') j += text[j] === '\\' ? 2 : 1
        i = j + 1
        continue
      }
      if (ch === '/') { state = 'code'; prevSignificant = '/'; i++; continue }
      i++
      continue
    }
    if (state === 'sq' || state === 'dq') {
      if (ch === '\\') { i += 2; continue }
      if (CJK.test(ch)) { record(); i++; continue }
      if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"')) {
        state = 'code'
        prevSignificant = ch
      }
      i++
      continue
    }
    if (state === 'tpl') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '$' && next === '{') { stack.push('sub'); state = 'code'; prevSignificant = '{'; i += 2; continue }
      if (ch === '`') { stack.pop(); state = 'code'; prevSignificant = '`'; i++; continue }
      if (CJK.test(ch)) record()
      i++
      continue
    }

    // state === 'code'
    if (ch === '/' && next === '/') { state = 'line'; i += 2; continue }
    if (ch === '/' && next === '*') { state = 'block'; i += 2; continue }
    // 正则字面量：`/` 位于表达式起始位置（前一有效字符是这些之一）才算。
    // ⚠ 两个必须排除的假象，否则会把 JSX 当正则吞掉、整段状态错位：
    //   - `}>` + `/>`：JSX 自闭标签的 `/`，前一有效字符常是 `}`（故 `}` 不进触发集）
    //   - `</div>`：结束标签的 `/`，前一有效字符是 `<`
    if (ch === '/' && next !== '>' && /[=(,:;[!&|?{]|^$/.test(prevSignificant)) { state = 'regex'; i++; continue }
    if (ch === "'") { state = 'sq'; i++; continue }
    if (ch === '"') { state = 'dq'; i++; continue }
    if (ch === '`') { stack.push('tpl'); state = 'tpl'; i++; continue }
    if (ch === '{') { stack.push('obj'); prevSignificant = '{'; i++; continue }
    if (ch === '}') {
      // 闭合 `${` 的替换体 → 回到外层模板串；普通花括号只是出栈
      if (stack.pop() === 'sub') { state = 'tpl'; prevSignificant = '}'; i++; continue }
    }
    if (CJK.test(ch)) record()
    if (!/\s/.test(ch)) prevSignificant = ch
    i++
  }
  return hits
}

let total = 0
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replaceAll('\\', '/')
  if (ALLOW.has(rel)) continue
  const hits = scan(readFileSync(file, 'utf8'))
  if (hits.length === 0) continue
  total += hits.length
  console.log(`\n${rel}（${hits.length} 处）`)
  for (const h of hits) console.log(`  ${h.line}: ${h.snippet}`)
}

console.log(total === 0 ? '\n裸 CJK 守卫：零命中 ✓' : `\n裸 CJK 守卫：命中 ${total} 处（应全部走 t()）`)
process.exitCode = total === 0 ? 0 : 1
