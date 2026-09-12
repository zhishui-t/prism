/**
 * 嵌入后端的**跨平台契约**测试（2026-09-12 双平台支持 + Metal 判定修正）。
 *
 * 三轮真实踩坑，都由本文件锁定：
 * 1. 二进制名与 GPU 目录曾双双写死 `llama-server.exe` + `bin-vulkan` → macOS 上
 *    `embeddingInstalled()` 恒 false，向量检索**静默降级**成纯 BM25（不报错、不阻塞）。
 * 2. 曾用 `platform === 'darwin'` 判定 Metal → Intel Mac（x64）上误报。上游 `release.yml`
 *    对 macOS 两个构建的开关不同：arm64 开 `-DGGML_METAL_EMBED_LIBRARY`，x64 显式
 *    `-DGGML_METAL=OFF`（注释：CI runner 无 GPU）；实测 x64 包内无 `libggml-metal*`。
 * 3. 误判后果不只是文案：`autoTier()` 会优先挑 `large`（609MB）在纯 CPU 上跑。
 *
 * 判定表用纯函数 `resolveAccelBackend` 测全，**不依赖本机装了什么**，故
 * Windows / macOS(Intel & ARM) / Linux 都能跑；最末一组再用独立探测做端到端对账。
 */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accelBackend,
  cpuBackendHint,
  gpuBackendLabel,
  gpuServerCandidates,
  preferredBackend,
  resolveAccelBackend,
} from '../src/kb/embedding.js'

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

/** 候选路径的倒数第二段 = 后端目录名（bin / bin-vulkan / bin-cuda）。 */
function backendDirs(): string[] {
  return gpuServerCandidates().map((candidate) => candidate.split(/[\\/]/).slice(-2)[0]!)
}

const BIN_DIR = fileURLToPath(new URL('../../../3rd/llama-runtime/bin', import.meta.url))

/** **独立**探测（不复用实现里的判定），用于端到端对账。 */
function metalDylibExists(): boolean {
  try {
    return readdirSync(BIN_DIR).some((f) => /^libggml-metal.*\.dylib$/.test(f))
  } catch {
    return false
  }
}

const noAccel = { hasMetalDylib: false, hasVulkanBin: false, hasCudaBin: false }

describe('llama-server 二进制名按平台', () => {
  it('Windows 带 .exe，POSIX 无扩展名', () => {
    const candidates = gpuServerCandidates()
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      if (isWin) {
        expect(candidate.endsWith('llama-server.exe')).toBe(true)
      } else {
        expect(candidate.endsWith('llama-server')).toBe(true)
      }
    }
  })
})

describe('加速后端目录按平台', () => {
  it('Windows → Vulkan 独立目录；macOS → bin/（Metal 若在就同目录）；Linux → CUDA 优先 + Vulkan 兜底', () => {
    const dirs = backendDirs()
    if (isWin) {
      expect(dirs).toEqual(['bin-vulkan'])
    } else if (isMac) {
      expect(dirs).toEqual(['bin'])
    } else {
      expect(dirs[0]).toBe('bin-cuda')
      expect(dirs).toContain('bin-vulkan')
    }
  })
})

describe('加速后端判定表（纯函数，可跨平台测全）', () => {
  it('Windows：只有装了 Vulkan 包才算有加速', () => {
    expect(resolveAccelBackend({ platform: 'win32', ...noAccel })).toBeNull()
    expect(resolveAccelBackend({ platform: 'win32', ...noAccel, hasVulkanBin: true })).toBe('vulkan')
  })

  it('macOS：判据是包内有没有 libggml-metal*.dylib，**不是** platform===darwin', () => {
    // arm64 预编译包（GGML_METAL_EMBED_LIBRARY=ON）→ 有
    expect(resolveAccelBackend({ platform: 'darwin', ...noAccel, hasMetalDylib: true })).toBe('metal')
    // Intel Mac 预编译包（-DGGML_METAL=OFF）→ 无。硬件报「Metal 3」也不作数
    expect(resolveAccelBackend({ platform: 'darwin', ...noAccel })).toBeNull()
  })

  it('Linux：CUDA 优先，Vulkan 兜底，都没有则 CPU', () => {
    expect(resolveAccelBackend({ platform: 'linux', ...noAccel })).toBeNull()
    expect(resolveAccelBackend({ platform: 'linux', ...noAccel, hasVulkanBin: true })).toBe('vulkan')
    expect(resolveAccelBackend({ platform: 'linux', ...noAccel, hasCudaBin: true })).toBe('cuda')
    expect(
      resolveAccelBackend({ platform: 'linux', ...noAccel, hasCudaBin: true, hasVulkanBin: true }),
    ).toBe('cuda')
  })
})

describe('PRISM_EMBEDDING_BACKEND 显式覆盖', () => {
  afterEach(() => {
    delete process.env.PRISM_EMBEDDING_BACKEND
  })

  it('cpu/none/off 强制 CPU；metal/cuda/vulkan 强制指定后端', () => {
    for (const value of ['cpu', 'none', 'off']) {
      process.env.PRISM_EMBEDDING_BACKEND = value
      expect(accelBackend(), `${value} 应强制 CPU`).toBeNull()
    }
    for (const value of ['metal', 'cuda', 'vulkan'] as const) {
      process.env.PRISM_EMBEDDING_BACKEND = value
      expect(accelBackend(), `${value} 应被采纳`).toBe(value)
    }
  })
})

describe('后端三处口径自洽（不再谎报）', () => {
  it('preferredBackend / gpuBackendLabel 与 accelBackend 一致', () => {
    delete process.env.PRISM_EMBEDDING_BACKEND
    const accel = accelBackend()
    expect(preferredBackend()).toBe(accel === null ? 'cpu' : 'gpu')

    const label = gpuBackendLabel()
    if (accel === null) {
      expect(label).toBeNull() // 无加速后端时不得再返回 'Metal'
    } else {
      expect(['Metal', 'CUDA', 'Vulkan']).toContain(label)
    }
  })

  it('macOS 上探测结果 = 包内是否真有 Metal（与独立探测对账）', () => {
    delete process.env.PRISM_EMBEDDING_BACKEND
    if (!isMac) return
    const expectAccel = metalDylibExists() ? 'metal' : null
    expect(accelBackend()).toBe(expectAccel)
  })

  it('走 CPU 时的建议文案：Intel Mac 不再建议「装 GPU 包」', () => {
    const hint = cpuBackendHint()
    expect(hint.length).toBeGreaterThan(0)
    if (isMac && process.arch !== 'arm64') {
      expect(hint).toContain('预编译包')
    } else {
      expect(hint).toContain('GPU 包')
    }
  })
})
