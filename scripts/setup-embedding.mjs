#!/usr/bin/env node
/**
 * 向量化环境安装脚本（变更 2：Prism 内置 embedding，不依赖宿主）：
 *
 *   node scripts/setup-embedding.mjs [选项]
 *
 * **双平台（2026-09-12）**：Windows 与 macOS / Linux 同级支持，但取二进制的方式不同——
 *
 *   | 平台              | 默认路径            | 加速后端                                      |
 *   | :---------------- | :------------------ | :-------------------------------------------- |
 *   | Windows           | 本地 MinGW 源码编译 | 预编译 Vulkan 包 → `bin-vulkan/`（独立目录）   |
 *   | macOS **arm64**   | 官方预编译包         | Metal（`GGML_METAL_EMBED_LIBRARY=ON`，包内 `libggml-metal.*.dylib`） |
 *   | macOS **x64**     | 官方预编译包         | **无**（上游显式 `-DGGML_METAL=OFF`，见下文）  |
 *   | Linux             | 官方预编译包         | 预编译 Vulkan 包 → `bin-vulkan/`（可选）       |
 *
 *   ⚠ **Intel Mac 的预编译包没有 Metal**（2026-09-12 实测 + 上游 release.yml 佐证）：
 *   上游 macOS 构建矩阵对两个架构开关不同——arm64 `-DGGML_METAL_EMBED_LIBRARY=ON`、
 *   x64 `-DGGML_METAL=OFF`（原文注释：Metal is disabled on x64 due to intermittent
 *   failures with Github runners not having a GPU）。实测 x64 包内无 `libggml-metal*`、
 *   二进制不含 `ggml_metal` 符号，只链 `CoreFoundation` + `libggml-blas`。
 *   而机器**硬件**照样报 `Metal Support: Metal 3`，所以「看硬件/看平台」必然假阳性——
 *   后果是本脚本会判「有显卡」去下 634MB 的 `large` 模型，然后在纯 CPU 上慢跑。
 *
 *   Windows 默认走源码编译是因为本机有 MinGW + CMake 工具链（产物可控）；macOS/Linux
 *   默认走预编译包——不需本机工具链，预编译包已带 Vulkan（macOS **arm64** 带 Metal）。
 *   `--prebuilt` / 编译失败回落对三家一视同仁。源码来自 git submodule（`3rd/llama.cpp`），
 *   产物落 Prism 自有的 `3rd/llama-runtime/`，绝不写进子模块。
 *
 *   模型：**按算力分档下载**——有显卡装 large(Qwen3-Emb-0.6B)+small；无显卡只装
 *         small(bge-small-zh, 25MB, 512 维)。default(BGE-M3) 需 --tier default 显式装。
 *
 * 前置：`git submodule update --init --recursive`（仅源码编译路径需要）。
 *
 * 选项：
 *   --check        只检查是否就绪（退出码 0/1）
 *   --tier <名>    只装指定档模型（small|default|large）
 *   --bin-only     只装二进制，跳过模型
 *   --model-only   只装模型，跳过二进制
 *   --prebuilt     强制用官方预编译包（不编译）
 *   --source       强制源码编译（POSIX 默认用预编译包，需本机有 cmake）
 *   --gpu          强制下载 GPU 包（即使未探到加速器）
 *   --no-gpu       跳过 GPU 包（只用 CPU）
 *   --force        重编译/重下载
 *
 * 产物（均 gitignored，不进仓库）：
 *   3rd/llama-runtime/bin/llama-server[.exe]          主二进制（Windows=CPU / macOS arm64=Metal / macOS x64=CPU）
 *   3rd/llama-runtime/bin-vulkan/llama-server[.exe]   GPU（Vulkan 预编译，Windows/Linux）
 *   3rd/llama-runtime/models/<档位模型>.gguf
 *
 * 验证：prism doctor 会检查 embedding 可用性；检索自动走 BM25+向量混合。
 */
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, rename, rm, stat, access, constants } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'

