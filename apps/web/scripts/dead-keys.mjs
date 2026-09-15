#!/usr/bin/env node
/**
 * i18n 死键扫描（零依赖，开发工具）。已接入 `apps/web/package.json` 的 `prebuild`
 * （2026-09-16）：死键 > 0 即退出码 1，构建随之失败。
 *
 * 口径（design-brief-v7-a.md §6.2）：
 * - **字典全集** = `src/i18n.ts` 的 `ZH` 键集合（EN 由 TS 的 `Record<keyof typeof ZH, string>` 强制覆盖）。
 * - **引用** = `src/**` 中出现的字符串字面量（排除 `i18n.ts` 自己）。
 *   用「字面量全集 ⊇ 键」判定引用，而不是只抓 `t('...')`：`DictKey` 类型的映射表
 *   （如 `{ key: 'tasks.st.WAITING' }`）也是合法引用，只抓 `t()` 会误删。
 * - 模板串动态拼 key（`` t(`a.${x}`) ``）无法静态判定 → 若存在，把匹配到该前缀的键
 *   列为「疑似动态引用」并从死键里排除（同时提示改成静态键，见 §6.2 的禁令）。
 *
 * 用法：node apps/web/scripts/dead-keys.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const DICT = join(SRC, 'i18n.ts')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

/** 字典键：`const ZH = {` 到 `const EN` 之间的 `'key':`。 */
function dictKeys() {
  const text = readFileSync(DICT, 'utf8')
  const start = text.indexOf('const ZH = {')
  const end = text.indexOf('const EN')
  if (start === -1 || end === -1) throw new Error('i18n.ts 里找不到 ZH / EN 块')
  const block = text.slice(start, end)
  const keys = []
  for (const line of block.split('\n')) {
    const m = /^\s*'([^']+)':/.exec(line)
    if (m) keys.push(m[1])
  }
  return keys
}

/** 源码里出现的所有字符串字面量（含模板串的静态片段）。 */
function literals(files) {
  const set = new Set()
  const dynamicPrefixes = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const m of text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) set.add(m[1] ?? m[2])
    for (const m of text.matchAll(/`([^`\n]*)`/g)) {
      const raw = m[1]
      if (raw.includes('${')) {
        const prefix = raw.slice(0, raw.indexOf('${'))
        if (prefix.includes('.')) dynamicPrefixes.push({ file: relative(SRC, file), prefix })
      } else {
        set.add(raw)
      }
    }
  }
  return { set, dynamicPrefixes }
}

const files = walk(SRC).filter((f) => f !== DICT)
const keys = dictKeys()
const { set, dynamicPrefixes } = literals(files)

const dead = []
const dynamic = []
for (const key of keys) {
  if (set.has(key)) continue
  if (dynamicPrefixes.some((d) => key.startsWith(d.prefix))) dynamic.push(key)
  else dead.push(key)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: keys.length, dead, dynamic, dynamicPrefixes }, null, 2))
} else {
  console.log(`字典键 ${keys.length} 个；引用字面量 ${set.size} 个`)
  console.log(`\n死键 ${dead.length} 个：`)
  for (const key of dead) console.log(`  ${key}`)
  if (dynamic.length > 0) {
    console.log(`\n疑似动态引用（已从死键排除）${dynamic.length} 个：`)
    for (const key of dynamic) console.log(`  ${key}`)
    console.log('  ↑ 动态拼 key 被 design-brief-v7-a.md §6.2 禁止，请改成静态键')
  }
}

// 机械保证（MINOR-9）：死键非零即构建失败——否则「挂 prebuild」只是打印一行日志。
process.exitCode = dead.length === 0 ? 0 : 1
