/**
 * 本地向量化服务（变更 2，2026-09-10 用户裁决：Prism 自理 embedding，不依赖宿主）。
 *
 * 形态：GGUF 模型经 llama.cpp 的 llama-server 常驻进程提供 `/embedding` HTTP 端点——
 * 模型加载一次，之后单条 embedding 毫秒级；比每次 spawn 加载模型快几个数量级。
 *
 * **分档**（2026-09-10 追加）：按算力自动选模型——无 GPU 用轻量 `small`（CPU 友好），
 * 有 GPU 用更强的 `large`；`default` 为多语言基线。可用 env `PRISM_EMBEDDING_MODEL`
 * 或 prism.yaml `embedding_model` 覆盖。见 embedding-models.ts。
 *
 * 生命周期：**按需启动 + 跨进程复用**——端口被占用即复用现存实例（CLI 每个命令是
 * 新进程，detached 启动保证 server 不随命令退出）；PID 落盘供 `prism embedding stop`。
 *
 * 未安装（setup-embedding 未跑）时降级：所有调用返回 unavailable，检索回落纯 BM25，
 * 不炸、不阻塞落库。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { repoRoot } from '@prism/core'

import {
  EMBEDDING_MODELS,
  EMBEDDING_TIERS,
  RERANK_MODELS,
  RERANK_TIERS,
  resolveRerankTier,
  resolveTier,
  type EmbeddingModelDef,
  type EmbeddingTier,
  type RerankModelDef,
  type RerankTier,
} from './embedding-models.js'

/** vendored 布局（scripts/setup-embedding.mjs 安装目标）。 */
/** 源码是 submodule（3rd/llama.cpp）；构建产物与模型在 Prism 自有的 3rd/llama-runtime/。 */
/** 发行根经 `repoRoot` 向上查找（兼容 packages/ 与 node_modules/@prism/ 两种布局）。 */
const RUNTIME_DIR = join(repoRoot(import.meta.url, 8) ?? fileURLToPath(new URL('../../../../', import.meta.url)), '3rd', 'llama-runtime')
const MODELS_DIR = join(RUNTIME_DIR, 'models')
const PID_FILE = join(RUNTIME_DIR, 'llama-server.pid')

/** llama-server 子进程输出 + 启动记录的落点（排障用）。 */
const SERVER_LOG = join(RUNTIME_DIR, 'llama-server.log')
/** 日志上限：超过就截断（只保留最近一次启动的记录，避免长期累积）。 */
const SERVER_LOG_MAX = 2 * 1024 * 1024

/** 追加一行启动记录到指定日志（写不了就静默——日志失败不该影响检索）。 */
function appendLogAt(logFile: string, message: string): void {
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
  } catch {
    // 只读文件系统等场合忽略
  }
}

/** 追加一行启动记录（写不了就静默——日志失败不该影响检索）。 */
function appendServerLog(message: string): void {
  appendLogAt(SERVER_LOG, message)
}

/**
 * 子进程 stdio：**把 llama-server 的输出落盘**，不再 `'ignore'`。
 *
 * 为什么必须留：曾经丢弃子进程全部输出，于是「启动超时」在用户侧只表现为
 * 「模型未就绪（档位模型缺失？跑 prism embedding install）」——**连日志都没有**，
 * 排查只能靠猜（2026-09-12 实测：冷启动两次各卡满 60s 后失败、第三次秒成，
 * 而失败那两次的子进程为何没起来，因输出被丢弃已无从复原）。
 * 落盘失败时退回 `'ignore'`。
 */
function openLogAt(logFile: string): { stdio: 'ignore' | ['ignore', number, number]; close: () => void } {
  try {
    try {
      if (statSync(logFile).size > SERVER_LOG_MAX) writeFileSync(logFile, '', 'utf-8')
    } catch {
      // 文件不存在等 → 不用截断
    }
    const fd = openSync(logFile, 'a')
    return {
      stdio: ['ignore', fd, fd],
      close: () => {
        try {
          closeSync(fd)
        } catch {
          // 已关闭
        }
      },
    }
  } catch {
    return { stdio: 'ignore', close: () => {} }
  }
}

/** embedding 实例的日志 stdio（rerank 第二实例复用 `openLogAt`，见文件末）。 */
function openServerLog(): { stdio: 'ignore' | ['ignore', number, number]; close: () => void } {
  return openLogAt(SERVER_LOG)
}

/**
 * llama.cpp 产物名（**跨平台**，2026-09-12 双平台支持）：Windows 带 `.exe`，macOS / Linux 无扩展名。
 *
 * 早先这里与 GPU 目录都写死 `llama-server.exe` + `bin-vulkan`，于是 macOS 上
 * `embeddingInstalled()` **恒为 false**——向量检索静默降级成纯 BM25，不报错、不阻塞，
 * 属于最难发现的一类跨平台缺陷（`prism doctor` 也只会说「未安装（可选）」）。
 */
const SERVER_BIN = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

const IS_WINDOWS = process.platform === 'win32'
const IS_MACOS = process.platform === 'darwin'

/**
 * 加速后端候选目录（按平台；存在即用，优先于 CPU——CPU 推理慢一个数量级）：
 * - Windows：`bin-vulkan`（官方预编译 Vulkan 包，NVIDIA/AMD/Intel 通用，免 CUDA SDK）
 * - macOS：`bin`（Metal 若编进去了就在这个目录，不另立子目录）
 * - Linux：`bin-cuda`（装了 CUDA SDK）→ `bin-vulkan`
 *
 * ⚠ 「macOS → bin」只说**去哪个目录找**，不说明那里一定带 Metal：见 `accelBackend()`。
 */
const GPU_DIRS = IS_WINDOWS ? ['bin-vulkan'] : IS_MACOS ? ['bin'] : ['bin-cuda', 'bin-vulkan']

const CPU_SERVER_EXE = join(RUNTIME_DIR, 'bin', SERVER_BIN)

/** 当前平台的 GPU 二进制候选路径（按优先级；无论是否已安装）。 */
export function gpuServerCandidates(): string[] {
  return GPU_DIRS.map((dir) => join(RUNTIME_DIR, dir, SERVER_BIN))
}

/** 实际已安装的 GPU 二进制路径（都没装 → null）。 */
function gpuServerExe(): string | null {
  return gpuServerCandidates().find((candidate) => existsSync(candidate)) ?? null
}

/** 加速后端名。 */
export type AccelBackend = 'metal' | 'cuda' | 'vulkan'

