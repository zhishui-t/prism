/**
 * 本地向量化服务（变更 2，2026-09-10 用户裁决：Prism 自理 embedding，不依赖宿主）。
 *
 * 形态：BGE-M3（GGUF Q8_0，1024 维）经 llama.cpp 的 llama-server 常驻进程提供
 * `/embedding` HTTP 端点——模型加载一次（约 10s），之后单条 embedding 毫秒级；
 * 比每次 spawn 加载 600MB 模型快几个数量级。
 *
 * 生命周期：**按需启动 + 跨进程复用**——端口被占用即复用现存实例（CLI 每个命令是
 * 新进程，detached 启动保证 server 不随命令退出）；PID 落盘供 `prism embedding stop`。
 *
 * 未安装（setup-embedding 未跑）时降级：所有调用返回 unavailable，检索回落纯 BM25，
 * 不炸、不阻塞落库。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** vendored 布局（scripts/setup-embedding.mjs 安装目标）。 */
const LLAMA_DIR = fileURLToPath(new URL('../../../../3rd/llama.cpp', import.meta.url))
const SERVER_EXE = join(LLAMA_DIR, 'bin', 'llama-server.exe')
const MODEL_PATH = join(LLAMA_DIR, 'models', 'bge-m3-Q8_0.gguf')
const PID_FILE = join(LLAMA_DIR, 'llama-server.pid')

/** 默认端口（可被 PRISM_EMBEDDING_PORT 覆盖）。 */
export const EMBEDDING_PORT = Number(process.env['PRISM_EMBEDDING_PORT'] ?? 8191)
const BASE = `http://127.0.0.1:${EMBEDDING_PORT}`
/** 启动等待上限（模型加载 ~10s，留余量）。 */
const START_TIMEOUT_MS = 60_000

/** BGE-M3 输出维度（写库校验用）。 */
export const EMBEDDING_DIM = 1024

/**
 * 上下文窗口（= physical batch）。**必须 ≥ 单条最长 token 数**：
 * llama-server 默认 `-b 2048`，中文约 1 字 1 token，约 1000 字就会 500
 * `input is too large to process. increase the physical batch size`（QA 复现）。
 * 与 `MAX_INPUT_CHARS`（1500 字）配套取 2048：既装得下单条最长输入，
 * 又不为 8192 的 KV 缓存白占约 600MB 内存（CPU 推理下注意力还更慢）。
 */
export const EMBEDDING_CTX = 2048

/** 安装是否就绪（二进制 + 模型都在）。`PRISM_EMBEDDING=off` 时一律视为未就绪（降级纯 BM25）。 */
export function embeddingInstalled(): boolean {
  if (embeddingDisabled()) return false
  return existsSync(SERVER_EXE) && existsSync(MODEL_PATH)
}

/**
 * 全局降级开关：`PRISM_EMBEDDING=off` 强制纯 BM25。
 * 用于确定性测试（向量召回会扩大命中面，破坏精确计数断言）与排障对照。
 */
function embeddingDisabled(): boolean {
  const v = process.env['PRISM_EMBEDDING']
  return v === 'off' || v === '0' || v === 'false'
}

/** 停止常驻 server（PID 文件记录的进程）。返回是否有进程被停。 */
export function stopEmbeddingServer(): boolean {
  let stopped = false
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf-8').trim())
    if (Number.isFinite(pid)) {
      process.kill(pid)
      stopped = true
    }
  } catch {
    // PID 缺失/进程已退；下方仍清理锁
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
      if (await isAlive()) return true
      if (!embeddingInstalled()) return false
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
        // -c/-b/--ubatch-size 三者统一为 EMBEDDING_CTX：默认 -b 2048 会让约 1000 字
        // 的输入直接 500（见 EMBEDDING_CTX 注释），必须放大到装得下单条最长输入。
        const child = spawn(
          SERVER_EXE,
          [
            '-m', MODEL_PATH,
            '--embedding',
            '--host', '127.0.0.1',
            '--port', String(EMBEDDING_PORT),
            '-c', String(EMBEDDING_CTX),
            '-b', String(EMBEDDING_CTX),
            '--ubatch-size', String(EMBEDDING_CTX),
          ],
          { detached: true, stdio: 'ignore', windowsHide: true },
        )
        child.unref()
        try {
          writeFileSync(PID_FILE, String(child.pid), 'utf-8')
        } catch {
          // PID 记录失败不影响运行
        }
        const ok = await waitAlive(START_TIMEOUT_MS)
        if (!ok) starting = undefined // 允许下次重试
        return ok
      } finally {
        releaseStartLock()
      }
    })()
  }
  return starting
}

/** 启动锁：`<dir>/llama-server.lock`（独占创建；陈旧锁自动接管）。 */
const LOCK_FILE = join(LLAMA_DIR, 'llama-server.lock')
const LOCK_STALE_MS = 120_000

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
 * 单条输入字符上限。**远低于** EMBEDDING_CTX，因为本机是 CPU 推理：
 * BGE-M3 为 XLM-RoBERTa-large（24 层），注意力 O(n²)，实测单条耗时
 * 800 字≈3s / 1500 字≈9s / 2500 字≈16s，且长请求会长时间占用稀缺的推理槽。
 *
 * 取 1500：一个「知识单元」（规则/接口/模块说明）通常远短于此，够用且单条 <10s。
 * 更长内容应由导入流程**拆成多条**（本就直接对齐「提取而非拷贝」的落库哲学）。
 */
const MAX_INPUT_CHARS = 1500

/** 发一次 /embedding；返回 200 的向量或错误信号。 */
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
 * 自适应长度：先按上限截断发一次；若服务端仍报「input too large」（batch 比预期小
 * 的构建、或 token 比预估更密），**逐次减半重试**，绝不因超长硬失败——宁可嵌入前半
 * 段文本，也不让整条知识缺向量。
 */
export async function embedText(text: string): Promise<EmbedText> {
  if (!embeddingInstalled()) {
    return { ok: false, error: 'embedding 未安装（跑 node scripts/setup-embedding.mjs）' }
  }
  if (!(await ensureEmbeddingServer())) {
    return { ok: false, error: 'embedding server 启动失败' }
  }
  try {
    let limit = Math.min(text.length, MAX_INPUT_CHARS)
    let lastError = 'unknown'
    for (let attempt = 0; attempt < 5 && limit > 0; attempt++) {
      const result = await embedOnce(text.slice(0, limit))
      if (result.ok) {
        if (result.vector.length !== EMBEDDING_DIM) {
          return { ok: false, error: `embedding 维度异常（${result.vector.length} ≠ ${EMBEDDING_DIM}）` }
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
