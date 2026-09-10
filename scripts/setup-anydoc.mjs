#!/usr/bin/env node
/**
 * anydoc 运行环境安装脚本（三方件规范化：源码进 submodule，二进制按平台下载）。
 *
 *   node scripts/setup-anydoc.mjs [--check] [--force]
 *
 * anydoc 是 **Rust (napi-rs)** 原生库，本机无 Rust 工具链时**无法自行编译**，故走
 * 官方 GitHub Release 的**平台预编译 `.node`**（每个平台一个资产）。
 *
 * 产物（gitignored，不进仓库）：`3rd/anydoc-runtime/`
 *   - anydoc.js / index.js / *.d.ts / package.json   ← 从 submodule 的 `node/` 拷来（上游 JS 包装层）
 *   - anydoc.<platform>.node                         ← 下载的平台原生绑定
 *
 * 为什么拷包装层而非直接 require submodule：napi 加载器**优先 require 同目录**的
 * `anydoc.<platform>.node`（见上游 index.js），把包装层与二进制放同一目录即可零改动加载，
 * 且**不往 submodule 里写构建产物**（保持 `git submodule status` 干净）。
 *
 * 加载方（`packages/knowledge/src/convert.ts`）按绝对路径动态 import 此目录。
 * 未安装时文档转换降级（md/txt/html 仍可直读），不报错阻断。
 */
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, copyFile, rename } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(ROOT, '3rd', 'anydoc')          // submodule（只读）
const SRC_NODE = join(SRC_DIR, 'node')                // 上游 npm 包源
const RUNTIME_DIR = join(ROOT, '3rd', 'anydoc-runtime')

const ANYDOC_TAG = 'v0.2.4'
/** 上游 JS 包装层文件（与 node/package.json 的 files 字段一致）。 */
const WRAPPER_FILES = ['anydoc.js', 'index.js', 'anydoc.d.ts', 'index.d.ts', 'package.json']

/** 平台 → 官方 release 资产名（上游 README/发布产物）。 */
const TARGETS = {
  'darwin-arm64': 'anydoc.darwin-arm64.node',
  'darwin-x64': 'anydoc.darwin-x64.node',
  'linux-arm64-gnu': 'anydoc.linux-arm64-gnu.node',
  'linux-arm64-musl': 'anydoc.linux-arm64-musl.node',
  'linux-x64-gnu': 'anydoc.linux-x64-gnu.node',
  'linux-x64-musl': 'anydoc.linux-x64-musl.node',
  'win32-x64': 'anydoc.win32-x64-msvc.node',
}

/** GitHub release 直连常被阻断 → 镜像前缀优先，空串为官方兜底。 */
const GH_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/', '']

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const FORCE = args.includes('--force')

function log(msg) {
  process.stdout.write(`[anydoc-setup] ${msg}\n`)
}

/** 探测当前平台 → 资产名；不支持则返回 null。 */
function detectTarget() {
  const arch = process.arch
  const platform = process.platform
  if (platform === 'darwin') {
    const key = arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : null
    return key !== null ? { key, asset: TARGETS[key] } : null
  }
  if (platform === 'win32') {
    const key = arch === 'x64' ? 'win32-x64' : null // 上游仅发布 x64
    return key !== null ? { key, asset: TARGETS[key] } : null
  }
  if (platform === 'linux') {
    const musl = isMusl()
    const suffix = musl ? 'musl' : 'gnu'
    const key = arch === 'x64' ? `linux-x64-${suffix}` : arch === 'arm64' ? `linux-arm64-${suffix}` : null
    return key !== null ? { key, asset: TARGETS[key] } : null
  }
  return null
}

function isMusl() {
  try {
    if (!existsSync('/usr/bin/ldd')) return false
    return readFileSync('/usr/bin/ldd', 'utf-8').includes('musl')
  } catch {
    return false
  }
}

function releaseUrls(asset) {
  const base = `https://github.com/firecrawl/anydoc/releases/download/${ANYDOC_TAG}/${asset}`
  return GH_MIRRORS.map((m) => (m === '' ? base : `${m}${base}`))
}

async function downloadAny(urls, dest) {
  let lastError
  for (const url of urls) {
    const tmp = `${dest}.${randomUUID().slice(0, 8)}.part`
    try {
      log(`下载 ${url}`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`)
      let received = 0
      await pipeline(
        res.body,
        async function* track(source) {
          for await (const chunk of source) {
            received += chunk.length
            yield chunk
          }
        },
        createWriteStream(tmp),
      )
      if (received === 0) throw new Error('下载内容为空')
      await rename(tmp, dest)
      log(`完成: ${dest}（${(received / 1048576).toFixed(1)} MB）`)
      return
    } catch (error) {
      lastError = error
      await rm(tmp, { force: true }).catch(() => undefined)
      log(`源失败（${error instanceof Error ? error.message : String(error)}），换下一个…`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有下载源均失败')
}

async function main() {
  const target = detectTarget()
  if (target === null) {
    process.stderr.write(
      `[anydoc-setup] 当前平台不受支持（${process.platform}/${process.arch}）——文档转换降级：\n` +
        `  支持: ${Object.keys(TARGETS).join(', ')}\n`,
    )
    process.exitCode = 1
    return
  }
  // 本地文件名必须与上游加载器期望一致（napi 加载器 `require('./<asset>')`）
  const bindingName = target.asset
  const bindingPath = join(RUNTIME_DIR, bindingName)
  const wrapperReady = WRAPPER_FILES.every((f) => existsSync(join(RUNTIME_DIR, f)))

  if (CHECK_ONLY) {
    log(`平台:   ${target.key}（${target.asset}）`)
    log(`包装层: ${wrapperReady ? '就绪' : '缺失'} → ${RUNTIME_DIR}`)
    log(`原生绑定: ${existsSync(bindingPath) ? '就绪' : '缺失'} → ${bindingPath}`)
    process.exitCode = wrapperReady && existsSync(bindingPath) ? 0 : 1
    return
  }

  if (!existsSync(SRC_NODE)) {
    throw new Error(
      `未找到 anydoc 源码（${SRC_NODE}）——请先初始化子模块：git submodule update --init --recursive`,
    )
  }

  await mkdir(RUNTIME_DIR, { recursive: true })
  log(`平台: ${target.key} → ${bindingName}`)

  // 1) 暂存上游 JS 包装层（与原生绑定同目录，加载器零改动）
  if (FORCE || !wrapperReady) {
    for (const f of WRAPPER_FILES) {
      const src = join(SRC_NODE, f)
      if (!existsSync(src)) throw new Error(`包装层文件缺失: ${src}`)
      await copyFile(src, join(RUNTIME_DIR, f))
    }
    log(`包装层就绪（${WRAPPER_FILES.length} 个文件）`)
  } else {
    log('包装层已存在，跳过（--force 可重写）')
  }

  // 2) 下载平台原生绑定
  if (FORCE || !existsSync(bindingPath)) {
    await downloadAny(releaseUrls(target.asset), bindingPath)
  } else {
    log(`原生绑定已存在，跳过: ${bindingPath}（--force 可重下）`)
  }

  log('\n全部就绪。文档转换（docx/pdf/xlsx/pptx/doc/odt/rtf/epub/csv）可用。')
}

await main()