/**
 * macOS 上 Metal 是否真在**已安装的运行时**里。
 *
 * **判定依据必须是「装了什么」，不能是「是什么平台」**：上游 `release.yml`（tag b10883）
 * 对 macOS 两个构建的开关本就不同——
 *
 *   | 构建                  | defines                              | 包内是否有 Metal |
 *   | :-------------------- | :----------------------------------- | :--------------- |
 *   | arm64（macos-26）     | `-DGGML_METAL_EMBED_LIBRARY=ON`      | 有 `libggml-metal.*.dylib` |
 *   | x64（macos-15-intel） | `-DGGML_METAL=OFF`                   | **没有**         |
 *
 * 上游 x64 关 Metal 的原文注释：
 * `Metal is disabled on x64 due to intermittent failures with Github runners not having a GPU`。
 *
 * 2026-09-12 实测（Intel Mac / x64 / b10883）：x64 包内无 `libggml-metal*`，全部二进制
 * 不含 `ggml_metal` 符号，`llama-server` 只链 `CoreFoundation` + `libggml-blas`；而 arm64
 * 包内有 `libggml-metal.0.23.0.dylib`（1795 个 metal 符号）。
 * 注意**机器硬件**照样报 `Metal Support: Metal 3`（`system_profiler`），所以任何「看硬件」
 * 或「看平台」的判定都会得到假阳性——Intel Mac 上会谎报 Metal。
 *
 * 按 dylib 是否存在判定，对三种情形同时成立：预编译 arm64（有）、预编译 x64（无）、
 * 源码编译（跟随 cmake 的 `-DGGML_METAL`）。探测不到的场合用 `PRISM_EMBEDDING_BACKEND`
 * 显式声明。
 */
function metalDylibPresent(): boolean {
  try {
    return readdirSync(join(RUNTIME_DIR, 'bin')).some((f) => /^libggml-metal.*\.dylib$/.test(f))
  } catch {
    return false
  }
}

/**
 * 加速后端探测输入（抽成参数，使判定表可在**任一平台**上被测全，见
 * `packages/server/test/embedding-platform.test.ts`）。与
 * `graphify.ts::resolvePythonCommand(env)` 同一手法：把决策从环境里取出来做纯函数。
 */
export interface AccelProbe {
  platform: NodeJS.Platform
  /** `bin/` 下是否存在 `libggml-metal*.dylib`（macOS 的 Metal 后端随包分发） */
  hasMetalDylib: boolean
  /** `bin-vulkan/llama-server` 是否存在 */
  hasVulkanBin: boolean
  /** `bin-cuda/llama-server` 是否存在 */
  hasCudaBin: boolean
}

/**
 * 加速后端判定表（**纯函数**：同一输入恒得同一结果）。
 *
 * macOS 分支只看 `hasMetalDylib`、**不看是不是 darwin**——上游 x64 预编译包显式
 * `-DGGML_METAL=OFF`，光看平台会把 Intel Mac 判成 Metal（见 `metalDylibPresent`）。
 */
export function resolveAccelBackend(probe: AccelProbe): AccelBackend | null {
  if (probe.platform === 'win32') return probe.hasVulkanBin ? 'vulkan' : null
  if (probe.platform === 'darwin') return probe.hasMetalDylib ? 'metal' : null
  if (probe.hasCudaBin) return 'cuda'
  return probe.hasVulkanBin ? 'vulkan' : null
}

/**
 * 本机实际可用的加速后端（无 → null）。**全仓唯一的加速后端判定点**。
 *
 * `PRISM_EMBEDDING_BACKEND` 可显式覆盖：`metal` / `cuda` / `vulkan` 强制指定，
 * `cpu`（亦认 `none` / `off`）强制走 CPU——用于「Intel Mac 上源码编译开了 Metal」
 * 这类自动探测覆盖不到的场合。
 */
export function accelBackend(): AccelBackend | null {
  const override = (process.env['PRISM_EMBEDDING_BACKEND'] ?? '').trim().toLowerCase()
  if (override === 'cpu' || override === 'none' || override === 'off') return null
  if (override === 'metal' || override === 'cuda' || override === 'vulkan') return override

  return resolveAccelBackend({
    platform: process.platform,
    hasMetalDylib: IS_MACOS ? metalDylibPresent() : false,
    hasVulkanBin: existsSync(join(RUNTIME_DIR, 'bin-vulkan', SERVER_BIN)),
    hasCudaBin: existsSync(join(RUNTIME_DIR, 'bin-cuda', SERVER_BIN)),
  })
}

/** 推理后端。 */
export type EmbeddingBackend = 'gpu' | 'cpu'

/** 优先后端：有可用加速后端就走 GPU，否则 CPU。 */
export function preferredBackend(): EmbeddingBackend {
  return accelBackend() !== null ? 'gpu' : 'cpu'
}

const ACCEL_LABELS: Record<AccelBackend, string> = { metal: 'Metal', cuda: 'CUDA', vulkan: 'Vulkan' }

/**
 * 加速后端展示名（`prism doctor` / `prism embedding` 用）。
 *
 * 返回**实际探测到的**后端；未探测到加速后端时返回 `null`（调用方据此走 CPU 文案）。
 * 早先这里在 macOS 上恒返回 `'Metal'`，Intel Mac 上因此谎报后端。
 */
export function gpuBackendLabel(): string | null {
  const accel = accelBackend()
  return accel === null ? null : ACCEL_LABELS[accel]
}

/**
 * 走 CPU 时给用户的补充说明（`prism doctor` 的 embedding 行）。
 *
 * 平台差异在此**一次性**判定，CLI 侧不再自己判平台（见
 * `doc/requirements/cross-platform.md` §3「唯一真相源」）。Intel Mac 上「装个 GPU 包」
 * 无从装起——上游 x64 预编译包就没编 Metal（见 `metalDylibPresent`），只能换 Apple
 * Silicon 机器，或源码编译（`pnpm run 3rd:setup -- --source`）。
 */
export function cpuBackendHint(): string {
  if (IS_MACOS && process.arch !== 'arm64') {
    return '（上游 x64 预编译包不含 Metal；Intel Mac 想要加速需源码编译）'
  }
  return '（较慢，建议有显卡时装 GPU 包）'
}

function serverExeFor(backend: EmbeddingBackend): string {
  if (backend === 'gpu') {
    const exe = gpuServerExe()
    if (exe !== null) return exe
  }
  return CPU_SERVER_EXE
}