// 归档解压 + 摊平（上游包带顶层目录，不摊平会「装了却检测不到」）
import { extractArchive } from './archive.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 源码：git submodule（只读，绝不写构建产物进去）。 */
const SRC_DIR = join(ROOT, '3rd', 'llama.cpp')
/** 运行时：Prism 自有的构建输出 + 下载的模型（gitignored）。 */
const RUNTIME_DIR = join(ROOT, '3rd', 'llama-runtime')
const BUILD_DIR = join(RUNTIME_DIR, 'build')
const BIN_DIR = join(RUNTIME_DIR, 'bin')
/** GPU 独立目录（Vulkan 包 → bin-vulkan）；macOS 不用它——Metal 不另立目录，落在 bin/。 */
const GPU_BIN_DIR = join(RUNTIME_DIR, 'bin-vulkan')
const MODEL_DIR = join(RUNTIME_DIR, 'models')

const IS_WINDOWS = process.platform === 'win32'
const IS_MACOS = process.platform === 'darwin'
/** macOS arm64 的官方预编译包才带 Metal（x64 上游显式关掉，见文件头说明）。 */
const METAL_PREBUILT = IS_MACOS && process.arch === 'arm64'

/** llama.cpp 产物名：Windows 带 `.exe`，macOS / Linux 无扩展名。 */
const SERVER_BIN = IS_WINDOWS ? 'llama-server.exe' : 'llama-server'

/**
 * llama.cpp 版本 = submodule 锁定的 tag（升级：改 submodule 引用即可，
 * 本脚本不再下载源码 zip）。常量仅用于预编译包资产名与提示。
 */
const LLAMA_TAG = 'b10883'

/**
 * 官方预编译包资产名（**按平台**）。
 *
 * 资产名经 GitHub releases API 实查核对，**不要凭记忆改**：
 *   curl -s https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/<tag> | grep '"name"'
 * 实测可用形态：`-bin-win-cpu-x64.zip`、`-bin-win-vulkan-x64.zip`、`-bin-macos-arm64.tar.gz`、
 * `-bin-macos-x64.tar.gz`、`-bin-ubuntu-x64.tar.gz`、`-bin-ubuntu-vulkan-x64.tar.gz`。
 *
 * macOS **没有独立的 GPU 资产**（两个架构都只有 `-bin-macos-<arch>.tar.gz`），
 * 但「有没有 Metal 后端」按架构不同：arm64 有（`libggml-metal.*.dylib`），x64 没有。
 * 所以 `gpu` 一律为 null（无独立资产可下），运行时侧另由「包内是否有 libggml-metal」
 * 判定（见 `packages/server/src/kb/embedding.ts::accelBackend`）。
 */
const PREBUILT = (() => {
  const base = `llama-${LLAMA_TAG}-bin`
  if (IS_WINDOWS) {
    return { cpu: `${base}-win-cpu-x64.zip`, gpu: `${base}-win-vulkan-x64.zip`, ext: 'zip' }
  }
  if (IS_MACOS) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return { cpu: `${base}-macos-${arch}.tar.gz`, gpu: null, ext: 'tar.gz' }
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return { cpu: `${base}-ubuntu-${arch}.tar.gz`, gpu: `${base}-ubuntu-vulkan-${arch}.tar.gz`, ext: 'tar.gz' }
})()

