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
  resolveTier,
  type EmbeddingModelDef,
  type EmbeddingTier,
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

/** 追加一行启动记录（写不了就静默——日志失败不该影响检索）。 */
function appendServerLog(message: string): void {
  try {
    appendFileSync(SERVER_LOG, `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
  } catch {
    // 只读文件系统等场合忽略
  }
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
function openServerLog(): { stdio: 'ignore' | ['ignore', number, number]; close: () => void } {
  try {
    try {
      if (statSync(SERVER_LOG).size > SERVER_LOG_MAX) writeFileSync(SERVER_LOG, '', 'utf-8')
    } catch {
      // 文件不存在等 → 不用截断
    }
    const fd = openSync(SERVER_LOG, 'a')
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

function readHandle(): ServerHandle | null {
  try {
    const text = readFileSync(PID_FILE, 'utf-8').trim()
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

/** 停止常驻 server（PID 文件记录的进程）。返回是否有进程被停。 */
export function stopEmbeddingServer(): boolean {
  let stopped = false
  const handle = readHandle()
  if (handle !== null) {
    try {
      process.kill(handle.pid)
      stopped = true
    } catch {
      // 进程可能已退出
    }
  }
  try {
    rmSync(PID_FILE, { force: true })
    rmSync(LOCK_FILE, { force: true })
  } catch {
    // 忽略
  }
  return stopped
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

function tryAcquireStartLock(): boolean {
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch {
    // 已存在：若是陈旧锁（上次启动中途崩溃），接管
    try {
      const age = Date.now() - statSync(LOCK_FILE).mtimeMs
      if (age > LOCK_STALE_MS) {
        writeFileSync(LOCK_FILE, String(process.pid), 'utf-8')
        return true
      }
    } catch {
      // stat 失败视为不可用
    }
    return false
  }
}

function releaseStartLock(): void {
  try {
    rmSync(LOCK_FILE, { force: true })
  } catch {
    // 忽略
  }
}

export interface EmbedText {
  ok: boolean
  vector?: Float32Array
  error?: string
}

/**
 * 发一次 /embedding；返回 200 的向量或错误信号。**维度由调用方校验**（随模型档位变）。
 */
async function embedOnce(
  input: string,
): Promise<{ ok: true; vector: number[] } | { ok: false; status: number; message: string }> {
  const res = await fetch(`${BASE}/embedding`, {
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
 * 单条文本 → 向量。**未安装/启动失败返回 ok:false**（调用方降级，不抛）。
 *
 * 长度上限取自当前档位模型定义（`activeModel().maxChars`）：CPU 档小、GPU 档大，
 * 各按自己的算力取「够用且不拖垮推理槽」的值。
 *
 * 自适应长度：先按上限截断发一次；若服务端仍报「input too large」（batch 比预期小
 * 的构建、或 token 比预估更密），**逐次减半重试**，绝不因超长硬失败——宁可嵌入前半
 * 段文本，也不让整条知识缺向量。
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
  const def = activeModel()
  try {
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
      if (!/too large|batch/i.test(lastError)) break
      limit = Math.floor(limit / 2)
    }
    return { ok: false, error: lastError }
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