function modelPathOf(def: EmbeddingModelDef): string {
  return join(MODELS_DIR, def.file)
}

/** 显式覆盖的档位（env > setter；null = 未指定，走自动）。 */
let overrideTier: EmbeddingTier | null | undefined

/** 由组合根（读 prism.yaml 后）设置；传 undefined/null 清除覆盖。 */
export function setEmbeddingTier(tier: string | undefined): void {
  overrideTier = tier === undefined ? null : resolveTier(tier)
}

/** env 指定的档位（优先于 setter）。 */
function envTier(): EmbeddingTier | null {
  return resolveTier(process.env['PRISM_EMBEDDING_MODEL'])
}

/**
 * 自动选档：有 GPU → 强档优先；无 GPU → 轻量档优先。**逐档回退到「已安装」的**，
 * 避免「选了档却没下模型」直接不可用。
 */
function autoTier(): EmbeddingTier {
  const order: EmbeddingTier[] =
    preferredBackend() === 'gpu' ? ['large', 'default', 'small'] : ['small', 'default']
  for (const tier of order) {
    if (existsSync(modelPathOf(EMBEDDING_MODELS[tier]))) return tier
  }
  return order[0]!
}

/** 当前生效档位：env > 显式 setter > 自动。 */
export function activeTier(): EmbeddingTier {
  return envTier() ?? overrideTier ?? autoTier()
}

/** 当前生效模型定义。 */
export function activeModel(): EmbeddingModelDef {
  return EMBEDDING_MODELS[activeTier()]
}

/** 默认端口（可被 PRISM_EMBEDDING_PORT 覆盖）。 */
export const EMBEDDING_PORT = Number(process.env['PRISM_EMBEDDING_PORT'] ?? 8191)
const BASE = `http://127.0.0.1:${EMBEDDING_PORT}`
/** 启动等待上限（模型加载 ~10s，留余量）。 */
const START_TIMEOUT_MS = 60_000

/**
 * 批大小缺省值（v17 §B-5，扁平键 `embed_batch`）。
 *
 * **为什么是 8 而非 SPEC 旧值 16**（`v17-recon-embed.md` §4①，队长口径覆盖 spec）：
 * GPU 实测「批 4（1.18×）稳定快于批 16（1.12×）」，主表与冷语料对照组**两次复现**；
 * 批 8 处于两者之间（1.14×）而单请求响应体更小。绝对差约 5%——是优化不是纠错，
 * 故取 4–8 区间的 8 作缺省。**单一真相源在此**（wiring 侧 re-export，勿另立默认）。
 */
export const DEFAULT_EMBED_BATCH = 8

/**
 * @deprecated 用 `activeModel().dim`（分档后维度随模型变）。保留仅为兼容旧引用。
 */
export const EMBEDDING_DIM = EMBEDDING_MODELS.default.dim

/**
 * @deprecated 用 `activeModel().ctx`（分档后上下文随模型变）。保留仅为兼容旧引用。
 */
export const EMBEDDING_CTX = EMBEDDING_MODELS.default.ctx

/** 安装是否就绪（二进制 + **任一档**模型在）。`PRISM_EMBEDDING=off` 时一律视为未就绪（降级纯 BM25）。 */
export function embeddingInstalled(): boolean {
  if (embeddingDisabled()) return false
  if (gpuServerExe() === null && !existsSync(CPU_SERVER_EXE)) return false
  return EMBEDDING_TIERS.some((t) => existsSync(modelPathOf(EMBEDDING_MODELS[t])))
}

/**
 * 全局降级开关：`PRISM_EMBEDDING=off` 强制纯 BM25。
 * 用于确定性测试（向量召回会扩大命中面，破坏精确计数断言）与排障对照。
 */
function embeddingDisabled(): boolean {
  const v = process.env['PRISM_EMBEDDING']
  return v === 'off' || v === '0' || v === 'false'
}

/** PID 文件内容（记录后端 + 模型，供「换了后端/模型就平滑切换」判断）。 */
interface ServerHandle {
  pid: number
  backend: EmbeddingBackend
  model: string
}

function readHandleAt(pidFile: string): ServerHandle | null {
  try {
    const text = readFileSync(pidFile, 'utf-8').trim()
    if (text === '') return null
    if (text.startsWith('{')) {
      const obj = JSON.parse(text) as { pid?: unknown; backend?: unknown; model?: unknown }
      if (typeof obj.pid === 'number') {
        return {
          pid: obj.pid,
          backend: obj.backend === 'gpu' ? 'gpu' : 'cpu',
          model: typeof obj.model === 'string' ? obj.model : '',
        }
      }
      return null
    }
    // 兼容旧格式（纯 pid）
    const pid = Number(text)
    return Number.isFinite(pid) ? { pid, backend: 'cpu', model: '' } : null
  } catch {
    return null
  }
}

function readHandle(): ServerHandle | null {
  return readHandleAt(PID_FILE)
}

/** 停掉某个实例（PID 文件记录的进程）+ 清 PID/锁文件。返回是否有进程被停。 */
function stopServerAt(pidFile: string, lockFile: string): boolean {
  let stopped = false
  const handle = readHandleAt(pidFile)
  if (handle !== null) {
    try {
      process.kill(handle.pid)
      stopped = true
    } catch {
      // 进程可能已退出
    }
  }
  try {
    rmSync(pidFile, { force: true })
    rmSync(lockFile, { force: true })
  } catch {
    // 忽略
  }
  return stopped
}

/**
 * 停止常驻 embedding server（PID 文件记录的进程）。返回是否有进程被停。
 *
 * 只动 embedding 自己的 PID/锁——**不连坐 rerank 实例**（两者档位独立判定，
 * SPEC-1.5）；要一起停由调用方分别调 `stopRerankServer()`。
 */
export function stopEmbeddingServer(): boolean {
  return stopServerAt(PID_FILE, LOCK_FILE)
}

/** 端口健康检查（禁代理：127.0.0.1 不能走系统代理）。 */
async function isAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/** 等待健康（轮询）。 */
async function waitAlive(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isAlive()) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

let starting: Promise<boolean> | undefined

/**
 * 确保已就绪并运行；失败（含未安装）返回 false。
 *
 * 跨进程并发：CLI 每条命令是一个新进程，可能同时发现「端口未监听」而各起一个
 * server（后起的会因端口占用而退出，留下孤儿/占位）。用**独占锁文件**
 * （`wx` 创建）串行化启动：抢到锁的进程负责拉起，其余进程等健康检查即可。
 */
