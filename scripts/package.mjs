#!/usr/bin/env node
/**
 * Prism 打包脚本：产出**按平台自包含**的发布包（解压即用，无需 git、无需联网）。
 *
 *   node scripts/package.mjs [--out <dir>] [--skip-build] [--models small|all] [--full-3rd]
 *   pnpm run package
 *
 * 产物：
 *   <out>/prism-<version>_<platform>.tgz     例：dist/prism-0.1.0-alpha_win_x64.tgz
 *   <out>/SHA256SUMS                         校验和（Release 附件一并上传）
 *
 * 为什么平台后缀进包名：包内带**本机平台的三方运行时**——
 *   - `3rd/llama-runtime/`   llama-server 二进制（CPU 自编译 + Vulkan 预编译）
 *   - `3rd/anydoc-runtime/`  anydoc 原生绑定（napi `.node`，平台专属）
 * 二者都不可跨平台复用，所以 mac 版必须**另出一个** `_mac_arm64` / `_mac_x64` 包，
 * 而不是共用同一个包。
 *
 * 产物结构（解压即用，无需 pnpm install）：
 *
 *   prism-<version>_<platform>/
 *   ├── bin/prism.js                        # 一键启动入口
 *   ├── packages/<name>/dist/               # 各包构建产物
 *   ├── node_modules/@prism/<name>/         # 物化的包副本（真实目录，非符号链接）
 *   ├── apps/web/dist/                      # 控制台静态资源
 *   ├── 3rd/archify/                        # 子模块源码（自包含 CLI，免构建）
 *   ├── 3rd/graphify/                       # 子模块源码（Python，免构建）
 *   ├── 3rd/anydoc/                         # 子模块源码（含 JS 包装层）
 *   ├── 3rd/anydoc-runtime/                 # ★ 原生绑定 + JS 包装层（本平台）
 *   ├── 3rd/llama-runtime/bin/              # ★ llama-server（本机 CPU / 平台预编译）
 *   ├── 3rd/llama-runtime/bin-vulkan/       # ★ Vulkan 加速后端（Windows / Linux）
 *   ├── 3rd/llama-runtime/models/bge-small-zh-v1.5-q8_0.gguf  # ★ 最小向量模型（26MB）
 *   ├── scripts/setup-*.mjs                 # 可选：重装 / 换档 / 换平台
 *   ├── examples/harnesses/                 # 宿主适配器插件
 *   ├── PRISM-MANIFEST.json                 # 版本 / 平台 / 运行时清单 / 体积
 *   ├── README.md / AGENTS.md / LICENSE
 *   └── package.json
 *
 * 设计要点：
 * - **仅 workspace 内部包**物化进 tarball，解压后无需 `pnpm install`；
 * - **三方运行时随包**（本平台），目标机**不需要 git、也不需要联网**即可跑通
 *   向量检索与文档转换——这正是「有的环境访问不了 git 就装不上」的根治；
 * - **默认只带最小向量模型**（`bge-small-zh` 26MB，CPU 默认档）→ 解压即开箱可用语义检索；
 *   大档模型（bge-m3 / Qwen3-Embedding，各 600MB+）走 `--models all` 或目标机按需下载；
 * - **排除项**（有依据，见下方 RUNTIME_DIRS / THIRD_PARTY_SLIM 注释）：
 *   `3rd/llama.cpp` 源码 173MB（只有「源码编译」路径需要）、
 *   `3rd/llama-runtime/build` 编译中间产物 95MB、非本平台运行时、
 *   以及 3rd 各子模块里与运行无关的 docs / examples / tests（约 46MB，全仓零引用）；
 *   `--full-3rd` 可保留 3rd 子模块的全部内容（llama.cpp 源码与运行时档位不受影响）。
 * - graphify 的 Python 依赖（tree-sitter / networkx / numpy / rapidfuzz）**不随包**——
 *   Python 环境无法可靠内嵌，目标机需联网 `pip install`（离线场景见 README 的说明）。
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PKG_NAMES = ['core', 'knowledge', 'agents', 'skills', 'server', 'cli']

/** 默认随包的最小向量模型（CPU 默认档，26MB）。 */
const DEFAULT_MODEL = 'bge-small-zh-v1.5-q8_0.gguf'

/**
 * 运行时目录：**永远**不进通用「三方源码」拷贝，而是下面按需**精确**拷贝。
 * 必须与 `--full-3rd` 解耦——否则 `--full-3rd` 会把 1.5GB 的 llama-runtime
 * （含 95MB `build/` 与 1.3GB 大档模型）整棵吞进来，与「只带最小模型」直接冲突。
 */
