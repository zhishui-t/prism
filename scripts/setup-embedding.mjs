#!/usr/bin/env node
/**
 * 向量化环境安装脚本（变更 2：Prism 内置 embedding，不依赖宿主）：
 *
 *   node scripts/setup-embedding.mjs [选项]
 *
 *   默认：本地 MinGW + CMake 源码编译 llama.cpp（含 llama-server.exe），
 *         找不到工具链时回落到官方预编译包。
 *   模型：始终需要下载 BGE-M3 GGUF（gpustack/bge-m3-GGUF Q8_0，约 634MB，1024 维）。
 *
 * 选项：
 *   --check        只检查是否就绪（退出码 0/1）
 *   --bin-only     只装二进制，跳过模型
 *   --model-only   只装模型，跳过二进制
 *   --prebuilt     强制用官方预编译包（不编译）
 *   --force        重编译/重下载
 *
 * 产物（均已 gitignore，不进仓库）：
 *   3rd/llama.cpp/bin/llama-server.exe   本地编译产物 + 运行库
 *   3rd/llama.cpp/models/bge-m3-Q8_0.gguf
 *
 * 验证：prism doctor 会检查 embedding 可用性；检索自动走 BM25+向量混合。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, stat, rm, access, constants, readdir, rename, copyFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LLAMA_DIR = join(ROOT, '3rd', 'llama.cpp')
const SRC_DIR = join(LLAMA_DIR, 'src')
const BUILD_DIR = join(LLAMA_DIR, 'build')
const BIN_DIR = join(LLAMA_DIR, 'bin')
const MODEL_DIR = join(LLAMA_DIR, 'models')

/** 版本钉死（升级时改这里）。 */
const LLAMA_TAG = 'b6900'
const SRC_URL = `https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/${LLAMA_TAG}`
const PREBUILT_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`
const MODEL_FILE = 'bge-m3-Q8_0.gguf'
/** 下载源按序尝试：国内镜像优先（huggingface.co 直连常被阻断）。 */
const MODEL_URLS = [
  `https://hf-mirror.com/gpustack/bge-m3-GGUF/resolve/main/${MODEL_FILE}`,
  `https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/${MODEL_FILE}`,
]
const MODEL_BYTES = 634_553_760

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
const FORCE = args.includes('--force')

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

/** 解压 zip（Python zipfile，零依赖、Windows 可用）。 */
async function unzip(zipPath, destDir) {
  log(`解压 ${zipPath} → ${destDir}`)
  const code = await new Promise((resolveCode) => {
    const py = spawn(
      'python',
      ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zipPath, destDir],
      { stdio: 'inherit' },
    )
    py.on('close', resolveCode)
    py.on('error', () => resolveCode(-1))
  })
  if (code !== 0) throw new Error('解压失败（需要 python 在 PATH）')
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