export function ensureEmbeddingServer(): Promise<boolean> {
  if (starting === undefined) {
    starting = (async () => {
      const backend = preferredBackend()
      const def = activeModel()
      if (await isAlive()) {
        // 后端或模型升级（如装了 GPU 包、或换了档位）→ 平滑切换：停旧起新
        const handle = readHandle()
        const sameBackend = handle !== null && handle.backend === backend
        const sameModel = handle !== null && handle.model === def.id
        if (handle !== null && (!sameBackend || !sameModel)) {
          stopEmbeddingServer()
          await new Promise((r) => setTimeout(r, 1000))
        } else {
          return true
        }
      }
      if (!embeddingInstalled() || !existsSync(modelPathOf(def))) return false
      const acquired = tryAcquireStartLock()
      if (!acquired) {
        // 别的进程正在拉；等它起来即可（不重复 spawn）
        const ok = await waitAlive(START_TIMEOUT_MS)
        if (!ok) starting = undefined
        return ok
      }
      try {
        // 再查一次（抢锁期间可能已被他人拉起）
        if (await isAlive()) return true
        // -c/-b/--ubatch-size 统一为模型 ctx：默认 -b 2048 会让约 1000 字输入直接 500
        // （见 embedding-models.ts 各档 ctx），须装得下单条最长输入。
        // GPU（Vulkan）后端额外 -ngl 99：全部层卸载到显卡。
        // causal 模型（Qwen3）需显式 --pooling last，否则池化方式不对。
        const argv = [
          '-m', modelPathOf(def),
          '--embedding',
          '--host', '127.0.0.1',
          '--port', String(EMBEDDING_PORT),
          '-c', String(def.ctx),
          '-b', String(def.ctx),
          '--ubatch-size', String(def.ctx),
          ...(def.pooling !== undefined ? ['--pooling', def.pooling] : []),
          ...(backend === 'gpu' ? ['-ngl', '99'] : []),
        ]
        const log = openServerLog()
        const child = spawn(serverExeFor(backend), argv, {
          detached: true,
          stdio: log.stdio,
          windowsHide: true,
        })
        log.close()
        child.unref()
        try {
          writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, backend, model: def.id }), 'utf-8')
        } catch {
          // PID 记录失败不影响运行
        }
        appendServerLog(`spawn pid=${child.pid} backend=${backend} model=${def.id}\n  argv: ${argv.join(' ')}`)
        const ok = await waitAlive(START_TIMEOUT_MS)
        if (!ok) {
          // 不静默：失败要留下可查的线索，否则用户只见「模型未就绪」，无从查起
          appendServerLog(`启动失败：${START_TIMEOUT_MS}ms 内 /health 未就绪（详见本文件上部子进程输出）`)
          starting = undefined // 允许下次重试
        }
        return ok
      } finally {
        releaseStartLock()
      }
    })()
  }
  return starting
}

/** 启动锁：`<dir>/llama-server.lock`（独占创建；陈旧锁自动接管）。 */
const LOCK_FILE = join(RUNTIME_DIR, 'llama-server.lock')
/**
 * 陈旧锁的接管阈值——**必须与 `START_TIMEOUT_MS` 配套**：持锁者最多等
 * `START_TIMEOUT_MS`（60s）就放弃并释放锁，所以比它更旧的锁一定是崩溃/被杀留下的残骸。
 *
 * 早先写死 120s（> 60s），于是残骸会让后续调用**各白等满 60s**：2026-09-12 实测两次
 * 连续冷启动就这么被拖成 2 分钟（第三次锁够旧才接管成功）。取 `START_TIMEOUT_MS + 30s`
 * 既留余量不误抢仍在等待的持锁者，又能在 90s 内接管残骸。
 */
const LOCK_STALE_MS = START_TIMEOUT_MS + 30_000