/** 预编译包下载地址（GitHub release 直链；镜像前缀由 withMirrors 叠加）。 */
function prebuiltUrl(asset) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}`
}

/**
 * 模型档位表（**必须与 packages/server/src/kb/embedding-models.ts 一致**；
 * `embedding-models.test.ts` 做一致性校验防漂移）。
 * 档位：small=CPU 友好 / default=多语言基线 / large=更强（GPU）。
 */
const TIERS = {
  small: {
    file: 'bge-small-zh-v1.5-q8_0.gguf',
    repo: 'CompendiumLabs/bge-small-zh-v1.5-gguf',
    bytes: 26_472_640,
  },
  default: {
    file: 'bge-m3-Q8_0.gguf',
    repo: 'gpustack/bge-m3-GGUF',
    bytes: 634_553_760,
  },
  large: {
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    bytes: 639_150_592,
  },
}
const TIER_NAMES = Object.keys(TIERS)

/** 模型下载源（国内镜像优先；huggingface.co 直连常被阻断）。 */
function modelUrls(tier) {
  const { file, repo } = TIERS[tier]
  return [
    `https://hf-mirror.com/${repo}/resolve/main/${file}`,
    `https://huggingface.co/${repo}/resolve/main/${file}`,
  ]
}

/**
 * GitHub 直连在国内常被阻断/抖动 → release 下载统一走镜像前缀。
 * 空串 = 官方直链（最后兜底）。codeload（源码 zip）一般可直连，不套镜像。
 */
const GH_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/', '']

/** 给一个 GitHub URL 生成「镜像优先 + 官方兜底」的可尝试列表。 */
function withMirrors(url) {
  return GH_MIRRORS.map((m) => (m === '' ? url : `${m}${url}`))
}

/** 工具链候选目录（PATH 找不到时逐个探测，目录内找 <name>.exe）。 */
const CMAKE_CANDIDATES = [
  'D:/code/cmake-3.31.6-windows-x86_64/bin',
  'D:/code/cmake-3.16.9-win64-x64/bin',
  'C:/Program Files/CMake/bin',
  'C:/Program Files (x86)/CMake/bin',
]
const MINGW_CANDIDATES = [
  'D:/code/mingw64/bin',
  'C:/mingw64/bin',
  'C:/msys64/mingw64/bin',
  'D:/msys64/mingw64/bin',
]

/** MinGW 运行库：随 exe 一起放到 bin/（否则子进程找不到 DLL）。 */
const MINGW_RUNTIME_DLLS = [
  'libstdc++-6.dll',
  'libgcc_s_seh-1.dll',
  'libwinpthread-1.dll',
  'libgomp-1.dll',
]

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const BIN_ONLY = args.includes('--bin-only')
const MODEL_ONLY = args.includes('--model-only')
const FORCE_PREBUILT = args.includes('--prebuilt')
const FORCE_SOURCE = args.includes('--source')
const FORCE = args.includes('--force')
const FORCE_GPU = args.includes('--gpu')

/** --tier <name>：只装该档模型（不传则由 GPU 探测决定 small/large）。 */
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const REQUESTED_TIER = argValue('--tier')

/** 要安装的档位集合：显式 --tier 则只装它；否则按算力（有卡装 large+small，无卡只装 small）。 */
function tiersToInstall() {
  if (REQUESTED_TIER !== undefined) {
    if (!TIER_NAMES.includes(REQUESTED_TIER)) {
      throw new Error(`未知档位: ${REQUESTED_TIER}（可用: ${TIER_NAMES.join(' / ')}）`)
    }
    return [REQUESTED_TIER]
  }
  // 有显卡：强档 + 轻量档兜底（万一显卡不可用仍能跑）；
  // 无显卡：只装轻量档——bge-m3(default) 在 CPU 上慢到不可用，装了也是浪费 600MB。
  return FORCE_GPU || detectGpu() !== null ? ['large', 'small'] : ['small']
}
const NO_GPU = args.includes('--no-gpu')

function log(msg) {
  process.stdout.write(`[embedding-setup] ${msg}\n`)
}

async function exists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 在 PATH 或候选目录里找工具，返回绝对路径（找不到 null）。 */
function findTool(name, candidates, probeArgs = ['--version']) {
  const onPath = spawnSync(name, probeArgs, { stdio: 'ignore' })
  if (onPath.status === 0) return name
  for (const dir of candidates) {
    const exe = join(dir, `${name}.exe`)
    if (existsSync(exe)) return exe
  }
  return null
}

