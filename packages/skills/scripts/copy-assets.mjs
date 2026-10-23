/**
 * 把内置技能的文件型 assets（src/builtin/assets/）拷进 dist——
 * 打包（scripts/package.mjs）每个包只带 dist，assets 必须随 tsc 产物落进 dist
 * 才能随包发行；运行侧 prism.ts 用 `import.meta.url` 相对定位，src/dist 同深度双态可解析。
 */
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src', 'builtin', 'assets')
const dst = join(here, '..', 'dist', 'builtin', 'assets')

if (!existsSync(src)) {
  console.error(`copy-assets: 源目录不存在: ${src}`)
  process.exit(1)
}
cpSync(src, dst, { recursive: true })
console.log(`copy-assets: ${src} -> ${dst}`)