function tryAcquireLockAt(lockFile: string): boolean {
  try {
    writeFileSync(lockFile, String(process.pid), { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch {
    // 已存在：若是陈旧锁（上次启动中途崩溃），接管
    try {
      const age = Date.now() - statSync(lockFile).mtimeMs
      if (age > LOCK_STALE_MS) {
        writeFileSync(lockFile, String(process.pid), 'utf-8')
        return true
      }
    } catch {
      // stat 失败视为不可用
    }
    return false
  }
}

function tryAcquireStartLock(): boolean {
  return tryAcquireLockAt(LOCK_FILE)
}

function releaseLockAt(lockFile: string): void {
  try {
    rmSync(lockFile, { force: true })
  } catch {
    // 忽略
  }
}

function releaseStartLock(): void {
  releaseLockAt(LOCK_FILE)
}

export interface EmbedText {
  ok: boolean
  vector?: Float32Array
  error?: string
}

/**
 * 可注入的 fetch（**测试缝**，同 rerank 的 `setRerankFetch`）：注入后 `embedOnce` /
 * `embedBatchOnce` 都不碰真实端点、不起子进程。生产缺省走全局 fetch。
 */
export type EmbeddingFetch = (input: string, init?: RequestInit) => Promise<Response>

let embeddingFetch: EmbeddingFetch | undefined

/** 注入/清除 embedding 的 fetch（传 null 恢复全局 fetch）。 */
export function setEmbeddingFetch(impl: EmbeddingFetch | null): void {
  embeddingFetch = impl ?? undefined
}

function activeEmbeddingFetch(): EmbeddingFetch {
  return embeddingFetch ?? ((input, init) => fetch(input, init))
}

/**
 * 「输入超上下文」类错误判据（`embedText` 自适应减半重试的开关）。
 *
 * 真实文案（B-R 实测 llama-server b10883，HTTP 400）：
 * `{"error":{"message":"request (5768 tokens) exceeds the available context size (2048 tokens),
 *  try increasing it","type":"exceed_context_size_error",...}}`。
 *
 * 早先判据是 `/too large|batch/i`——**不命中**该文案（B-R 实测 `false`），于是「逐次减半
 * 重试」是死代码（潜伏缺陷：正常路径 1500 字 < ctx 触发不到，但超长段会直接 `ok:false`）。
 * 这里补上真实形态；保留 `too large|batch` 兼容旧构建的其他文案。
 */
function isOverContextError(message: string): boolean {
  return /too large|batch|exceeds the available context size|exceed_context_size/i.test(message)
}

/**
 * 发一次 /embedding；返回 200 的向量或错误信号。**维度由调用方校验**（随模型档位变）。
 */
async function embedOnce(
  input: string,
): Promise<{ ok: true; vector: number[] } | { ok: false; status: number; message: string }> {
  const res = await activeEmbeddingFetch()(`${BASE}/embedding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const message = (await res.text().catch(() => '')).slice(0, 200)
    return { ok: false, status: res.status, message }
  }
  const data = (await res.json()) as unknown
  // 响应兼容两种形态：{"embedding":[...]} 与批量 [{"index":0,"embedding":[[...]]}]
  let vec: number[] | undefined
  if (Array.isArray(data)) {
    const first = data[0] as { embedding: number[] | number[][] } | undefined
    const e = first?.embedding
    vec = Array.isArray(e?.[0]) ? (e as number[][])[0] : (e as number[] | undefined)
  } else if (typeof data === 'object' && data !== null) {
    const e = (data as { embedding: number[] | number[][] }).embedding
    vec = Array.isArray(e?.[0]) ? (e as number[][])[0] : (e as number[] | undefined)
  }
  if (vec === undefined) return { ok: false, status: 0, message: '响应缺 embedding 字段' }
  return { ok: true, vector: vec }
}

/**
 * 批请求客户端超时（v17 §B-5，B-R 回填公式）：
 * `clamp(3000 + 800 × n, 5000, 120000)` ms。
 *
 * 依据（`v17-recon-embed.md` §4③）：单段最坏计算量 ~210 ms（1500 字 ≈ 1092 tok × 0.19 ms/tok），
 * `800 ms/段` 是它的 ~3.8×（覆盖宿主负载/热降频/并发检索抢占）；`3000 ms` 基座覆盖冷启动
 * 实测 1216 ms + 大响应体（批 16 ≈ 350 KB JSON）+ 队列余量。n=16 → 15.8 s（实测典型 1.84 s
 * 的 8.6×）。**单口维持现状 120 s 不动**。
 */
export function batchTimeoutMs(n: number): number {
  const size = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  return Math.min(120_000, Math.max(5_000, 3_000 + 800 * size))
}

/**
 * 一次 `/embedding {input: string[]}`（批量形态实测：顶层数组、元素带 `index`、按序返回）。
 * 返回**按 `index` 回填后与入参同序**的向量数组（未拿到向量的位为 `null`）；
 * 整请求非 200 / 响应形态不符 → 返回 `null`（由调用方决定「全部逐条重试」）。
 */
async function embedBatchOnce(
  inputs: readonly string[],
  timeoutMs: number,
): Promise<Array<number[] | null> | null> {
  const res = await activeEmbeddingFetch()(`${BASE}/embedding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: inputs }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) return null
  const data = (await res.json()) as unknown
  if (!Array.isArray(data)) return null
  const out: Array<number[] | null> = inputs.map(() => null)
  for (const el of data) {
    if (typeof el !== 'object' || el === null) continue
    const rec = el as { index?: unknown; embedding?: number[] | number[][] }
    const index = typeof rec.index === 'number' && Number.isInteger(rec.index) ? rec.index : null
    const e = rec.embedding
    const vec = Array.isArray(e?.[0]) ? (e as number[][])[0] : (e as number[] | undefined)
    if (index === null || index < 0 || index >= out.length || !Array.isArray(vec)) continue
    out[index] = vec
  }
  return out
}

/**
 * 单条嵌入的**核心**（守卫之后）：先按档位上限截断发一次，超 ctx 类错误则逐次减半重试，
 * 最后校验维度。返回向量或错误串（`embedText` 与批口逐条回落共用，避免两处口径漂移）。
 */
async function embedSingleCore(
  text: string,
  def: EmbeddingModelDef,
): Promise<{ ok: true; vector: Float32Array } | { ok: false; error: string }> {
  let limit = Math.min(text.length, def.maxChars)
  let lastError = 'unknown'
  for (let attempt = 0; attempt < 5 && limit > 0; attempt++) {
    const result = await embedOnce(text.slice(0, limit))
    if (result.ok) {
      if (result.vector.length !== def.dim) {
        return { ok: false, error: `embedding 维度异常（${result.vector.length} ≠ ${def.dim}，档位 ${def.tier}）` }
      }
      return { ok: true, vector: Float32Array.from(result.vector) }
    }
    lastError = result.message || `HTTP ${result.status}`
    // 只对「输入过大」类错误重试；其它错误（如 400 参数错）无意义
    if (!isOverContextError(lastError)) break
    limit = Math.floor(limit / 2)
  }
  return { ok: false, error: lastError }
}

/**
 * **纯调用层**：批量嵌入（不判门控、不拉服务——范本 `callRerank`，测试缝在此）。
 *
 * 契约（v17 §B-5，队长口径）：
 * - 按 `batchSize` 切批，每批一次 `/embedding input: string[]`；**结果与入参等长且同序**；
 * - 任一整批失败（llama-server 任一段超 ctx → 整请求 400、错误体无段序号）→ **该批全部
 *   逐条重试**（一轮，不递归；最坏 1+n 次请求——设计声明接受）；单条仍败 → 该位 `null`；
 * - 逐条回落到 `embedSingleCore`（含截断/减半/维度校验），故超长段在单条路可自愈。
 *
 * `def` 缺省取 `activeModel()`（读 env/配置，不碰文件系统与网络）；测试可显式传入。
 */
export async function callEmbedBatch(
  texts: readonly string[],
  batchSize: number,
  def: EmbeddingModelDef = activeModel(),
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return []
  const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : DEFAULT_EMBED_BATCH
  const prepared = texts.map((text) => text.slice(0, def.maxChars))
  const out: (Float32Array | null)[] = []
  for (let i = 0; i < prepared.length; i += size) {
    const batch = prepared.slice(i, i + size)
    let batched: Array<number[] | null> | null
    try {
      batched = await embedBatchOnce(batch, batchTimeoutMs(batch.length))
    } catch {
      batched = null
    }
    if (batched !== null && batched.length === batch.length) {
      for (const vec of batched) {
        if (vec === null || vec.length !== def.dim) {
          out.push(null)
          continue
        }
        out.push(Float32Array.from(vec))
      }
      continue
    }
    // 整批失败 → 该批**全部逐条重试**（只一轮，不递归）
    for (const text of batch) {
      let vec: Float32Array | null = null
      try {
        const single = await embedSingleCore(text, def)
        vec = single.ok ? single.vector : null
      } catch {
        vec = null
      }
      out.push(vec)
    }
  }
  return out
}

/**
 * 批量文本 → 向量数组（**门控 + 委托 `callEmbedBatch`**）。
 *
 * 未安装 / 服务未就绪 → 与单口同口径：**不抛**，全位 `null`（调用方跳过，纯 BM25 降级）。
 * 超时按批大小派生（`batchTimeoutMs`）；批大小缺省 `DEFAULT_EMBED_BATCH`。
 */
export async function embedBatchText(
  texts: readonly string[],
  batchSize: number = DEFAULT_EMBED_BATCH,
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return []
  if (!embeddingInstalled()) return texts.map(() => null)
  if (!(await ensureEmbeddingServer())) return texts.map(() => null)
  return callEmbedBatch(texts, batchSize)
}

/**
 * 单条文本 → 向量。**未安装/启动失败返回 ok:false**（调用方降级，不抛）。
 *
 * 长度上限取自当前档位模型定义（`activeModel().maxChars`）：CPU 档小、GPU 档大，
 * 各按自己的算力取「够用且不拖垮推理槽」的值。
 *
 * 自适应长度：先按上限截断发一次；若服务端仍报「输入超上下文」（`exceeds the available
 * context size`——B-R 实测的真实文案，判据见 `isOverContextError`），**逐次减半重试**，
 * 绝不因超长硬失败——宁可嵌入前半段文本，也不让整条知识缺向量。
 */
export async function embedText(text: string): Promise<EmbedText> {
  if (!embeddingInstalled()) {
    return { ok: false, error: 'embedding 未安装（跑 node scripts/setup-embedding.mjs）' }
  }
  if (!(await ensureEmbeddingServer())) {
    // 走到这里「未安装」已被上面挡掉，所以只可能是：档位模型缺失，或 llama-server 没起来。
    // 别再说成「模型未就绪」——模型明明在的时候这句话会把排查带偏（2026-09-12 实测踩到）。
    return {
      ok: false,
      error: `embedding 服务未就绪（档位模型缺失，或 llama-server 未能启动；日志：${SERVER_LOG}）`,
    }
  }
  try {
    const result = await embedSingleCore(text, activeModel())
    return result.ok ? { ok: true, vector: result.vector } : { ok: false, error: result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 余弦相似度（向量应已归一化，但 BGE 输出未必严格单位长——显式归一）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Float32Array → BLOB（SQLite 存储）。 */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

/** BLOB → Float32Array。 */
export function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  const copy = new Float32Array(blob.byteLength / 4)
  new Uint8Array(copy.buffer).set(blob)
  return copy
}

// ════════════════════════════════════════════════════════════════════════════
// Rerank 第二实例（v14 §1.1 / SPEC-1.1–1.7；M1 实例架构 / M2 档位超时 / S6 取材）
//
// 为什么要**第二个进程**（M1，vendored @91f6a6cf3 证伪「同进程加载」）：
//   ① llama-server 经 `-m` 只装一个 GGUF，embedding 与 reranker 是两个不同文件；
//   ② `--rerank` 会把实例池化全局改成 RANK（`common/arg.cpp:3471-3476`：
//      `params.embedding = true; params.pooling_type = LLAMA_POOLING_TYPE_RANK`），
//      同实例下 `/embedding` 吐的是一维 rerank 分而非语义向量——现有 dim 校验必败。
//      故 rerank argv **只带 `--rerank`**，不带 `--embedding`、不带 `--pooling`。
//   ③ `/rerank` 自身要求 `embedding && pooling == RANK`（`server-context.cpp:5149`）——
//      由 `--rerank` 自行满足，无需也不可显式再传。
//
// 生命周期整套镜像 embedding（独立端口 / PID / 启动锁 / 日志落盘 / 健康检查），
// 但**档位独立判定**：embedding 换档或停服都不连坐 rerank（SPEC-1.5）。
// ════════════════════════════════════════════════════════════════════════════

/** rerank 第二实例端口（可被 PRISM_RERANK_PORT 覆盖；与 embedding 8191 隔开）。 */
export const RERANK_PORT = Number(process.env['PRISM_RERANK_PORT'] ?? 8192)
const RERANK_BASE = `http://127.0.0.1:${RERANK_PORT}`

/** rerank 实例的独立落点（PID / 锁 / 日志）——与 embedding 三件套互不覆盖。 */
const RERANK_PID_FILE = join(RUNTIME_DIR, 'llama-rerank-server.pid')
const RERANK_LOCK_FILE = join(RUNTIME_DIR, 'llama-rerank-server.lock')
const RERANK_LOG = join(RUNTIME_DIR, 'llama-rerank-server.log')

function rerankModelPathOf(def: RerankModelDef): string {
  return join(MODELS_DIR, def.file)
}

/**
 * rerank 实例的三个落点（PID / 启动锁 / 日志）——**诊断与测试用**：三者与 embedding 的
 * 同名文件互不覆盖（`llama-rerank-server.*` vs `llama-server.*`），这是「两实例互不影响」
 * 的物理前提。
 */
export function rerankPaths(): { pid: string; lock: string; log: string } {
  return { pid: RERANK_PID_FILE, lock: RERANK_LOCK_FILE, log: RERANK_LOG }
}

/** 显式覆盖的 rerank 档位（env > setter；null = 未指定，走自动）。 */
let overrideRerankTier: RerankTier | null | undefined

/** 由组合根（读 prism.yaml 的 rerank_model 后）设置；传 undefined/null 清除覆盖。 */
export function setRerankTier(tier: string | undefined): void {
  overrideRerankTier = tier === undefined ? null : resolveRerankTier(tier)
}

/** env 指定的 rerank 档位（优先于 setter）。 */
function envRerankTier(): RerankTier | null {
  return resolveRerankTier(process.env['PRISM_RERANK_MODEL'])
}

/**
 * 自动选 rerank 档：**复用 `preferredBackend()`（其唯一真相源是 `accelBackend()`）**，
 * 不新写平台判断（AGENTS.md §3.4）。逐档回退到「已安装的」模型，避免「选了档却没下模型」
 * 直接不可用——与 embedding 的 `autoTier()` 同一手法。
 */
function autoRerankTier(): RerankTier {
  const order: RerankTier[] = preferredBackend() === 'gpu' ? ['gpu', 'cpu'] : ['cpu', 'gpu']
  for (const tier of order) {
    if (existsSync(rerankModelPathOf(RERANK_MODELS[tier]))) return tier
  }
  return order[0]!
}

/** 当前生效 rerank 档位：env > 显式 setter > 自动。 */
export function activeRerankTier(): RerankTier {
  return envRerankTier() ?? overrideRerankTier ?? autoRerankTier()
}

/** 当前生效 rerank 模型定义。 */
export function activeRerankModel(): RerankModelDef {
  return RERANK_MODELS[activeRerankTier()]
}

/**
 * rerank 全局降级开关：`PRISM_RERANK=off` 强制不发请求。
 * 与 `PRISM_EMBEDDING=off` 同形（确定性测试与排障对照；**不**与 embedding 开关联动）。
 */
function rerankDisabled(): boolean {
  const v = process.env['PRISM_RERANK']
  return v === 'off' || v === '0' || v === 'false'
}

/**
 * rerank 独立门控（SPEC-1.5 / M1）：**二进制 + rerank 档模型**。
 *
 * 不复用 `embeddingInstalled()`——它只查 embedding 三档模型，对 rerank 模型一无所知；
 * 反过来 embedding 未装也不该挡住 rerank（两实例互不影响）。
 */
export function rerankInstalled(): boolean {
  if (rerankDisabled()) return false
  if (gpuServerExe() === null && !existsSync(CPU_SERVER_EXE)) return false
  return RERANK_TIERS.some((tier) => existsSync(rerankModelPathOf(RERANK_MODELS[tier])))
}

/**
 * rerank 实例的 llama-server argv（**纯函数**，供结构断言——M1 的三条约束都在这里）：
 * `--rerank` 存在、**无** `--embedding`、**无** `--pooling`、`-c ≥ 1024`。
 */
export function buildRerankServerArgv(input: {
  modelPath: string
  ctx: number
  gpu: boolean
  port?: number
}): string[] {
  return [
    '-m', input.modelPath,
    '--rerank',
    '--host', '127.0.0.1',
    '--port', String(input.port ?? RERANK_PORT),
    '-c', String(input.ctx),
    '-b', String(input.ctx),
    '--ubatch-size', String(input.ctx),
    // GPU（Vulkan/Metal/CUDA）后端全部层卸载；CPU 档不带 -ngl
    ...(input.gpu ? ['-ngl', '99'] : []),
  ]
}

/**
 * rerank 实例的执行设备判定（**纯函数**——波次 3 检视批队长裁决②的测试缝，与
 * `resolveAccelBackend` 同一手法：把决策从环境里取出来做纯函数，逐分支可测）。
 *
 * 显式 cpu 档 → 恒 CPU（argv 不带 `-ngl 99`，「档位名」与「执行设备」不再脱节——
 * 此前 cpu 档在 GPU 机器上仍被卸载进显存）；gpu 档跟随探测后端（CPU 机器选 gpu 档
 * 自然回落 CPU 执行，`serverExeFor` 兜底不变）。
 */
export function resolveRerankBackend(tier: RerankTier, preferred: EmbeddingBackend): EmbeddingBackend {
  return tier === 'cpu' ? 'cpu' : preferred
}

/** rerank 端点健康检查（禁代理：127.0.0.1 不能走系统代理）。 */
async function isRerankAlive(): Promise<boolean> {
  try {
    const res = await activeRerankFetch()(`${RERANK_BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * rerank 端点是否在运行（**只探不发**——不会拉起子进程）。
 * 给 `prism doctor` / `prism embedding status` 报「端点状态」用：doctor 若按 embedding 的
 * 手法真发一次请求，会在装了 rerank 档的机器上**为自检拉起 438MB 的第二个实例**，
 * 代价与收益不成比例（检索是启动时机的真相）。
 */
export function rerankServerAlive(): Promise<boolean> {
  return isRerankAlive()
}

async function waitRerankAlive(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isRerankAlive()) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

let startingRerank: Promise<boolean> | undefined

/**
 * 确保 rerank 实例已就绪运行；失败（含未安装）返回 false。
 * 启动锁与 embedding 同一手法（跨进程串行化：抢到锁的进程负责 spawn，其余等健康检查）。
 */
export function ensureRerankServer(): Promise<boolean> {
  if (startingRerank === undefined) {
    startingRerank = (async () => {
      // 设备跟随档位（v14 检视批队长裁决②）：显式选 cpu 档 → 纯 CPU（不带 -ngl 99），
      // 「档位名」与「执行设备」不再脱节（此前 cpu 档在 GPU 机器上仍被 -ngl 99 卸载进
      // 显存）；gpu 档仍跟随探测后端（CPU 机器上选 gpu 档自然回落 CPU 执行）。
      // 判定抽成纯函数 `resolveRerankBackend`（逐分支可测，见 kb-rerank.test.ts）。
      const tier = activeRerankTier()
      const backend = resolveRerankBackend(tier, preferredBackend())
      const def = activeRerankModel()
      if (await isRerankAlive()) {
        // 后端或模型变了 → 只重启 rerank 自己（不碰 embedding）
        const handle = readHandleAt(RERANK_PID_FILE)
        const sameBackend = handle !== null && handle.backend === backend
        const sameModel = handle !== null && handle.model === def.id
        if (handle !== null && (!sameBackend || !sameModel)) {
          stopRerankServer()
          await new Promise((r) => setTimeout(r, 1000))
        } else {
          return true
        }
      }
      if (!rerankInstalled() || !existsSync(rerankModelPathOf(def))) return false
      const acquired = tryAcquireLockAt(RERANK_LOCK_FILE)
      if (!acquired) {
        const ok = await waitRerankAlive(START_TIMEOUT_MS)
        if (!ok) startingRerank = undefined
        return ok
      }
      try {
        if (await isRerankAlive()) return true
        const argv = buildRerankServerArgv({
          modelPath: rerankModelPathOf(def),
          ctx: def.ctx,
          gpu: backend === 'gpu',
        })
        const log = openLogAt(RERANK_LOG)
        const child = spawn(serverExeFor(backend), argv, {
          detached: true,
          stdio: log.stdio,
          windowsHide: true,
        })
        log.close()
        child.unref()
        try {
          writeFileSync(RERANK_PID_FILE, JSON.stringify({ pid: child.pid, backend, model: def.id }), 'utf-8')
        } catch {
          // PID 记录失败不影响运行
        }
        appendLogAt(RERANK_LOG, `spawn pid=${child.pid} backend=${backend} model=${def.id}（rerank 第二实例）\n  argv: ${argv.join(' ')}`)
        const ok = await waitRerankAlive(START_TIMEOUT_MS)
        if (!ok) {
          appendLogAt(RERANK_LOG, `启动失败：${START_TIMEOUT_MS}ms 内 /health 未就绪（详见本文件上部子进程输出）`)
          startingRerank = undefined // 允许下次重试
        }
        return ok
      } finally {
        releaseLockAt(RERANK_LOCK_FILE)
      }
    })()
  }
  return startingRerank
}

/**
 * 停止 rerank 实例（只动 rerank 自己的 PID/锁——不连坐 embedding，SPEC-1.5）。
 */
export function stopRerankServer(): boolean {
  return stopServerAt(RERANK_PID_FILE, RERANK_LOCK_FILE)
}

// ── /rerank 调用层 ──────────────────────────────────────────────────────────

/**
 * 可注入的 fetch（**测试四态**用：注入后不碰真实端点、不起子进程）。
 * 生产缺省走全局 fetch。
 */
export type RerankFetch = (input: string, init?: RequestInit) => Promise<Response>

let rerankFetch: RerankFetch | undefined

/** 注入/清除 rerank 的 fetch（传 null 恢复全局 fetch）。 */
export function setRerankFetch(impl: RerankFetch | null): void {
  rerankFetch = impl ?? undefined
}

function activeRerankFetch(): RerankFetch {
  return rerankFetch ?? ((input, init) => fetch(input, init))
}

export type RerankCallResult =
  | { ok: true; scores: number[] }
  | { ok: false; reason: 'timeout' | 'http' | 'parse' | 'network' }

/**
 * 解析 `/rerank` 响应（vendored `server-common.cpp:1451 format_response_rerank` 实查）。
 *
 * Jina 形态：`{model, object, usage, results: [{index, relevance_score}]}`；
 * TEI 形态（请求体带 `texts`）：直接是 `[{index, score}]` 数组——这里两种都认。
 *
 * ⚠ **返回的 results 已按 score 降序排好**（源码里 `std::sort` + `resize(top_n)`），
 * 所以**必须按 `index` 回填**，绝不能按数组位置对应入参顺序——这是最容易写错的一处。
 * 长度/密度不符（缺 index、重复 index、非有限数）→ 返回 null，由调用方静默回落 RRF。
 */
export function parseRerankScores(data: unknown): number[] | null {
  const rawResults = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { results?: unknown }).results)
      ? ((data as { results: unknown[] }).results)
      : null
  if (rawResults === null || rawResults.length === 0) return null
  const byIndex = new Map<number, number>()
  for (const item of rawResults) {
    if (typeof item !== 'object' || item === null) return null
    const rec = item as { index?: unknown; relevance_score?: unknown; score?: unknown }
    const index = typeof rec.index === 'number' && Number.isInteger(rec.index) && rec.index >= 0 ? rec.index : null
    const score = typeof rec.relevance_score === 'number' ? rec.relevance_score : rec.score
    if (index === null || typeof score !== 'number' || !Number.isFinite(score)) return null
    byIndex.set(index, score)
  }
  if (byIndex.size !== rawResults.length) return null
  const scores: number[] = []
  for (let i = 0; i < rawResults.length; i++) {
    const score = byIndex.get(i)
    if (score === undefined) return null
    scores.push(score)
  }
  return scores
}

/**
 * **纯调用层**：POST `/rerank`（`{query, documents}` 数组，一次请求），不判门控、不拉服务。
 *
 * 超时随档走（M2）：`AbortSignal.timeout(timeoutMs)`；超时/网络/HTTP/解析失败统一
 * 归类为 `{ok:false, reason}`——调用方静默回落，不抛。
 */
export async function callRerank(
  query: string,
  docs: readonly string[],
  timeoutMs: number,
): Promise<RerankCallResult> {
  if (docs.length === 0) return { ok: true, scores: [] }
  try {
    const res = await activeRerankFetch()(`${RERANK_BASE}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, documents: docs }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      // 响应体可能很大（服务端错误 JSON），只留 200 字进日志
      const message = await res.text().catch(() => '')
      appendLogAt(RERANK_LOG, `HTTP ${res.status}：${message.slice(0, 200)}`)
      return { ok: false, reason: 'http' }
    }
    const scores = parseRerankScores((await res.json()) as unknown)
    return scores === null ? { ok: false, reason: 'parse' } : { ok: true, scores }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return { ok: false, reason: /timeout|abort/i.test(name) ? 'timeout' : 'network' }
  }
}

/**
 * 按档位预算裁剪候选文档（SPEC-1.2/1.7：`24×512tok` / `10×256tok`）。
 *
 * 客户端不引分词器，故 token 预算按「CJK 1 字符 ≈ 1 token」**保守**折算成字符数
 * （`RerankModelDef.maxDocChars`）——宁可少喂一点，也不要超 ctx 让服务端报错。
 * 纯函数：入参顺序与长度不变，只截字符。
 */
export function boundRerankDocs(docs: readonly string[], maxChars: number): string[] {
  return docs.map((doc) => (doc.length > maxChars ? doc.slice(0, maxChars) : doc))
}

/**
 * 门控 + 调用 + 降级（knowledge 侧注入的就是它）。
 *
 * 返回 `number[]`（**按入参 docs 顺序**，长度 === docs.length）或 `null`；
 * 未装/未就绪/失败/超时一律 `null` → knowledge 侧维持 RRF 序**零痕迹**（SPEC-1.4）。
 * 实际耗时进日志（SPEC-1.4「耗时进日志」）。
 */
export async function rerankText(query: string, docs: readonly string[]): Promise<number[] | null> {
  if (docs.length === 0) return []
  if (!rerankInstalled()) return null
  if (!(await ensureRerankServer())) return null
  const def = activeRerankModel()
  const bounded = boundRerankDocs(docs, def.maxDocChars)
  const started = Date.now()
  const result = await callRerank(query, bounded, def.timeoutMs)
  const elapsed = Date.now() - started
  if (!result.ok) {
    appendLogAt(
      RERANK_LOG,
      `rerank 降级（${result.reason}）：${elapsed}ms 内未获结果（档位 ${def.tier} / 超时 ${def.timeoutMs}ms）→ 维持 RRF 序`,
    )
    return null
  }
  if (result.scores.length !== docs.length) {
    appendLogAt(RERANK_LOG, `rerank 降级（parse）：返回 ${result.scores.length} 个分 ≠ 候选 ${docs.length} → 维持 RRF 序`)
    return null
  }
  appendLogAt(RERANK_LOG, `rerank 完成：${docs.length} 候选 / ${elapsed}ms（档位 ${def.tier}）`)
  return result.scores
}