/** 找 MinGW 的 bin 目录（gcc/g++ 所在）。 */
function findMingwBin() {
  const gccOnPath = spawnSync('gcc', ['--version'], { stdio: 'ignore' })
  if (gccOnPath.status === 0) {
    // PATH 里有 gcc，让 cmake 自己找
    return null
  }
  for (const dir of MINGW_CANDIDATES) {
    if (existsSync(join(dir, 'gcc.exe')) && existsSync(join(dir, 'g++.exe'))) return dir
  }
  return null
}

/** 下载（显示进度；支持代理环境变量 http_proxy/https_proxy 由 fetch 自带处理）。 */
async function download(url, dest, expectedBytes) {
  if (!FORCE && (await exists(dest))) {
    const info = await stat(dest)
    if (expectedBytes === undefined || info.size === expectedBytes) {
      log(`已存在，跳过: ${dest}（${(info.size / 1048576).toFixed(1)} MB）`)
      return
    }
    log(`大小不符，重下: ${dest}（${info.size} ≠ ${expectedBytes}）`)
    await rm(dest, { force: true })
  }
  log(`下载 ${url}`)
  log(`→ ${dest}${expectedBytes !== undefined ? `（${(expectedBytes / 1048576).toFixed(0)} MB）` : ''}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || res.body === null) {
    throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  }
  const tmp = `${dest}.${randomUUID().slice(0, 8)}.part`
  let received = 0
  const total = Number(res.headers.get('content-length') ?? expectedBytes ?? 0)
  await pipeline(
    res.body,
    async function* track(source) {
      for await (const chunk of source) {
        received += chunk.length
        if (total > 0 && received % (50 * 1024 * 1024) < chunk.length) {
          log(`  ${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`)
        }
        yield chunk
      }
    },
    createWriteStream(tmp),
  )
  if (expectedBytes !== undefined && received !== expectedBytes) {
    await rm(tmp, { force: true })
    throw new Error(`大小校验失败: ${received} ≠ ${expectedBytes}`)
  }
  await rename(tmp, dest)
  log(`完成: ${dest}（${(received / 1048576).toFixed(1)} MB）`)
}

/** 多源下载：逐个尝试，全失败才抛错。 */
async function downloadAny(urls, dest, expectedBytes) {
  let lastError
  for (const url of urls) {
    try {
      await download(url, dest, expectedBytes)
      return
    } catch (error) {
      lastError = error
      log(`源失败（${error instanceof Error ? error.message : String(error)}），换下一个源…`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有下载源均失败')
}

/** 运行命令，实时透传输出；失败抛错。 */
async function run(cmd, cmdArgs, options = {}) {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`)
  const code = await new Promise((resolveCode) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', ...options })
    child.on('close', resolveCode)
    child.on('error', (err) => {
      process.stderr.write(`[embedding-setup] 无法启动 ${cmd}: ${err.message}\n`)
      resolveCode(-1)
    })
  })
  if (code !== 0) throw new Error(`命令失败（退出码 ${code}）: ${cmd} ${cmdArgs.join(' ')}`)
}