/** 源码编译 llama.cpp → bin/。 */
async function buildFromSource() {
  const cmake = findTool('cmake', CMAKE_CANDIDATES)
  if (cmake === null) throw new Error('未找到 cmake（装 CMake 或加进 PATH）')
  const mingwBin = findMingwBin()
  const gcc = mingwBin === null ? findTool('gcc', []) : join(mingwBin, 'gcc.exe')
  const make = mingwBin === null ? 'mingw32-make' : join(mingwBin, 'mingw32-make.exe')
  if (gcc === null) throw new Error('未找到 MinGW gcc（装 MinGW-w64 或加进 PATH）')

  const env = { ...process.env }
  if (mingwBin !== null) {
    env.PATH = `${mingwBin};${env.PATH ?? ''}`
    env.CC = join(mingwBin, 'gcc.exe')
    env.CXX = join(mingwBin, 'g++.exe')
  }

  // 1. 源码
  if (!(await exists(join(SRC_DIR, 'CMakeLists.txt')))) {
    await rm(SRC_DIR, { recursive: true, force: true })
    const tmp = join(LLAMA_DIR, '_src_tmp')
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    const zipPath = join(LLAMA_DIR, `llama.cpp-${LLAMA_TAG}-src.zip`)
    await download(SRC_URL, zipPath)
    await unzip(zipPath, tmp)
    await rm(zipPath, { force: true })
    const entries = await readdir(tmp)
    const top = entries.find((e) => e.startsWith('llama.cpp-'))
    if (top === undefined) throw new Error('源码解压结果异常：未找到顶层目录')
    await rename(join(tmp, top), SRC_DIR)
    await rm(tmp, { recursive: true, force: true })
    log(`源码就绪: ${SRC_DIR}（tag ${LLAMA_TAG}）`)
  } else {
    log(`源码已存在: ${SRC_DIR}`)
  }

  // 2. 配置（MinGW Makefiles；关 OpenMP 免 libgomp 依赖，关 curl/tests 提速）
  await rm(BUILD_DIR, { recursive: true, force: true })
  await mkdir(BUILD_DIR, { recursive: true })
  const native = process.env.PRISM_EMBED_NATIVE !== '0' ? 'ON' : 'OFF'
  await run(
    cmake,
    [
      '-S', SRC_DIR,
      '-B', BUILD_DIR,
      '-G', 'MinGW Makefiles',
      `-DCMAKE_MAKE_PROGRAM=${make}`,
      '-DCMAKE_BUILD_TYPE=Release',
      `-DGGML_NATIVE=${native}`,
      '-DGGML_OPENMP=OFF',
      '-DLLAMA_CURL=OFF',
      '-DLLAMA_BUILD_TESTS=OFF',
      '-DLLAMA_BUILD_EXAMPLES=ON',
      '-DLLAMA_BUILD_TOOLS=ON',
      '-DLLAMA_BUILD_SERVER=ON',
    ],
    { env },
  )

  // 3. 编译（只编 llama-server，省时间）
  const jobs = String(Math.max(1, os.cpus().length))
  await run(cmake, ['--build', BUILD_DIR, '--config', 'Release', '--target', 'llama-server', '-j', jobs], { env })

  // 4. 收集产物：build/bin 下所有 exe/dll + MinGW 运行库
  const outBin = join(BUILD_DIR, 'bin')
  if (!(await exists(join(outBin, 'llama-server.exe')))) {
    throw new Error(`编译完成但未找到 ${join(outBin, 'llama-server.exe')}`)
  }
  await rm(BIN_DIR, { recursive: true, force: true })
  await mkdir(BIN_DIR, { recursive: true })
  for (const f of await readdir(outBin)) {
    await copyFile(join(outBin, f), join(BIN_DIR, f))
  }
  if (mingwBin !== null) {
    for (const dll of MINGW_RUNTIME_DLLS) {
      const src = join(mingwBin, dll)
      if (existsSync(src)) await copyFile(src, join(BIN_DIR, dll))
    }
  }
  log(`源码编译完成 → ${BIN_DIR}/llama-server.exe`)
}

/** 官方预编译包（回落路径）。 */
async function installPrebuilt() {
  const zipPath = join(LLAMA_DIR, `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`)
  await download(PREBUILT_URL, zipPath)
  await rm(BIN_DIR, { recursive: true, force: true })
  await unzip(zipPath, BIN_DIR)
  await rm(zipPath, { force: true })
  log(`预编译包安装完成（${(await exists(join(BIN_DIR, 'llama-server.exe'))) ? 'llama-server.exe OK' : '警告: 未找到 llama-server.exe'}）`)
}

async function installBinary() {
  if (FORCE_PREBUILT) {
    log('--prebuilt：使用官方预编译包')
    await installPrebuilt()
    return
  }
  try {
    await buildFromSource()
  } catch (error) {
    log(`源码编译不可用（${error instanceof Error ? error.message : String(error)}）`)
    log('回落到官方预编译包…')
    await installPrebuilt()
  }
}

async function main() {
  await mkdir(LLAMA_DIR, { recursive: true })
  await mkdir(MODEL_DIR, { recursive: true })

  const serverExe = join(BIN_DIR, 'llama-server.exe')
  const modelPath = join(MODEL_DIR, MODEL_FILE)
  const binReady = await exists(serverExe)
  const modelReady = await exists(modelPath)

  if (CHECK_ONLY) {
    log(`二进制: ${binReady ? '就绪' : '缺失'} → ${serverExe}`)
    log(`模型:   ${modelReady ? '就绪' : '缺失'} → ${modelPath}`)
    if (binReady) {
      const cmake = findTool('cmake', CMAKE_CANDIDATES)
      const mingwBin = findMingwBin()
      log(`工具链: cmake=${cmake ?? '缺失'} mingw=${mingwBin ?? (spawnSync('gcc', ['--version'], { stdio: 'ignore' }).status === 0 ? 'PATH' : '缺失')}`)
    }
    process.exitCode = binReady && modelReady ? 0 : 1
    return
  }

  try {
    if (!MODEL_ONLY && (!binReady || FORCE)) {
      await installBinary()
    } else if (!MODEL_ONLY) {
      log(`二进制已存在，跳过: ${serverExe}（--force 可重编）`)
    }
    if (!BIN_ONLY && (!modelReady || FORCE)) {
      await downloadAny(MODEL_URLS, modelPath, MODEL_BYTES)
      log('模型安装完成')
    } else if (!BIN_ONLY) {
      log(`模型已存在，跳过: ${modelPath}`)
    }
    log('\n全部就绪。可用 prism doctor 检查；检索将自动使用向量混合排序。')
  } catch (error) {
    process.stderr.write(`[embedding-setup] 失败: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

await main()
