#!/usr/bin/env node
/**
 * Prism 打包脚本：产出自包含 tarball + 一键启动入口。
 *
 *   node scripts/package.mjs [--out <dir>] [--skip-build]
 *   pnpm run package
 *
 * 产物结构（解压即用，无需 pnpm install）：
 *
 *   prism-<version>/
 *   ├── bin/prism.js               # 一键启动入口
 *   ├── packages/<name>/dist/      # 各包构建产物
 *   ├── packages/<name>/package.json
 *   ├── node_modules/@prism/<name> → 物化的包副本（真实目录，非符号链接）
 *   ├── apps/web/dist/             # 控制台静态资源
 *   ├── 3rd/archify/               # vendored 子工程（自包含）
 *   ├── 3rd/graphify/              # vendored 子工程（Python，需本机装依赖）
 *   ├── README.md / AGENTS.md / LICENSE
 *   └── package.json
 *
 * 设计要点：
 * - **零外部运行时依赖**（各包只依赖 workspace 内部包），故无需装 node_modules；
 * - workspace 包在开发态是符号链接，打包时**物化**为真实目录，避免解压后链接失效；
 * - graphify 的 Python 依赖（tree-sitter 等）需目标机 `pnpm run 3rd:build` 安装——
 *   tarball 不携带 Python 环境，bin/prism.js 启动时会检测并给出提示。
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PKG_NAMES = ['core', 'knowledge', 'agents', 'skills', 'server', 'cli']

function log(msg) {
  process.stdout.write(`[package] ${msg}\n`)
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function run(cmd, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', rejectPromise)
    child.on('close', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/** 解析 CLI 参数。 */
function parseArgs(argv) {
  const out = { outDir: join(ROOT, 'dist'), skipBuild: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.outDir = resolve(argv[++i])
    else if (argv[i] === '--skip-build') out.skipBuild = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'))
  const version = rootPkg.version
  const stageName = `prism-${version}`
  const stageDir = join(args.outDir, stageName)

  // 1) 构建（默认；--skip-build 用现有 dist）
  if (!args.skipBuild) {
    log('构建全部包 + 控制台…')
    await run('pnpm', ['-r', 'build'], ROOT)
  }

  // 2) 校验产物齐全
  const missing = []
  for (const name of PKG_NAMES) {
    if (!(await exists(join(ROOT, 'packages', name, 'dist')))) missing.push(`packages/${name}/dist`)
  }
  if (!(await exists(join(ROOT, 'apps', 'web', 'dist')))) missing.push('apps/web/dist')
  if (missing.length > 0) {
    throw new Error(`构建产物缺失：${missing.join(', ')}（先跑 pnpm run build）`)
  }

  // 3) 清理 + 准备暂存目录
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  log(`暂存目录: ${stageDir}`)

  // 4) 拷贝各包（dist + package.json + README）
  for (const name of PKG_NAMES) {
    const src = join(ROOT, 'packages', name)
    const dst = join(stageDir, 'packages', name)
    await mkdir(dst, { recursive: true })
    await cp(join(src, 'dist'), join(dst, 'dist'), { recursive: true })
    await cp(join(src, 'package.json'), join(dst, 'package.json'))
    for (const extra of ['README.md']) {
      if (await exists(join(src, extra))) await cp(join(src, extra), join(dst, extra))
    }
  }

  // 5) 物化 workspace 依赖：node_modules/@prism/<name> → 真实目录副本
  //    （开发态是符号链接，解压后失效；这里复制为真实目录）
  const nm = join(stageDir, 'node_modules', '@prism')
  await mkdir(nm, { recursive: true })
  for (const name of PKG_NAMES) {
    const pkgJson = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf-8'))
    const target = join(nm, pkgJson.name.replace('@prism/', ''))
    await cp(join(stageDir, 'packages', name), target, { recursive: true })
  }
  log(`物化 workspace 依赖: ${PKG_NAMES.length} 个包`)

  // 6) 控制台静态资源
  await cp(join(ROOT, 'apps', 'web', 'dist'), join(stageDir, 'apps', 'web', 'dist'), { recursive: true })

  // 7) vendored 子工程（archify 自包含；graphify Python 源码）
  await cp(join(ROOT, '3rd'), join(stageDir, '3rd'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('__pycache__') && !src.includes('.git'),
  })

  // 8) 文档与许可
  for (const file of ['README.md', 'AGENTS.md', 'LICENSE']) {
    if (await exists(join(ROOT, file))) await cp(join(ROOT, file), join(stageDir, file))
  }

  // 9) 一键启动入口 + 包清单
  await mkdir(join(stageDir, 'bin'), { recursive: true })
  await writeFile(join(stageDir, 'bin', 'prism.js'), LAUNCHER, 'utf-8')
  await writeFile(
    join(stageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'prism',
        version,
        private: true,
        type: 'module',
        description: rootPkg.description,
        license: rootPkg.license,
        engines: rootPkg.engines,
        bin: { prism: './bin/prism.js' },
        scripts: { '3rd:build': 'python -m pip install -q "tree-sitter>=0.23.0,<0.26" tree-sitter-python tree-sitter-typescript tree-sitter-javascript networkx numpy rapidfuzz' },
      },
      null,
      2,
    )}\n`,
    'utf-8',
  )

  // 10) 打 tarball（相对路径打包，解压得到 prism-<version>/ 目录）
  const tarball = join(args.outDir, `${stageName}.tgz`)
  await rm(tarball, { force: true })
  log('压缩中…')
  // 用相对路径 + cwd 调 tar：Git Bash 的 GNU tar 会把 "K:/..." 当远程主机（路径转换陷阱），
  // 故以 outDir 为工作目录、只传相对文件名。
  await run('tar', ['-czf', `${stageName}.tgz`, stageName], args.outDir)

  const size = (await stat(tarball)).size
  log(`完成: ${tarball}（${(size / 1024 / 1024).toFixed(1)} MB）`)
  log('')
  log('解压即用：')
  log(`  tar -xzf ${stageName}.tgz && cd ${stageName}`)
  log('  node bin/prism.js --version')
  log('  node bin/prism.js serve')
  log('')
  log('注意：代码图谱需本机 Python ≥3.10 并安装依赖 → npm run 3rd:build')
}

/** 一键启动入口（ESM）：转发到 CLI，并做 Python 依赖预检。 */
const LAUNCHER = `#!/usr/bin/env node
/**
 * Prism 一键启动入口（打包产物）。
 * 用法: node bin/prism.js <命令>   （如 serve / init / graph build …）
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// 代码图谱依赖 Python 版 graphify（vendored 子工程，需本机装依赖）
if (!existsSync(join(root, '3rd', 'graphify', 'pyproject.toml'))) {
  process.stderr.write('[prism] 警告: 未找到 3rd/graphify 子工程，代码图谱不可用\\n')
}

// Windows 绝对路径必须转 file:// URL 才能被 ESM 加载器接受
const cliEntry = pathToFileURL(join(root, 'packages', 'cli', 'dist', 'argv.js')).href
const { runCommand, defaultContext } = await import(cliEntry)
const code = await runCommand(defaultContext(), process.argv.slice(2))
process.exit(code)
`

await main()