/** 源码编译 llama.cpp（源码来自 submodule）→ `bin/`。Windows 默认走这条；POSIX 需 --source。 */
async function buildFromSource() {
  const cmake = findTool('cmake', CMAKE_CANDIDATES)
  if (cmake === null) throw new Error('未找到 cmake（装 CMake 或加进 PATH）')

  // 源码来自 submodule：先确保已初始化（否则提示 git submodule update）
  if (!(await exists(join(SRC_DIR, 'CMakeLists.txt')))) {
    throw new Error(
      `未找到 llama.cpp 源码（${SRC_DIR}）——请先初始化子模块：git submodule update --init --recursive`,
    )
  }
  log(`源码: ${SRC_DIR}（submodule）`)

  const env = { ...process.env }
  /** 生成器与工具链参数：Windows 走 MinGW Makefiles，POSIX 交给 cmake 默认（Make/Ninja）。 */
  const toolchainArgs = []
  let mingwBin = null

  if (IS_WINDOWS) {
    mingwBin = findMingwBin()
    const gcc = mingwBin === null ? findTool('gcc', []) : join(mingwBin, 'gcc.exe')
    if (gcc === null) throw new Error('未找到 MinGW gcc（装 MinGW-w64 或加进 PATH）')
    const make = mingwBin === null ? 'mingw32-make' : join(mingwBin, 'mingw32-make.exe')
    if (mingwBin !== null) {
      env.PATH = `${mingwBin}${delimiter}${env.PATH ?? ''}`
      env.CC = join(mingwBin, 'gcc.exe')
      env.CXX = join(mingwBin, 'g++.exe')
    }
    toolchainArgs.push('-G', 'MinGW Makefiles', `-DCMAKE_MAKE_PROGRAM=${make}`)
  }

  // 配置（关 OpenMP 免 libgomp 依赖，关 curl/tests 提速）
  // **out-of-source**：构建目录在 3rd/llama-runtime/build，绝不写进 submodule。
  await rm(BUILD_DIR, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  const native = process.env.PRISM_EMBED_NATIVE !== '0' ? 'ON' : 'OFF'
  /**
   * macOS：显式开 Metal（Apple 平台本就默认开，写出来是为了可读、可查）。
   * **x64 上这是拿到 Metal 的唯一途径**——官方预编译包把 x64 的 Metal 关了。
   */
  const accel = IS_MACOS ? ['-DGGML_METAL=ON'] : []
  await run(
    cmake,
    [
      '-S', SRC_DIR,
      '-B', BUILD_DIR,
      ...toolchainArgs,
      '-DCMAKE_BUILD_TYPE=Release',
      `-DGGML_NATIVE=${native}`,
      '-DGGML_OPENMP=OFF',
      '-DLLAMA_CURL=OFF',
      '-DLLAMA_BUILD_TESTS=OFF',
      '-DLLAMA_BUILD_EXAMPLES=ON',
      '-DLLAMA_BUILD_TOOLS=ON',
      '-DLLAMA_BUILD_SERVER=ON',
      ...accel,
    ],
    { env },
  )

  // 编译（只编 llama-server，省时间）
  const jobs = String(Math.max(1, os.cpus().length))
  await run(cmake, ['--build', BUILD_DIR, '--config', 'Release', '--target', 'llama-server', '-j', jobs], { env })

  // 收集产物：build/bin 下的二进制（+ Windows 的 dll 与 MinGW 运行库）
  const outBin = join(BUILD_DIR, 'bin')
  const produced = join(outBin, SERVER_BIN)
  if (!(await exists(produced))) {
    throw new Error(`编译完成但未找到 ${produced}`)
  }
  await rm(BIN_DIR, { recursive: true, force: true })
  await mkdir(BIN_DIR, { recursive: true })
  for (const f of await readdir(outBin)) {
    const src = join(outBin, f)
    const info = await stat(src)
    if (!info.isFile()) continue
    await copyFile(src, join(BIN_DIR, f))
  }
  if (IS_WINDOWS && mingwBin !== null) {
    for (const dll of MINGW_RUNTIME_DLLS) {
      const src = join(mingwBin, dll)
      if (existsSync(src)) await copyFile(src, join(BIN_DIR, dll))
    }
  }
  if (!IS_WINDOWS) {
    try {
      await chmod(join(BIN_DIR, SERVER_BIN), 0o755)
    } catch {
      // 无 POSIX 权限的文件系统上忽略
    }
  }
  log(`源码编译完成 → ${BIN_DIR}/${SERVER_BIN}`)
}

/** 官方预编译包（主二进制）→ `bin/`；资产名按平台取自 `PREBUILT`。 */
async function installPrebuilt() {
  const archive = join(RUNTIME_DIR, PREBUILT.cpu)
  await downloadAny(withMirrors(prebuiltUrl(PREBUILT.cpu)), archive)
  await extractArchive(archive, BIN_DIR, SERVER_BIN, log)
  await rm(archive, { force: true })
  if (!(await exists(join(BIN_DIR, SERVER_BIN)))) {
    // 不静默：装完却没有二进制 = 「装了却检测不到」，只警告会让人一头雾水
    throw new Error(`预编译包安装完成但未找到 ${join(BIN_DIR, SERVER_BIN)}`)
  }
  log(`预编译包安装完成 → ${BIN_DIR}/${SERVER_BIN}`)
}

/**
 * GPU 加速包 → `bin-vulkan/`（Windows / Linux）。
 *
 * 为什么选 Vulkan 而非 CUDA：Vulkan 包仅约 28MB 且无需 CUDA SDK，在 NVIDIA/AMD/Intel
 * 上都能卸载到 GPU；CUDA 包 179MB + 391MB 运行时，收益并无量级差异（瓶颈在显存带宽）。
 *
 * **macOS 不走这里**：官方 macos 包没有独立 GPU 资产（`PREBUILT.gpu === null`）——
 * Metal 不另发包，arm64 的 Metal 就编在主二进制同目录的 `libggml-metal.*.dylib` 里，
 * x64 则根本没有（见文件头）。
 */
async function installGpu() {
  if (PREBUILT.gpu === null) {
    log('本平台无独立 GPU 包，跳过')
    return false
  }
  const archive = join(RUNTIME_DIR, PREBUILT.gpu)
  await downloadAny(withMirrors(prebuiltUrl(PREBUILT.gpu)), archive)
  await extractArchive(archive, GPU_BIN_DIR, SERVER_BIN, log)
  await rm(archive, { force: true })
  const ok = await exists(join(GPU_BIN_DIR, SERVER_BIN))
  log(ok ? `GPU(Vulkan) 包安装完成 → ${GPU_BIN_DIR}/${SERVER_BIN}` : `警告: GPU 包内未找到 ${SERVER_BIN}`)
  return ok
}

/** 探测本机加速器（决定是否装 GPU 包、以及模型档位）。 */
function detectGpu() {
  // 通用：NVIDIA 驱动（Linux / Windows 都适用）
  const nv = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf-8' })
  if (nv.status === 0 && (nv.stdout ?? '').trim() !== '') return (nv.stdout ?? '').trim().split('\n')[0]

  // macOS：**只有 arm64 的官方预编译包带 Metal**（x64 被上游显式关掉，见文件头）。
  // 不能拿 system_profiler 的「Metal Support」当真——那是**硬件**能力，Intel Mac 照样报
  // 「Metal 3」，但预编译的 llama-server 里没有 Metal 后端。误判的代价是白下 634MB 的
  // large 模型然后在纯 CPU 上慢跑（本判据同时决定模型档位，见 tiersToInstall）。
  if (IS_MACOS) {
    if (!METAL_PREBUILT) return null
    const sp = spawnSync('system_profiler', ['SPDisplaysDataType'], { encoding: 'utf-8' })
    const chip = /Chipset Model:\s*(.+)/.exec(sp.stdout ?? '')
    return chip !== null ? `${chip[1].trim()}（Metal）` : 'Apple GPU（Metal）'
  }

  // Windows 通用探测：wmic 列显卡名（非 NVIDIA 也可能支持 Vulkan）
  if (IS_WINDOWS) {
    const wmic = spawnSync('wmic', ['path', 'win32_VideoController', 'get', 'name'], { encoding: 'utf-8' })
    if (wmic.status === 0) {
      const names = (wmic.stdout ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && l.toLowerCase() !== 'name')
      if (names.length > 0) return names[0]
    }
  }
  return null
}

/**
 * 取二进制：Windows 默认源码编译（本机有 MinGW 工具链，产物可控），
 * 失败即回落预编译包；macOS / Linux 默认直接用官方预编译包（无需本机工具链），
 * 想本地编译就显式加 `--source`。
 */
async function installBinary() {
  if (FORCE_PREBUILT) {
    log('--prebuilt：使用官方预编译包')
    await installPrebuilt()
    return
  }
  if (FORCE_SOURCE || IS_WINDOWS) {
    try {
      await buildFromSource()
      return
    } catch (error) {
      log(`源码编译不可用（${error instanceof Error ? error.message : String(error)}）`)
      log('回落到官方预编译包…')
    }
  }
  await installPrebuilt()
}

/** 是否装 GPU 包：显式 --gpu > 探测到加速器且未 --no-gpu；平台无独立 GPU 包时直接跳过。 */
function shouldInstallGpu() {
  if (NO_GPU) return { want: false, reason: '--no-gpu' }
  if (PREBUILT.gpu === null) {
    return { want: false, reason: '本平台无独立 GPU 包' }
  }
  if (FORCE_GPU) return { want: true, reason: '--gpu' }
  const gpu = detectGpu()
  return gpu !== null
    ? { want: true, reason: `探测到加速器: ${gpu}` }
    : { want: false, reason: '未探测到加速器（可 --gpu 强制，或装 GPU 驱动后重试）' }
}

async function main() {
  await mkdir(RUNTIME_DIR, { recursive: true })
  await mkdir(MODEL_DIR, { recursive: true })

  const serverExe = join(BIN_DIR, SERVER_BIN)
  const gpuServerExe = join(GPU_BIN_DIR, SERVER_BIN)
  const binReady = await exists(serverExe)
  const gpuReady = await exists(gpuServerExe)
  const tierState = TIER_NAMES.map((t) => ({ tier: t, ready: existsSync(join(MODEL_DIR, TIERS[t].file)) }))
  const anyModelReady = tierState.some((t) => t.ready)

  if (CHECK_ONLY) {
    log(`二进制(CPU):  ${binReady ? '就绪' : '缺失'} → ${serverExe}`)
    log(`二进制(GPU):  ${gpuReady ? '就绪' : '缺失'} → ${gpuServerExe}`)
    for (const t of tierState) log(`模型(${t.tier.padEnd(7)}): ${t.ready ? '就绪' : '缺失'} → ${TIERS[t.tier].file}`)
    process.exitCode = (binReady || gpuReady) && anyModelReady ? 0 : 1
    return
  }

  try {
    if (!MODEL_ONLY && (!binReady || FORCE)) {
      await installBinary()
    } else if (!MODEL_ONLY) {
      log(`CPU 二进制已存在，跳过: ${serverExe}（--force 可重编）`)
    }

    // GPU 包：可选增强，失败不阻断（CPU 仍可用）
    const gpuPlan = shouldInstallGpu()
    if (!MODEL_ONLY && gpuPlan.want && (!gpuReady || FORCE)) {
      log(`安装 GPU 加速包（${gpuPlan.reason}）…`)
      try {
        await installGpu()
      } catch (error) {
        log(`GPU 包安装失败（不影响 CPU 运行）：${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (!MODEL_ONLY) {
      log(gpuPlan.want ? `GPU 包已存在，跳过: ${gpuServerExe}` : `跳过 GPU 包：${gpuPlan.reason}`)
    }

    if (!BIN_ONLY) {
      const want = tiersToInstall()
      log(`模型档位: ${want.join(', ')}`)
      for (const tier of want) {
        const { file, bytes } = TIERS[tier]
        const dest = join(MODEL_DIR, file)
        if (existsSync(dest) && !FORCE) {
          log(`模型已存在，跳过（${tier}）: ${file}`)
          continue
        }
        await downloadAny(modelUrls(tier), dest, bytes)
        log(`模型安装完成（${tier}）`)
      }
    }
    log('\n全部就绪。可用 prism doctor 检查；检索将自动使用向量混合排序。')
    log('档位查看: prism embedding models；切换: prism embedding use <small|default|large>')
  } catch (error) {
    process.stderr.write(`[embedding-setup] 失败: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

await main()