const RUNTIME_DIRS = ['3rd/llama.cpp', '3rd/llama-runtime', '3rd/anydoc-runtime']

/**
 * 3rd 子模块里**与运行无关**的目录，随包时排除（`--full-3rd` 可全部保留）。
 * 依据：全仓 grep 这些路径（packages / scripts / test / apps）**零引用**，
 * 命中的只有代码注释里描述「测试样本出处」的文字。运行时真正需要的是
 * `archify/archify/`（CLI 包本体）与 `graphify/graphify/`（Python 包本体）。
 */
const THIRD_PARTY_SLIM = [
  '3rd/archify/docs', // 18MB 上游文档
  '3rd/archify/examples', // 9.1MB 仓库级示例（注意：archify/archify/examples 保留，测试要用）
  '3rd/archify/experiments', // 3.1MB
  '3rd/archify/generated', // 1.7MB
  '3rd/archify/benchmarks', // 580KB
  '3rd/archify/archify.zip', // 1.3MB 打包好的发布 zip
  '3rd/graphify/docs', // 1.4MB
  '3rd/graphify/tools', // 2.0MB
  '3rd/graphify/worked', // 4.3MB 上游跑过的样本语料
  '3rd/graphify/tests', // 4.4MB
]

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

/** 目录/文件字节数（递归）。 */
async function sizeOf(p) {
  try {
    const s = await stat(p)
    if (!s.isDirectory()) return s.size
    let total = 0
    for (const entry of await readdir(p, { withFileTypes: true })) {
      total += await sizeOf(join(p, entry.name))
    }
    return total
  } catch {
    return 0
  }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * 平台标识（进包名）。
 * 与 Node 的 process.platform / process.arch 同构，便于目标机核对：
 *   win32+x64 → win_x64     darwin+arm64 → mac_arm64     darwin+x64 → mac_x64
 * 未收录的组合直接抛错——宁可不发包，也不发一个名字骗人的包。
 */
function platformToken() {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
  if (os === undefined) {
    throw new Error(`未知平台 process.platform=${process.platform}——请先在 platformToken() 里登记`)
  }
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch]
  if (arch === undefined) {
    throw new Error(`未知架构 process.arch=${process.arch}——请先在 platformToken() 里登记`)
  }
  return `${os}_${arch}`
}

/**
 * 物化一个外部依赖到目标 node_modules（含其运行时依赖闭包）。
 * pnpm 布局下依赖可能只装在**声明它的包**的 node_modules 里（而非仓库根），
 * 故按 `fromDir` 逐级向上查找，找不到再回落根 node_modules。
 */
async function materializeDependency(dep, nodeModulesDir, fromDir = ROOT) {
  const src = await resolveDependencyDir(dep, fromDir)
  if (src === null) {
    log(`  跳过（未安装）: ${dep}`)
    return
  }
  const dst = join(nodeModulesDir, ...dep.split('/'))
  await mkdir(join(dst, '..'), { recursive: true })
  await cp(src, dst, { recursive: true, dereference: true })
  // 递归带上该依赖自身的运行时依赖
  const pkgJsonPath = join(dst, 'package.json')
  if (!(await exists(pkgJsonPath))) return
  const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'))
  // optionalDependencies 也带上（平台原生绑定常走这里）；只带**本机已安装**的那些。
  const childDeps = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.optionalDependencies ?? {}) }
  for (const child of Object.keys(childDeps)) {
    if (child.startsWith('@prism/')) continue
    const childDst = join(nodeModulesDir, ...child.split('/'))
    if (await exists(childDst)) continue
    await materializeDependency(child, nodeModulesDir, src)
  }
}

/** 逐级向上查找依赖目录（pnpm 常把它装在声明方包的 node_modules 下）。 */
async function resolveDependencyDir(dep, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', ...dep.split('/'))
    if (await exists(join(candidate, 'package.json'))) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  // pnpm 布局：optional 平台包只落在 `.pnpm/<pkg>@<ver>/node_modules/` 下，
  // 不在任何逐级路径上——扫一遍 .pnpm 目录找它。
  return await findInPnpmStore(dep)
}

/** 在 pnpm 虚拟 store（node_modules/.pnpm 下的各包目录）里查找依赖。 */
async function findInPnpmStore(dep) {
  const store = join(ROOT, 'node_modules', '.pnpm')
  let entries
  try {
    entries = await readdir(store)
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = join(store, entry, 'node_modules', ...dep.split('/'))
    if (await exists(join(candidate, 'package.json'))) return candidate
  }
  return null
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
  const out = { outDir: join(ROOT, 'dist'), skipBuild: false, models: 'small', full3rd: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.outDir = resolve(argv[++i])
    else if (argv[i] === '--skip-build') out.skipBuild = true
    else if (argv[i] === '--models') out.models = argv[++i]
    else if (argv[i] === '--full-3rd') out.full3rd = true
  }
  if (out.models !== 'small' && out.models !== 'all') {
    throw new Error(`--models 只接受 small|all，收到 ${out.models}`)
  }
  return out
}

/** 某个绝对路径相对仓库根是否落在排除清单里。 */
function isSkipped(rel, full3rd) {
  const lists = full3rd ? RUNTIME_DIRS : [...RUNTIME_DIRS, ...THIRD_PARTY_SLIM]
  return lists.some((skip) => rel === skip || rel.startsWith(`${skip}/`))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'))
  const version = rootPkg.version
  const platform = platformToken()
  const stageName = `prism-${version}_${platform}`
  const stageDir = join(args.outDir, stageName)

  log(`版本 ${version} · 平台 ${platform}（process.platform=${process.platform} / arch=${process.arch}）`)

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

  // 2b) 运行时前置校验：既然承诺「解压即用」，缺件就必须**打包期**炸掉，
  //     而不是等目标机跑到一半才发现。任何一项缺失都让本次打包失败。
  //     文件名按平台折算：Windows 是 llama-server.exe，其余是 llama-server。
  const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const runtimeNeeded = [
    ['llama 主二进制', join(ROOT, '3rd', 'llama-runtime', 'bin', binName)],
    ['anydoc 原生绑定', join(ROOT, '3rd', 'anydoc-runtime', 'anydoc.js')],
    ['最小向量模型', join(ROOT, '3rd', 'llama-runtime', 'models', DEFAULT_MODEL)],
    // Vulkan 后端只在 Windows / Linux 上存在；macOS 走随包分发的 Metal。
    ...(process.platform === 'win32' || process.platform === 'linux'
      ? [['llama Vulkan 后端', join(ROOT, '3rd', 'llama-runtime', 'bin-vulkan', binName)]]
      : []),
  ]
  const absent = runtimeNeeded
    .filter(([, p]) => !existsSync(p))
    .map(([label, p]) => `${label} → ${relative(ROOT, p).split(sep).join('/')}`)
  if (absent.length > 0) {
    throw new Error(
      `运行时缺失，无法产出「解压即用」的平台包：\n  - ${absent.join('\n  - ')}\n` +
        `先跑 \`pnpm run 3rd:setup\`（anydoc + embedding）再打包。`,
    )
  }
  log(`运行时前置校验通过（${runtimeNeeded.map(([label]) => label).join(' / ')}）`)

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

  // 5b) 物化**外部运行时依赖**：遍历各包 dependencies 的外部闭包（不含 devDependencies）。
  //     三方件现已全走 submodule，故此步通常为空；保留以兜住将来新增的外部 npm 依赖。
  const externalDeps = new Set()
  for (const name of PKG_NAMES) {
    const pkgDir = join(ROOT, 'packages', name)
    const pkgJson = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'))
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      if (!dep.startsWith('@prism/')) externalDeps.add(`${dep}\u0000${pkgDir}`)
    }
  }
  for (const entry of externalDeps) {
    const [dep, fromDir] = entry.split('\u0000')
    await materializeDependency(dep, join(stageDir, 'node_modules'), fromDir)
  }
  if (externalDeps.size > 0) {
    log(`物化外部运行时依赖: ${[...externalDeps].map((e) => e.split('\u0000')[0]).join(', ')}`)
  }

  // 6) 控制台静态资源
  await cp(join(ROOT, 'apps', 'web', 'dist'), join(stageDir, 'apps', 'web', 'dist'), { recursive: true })

  // 7) 三方**源码**（archify 自包含 CLI、graphify Python 包、anydoc JS 包装层来源）。
  //    解压即用需要它们在场：目标机不跑 git submodule 也能直接调起这三个工具。
  await cp(join(ROOT, '3rd'), join(stageDir, '3rd'), {
    recursive: true,
    filter: (src) => {
      const rel = relative(ROOT, src).split(sep).join('/')
      const segments = rel.split('/')
      if (segments.some((s) => s === '.git' || s === 'node_modules' || s === '__pycache__')) return false
      if (rel === '3rd') return true
      return !isSkipped(rel, args.full3rd)
    },
  })
  log(args.full3rd ? '三方源码已随包（--full-3rd：保留 3rd 子模块全部内容）' : '三方源码已随包（已排除 docs/examples/tests 等死重）')

  // 7a) ★ 三方**运行时**（本平台）——「访问不了 git 也装得上」的关键。
  //     llama-runtime 只取 bin / bin-vulkan / 指定模型；
  //     build/（95MB 编译中间产物）与 llama-server.log 绝不入包。
  const rtRoot = join(ROOT, '3rd', 'llama-runtime')
  const rtDest = join(stageDir, '3rd', 'llama-runtime')
  await mkdir(rtDest, { recursive: true })
  for (const sub of ['bin', 'bin-vulkan']) {
    if (!(await exists(join(rtRoot, sub)))) continue
    await cp(join(rtRoot, sub), join(rtDest, sub), {
      recursive: true,
      filter: (src) => !src.endsWith('.log'),
    })
    const bytes = await sizeOf(join(rtDest, sub))
    log(`  ★ ${sub.padEnd(11)} ${mb(bytes)}`)
  }
  // 模型：默认只带最小档；--models all 才带大档（各 600MB+）
  const models = args.models === 'all'
    ? ['bge-small-zh-v1.5-q8_0.gguf', 'bge-m3-Q8_0.gguf', 'Qwen3-Embedding-0.6B-Q8_0.gguf']
    : [DEFAULT_MODEL]
  const modelsDest = join(rtDest, 'models')
  await mkdir(modelsDest, { recursive: true })
  for (const model of models) {
    const src = join(rtRoot, 'models', model)
    if (!(await exists(src))) {
      throw new Error(`模型缺失：${relative(ROOT, src)}（--models ${args.models} 要求它在场）`)
    }
    await cp(src, join(modelsDest, model))
    log(`  ★ models/${model}  ${mb((await stat(src)).size)}`)
  }

  // 7b) ★ anydoc 运行时（原生绑定 + JS 包装层）
  await cp(join(ROOT, '3rd', 'anydoc-runtime'), join(stageDir, '3rd', 'anydoc-runtime'), {
    recursive: true,
    filter: (src) => !src.endsWith('.log'),
  })
  log(`  ★ anydoc-runtime ${mb(await sizeOf(join(stageDir, '3rd', 'anydoc-runtime')))}`)

  // 7c) 三方件安装脚本（`prism embedding install` / anydoc 重装 / 换平台；小文件，随包发）
  //     setup-embedding 依赖 archive.mjs（解压 llama.cpp 预编译包）+ python.mjs（Windows 解压 zipfile 用）
  await mkdir(join(stageDir, 'scripts'), { recursive: true })
  for (const script of ['setup-embedding.mjs', 'setup-anydoc.mjs', 'archive.mjs', 'python.mjs']) {
    const src = join(ROOT, 'scripts', script)
    if (existsSync(src)) await cp(src, join(stageDir, 'scripts', script))
  }

  // 7c) assets/（vis-network 等离线化资源——studio 路由此目录代理，缺了代码图谱就是黑屏）
  //     缺失即 throw：静默跳过会让发行版少了 vendored 资源，只在运行时以「代码图谱黑屏」暴露。
  const assetsSrc = join(ROOT, 'assets')
  if (!(await exists(assetsSrc))) {
    throw new Error(`assets/ 缺失：${relative(ROOT, assetsSrc)}（studio 的 vendor 路由依赖它，缺了代码图谱会黑屏）`)
  }
  await cp(assetsSrc, join(stageDir, 'assets'), { recursive: true })
  log(`  ★ assets/ ${mb(await sizeOf(join(stageDir, 'assets')))}`)

  // 8) 文档与许可
  for (const file of ['README.md', 'AGENTS.md', 'LICENSE']) {
    if (await exists(join(ROOT, file))) await cp(join(ROOT, file), join(stageDir, file))
  }

  // 8b) 宿主适配器示例（运行期插件，随包分发：目标机复制到 <PRISM_HOME>/harnesses/ 即用）
  if (await exists(join(ROOT, 'examples'))) {
    await cp(join(ROOT, 'examples'), join(stageDir, 'examples'), {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    })
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
        // os / cpu 是 package.json 的标准字段：让工具链一眼看出这是**单平台**包
        os: [process.platform],
        cpu: [process.arch],
        engines: rootPkg.engines,
        bin: { prism: './bin/prism.js' },
        scripts: { '3rd:build': 'python -m pip install -q "tree-sitter>=0.23.0,<0.26" tree-sitter-python tree-sitter-typescript tree-sitter-javascript networkx numpy rapidfuzz' },
      },
      null,
      2,
    )}\n`,
    'utf-8',
  )

  // 9b) 清单：版本 / 平台 / 运行时实况 / 体积——目标机与支持人员据此核对包内容
  const manifest = {
    name: stageName,
    version,
    platform,
    processPlatform: process.platform,
    arch: process.arch,
    nodeEngine: rootPkg.engines?.node,
    runtime: {
      llama: {
        cpu: existsSync(join(rtDest, 'bin')) ? await sizeOf(join(rtDest, 'bin')) : 0,
        vulkan: existsSync(join(rtDest, 'bin-vulkan')) ? await sizeOf(join(rtDest, 'bin-vulkan')) : 0,
      },
      anydoc: await sizeOf(join(stageDir, '3rd', 'anydoc-runtime')),
      models,
    },
    /** graphify 的 Python 依赖不随包：目标机需 `python -m pip install`（见 README）。 */
    externalPythonDeps: ['tree-sitter', 'tree-sitter-python', 'tree-sitter-typescript', 'tree-sitter-javascript', 'networkx', 'numpy', 'rapidfuzz'],
    full3rd: args.full3rd,
  }
  await writeFile(join(stageDir, 'PRISM-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

  // 10) 打 tarball（相对路径打包，解压得到 prism-<version>_<platform>/ 目录）
  const tarball = join(args.outDir, `${stageName}.tgz`)
  await rm(tarball, { force: true })
  log('压缩中…')
  // 用相对路径 + cwd 调 tar：Git Bash 的 GNU tar 会把 "K:/..." 当远程主机（路径转换陷阱），
  // 故以 outDir 为工作目录、只传相对文件名。
  await run('tar', ['-czf', `${stageName}.tgz`, stageName], args.outDir)

  // 10b) 校验和（Release 附件：让下载方核对完整性）
  const bytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const sumsPath = join(args.outDir, 'SHA256SUMS')
  const prevSums = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf-8') : ''
  // 同名条目只保留最新一条（重打包同一版本时不会累积重复行）
  const kept = prevSums
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().endsWith(`  ${stageName}.tgz`))
  const nextSums = [...kept, `${sha256}  ${stageName}.tgz`].join('\n') + '\n'
  await writeFile(sumsPath, nextSums, 'utf-8')

  const size = (await stat(tarball)).size
  log(`完成: ${tarball}（${mb(size)}）`)
  log(`sha256: ${sha256}`)
  log(`校验和清单: ${sumsPath}`)
  log('')
  log('解压即用（无需 git / 无需联网）：')
  log(`  tar -xzf ${stageName}.tgz && cd ${stageName}`)
  log('  node bin/prism.js --version')
  log('  node bin/prism.js serve')
  log('')
  log('注意：代码图谱需本机 Python ≥3.10 并安装依赖 → npm run 3rd:build（这一步需要联网）。')
}

/** 一键启动入口（ESM）：转发到 CLI，并做运行时预检。 */
const LAUNCHER = `#!/usr/bin/env node
/**
 * Prism 一键启动入口（打包产物，单平台自包含）。
 * 用法: node bin/prism.js <命令>   （如 serve / init / graph build …）
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const has = (...rel) => existsSync(join(root, ...rel))

// 代码图谱依赖 graphify（源码随包；Python 依赖需本机 pip 装）
if (!has('3rd', 'graphify', 'pyproject.toml')) {
  process.stderr.write('[prism] 警告: 未找到 3rd/graphify，代码图谱不可用（包可能不完整，建议重新解压）\\n')
}
// 文档转换依赖 anydoc 原生绑定（平台专属，已随包）
if (!has('3rd', 'anydoc-runtime', 'anydoc.js')) {
  process.stderr.write('[prism] 警告: anydoc 运行时缺失，文档转换降级（重跑 node scripts/setup-anydoc.mjs）\\n')
}
// 向量检索依赖 llama-server（已随包）：CPU 档在 bin/，GPU 档在 bin-vulkan/
if (!has('3rd', 'llama-runtime', 'bin') && !has('3rd', 'llama-runtime', 'bin-vulkan')) {
  process.stderr.write('[prism] 警告: 未找到 llama 运行时，语义检索不可用（重跑 node scripts/setup-embedding.mjs）\\n')
}

// Windows 绝对路径必须转 file:// URL 才能被 ESM 加载器接受
const cliEntry = pathToFileURL(join(root, 'packages', 'cli', 'dist', 'argv.js')).href
const { runCommand, defaultContext } = await import(cliEntry)
const code = await runCommand(defaultContext(), process.argv.slice(2))
process.exit(code)
`

await main()
